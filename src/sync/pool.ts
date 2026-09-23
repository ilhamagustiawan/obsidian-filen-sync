/**
 * Pure fixed-size worker pool: runs fn(item, index) over items with at most
 * `concurrency` tasks in flight. Results are index-addressed, so the output
 * order matches the input order no matter how tasks complete. Any rejection
 * fails the whole map.
 */
export async function mapPool<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const results = Array.from<R>({ length: items.length });
	let next = 0;
	let error: unknown = null;

	const worker = async (): Promise<void> => {
		while (next < items.length) {
			if (error !== null) return;
			const index = next++;
			try {
				results[index] = await fn(items[index] as T, index);
			} catch (err) {
				if (error === null) error = err;
				return;
			}
		}
	};

	const workerCount = Math.min(Math.max(concurrency, 1), items.length);
	const workers: Promise<void>[] = [];
	for (let i = 0; i < workerCount; i++) {
		workers.push(worker());
	}
	await Promise.all(workers);

	if (error !== null) {
		throw error;
	}
	return results;
}
