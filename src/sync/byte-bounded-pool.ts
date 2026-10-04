/**
 * Byte-bounded worker pool for hashing small files.
 *
 * Concurrency is constrained by BOTH the worker limit and an explicit accounted
 * in-flight byte budget. Large jobs (at/above `largeJobThresholdBytes`) run
 * serially; a single job whose accounted bytes alone exceed the budget runs
 * only in isolation (no other job in flight). Any worker rejection stops
 * scheduling new work, drains in-flight operations, and rejects the run - so
 * incomplete results can never be published as evidence.
 */

export type BoundedPoolConfig = {
	maxWorkers: number;
	maxInFlightBytes: number;
	largeJobThresholdBytes: number;
	/** Memory accounted per byte read (digest copies, read buffers). Default 2. */
	accountFactor?: number;
};

export type BoundedPoolStats = {
	peakActive: number;
	peakInFlightBytes: number;
	serialLargeJobs: number;
	pooledJobs: number;
};

export class ByteBoundedWorkPool {
	private peakActive = 0;
	private peakInFlightBytes = 0;
	private serialLargeJobs = 0;
	private pooledJobs = 0;

	constructor(readonly config: BoundedPoolConfig) {}

	get stats(): BoundedPoolStats {
		return {
			peakActive: this.peakActive,
			peakInFlightBytes: this.peakInFlightBytes,
			serialLargeJobs: this.serialLargeJobs,
			pooledJobs: this.pooledJobs,
		};
	}

	private accountFor(size: number): number {
		return Math.max(1, Math.ceil(size * (this.config.accountFactor ?? 2)));
	}

	/**
	 * Runs worker(item) over every item with bounded concurrency and bytes.
	 * Throws the first worker error after in-flight work drains.
	 */
	async run<T>(
		items: readonly T[],
		sizeOf: (item: T) => number,
		worker: (item: T) => Promise<void>,
	): Promise<void> {
		const large = items.filter((item) => sizeOf(item) >= this.config.largeJobThresholdBytes);
		const small = items.filter((item) => sizeOf(item) < this.config.largeJobThresholdBytes);

		// Large jobs stay serial; a single oversized small job may run only alone.
		for (const item of large) {
			this.serialLargeJobs++;
			const bytes = this.accountFor(sizeOf(item));
			this.peakActive = Math.max(this.peakActive, 1);
			this.peakInFlightBytes = Math.max(this.peakInFlightBytes, bytes);
			await worker(item);
		}

		await this.runBounded(small, sizeOf, worker);
	}

	private async runBounded<T>(
		items: readonly T[],
		sizeOf: (item: T) => number,
		worker: (item: T) => Promise<void>,
	): Promise<void> {
		if (items.length === 0) return;
		this.pooledJobs += items.length;

		let next = 0;
		let running = 0;
		let inFlightBytes = 0;
		let error: unknown = null;
		const active = new Set<Promise<void>>();

		const touchPeaks = (): void => {
			this.peakActive = Math.max(this.peakActive, running);
			this.peakInFlightBytes = Math.max(this.peakInFlightBytes, inFlightBytes);
		};

		return new Promise<void>((resolve, reject) => {
			const maybeFinish = (): void => {
				// A failure rejects as soon as in-flight work drains; success waits for
				// every item to be consumed and completed.
				if (active.size === 0 && (error !== null || next >= items.length)) {
					if (error !== null) reject(error);
					else resolve();
				}
			};

			const settle = (): void => {
				if (error !== null) return;
				while (next < items.length) {
					if (running >= this.config.maxWorkers) return;
					const item = items[next] as T;
					const accounted = this.accountFor(sizeOf(item));
					const hasRoom = inFlightBytes + accounted <= this.config.maxInFlightBytes;
					const oversizedAlone =
						accounted > this.config.maxInFlightBytes && inFlightBytes === 0;
					if (!hasRoom && !oversizedAlone) return;
					next++;
					running++;
					inFlightBytes += accounted;
					touchPeaks();
					const completion = { task: undefined as Promise<void> | undefined };
					const task = (async () => {
						try {
							await worker(item);
						} catch (err) {
							if (error === null) error = err;
						} finally {
							running--;
							inFlightBytes = Math.max(0, inFlightBytes - accounted);
							touchPeaks();
							if (completion.task !== undefined) active.delete(completion.task);
							settle();
							maybeFinish();
						}
					})();
					completion.task = task;
					active.add(task);
				}
			};

			settle();
			maybeFinish();
		});
	}
}
