import localforage from "localforage";
import type { MergeBaseline } from "./db";

type Store = ReturnType<typeof localforage.createInstance>;
type BaselineMetadata = { size: number; at: number };
type BaselineIndex = { entries: Map<string, BaselineMetadata>; total: number };
type BaselineBudget = {
	write: Promise<void>;
	index?: BaselineIndex;
	generation?: string | null;
	generationStore?: Store;
};

const FILE_LIMIT = 1024 * 1024;
const TOTAL_LIMIT = 64 * FILE_LIMIT;
// All database instances for a target in this runtime must share both the queue
// and index. A per-instance byte counter would miss other instances' writes.
const baselineBudgets = new Map<string, BaselineBudget>();

export function writeMergeBaselineWithinBudget(
	targetKey: string,
	baselines: Store,
	metadata: Store,
	path: string,
	baseline: MergeBaseline,
): Promise<void> {
	let budget = baselineBudgets.get(targetKey);
	if (!budget) {
		budget = { write: Promise.resolve() };
		baselineBudgets.set(targetKey, budget);
	}
	const shared = budget;
	const write = shared.write.then(async () => {
		const locks = globalThis.navigator?.locks;
		const mutate = async (): Promise<void> => {
			try {
				shared.generationStore ??= localforage.createInstance({
					name: targetKey,
					storeName: "merge-budget",
				});
				const generation = await shared.generationStore.getItem<string>("generation");
				if (!locks || generation !== shared.generation) shared.index = undefined;
				// Publish invalidation BEFORE touching either baseline store, including
				// writes that later fail or whose window exits before finishing.
				const nextGeneration = globalThis.crypto.randomUUID();
				await shared.generationStore.setItem("generation", nextGeneration);
				shared.generation = nextGeneration;
				if (!shared.index) {
					const index: BaselineIndex = { entries: new Map(), total: 0 };
					await metadata.iterate<BaselineMetadata, void>((entry, key) => {
						index.entries.set(key, entry);
						index.total += entry.size;
					});
					shared.index = index;
				}
				const index = shared.index;
				const replaceMetadata = (key: string, entry?: BaselineMetadata): void => {
					index.total -= index.entries.get(key)?.size ?? 0;
					if (entry) {
						index.entries.set(key, entry);
						index.total += entry.size;
					} else index.entries.delete(key);
				};
				const remove = async (key: string): Promise<void> => {
					// Delete text first: interrupted deletions can overcount, never undercount.
					await baselines.removeItem(key);
					await metadata.removeItem(key);
					replaceMetadata(key);
				};
				const size = new TextEncoder().encode(baseline.text).length;
				if (size > FILE_LIMIT) await remove(path);
				else {
					const previous = index.entries.get(path);
					const entry = { size, at: baseline.savedAt };
					// Reserve the larger size before replacing text. If either store fails,
					// reloading metadata still conservatively accounts for the stored text.
					await metadata.setItem(path, {
						...entry,
						size: Math.max(size, previous?.size ?? 0),
					});
					await baselines.setItem(path, baseline);
					if (previous && previous.size > size) await metadata.setItem(path, entry);
					replaceMetadata(path, entry);
				}
				if (index.total > TOTAL_LIMIT) {
					const oldest = [...index.entries].sort((a, b) => a[1].at - b[1].at);
					for (const [key] of oldest) {
						if (index.total <= TOTAL_LIMIT) break;
						await remove(key);
					}
				}
			} catch (error) {
				// Localforage stores are not a multi-store transaction. Rebuild after
				// any partial error rather than trusting a partially updated counter.
				shared.index = undefined;
				throw error;
			}
		};
		if (locks) {
			await locks.request(`filen-merge-baseline:${targetKey}`, { mode: "exclusive" }, mutate);
		} else {
			// Without Web Locks, reload every write rather than retain a counter
			// another context can stale. This cannot serialize overlapping writes
			// in different contexts; only the same-runtime queue remains available.
			try {
				await mutate();
			} finally {
				shared.index = undefined;
			}
		}
	});
	shared.write = write.catch(() => {});
	return write;
}
