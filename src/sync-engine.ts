import { readLocalBytes } from "./sync/local-io";
import { selectedSettingsPaths } from "./sync/settings-paths";
import { scanLocal } from "./sync/local-scanner";
import type { App } from "obsidian";
import { normalizePath, TFile, TFolder } from "obsidian";
import type { SyncDb } from "./db";
import type { RemoteEntry, RemoteFs } from "./fs-remote";
import { createSyncPathFilter, type SyncPathFilter } from "./path-filters";
import type { SyncedFileRecord } from "./settings";
import { isValidFilenSha512 } from "./sync/content-hash";
import { checkBulkGuard, type BulkGuardReport, type BulkGuardThresholds } from "./sync/bulk-guard";
import { sha256Hex, SyncExecutor, type ExecutionResult, type LocalEntry } from "./sync/executor";
import { assertNoPathCollisions } from "./sync/path-validation";
import { planSync } from "./sync/planner";
import { LocalHashCache } from "./sync/local-hash-cache";
import { mapPool } from "./sync/pool";
import { ByteBoundedWorkPool, type BoundedPoolConfig } from "./sync/byte-bounded-pool";
import type {
	ConflictCopy,
	LocalFileInfo,
	RemoteFileInfo,
	ScanCounters,
	ScanDiagnostics,
	ScanFallbackReason,
	ScanMode,
	SnapshotProvenance,
	SyncActivityEvent,
	SyncDirection,
	SyncOperation,
	SyncOutcome,
	SyncPreviewResult,
	SyncProgress,
	TargetIdentityInfo,
} from "./sync/types";

export type {
	BulkGuardReport,
	ConflictCopy,
	SyncActivityEvent,
	SyncDirection,
	SyncOperation,
	SyncOutcome,
	SyncPreviewResult,
	SyncProgress,
	TargetIdentityInfo,
};

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

type RemoteTreeCache = {
	fetchedAt: number;
	eventWatermark: number;
	scan: RemoteScan;
};

type LocalScanSnapshot = {
	fetchedAt: number;
	scan: LocalScan;
};

type SyncEngineConfig = {
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
	transferConcurrency?: 1 | 2;
	/** Byte-bounded small-file hashing pool; omit to hash serially. */
	hashingPool?: ByteBoundedWorkPool;
};

type LocalScan = {
	files: Map<string, LocalEntry>;
	dirs: Set<string>;
};

