import type { App } from "obsidian";
import type { SyncDb } from "../db";
import type { RemoteEntry, RemoteFs } from "../fs-remote";
import { ByteBoundedWorkPool, type BoundedPoolConfig } from "./byte-bounded-pool";
import type { LocalEntry } from "./executor";
import type { ScanFallbackReason, ScanMode } from "./types";

export const REMOTE_TREE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const LOCAL_SCAN_SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Small-file hashing pool limits. Concurrency is bounded by workers AND by an
 * accounted in-flight byte budget; files at/above `largeJobThresholdBytes`
 * hash serially. These values are the current defaults and are exercised by
 * the checked-in deterministic benchmarks (benchmark-workloads.test.mjs).
 */
export const HASH_POOL_DEFAULT_CONFIG: BoundedPoolConfig = {
	maxWorkers: 2,
	maxInFlightBytes: 8 * 1024 * 1024,
	largeJobThresholdBytes: 8 * 1024 * 1024,
	accountFactor: 2,
};

/**
 * Concurrent small-file hashing is enabled by default only because the checked-in
 * deterministic benchmarks (benchmark-workloads.test.mjs) show it eliminates
 * unnecessary reads without regressing serial hashing correctness or bounds.
 * Set to false to keep serial hashing.
 */
export const HASH_POOL_ENABLED = true;

export function createDefaultHashingPool(): ByteBoundedWorkPool {
	return new ByteBoundedWorkPool(HASH_POOL_DEFAULT_CONFIG);
}

export type RemoteTreeCache = {
	fetchedAt: number;
	eventWatermark: number;
	scan: RemoteScan;
};

export type LocalScanSnapshot = {
	fetchedAt: number;
	scan: LocalScan;
};

export type SyncEngineConfig = {
	app: App;
	db: SyncDb;
	pluginId: string;
	settings: {
		deviceId: string;
		vaultName: string;
		ignorePatterns: string[];
		fastRemotePolling: boolean;
		skipLargeFiles: boolean;
		skipSizeLargerThanMB: number;
		conflictResolution?: "auto" | "copy";
		syncSettings?: boolean;
		selectedSettings?: string[];
	};
	remote: RemoteFs;
	verifyTarget?: () => Promise<void>;
	transferConcurrency?: 1 | 2;
	/** Byte-bounded small-file hashing pool; omit to hash serially. */
	hashingPool?: ByteBoundedWorkPool;
};

export type LocalScan = {
	files: Map<string, LocalEntry>;
	dirs: Set<string>;
};

export type RemoteScan = {
	files: Map<string, RemoteEntry>;
	dirs: Set<string>;
};

export type SyncRunOptions = {
	isManual?: boolean;
	initialSync?: boolean;
	/** Legacy forced pass: verifies local contents AND refreshes remote metadata. */
	fullScan?: boolean;
	/** Force fresh content hashes for the full inventory. */
	verifyContents?: boolean;
	/** Force a fresh remote metadata walk. */
	refreshRemote?: boolean;
	/** Hinted paths for the narrow edit pass. */
	scanHints?: string[];
};

export type ScanPolicy = {
	mode: ScanMode;
	fallbackReason?: ScanFallbackReason | string;
	verifyContents: boolean;
	refreshRemote: boolean;
	narrow: boolean;
};

export type ExclusionsTracker = {
	ignoredCount: number;
	tooLargeCount: number;
	samplePaths: string[];
};
