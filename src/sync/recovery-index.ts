import type { RecoveryRecord } from "../db";

type RecoveryLookup = { targetKey: string; records: RecoveryRecord[]; scannedAt: number };

/** Fixed, non-sliding freshness window for writes from other windows/processes. */
export const RECOVERY_LOOKUP_TTL_MS = 1_000;

/**
 * Bounded, metadata-only history cache shared by DB instances in this JS runtime.
 * The recovery store remains authoritative: cold/evicted paths scan legacy records.
 * No persistent completeness marker is safe without atomic record/index writes.
 * Other windows/processes and direct store writes cannot invalidate this cache;
 * their changes are seen on the next lookup after the one-second TTL expires.
 * Expiry starts before scanning (not on hits), so even a slow scan cannot extend
 * the staleness window. This is bounded staleness, not cross-window consistency.
 */
export class RecoveryIndex {
	private readonly lookups = new Map<string, RecoveryLookup>();
	private readonly writers = new Map<string, number>();
	private revision = 0;

	// Bound retained metadata, not history: larger histories are returned uncached.
	private readonly maxPaths = 128;
	private readonly maxRecordsPerPath = 256;

	constructor(private readonly now: () => number = () => performance.now()) {}

	async getRecovery(
		targetKey: string,
		path: string,
		scan: () => Promise<RecoveryRecord[]>,
	): Promise<RecoveryRecord[]> {
		const key = JSON.stringify([targetKey, path]);
		const cached = this.lookups.get(key);
		if (cached && this.isFresh(cached.scannedAt)) {
			this.lookups.delete(key);
			this.lookups.set(key, cached);
			return cached.records.map((record) => ({ ...record }));
		}
		// Expired results must not survive a failed refresh.
		this.lookups.delete(key);
		const revision = this.revision;
		const scannedAt = this.now();
		const records = await scan();
		if (
			revision === this.revision &&
			!this.writers.has(targetKey) &&
			this.isFresh(scannedAt) &&
			records.length <= this.maxRecordsPerPath
		) {
			this.lookups.set(key, {
				targetKey,
				scannedAt,
				records: records.map((record) => ({ ...record })),
			});
			while (this.lookups.size > this.maxPaths) {
				const oldest = this.lookups.keys().next().value;
				if (oldest !== undefined) this.lookups.delete(oldest);
			}
		}
		return records;
	}

	private isFresh(scannedAt: number): boolean {
		const age = this.now() - scannedAt;
		return age >= 0 && age < RECOVERY_LOOKUP_TTL_MS;
	}

	/** Invalidate both sides of a write, even if it commits and then rejects. */
	async addRecovery(targetKey: string, write: () => Promise<unknown>): Promise<void> {
		this.invalidateTarget(targetKey);
		this.writers.set(targetKey, (this.writers.get(targetKey) ?? 0) + 1);
		try {
			await write();
		} finally {
			this.invalidateTarget(targetKey);
			const remaining = (this.writers.get(targetKey) ?? 1) - 1;
			if (remaining) this.writers.set(targetKey, remaining);
			else this.writers.delete(targetKey);
		}
	}

	private invalidateTarget(targetKey: string): void {
		this.revision++;
		for (const [key, lookup] of this.lookups) {
			if (lookup.targetKey === targetKey) this.lookups.delete(key);
		}
	}
}
