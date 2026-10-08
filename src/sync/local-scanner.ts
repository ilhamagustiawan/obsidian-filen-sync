import { TFile, TFolder, type App } from "obsidian";
import type { SyncPathFilter } from "../path-filters";
import type { LocalEntry } from "./executor";
import type { LocalHashCache } from "./local-hash-cache";
import type { ByteBoundedWorkPool } from "./byte-bounded-pool";
import { assertNoPathCollisions } from "./path-validation";

/** Capture identity and stats before asynchronous work; publish only verified fingerprints. */
export async function scanLocal(
	app: App,
	filter: SyncPathFilter,
	cache: LocalHashCache,
	force: boolean,
	baseline: Set<string> | null,
	pool?: ByteBoundedWorkPool,
	exclusions?: { ignoredCount: number; tooLargeCount: number; samplePaths: string[] },
	selectedSettings: string[] = [],
): Promise<{ files: Map<string, LocalEntry>; dirs: Set<string> }> {
	const files = new Map<string, LocalEntry>();
	const dirs = new Set<string>();
	const jobs: LocalEntry[] = [];
	for (const file of app.vault.getAllLoadedFiles()) {
		if (!file.path) continue;
		const reason = filter.checkExclusion(
			file.path,
			file instanceof TFile ? file.stat.size : undefined,
		);
		if (reason !== "included") {
			if (exclusions) {
				if (reason === "too_large") exclusions.tooLargeCount++;
				else exclusions.ignoredCount++;
				if (exclusions.samplePaths.length < 10) exclusions.samplePaths.push(file.path);
			}
			continue;
		}
		if (file instanceof TFolder) dirs.add(file.path);
		else if (file instanceof TFile) {
			const entry: LocalEntry = { path: file.path, ...file.stat, file };
			const hit = cache.getFresh(file, force);
			if (hit) files.set(entry.path, { ...entry, ...hit });
			else if (baseline !== null && !baseline.has(entry.path)) files.set(entry.path, entry);
			else jobs.push(entry);
		}
	}
	for (const path of selectedSettings) {
		const stat = await app.vault.adapter.stat(path);
		if (!stat || stat.type !== "file" || filter.checkExclusion(path, stat.size) !== "included")
			continue;
		const file = new TFile();
		file.path = path;
		file.stat = { mtime: stat.mtime, ctime: stat.ctime, size: stat.size };
		const entry: LocalEntry = { path, ...file.stat, file, adapterOnly: true };
		const cached = cache.getFresh(file, force, true);
		if (cached) files.set(path, { ...entry, ...cached });
		else jobs.push(entry);
	}
	const hash = async (entry: LocalEntry) => {
		const file = entry.file as TFile;
		const fp = await cache.readBoth(
			file,
			() =>
				entry.adapterOnly
					? app.vault.adapter.readBinary(entry.path)
					: app.vault.readBinary(file),
			force,
			{ withSha512: false },
		);
		if (
			file.path !== entry.path ||
			file.stat.mtime !== entry.mtime ||
			file.stat.ctime !== entry.ctime ||
			file.stat.size !== entry.size ||
			(!entry.adapterOnly && app.vault.getAbstractFileByPath(entry.path) !== file)
		)
			throw new Error(`Local file changed while scanning: ${entry.path}. Replan the sync.`);
		if (entry.adapterOnly) {
			const stat = await app.vault.adapter.stat(entry.path);
			if (
				!stat ||
				stat.mtime !== entry.mtime ||
				stat.ctime !== entry.ctime ||
				stat.size !== entry.size
			)
				throw new Error(
					`Local file changed while scanning: ${entry.path}. Replan the sync.`,
				);
		}
		files.set(entry.path, { ...entry, ...fp });
	};
	if (pool) await pool.run(jobs, (e) => e.size, hash);
	else for (const job of jobs) await hash(job);
	cache.prune(new Set(files.keys()));
	assertNoPathCollisions([
		...Array.from(files.keys(), (path) => ({ path, isDir: false })),
		...Array.from(dirs, (path) => ({ path, isDir: true })),
	]);
	return { files, dirs };
}