type RemoteScan = {
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

type ScanPolicy = {
	mode: ScanMode;
	fallbackReason?: ScanFallbackReason | string;
	verifyContents: boolean;
	refreshRemote: boolean;
	narrow: boolean;
};

export class SyncEngine {
	private remoteTreeCache: RemoteTreeCache | null = null;
	private localScanSnapshot: LocalScanSnapshot | null = null;
	private localHashes = new LocalHashCache();
	/** Bumped whenever external vault events invalidate paths during a scan. */
	private invalidationEpoch = 0;

	invalidateLocal(path: string, subtree = false): void {
		this.invalidationEpoch++;
		if (subtree) this.localHashes.invalidateSubtree(path);
		else this.localHashes.invalidate(path);
	}

	constructor(private readonly config: SyncEngineConfig) {}

	close(): void {
		this.config.remote.close();
		this.remoteTreeCache = null;
		this.localScanSnapshot = null;
		this.localHashes.clear();
	}

	async testRemote(): Promise<void> {
		await this.config.remote.checkConnect();
	}

	/**
	 * Two-pass synchronization:
	 * 1. Plan pass: reads metadata, checks collision, computes pure actions, applies safety guards.
	 * 2. Apply pass: executes actions with revalidation and per-file baseline updates.
	 */
	async sync(
		onProgress?: (progress: SyncProgress) => void,
		confirmLocalDeletes?: (paths: string[]) => Promise<boolean>,
		onActivity?: (event: SyncActivityEvent) => void,
		direction: SyncDirection = "both",
		confirmBulkOperations?: (report: BulkGuardReport) => Promise<boolean>,
		bulkThresholds?: BulkGuardThresholds,
		options: SyncRunOptions = {},
	): Promise<SyncOutcome> {
		await this.config.remote.mkdir("");

		const maxFileSizeBytes = this.config.settings.skipLargeFiles
			? this.config.settings.skipSizeLargerThanMB * 1024 * 1024
			: undefined;

		const pathFilter = createSyncPathFilter({
			configDir: this.config.app.vault.configDir,
			pluginId: this.config.pluginId,
			ignorePatterns: this.config.settings.ignorePatterns,
			maxFileSizeBytes,
			selectedSettings: selectedSettingsPaths(
				this.config.app.vault.configDir,
				this.config.pluginId,
				this.config.settings.syncSettings,
				this.config.settings.selectedSettings,
			),
		});

		let replanAttempts = 0;
		const maxReplanAttempts = 1;

		while (true) {
			try {
				return await this.executeSyncPass(
					pathFilter,
					direction,
					onProgress,
					confirmLocalDeletes,
					onActivity,
					confirmBulkOperations,
					bulkThresholds,
					options,
					replanAttempts,
				);
			} catch (error) {
				this.remoteTreeCache = null;
				this.localScanSnapshot = null;
				this.localHashes.clear();
				if (
					replanAttempts < maxReplanAttempts &&
					error instanceof Error &&
					error.message.includes("Replan the sync")
				) {
					replanAttempts += 1;
					onActivity?.({
						type: "diagnostic",
						message: "Changes detected during sync; running fresh pass...",
					});
					continue;
				}
				throw error;
			}
		}
	}

	private patchSnapshots(result: ExecutionResult): void {
		if (result.applied === 0) return;
		if (this.localScanSnapshot !== null) {
			if (result.deletedLocalPath !== undefined) {
				this.localScanSnapshot.scan.files.delete(result.deletedLocalPath);
			}
			if (result.localFile !== undefined) {
				this.localScanSnapshot.scan.files.set(result.localFile.path, result.localFile);
			}
			if (result.conflictLocalFile !== undefined) {
				this.localScanSnapshot.scan.files.set(
					result.conflictLocalFile.path,
					result.conflictLocalFile,
				);
			}
		}
		if (this.remoteTreeCache !== null) {
			if (result.deletedRemotePath !== undefined) {
				this.remoteTreeCache.scan.files.delete(result.deletedRemotePath);
			}
			if (result.remoteFile !== undefined) {
				this.remoteTreeCache.scan.files.set(result.remoteFile.path, result.remoteFile);
			}
			if (result.conflictRemoteFile !== undefined) {
				this.remoteTreeCache.scan.files.set(
					result.conflictRemoteFile.path,
					result.conflictRemoteFile,
				);
			}
		}
	}

	/**
	 * Guards snapshot publication against edits arriving during scanning: the
	 * observed invalidation epoch must still match the epoch captured at scan
	 * start, otherwise stale evidence is discarded and the pass replans.
	 */
	private assertScanEpoch(epoch: number): void {
		if (this.invalidationEpoch !== epoch) {
			throw new Error("Local files changed while scanning. Replan the sync.");
		}
	}

	private deriveScanPolicy(
		options: SyncRunOptions,
		replanAttempts: number,
		snapshotValid: boolean,
		cacheValid: boolean,
		probeHasChanges: boolean,
		probeFailed: boolean,
		probeStatus: "available" | "unsupported" | "disabled",
		hasValidFileHints: boolean,
	): ScanPolicy {
		const isManual = options.isManual === true;
		const isInitial = options.initialSync === true;
		const forceVerified = isManual || isInitial;
		const verifyContents =
			forceVerified || options.fullScan === true || options.verifyContents === true;
		const refreshRemote =
			forceVerified || options.fullScan === true || options.refreshRemote === true;

		const narrow =
			!this.config.settings.syncSettings &&
			!verifyContents &&
			!refreshRemote &&
			replanAttempts === 0 &&
			snapshotValid &&
			cacheValid &&
			!probeHasChanges &&
			hasValidFileHints;

		if (narrow) {
			return { mode: "narrow", verifyContents, refreshRemote, narrow: true };
		}

		const hasAnyHints = options.scanHints !== undefined && options.scanHints.length > 0;
		const folderHintsOnly = hasAnyHints && !hasValidFileHints;

		let fallbackReason: ScanFallbackReason | string | undefined;
		if (isManual) fallbackReason = "manual-sync";
		else if (isInitial) fallbackReason = "initial-sync";
		else if (replanAttempts > 0) fallbackReason = "replan";
		else if (options.verifyContents === true) fallbackReason = "explicit-verify";
		else if (options.fullScan === true || options.refreshRemote === true)
			fallbackReason = "explicit-refresh";
		else if (folderHintsOnly) fallbackReason = "folder-hints";
		else if (!hasAnyHints) fallbackReason = "missing-hints";
		else if (probeStatus === "unsupported") fallbackReason = "no-remote-event-support";
		else if (probeStatus === "disabled") fallbackReason = "fast-polling-disabled";
		else if (probeFailed) fallbackReason = "remote-probe-failed";
		else if (probeHasChanges) fallbackReason = "remote-changes-detected";
		else if (!cacheValid && !snapshotValid) fallbackReason = "cold-session";
		else if (!cacheValid) fallbackReason = "stale-remote-tree";
		else if (!snapshotValid) fallbackReason = "stale-local-snapshot";
		else fallbackReason = "ambiguous-hints";

		const mode: ScanMode = verifyContents && refreshRemote ? "full" : "reconcile";
		return { mode, fallbackReason, verifyContents, refreshRemote, narrow: false };
	}

	private async executeSyncPass(
		pathFilter: SyncPathFilter,
		direction: SyncDirection,
		onProgress?: (progress: SyncProgress) => void,
		confirmLocalDeletes?: (paths: string[]) => Promise<boolean>,
		onActivity?: (event: SyncActivityEvent) => void,
		confirmBulkOperations?: (report: BulkGuardReport) => Promise<boolean>,
		bulkThresholds?: BulkGuardThresholds,
		options: SyncRunOptions = {},
		replanAttempts = 0,
	): Promise<SyncOutcome> {
		// Fresh counter window per pass so diagnostics describe THIS scan only.
		this.localHashes.resetCounters();

		const localSnapshotValid =
			this.localScanSnapshot !== null &&
			Date.now() - this.localScanSnapshot.fetchedAt < LOCAL_SCAN_SNAPSHOT_TTL_MS;

		const remoteCacheValid =
			this.remoteTreeCache !== null &&
			Date.now() - this.remoteTreeCache.fetchedAt < REMOTE_TREE_CACHE_TTL_MS;

		const canFastPoll =
			this.config.settings.fastRemotePolling && this.config.remote.checkEvents !== undefined;

		// Independently decide whether fresh content hashes / remote metadata are
		// required before we consult the remote event probe.
		const isManual = options.isManual === true;
		const isInitial = options.initialSync === true;
		const forceVerified = isManual || isInitial;
		const verifyContents =
			forceVerified || options.fullScan === true || options.verifyContents === true;
		const refreshRemote =
			forceVerified || options.fullScan === true || options.refreshRemote === true;

		let probeHasChanges = true;
		let probeFailed = false;
		let newWatermark = Date.now();
		const eventProbeAvailable = this.config.remote.checkEvents !== undefined;
		const probeStatus: "available" | "unsupported" | "disabled" = !eventProbeAvailable
			? "unsupported"
			: canFastPoll
				? "available"
				: "disabled";
		const eventProbeStart = performance.now();
		if (canFastPoll && !refreshRemote && this.config.remote.checkEvents !== undefined) {
			const currentWatermark = this.remoteTreeCache?.eventWatermark ?? 0;
			try {
				const probe = await this.config.remote.checkEvents(currentWatermark);
				probeHasChanges = probe.hasChanges;
				newWatermark = probe.newWatermarkMs;
			} catch {
				probeHasChanges = true;
				probeFailed = true;
			}
		}
		const eventProbeMs = Math.round(performance.now() - eventProbeStart);

		const hasValidFileHints =
			options.scanHints !== undefined &&
			options.scanHints.length > 0 &&
			!options.scanHints.some((path) => {
				const f = this.config.app.vault.getAbstractFileByPath(normalizePath(path));
				return (
					f instanceof TFolder ||
					this.localScanSnapshot?.scan.dirs.has(path) ||
					this.remoteTreeCache?.scan.dirs.has(path)
				);
			});

		const resolvedPolicy = this.deriveScanPolicy(
			options,
			replanAttempts,
			localSnapshotValid,
			remoteCacheValid,
			probeHasChanges,
			probeFailed,
			probeStatus,
			hasValidFileHints,
		);

		const isNarrow = resolvedPolicy.narrow;

		let planResult: ReturnType<typeof planSync>;
		let bulkReport: ReturnType<typeof checkBulkGuard>;
		let effectiveLocalFiles: Map<string, LocalEntry>;
		let effectiveRemoteFiles: Map<string, RemoteEntry>;
		let effectivePrev: Map<string, SyncedFileRecord>;
		let localDirs = new Set<string>();
		let remoteDirs = new Set<string>();
		let remoteFromCache = false;
		let equalityDownloads = 0;
		let equalityComparisons = 0;
		let remoteProbes = 0;
		let remoteRefreshes = 0;
		let remoteReuses = 0;
		remoteProbes = canFastPoll && !refreshRemote ? 1 : 0;

		let scanMs = 0;
		let planMs = 0;
		let localScanMs = 0;
		let baselineMs = 0;
		let remoteScanMs = 0;
		let equalityMs = 0;
		let directoriesMs = 0;
		let executeMs = 0;
		let inventoryFiles = 0;
		let inventoryDirs = 0;

		const syncPassStart = performance.now();
		const scanStart = performance.now();
		const epoch = this.invalidationEpoch;

		if (isNarrow) {
			onProgress?.({ phase: "scanning-local", current: 0, total: 0, path: "" });
			const candidatePaths = new Set(options.scanHints!);
			const candidateLocalFiles = new Map<string, LocalEntry>();
			for (const path of candidatePaths) {
				const file = this.config.app.vault.getAbstractFileByPath(normalizePath(path));
				if (file instanceof TFile) {
					if (pathFilter.isIgnored(file.path, file.stat.size)) continue;
					const snapshot = { path: file.path, ...file.stat, file };
					const fp = await this.localHashes.readBoth(
						file,
						() => this.config.app.vault.readBinary(file),
						false,
						{ withSha512: false },
					);
					candidateLocalFiles.set(snapshot.path, {
						...snapshot,
						hash: fp.hash,
						sha512: fp.sha512,
						file,
					});
				}
			}

			this.assertScanEpoch(epoch);

			const candidatePrev = new Map<string, SyncedFileRecord>();
			for (const path of candidatePaths) {
				const record = await this.config.db.getFile(path);
				if (
					record !== null &&
					record !== undefined &&
					!pathFilter.isIgnored(path, record.size)
				) {
					candidatePrev.set(path, record);
				}
			}

			onProgress?.({ phase: "scanning-remote", current: 0, total: 0, path: "" });
			const candidateEntries: Array<[string, RemoteEntry]> = [];
			for (const path of candidatePaths) {
				const entry = this.remoteTreeCache!.scan.files.get(path);
				if (
					entry !== undefined &&
					!entry.isDir &&
					!pathFilter.isIgnored(entry.path, entry.size)
				) {
					candidateEntries.push([path, entry]);
				}
			}
			const candidateEqualityHashes = await this.resolveRemoteFileHashes(
				candidateEntries,
				candidateLocalFiles,
				candidatePrev,
			);
			equalityComparisons = candidateEqualityHashes.comparisons;
			equalityDownloads = candidateEqualityHashes.downloads;

			const candidateRemoteFiles = new Map<string, RemoteFileInfo>();
			for (const [path, entry] of candidateEntries) {
				candidateRemoteFiles.set(path, {
					path: entry.path,
					mtime: entry.mtime,
					size: entry.size,
					isDir: false,
					uuid: entry.uuid,
					remoteHash: entry.remoteHash,
					hash: candidateEqualityHashes.resolved.get(path),
				});
			}

			// Validate collisions against complete cached snapshot
			const testLocalPaths = new Map<string, boolean>();
			for (const [p] of this.localScanSnapshot!.scan.files) {
				if (!candidatePaths.has(p)) testLocalPaths.set(p, false);
			}
			for (const [p] of candidateLocalFiles) {
				testLocalPaths.set(p, false);
			}
			for (const d of this.localScanSnapshot!.scan.dirs) {
				testLocalPaths.set(d, true);
			}
			assertNoPathCollisions(
				[...testLocalPaths.entries()].map(([path, isDir]) => ({ path, isDir })),
			);

			scanMs = Math.round(performance.now() - scanStart);
			localScanMs = scanMs;
			const planStart = performance.now();
			onProgress?.({ phase: "planning", current: 0, total: 0, path: "" });
			const localFiles = new Map<string, LocalFileInfo>();
			for (const [path, entry] of candidateLocalFiles) {
				localFiles.set(path, {
					path,
					mtime: entry.mtime,
					ctime: entry.ctime,
					size: entry.size,
					hash: entry.hash,
				});
			}

			planResult = planSync({
				localFiles,
				remoteFiles: candidateRemoteFiles,
				prevRecords: candidatePrev,
				direction,
			});

			bulkReport = checkBulkGuard(
				planResult.actions,
				{
					totalLocalFiles: this.localScanSnapshot!.scan.files.size,
					totalRemoteFiles: this.remoteTreeCache!.scan.files.size,
					totalBaselineFiles: this.localScanSnapshot!.scan.files.size,
				},
				bulkThresholds,
			);
			planMs = Math.round(performance.now() - planStart);

			effectiveLocalFiles = candidateLocalFiles;
			effectiveRemoteFiles = this.remoteTreeCache!.scan.files;
			effectivePrev = candidatePrev;
			inventoryFiles = candidateLocalFiles.size;
			inventoryDirs = this.localScanSnapshot?.scan.dirs.size ?? 0;
		} else {
			onProgress?.({ phase: "scanning-local", current: 0, total: 0, path: "" });

			const baselineStart = performance.now();
			const prevRecords = await this.config.db.getAllFiles();
			baselineMs = Math.round(performance.now() - baselineStart);
			const filteredPrev = filterPrevRecords(prevRecords, pathFilter);
			const baselinePaths = new Set(filteredPrev.keys());
			this.assertScanEpoch(epoch);

			const localScanStart = performance.now();
			// Routine reconcile runs reuse valid session hashes; explicit verification
			// forces fresh content evidence for the complete inventory. No-baseline
			// files are deferred to equality resolution so both fingerprints come from
			// one read (single-read equality), unless explicit verification demands it.
			const deferNoBaselineHashing = !verifyContents;
			const local = await this.walkLocal(
				pathFilter,
				verifyContents,
				deferNoBaselineHashing ? baselinePaths : null,
				epoch,
			);
			localScanMs = Math.round(performance.now() - localScanStart);
			this.assertScanEpoch(epoch);

			onProgress?.({ phase: "scanning-remote", current: 0, total: 0, path: "" });
			const remoteStart = performance.now();
			let remote: RemoteScan;

			if (
				canFastPoll &&
				!refreshRemote &&
				eventProbeAvailable &&
				!probeHasChanges &&
				remoteCacheValid &&
				this.remoteTreeCache !== null
			) {
				remote = this.remoteTreeCache.scan;
				remoteFromCache = true;
				remoteReuses = 1;
			} else {
				const fetchStartedAt = Date.now();
				remote = await this.walkRemote(pathFilter);
				this.remoteTreeCache = {
					fetchedAt: Date.now(),
					eventWatermark: Math.max(newWatermark, fetchStartedAt),
					scan: remote,
				};
				remoteRefreshes = 1;
			}
			remoteScanMs = Math.round(performance.now() - remoteStart);
			this.assertScanEpoch(epoch);

			const equalityStart = performance.now();
			const equalityHashes = await this.resolveRemoteFileHashes(
				remote.files,
				local.files,
				filteredPrev,
			);
			equalityMs = Math.round(performance.now() - equalityStart);
			this.assertScanEpoch(epoch);
			equalityComparisons = equalityHashes.comparisons;
			equalityDownloads = equalityHashes.downloads;

			// Build planner inputs after equality resolution so no-baseline files use
			// the same-bytes fingerprints derived during equality checking.
			const localFiles = new Map<string, LocalFileInfo>();
			for (const [path, entry] of local.files) {
				localFiles.set(path, {
					path,
					mtime: entry.mtime,
					ctime: entry.ctime,
					size: entry.size,
					hash: entry.hash,
				});
			}

			const remoteFiles = new Map<string, RemoteFileInfo>();
			for (const [path, entry] of remote.files) {
				remoteFiles.set(path, {
					path,
					mtime: entry.mtime,
					size: entry.size,
					isDir: entry.isDir,
					uuid: entry.uuid,
					remoteHash: entry.remoteHash,
					hash: equalityHashes.resolved.get(path),
				});
			}

			// Publish snapshots only after successful scanning, then prune cache.
			this.localScanSnapshot = {
				fetchedAt: Date.now(),
				scan: { files: new Map(local.files), dirs: new Set(local.dirs) },
			};
			this.localHashes.prune(new Set(local.files.keys()));

			scanMs = Math.round(performance.now() - scanStart);
			const planStart = performance.now();
			onProgress?.({ phase: "planning", current: 0, total: 0, path: "" });
			planResult = planSync({
				localFiles,
				remoteFiles,
				prevRecords: filteredPrev,
				direction,
			});

			bulkReport = checkBulkGuard(
				planResult.actions,
				{
					totalLocalFiles: local.files.size,
					totalRemoteFiles: remote.files.size,
					totalBaselineFiles: filteredPrev.size,
				},
				bulkThresholds,
			);
			planMs = Math.round(performance.now() - planStart);

			effectiveLocalFiles = local.files;
			effectiveRemoteFiles = remote.files;
			effectivePrev = filteredPrev;
			localDirs = local.dirs;
			remoteDirs = remote.dirs;
			inventoryFiles = local.files.size;
			inventoryDirs = local.dirs.size;
		}

		if (bulkReport.blocked) {
			onProgress?.({ phase: "confirming", current: 0, total: 0, path: "" });
			if (confirmBulkOperations !== undefined) {
				const confirmed = await confirmBulkOperations(bulkReport);
				if (!confirmed) {
					return {
						applied: 0,
						conflicts: 0,
						conflictCopies: [],
						cancelled: true,
						cancelReason: bulkReport.reason,
					};
				}
			} else {
				return {
					applied: 0,
					conflicts: 0,
					conflictCopies: [],
					cancelled: true,
					cancelReason: bulkReport.reason,
				};
			}
		}

		// 3. Local Deletions Confirmation
		const deleteLocalPaths = planResult.actions
			.filter((a) => a.operation === "delete-local")
			.map((a) => a.path);

		if (deleteLocalPaths.length > 0 && confirmLocalDeletes !== undefined) {
			onProgress?.({ phase: "confirming", current: 0, total: 0, path: "" });
			const confirmed = await confirmLocalDeletes(deleteLocalPaths);
			if (!confirmed) {
				return {
					applied: 0,
					conflicts: 0,
					conflictCopies: [],
					cancelled: true,
					cancelReason: "Local deletes cancelled by user.",
				};
			}
		}

		// 4. Safe Apply Pass
		const executor = new SyncExecutor({
			app: this.config.app,
			db: this.config.db,
			deviceId: this.config.settings.deviceId,
			remote: this.config.remote,
			pluginId: this.config.pluginId,
			conflictResolution: this.config.settings.conflictResolution,
			selectedSettings: selectedSettingsPaths(
				this.config.app.vault.configDir,
				this.config.pluginId,
				this.config.settings.syncSettings,
				this.config.settings.selectedSettings,
			),
		});

		let applied = 0;
		let conflicts = 0;
		let uploaded = 0;
		let downloaded = 0;
		let deletedLocal = 0;
		let deletedRemote = 0;
		const conflictCopies: ConflictCopy[] = [];
		const total = planResult.actions.filter((action) => action.operation !== "noop").length;
		let completed = 0;
		const executeStart = performance.now();

		if (!isNarrow) {
			onProgress?.({ phase: "directories", current: 0, total: 0, path: "" });
			const dirsStart = performance.now();
			applied += await executor.syncDirectories(localDirs, remoteDirs, {
				skipRemoteFolderPrune: remoteFromCache,
			});
			directoriesMs = Math.round(performance.now() - dirsStart);
		}

		let firstTransferMs: number | undefined;
		const transferStart = performance.now();

		const execute = async (action: (typeof planResult.actions)[number]): Promise<void> => {
			const report = (completedBytes?: number, totalBytes?: number): void => {
				if (action.operation !== "noop")
					onProgress?.({
						phase: "transferring",
						current: completed,
						total,
						path: action.path,
						operation: action.operation,
						completedBytes,
						totalBytes,
					});
			};
			report();

			const result = await executor.execute(
				action,
				effectiveLocalFiles.get(action.path),
				effectiveRemoteFiles.get(action.path),
				effectivePrev.get(action.path),
				report,
			);

			if (action.operation !== "noop") {
				if (result.applied === 0)
					throw new Error(
						`File changed before applying ${action.path}. Replan the sync.`,
					);
				completed++;
				if (firstTransferMs === undefined) {
					firstTransferMs = Math.round(performance.now() - syncPassStart);
				}
				report();
			}
			applied += result.applied;
			conflicts += result.conflicts;
			if (result.applied > 0) {
				this.patchSnapshots(result);
				switch (action.operation) {
					case "upload":
						uploaded++;
						break;
					case "download":
						downloaded++;
						break;
					case "delete-local":
						deletedLocal++;
						break;
					case "delete-remote":
						deletedRemote++;
						break;
				}
			}

			if (action.operation !== "noop" && result.applied > 0) {
				onActivity?.({
					type: "operation-complete",
					operation: action.operation,
					path: action.path,
					detail:
						action.operation === "conflict" && result.conflicts === 0
							? "Automatically resolved; originals saved in local recovery"
							: action.detail,
				});
			}

			if (result.conflictCopy !== undefined) {
				conflictCopies.push(result.conflictCopy);
			}
		};
		// Keep deletes and conflicts serial. Large attachments stay serial to bound memory.
		let batch: typeof planResult.actions = [];
		const flush = async (): Promise<void> => {
			await mapPool(batch, this.config.transferConcurrency ?? 2, execute);
			batch = [];
		};
		const runTransfers = async (): Promise<void> => {
			for (const action of planResult.actions) {
				const size = Math.max(
					effectiveLocalFiles.get(action.path)?.size ?? 0,
					effectiveRemoteFiles.get(action.path)?.size ?? 0,
				);
				if (
					(action.operation === "upload" || action.operation === "download") &&
					size < 8 * 1024 * 1024
				)
					batch.push(action);
				else {
					await flush();
					await execute(action);
				}
			}
			await flush();
		};

		if (this.config.remote.withMutationSession) {
			await this.config.remote.withMutationSession(runTransfers);
		} else {
			await runTransfers();
		}

		executeMs = Math.round(performance.now() - executeStart);
		const transferMs = Math.round(performance.now() - transferStart);
		if (applied > 0 && options.scanHints === undefined) {
			this.remoteTreeCache = null;
		}

		const scanCounters: ScanCounters = {
			localReads: this.localHashes.reads,
			localReadBytes: this.localHashes.readBytes,
			hashHits: this.localHashes.hashHits,
			hashMisses: this.localHashes.hashMisses,
			equalityComparisons,
			equalityDownloads,
			remoteProbes,
			remoteRefreshes,
			remoteReuses,
			inventoryFiles,
			inventoryDirs,
		};
		const scanDiagnostics: ScanDiagnostics = {
			mode: resolvedPolicy.mode,
			fallbackReason: resolvedPolicy.fallbackReason,
			...scanCounters,
		};
		const provenance: SnapshotProvenance =
			resolvedPolicy.mode === "narrow" ? "narrow" : resolvedPolicy.mode;

		return {
			applied,
			conflicts,
			conflictCopies,
			uploaded,
			downloaded,
			deletedLocal,
			deletedRemote,
			timing: {
				totalMs: Math.round(performance.now() - syncPassStart),
				scanMs,
				planMs,
				transferMs: applied > 0 ? transferMs : 0,
				firstTransferMs,
				eventProbeMs,
				localScanMs,
				baselineMs,
				remoteScanMs,
				equalityMs,
				directoriesMs,
				executeMs,
			},
			provenance,
			scanDiagnostics,
		};
	}

	/**
	 * Resolves equality fingerprints for eligible no-baseline candidates (equal
	 * size/mtime with a validated Filen SHA-512). When feasible, local SHA-256 and
	 * SHA-512 are derived from one stable binary read so the pair always refers to
	 * the same verified bytes. Invalid/missing remote hashes retain the existing
	 * equality fallback (remote download for SHA-256 comparison).
	 */
	private async resolveRemoteFileHashes(
		remoteEntries: Iterable<[string, RemoteEntry]>,
		localFiles: Map<string, LocalEntry>,
		prevRecords: Map<string, SyncedFileRecord>,
	): Promise<{
		resolved: Map<string, string | undefined>;
		comparisons: number;
		downloads: number;
	}> {
		const candidates: Array<{ path: string; entry: RemoteEntry; localEntry: LocalEntry }> = [];
		for (const [path, entry] of remoteEntries) {
			if (entry.isDir) continue;
			const localEntry = localFiles.get(path);
			if (
				localEntry !== undefined &&
				localEntry.size === entry.size &&
				(!prevRecords.has(path) ||
					entry.uuid !== prevRecords.get(path)?.remoteUuid ||
					entry.remoteHash !== prevRecords.get(path)?.remoteHash ||
					entry.mtime !==
						(prevRecords.get(path)?.remoteMtime ?? prevRecords.get(path)?.mtime))
			) {
				candidates.push({ path, entry, localEntry });
			}
		}

		const resolved = new Map<string, string | undefined>();
		let comparisons = 0;
		let downloads = 0;

		for (const { path, entry, localEntry } of candidates) {
			comparisons++;
			const applyFreshLocalHash = (hash?: string, sha512?: string): void => {
				if (hash !== undefined) {
					localEntry.hash = hash;
					localEntry.sha512 = sha512;
				}
			};

			if (entry.remoteHash !== undefined && isValidFilenSha512(entry.remoteHash)) {
				try {
					// Prefer the SHA-512 already derived from the same read as the local
					// SHA-256; otherwise do one fresh read for both fingerprints.
					let fp: { hash?: string; sha512?: string };
					if (localEntry.sha512 !== undefined) {
						fp = { hash: localEntry.hash, sha512: localEntry.sha512 };
					} else {
						const abstractFile = localEntry.adapterOnly
							? localEntry.file
							: this.config.app.vault.getAbstractFileByPath(normalizePath(path));
						if (abstractFile instanceof TFile) {
							const r = await this.localHashes.readBoth(
								abstractFile,
								() => readLocalBytes(this.config.app, localEntry),
								false,
								{ withSha512: true },
							);
							fp = { hash: r.hash, sha512: r.sha512 };
						} else {
							fp = { hash: localEntry.hash, sha512: localEntry.sha512 };
						}
					}
					if (fp.sha512 !== undefined && fp.hash !== undefined) {
						if (fp.sha512.toLowerCase() === entry.remoteHash.toLowerCase()) {
							applyFreshLocalHash(fp.hash, fp.sha512);
							resolved.set(path, fp.hash);
						} else {
							applyFreshLocalHash(fp.hash, fp.sha512);
							resolved.set(path, undefined);
						}
					} else {
						resolved.set(path, undefined);
					}
				} catch {
					// Fall through to remote download fallback
					const remoteBytes = await this.config.remote.readFile(path, entry.uuid);
					downloads++;
					const remoteSha256 = await sha256Hex(remoteBytes);
					const abstractFile = this.config.app.vault.getAbstractFileByPath(
						normalizePath(path),
					);
					let localSha256: string | undefined = localEntry.hash;
					if (abstractFile instanceof TFile) {
						const r = await this.localHashes.readBoth(
							abstractFile,
							() => readLocalBytes(this.config.app, localEntry),
							false,
							{ withSha512: false },
						);
						localSha256 = r.hash ?? localEntry.hash;
						applyFreshLocalHash(localSha256, r.sha512);
					}
					if (localSha256 !== undefined && localSha256 === remoteSha256) {
						resolved.set(path, localSha256);
					} else {
						resolved.set(path, remoteSha256);
					}
				}
				continue;
			}

			// Fallback: download remote file and compute SHA-256 for the comparison
			const remoteBytes = await this.config.remote.readFile(path, entry.uuid);
			downloads++;
			const remoteSha256 = await sha256Hex(remoteBytes);
			const abstractFile = localEntry.adapterOnly
				? localEntry.file
				: this.config.app.vault.getAbstractFileByPath(normalizePath(path));
			let localSha256: string | undefined = localEntry.hash;
			if (abstractFile instanceof TFile) {
				const r = await this.localHashes.readBoth(
					abstractFile,
					() => readLocalBytes(this.config.app, localEntry),
					false,
					{ withSha512: false },
				);
				localSha256 = r.hash ?? localEntry.hash;
				applyFreshLocalHash(localSha256, r.sha512);
			}
			if (localSha256 !== undefined && localSha256 === remoteSha256) {
				resolved.set(path, localSha256);
			} else {
				resolved.set(path, remoteSha256);
			}
		}

		return { resolved, comparisons, downloads };
	}

	private async walkLocal(
		pathFilter: SyncPathFilter,
		verifyContents: boolean,
		baselinePaths: Set<string> | null,
		epoch: number,
		exclusionsTracker?: { ignoredCount: number; tooLargeCount: number; samplePaths: string[] },
	): Promise<LocalScan> {
		const result = await scanLocal(
			this.config.app,
			pathFilter,
			this.localHashes,
			verifyContents,
			baselinePaths,
			this.config.hashingPool,
			exclusionsTracker,
			selectedSettingsPaths(
				this.config.app.vault.configDir,
				this.config.pluginId,
				this.config.settings.syncSettings,
				this.config.settings.selectedSettings,
			),
		);
		this.assertScanEpoch(epoch);
		return result;
	}

	private async walkRemote(
		pathFilter: SyncPathFilter,
		exclusionsTracker?: { ignoredCount: number; tooLargeCount: number; samplePaths: string[] },
		options: { noCreate?: boolean } = {},
	): Promise<RemoteScan> {
		const files = new Map<string, RemoteEntry>();
		const dirs = new Set<string>();
		const remoteEntries = await this.config.remote.walk(options);
		assertNoPathCollisions(remoteEntries.map(({ path, isDir }) => ({ path, isDir })));
		for (const entry of remoteEntries) {
			const exclusion = pathFilter.checkExclusion(entry.path, entry.size);
			if (exclusion !== "included") {
				if (exclusionsTracker) {
					if (exclusion === "too_large") exclusionsTracker.tooLargeCount += 1;
					else exclusionsTracker.ignoredCount += 1;
					if (exclusionsTracker.samplePaths.length < 10) {
						exclusionsTracker.samplePaths.push(entry.path);
					}
				}
				continue;
			}
			if (entry.isDir) {
				dirs.add(entry.path);
			} else {
				files.set(entry.path, entry);
			}
		}
		return { files, dirs };
	}

	/**
	 * Strictly read-only preview of proposed sync operations.
	 * Performs no remote mkdir/upload/delete/rename, no local content writes,
	 * no conflict copies, and no baseline updates.
	 */
	async previewPlan(
		direction: SyncDirection = "both",
		targetInfo: TargetIdentityInfo,
		onProgress?: (progress: SyncProgress) => void,
		bulkThresholds?: BulkGuardThresholds,
	): Promise<SyncPreviewResult> {
		const maxFileSizeBytes = this.config.settings.skipLargeFiles
			? this.config.settings.skipSizeLargerThanMB * 1024 * 1024
			: undefined;

		const pathFilter = createSyncPathFilter({
			configDir: this.config.app.vault.configDir,
			pluginId: this.config.pluginId,
			ignorePatterns: this.config.settings.ignorePatterns,
			maxFileSizeBytes,
			selectedSettings: selectedSettingsPaths(
				this.config.app.vault.configDir,
				this.config.pluginId,
				this.config.settings.syncSettings,
				this.config.settings.selectedSettings,
			),
		});

		const exclusionsTracker = {
			ignoredCount: 0,
			tooLargeCount: 0,
			samplePaths: [] as string[],
		};

		const previewStart = performance.now();
		const scanStart = performance.now();
		onProgress?.({ phase: "scanning-local", current: 0, total: 0, path: "" });

		// Full fresh scans for preview: verify contents and refresh remote metadata.
		this.localHashes.resetCounters();
		const epoch = this.invalidationEpoch;
		const [local, prevRecords] = await Promise.all([
			this.walkLocal(pathFilter, true, null, epoch, exclusionsTracker),
			this.config.db.getAllFiles(),
		]);
		this.assertScanEpoch(epoch);

		onProgress?.({ phase: "scanning-remote", current: 0, total: 0, path: "" });
		// Walk remote without creating folder!
		const remote = await this.walkRemote(pathFilter, exclusionsTracker, { noCreate: true });
		this.assertScanEpoch(epoch);

		const filteredPrev = filterPrevRecords(prevRecords, pathFilter);

		const localFiles = new Map<string, LocalFileInfo>();
		for (const [path, entry] of local.files) {
			localFiles.set(path, {
				path,
				mtime: entry.mtime,
				ctime: entry.ctime,
				size: entry.size,
				hash: entry.hash,
			});
		}

		const equalityHashes = await this.resolveRemoteFileHashes(
			remote.files,
			local.files,
			filteredPrev,
		);
		this.assertScanEpoch(epoch);

		const remoteFiles = new Map<string, RemoteFileInfo>();
		for (const [path, entry] of remote.files) {
			remoteFiles.set(path, {
				path,
				mtime: entry.mtime,
				size: entry.size,
				isDir: entry.isDir,
				uuid: entry.uuid,
				remoteHash: entry.remoteHash,
				hash: equalityHashes.resolved.get(path),
			});
		}

		const scanMs = Math.round(performance.now() - scanStart);
		const planStart = performance.now();
		onProgress?.({ phase: "planning", current: 0, total: 0, path: "" });

		const planResult = planSync({
			localFiles,
			remoteFiles,
			prevRecords: filteredPrev,
			direction,
		});

		const bulkReport = checkBulkGuard(
			planResult.actions,
			{
				totalLocalFiles: local.files.size,
				totalRemoteFiles: remote.files.size,
				totalBaselineFiles: filteredPrev.size,
			},
			bulkThresholds,
		);
		const planMs = Math.round(performance.now() - planStart);
		const totalMs = Math.round(performance.now() - previewStart);

		const totalProposed = planResult.actions.filter((a) => a.operation !== "noop").length;

		return {
			target: targetInfo,
			direction,
			createdAt: Date.now(),
			actions: planResult.actions,
			counts: {
				...planResult.counts,
				totalProposed,
			},
			destructiveStats: bulkReport.stats,
			safetyReport: bulkReport,
			exclusions: {
				ignoredCount: exclusionsTracker.ignoredCount,
				tooLargeCount: exclusionsTracker.tooLargeCount,
				totalExcluded: exclusionsTracker.ignoredCount + exclusionsTracker.tooLargeCount,
				samplePaths: exclusionsTracker.samplePaths,
			},
			timing: {
				totalMs,
				scanMs,
				planMs,
			},
			provenance: "full",
			scanDiagnostics: {
				mode: "full",
				fallbackReason: "initial-sync",
				localReads: this.localHashes.reads,
				localReadBytes: this.localHashes.readBytes,
				hashHits: this.localHashes.hashHits,
				hashMisses: this.localHashes.hashMisses,
				equalityComparisons: equalityHashes.comparisons,
				equalityDownloads: equalityHashes.downloads,
				remoteProbes: 0,
				remoteRefreshes: 1,
				remoteReuses: 0,
				inventoryFiles: local.files.size,
				inventoryDirs: local.dirs.size,
			},
		};
	}
}

const filterPrevRecords = (
	records: Map<string, SyncedFileRecord>,
	pathFilter: SyncPathFilter,
): Map<string, SyncedFileRecord> => {
	const filtered = new Map<string, SyncedFileRecord>();
	for (const [path, record] of records) {
		if (!pathFilter.isIgnored(path, record.size)) filtered.set(path, record);
	}
	return filtered;
};
