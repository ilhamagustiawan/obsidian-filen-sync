import { LocalEditPendingError } from "./sync/local-edit-pending";
import { scanLocal } from "./sync/local-scanner";
import { normalizePath, TFile, TFolder } from "obsidian";
import type { RemoteEntry } from "./fs-remote";
import type { SyncPathFilter } from "./path-filters";
import type { SyncedFileRecord } from "./settings";
import { checkBulkGuard, type BulkGuardReport, type BulkGuardThresholds } from "./sync/bulk-guard";
import type { ExecutionResult, LocalEntry } from "./sync/executor";
import { assertNoPathCollisions } from "./sync/path-validation";
import { planSync } from "./sync/planner";
import { filterDirectoryBaseline, planDirectories, type DirectoryPass } from "./sync/dir-planner";
import { LocalHashCache } from "./sync/local-hash-cache";
import { confirmPlannedChanges, runApplyPass } from "./sync/apply-pass";
import {
	LOCAL_SCAN_SNAPSHOT_TTL_MS,
	REMOTE_TREE_CACHE_TTL_MS,
	type ExclusionsTracker,
	type LocalScan,
	type LocalScanSnapshot,
	type RemoteScan,
	type RemoteTreeCache,
	type ScanPolicy,
	type SyncEngineConfig,
	type SyncRunOptions,
} from "./sync/engine-types";
import { resolveEqualityHashes, type EqualityHashResult } from "./sync/equality-hashes";
import { deriveScanPolicy } from "./sync/scan-policy";
import {
	createEnginePathFilter,
	filterPrevRecords,
	selectedEngineSettingsPaths,
	toLocalFileInfos,
	toRemoteFileInfos,
	walkRemoteTree,
} from "./sync/scan-inputs";
import type {
	ConflictCopy,
	LocalFileInfo,
	RemoteFileInfo,
	ScanCounters,
	ScanDiagnostics,
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
export {
	createDefaultHashingPool,
	HASH_POOL_DEFAULT_CONFIG,
	HASH_POOL_ENABLED,
	LOCAL_SCAN_SNAPSHOT_TTL_MS,
	REMOTE_TREE_CACHE_TTL_MS,
} from "./sync/engine-types";
export type { SyncRunOptions } from "./sync/engine-types";

/** Planner inputs and scan evidence gathered by one narrow or full scan. */
type PlannedPass = {
	planResult: ReturnType<typeof planSync>;
	bulkReport: ReturnType<typeof checkBulkGuard>;
	localFiles: Map<string, LocalEntry>;
	remoteFiles: Map<string, RemoteEntry>;
	prev: Map<string, SyncedFileRecord>;
	directories?: DirectoryPass;
	equalityComparisons: number;
	equalityDownloads: number;
	remoteRefreshes: number;
	remoteReuses: number;
	inventoryFiles: number;
	inventoryDirs: number;
	scanMs: number;
	planMs: number;
	localScanMs: number;
	baselineMs: number;
	remoteScanMs: number;
	equalityMs: number;
};

/** Remote-side facts the full scan needs from the event probe. */
type RemoteReadPlan = {
	canFastPoll: boolean;
	refreshRemote: boolean;
	eventProbeAvailable: boolean;
	probeHasChanges: boolean;
	remoteCacheValid: boolean;
	newWatermark: number;
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

		const pathFilter = createEnginePathFilter(this.config);

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
					!(error instanceof LocalEditPendingError) &&
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

		const resolvedPolicy: ScanPolicy = deriveScanPolicy({
			syncSettings: this.config.settings.syncSettings,
			options,
			replanAttempts,
			snapshotValid: localSnapshotValid,
			cacheValid: remoteCacheValid,
			probeHasChanges,
			probeFailed,
			probeStatus,
			hasValidFileHints,
		});

		const remoteProbes = canFastPoll && !refreshRemote ? 1 : 0;

		const syncPassStart = performance.now();
		const scanStart = performance.now();
		const epoch = this.invalidationEpoch;

		const pass = resolvedPolicy.narrow
			? await this.scanNarrow(
					pathFilter,
					direction,
					options.scanHints!,
					bulkThresholds,
					onProgress,
					scanStart,
					epoch,
				)
			: await this.scanFull(
					pathFilter,
					direction,
					verifyContents,
					{
						canFastPoll,
						refreshRemote,
						eventProbeAvailable,
						probeHasChanges,
						remoteCacheValid,
						newWatermark,
					},
					bulkThresholds,
					onProgress,
					scanStart,
					epoch,
				);

		const cancelled = await confirmPlannedChanges(
			[...pass.planResult.actions, ...(pass.directories?.actions ?? [])],
			pass.bulkReport,
			onProgress,
			confirmLocalDeletes,
			confirmBulkOperations,
		);
		if (cancelled) return cancelled;

		const applyResult = await runApplyPass({
			config: this.config,
			actions: pass.planResult.actions,
			localFiles: pass.localFiles,
			remoteFiles: pass.remoteFiles,
			prevRecords: pass.prev,
			directories: pass.directories,
			syncPassStart,
			onProgress,
			onActivity,
			onApplied: (result) => this.patchSnapshots(result),
			onCopiesCleaned: () => {
				this.localScanSnapshot = null;
				this.remoteTreeCache = null;
			},
			onDirectoriesChanged: () => {
				this.localScanSnapshot = null;
				this.remoteTreeCache = null;
			},
		});
		const { applied } = applyResult;
		if (applied > 0 && options.scanHints === undefined) {
			this.remoteTreeCache = null;
		}

		const scanCounters: ScanCounters = {
			localReads: this.localHashes.reads,
			localReadBytes: this.localHashes.readBytes,
			hashHits: this.localHashes.hashHits,
			hashMisses: this.localHashes.hashMisses,
			equalityComparisons: pass.equalityComparisons,
			equalityDownloads: pass.equalityDownloads,
			remoteProbes,
			remoteRefreshes: pass.remoteRefreshes,
			remoteReuses: pass.remoteReuses,
			inventoryFiles: pass.inventoryFiles,
			inventoryDirs: pass.inventoryDirs,
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
			conflicts: applyResult.conflicts,
			conflictCopies: applyResult.conflictCopies,
			pendingConflicts: applyResult.pendingConflicts,
			newConflicts: applyResult.newConflicts,
			uploaded: applyResult.uploaded,
			downloaded: applyResult.downloaded,
			deletedLocal: applyResult.deletedLocal,
			deletedRemote: applyResult.deletedRemote,
			timing: {
				totalMs: Math.round(performance.now() - syncPassStart),
				scanMs: pass.scanMs,
				planMs: pass.planMs,
				transferMs: applied > 0 ? applyResult.transferMs : 0,
				firstTransferMs: applyResult.firstTransferMs,
				eventProbeMs,
				localScanMs: pass.localScanMs,
				baselineMs: pass.baselineMs,
				remoteScanMs: pass.remoteScanMs,
				equalityMs: pass.equalityMs,
				directoriesMs: applyResult.directoriesMs,
				executeMs: applyResult.executeMs,
			},
			provenance,
			scanDiagnostics,
		};
	}

	/** Narrow edit pass: re-reads only hinted and conflicted paths against cached inventories. */
	private async scanNarrow(
		pathFilter: SyncPathFilter,
		direction: SyncDirection,
		scanHints: string[],
		bulkThresholds: BulkGuardThresholds | undefined,
		onProgress: ((progress: SyncProgress) => void) | undefined,
		scanStart: number,
		epoch: number,
	): Promise<PlannedPass> {
		onProgress?.({ phase: "scanning-local", current: 0, total: 0, path: "" });
		const candidatePaths = new Set([
			...scanHints,
			...((await this.config.db.getConflicts?.()) ?? new Map()).keys(),
		]);
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

		const scanMs = Math.round(performance.now() - scanStart);
		const planStart = performance.now();
		onProgress?.({ phase: "planning", current: 0, total: 0, path: "" });
		const localFiles: Map<string, LocalFileInfo> = toLocalFileInfos(candidateLocalFiles);

		const planResult = planSync({
			pendingConflicts: new Set(
				((await this.config.db.getConflicts?.()) ?? new Map()).keys(),
			),
			localFiles,
			remoteFiles: candidateRemoteFiles,
			prevRecords: candidatePrev,
			direction,
		});

		const bulkReport = checkBulkGuard(
			planResult.actions,
			{
				totalLocalFiles: this.localScanSnapshot!.scan.files.size,
				totalRemoteFiles: this.remoteTreeCache!.scan.files.size,
				totalBaselineFiles: this.localScanSnapshot!.scan.files.size,
			},
			bulkThresholds,
		);
		const planMs = Math.round(performance.now() - planStart);

		return {
			planResult,
			bulkReport,
			localFiles: candidateLocalFiles,
			remoteFiles: this.remoteTreeCache!.scan.files,
			prev: candidatePrev,
			equalityComparisons: candidateEqualityHashes.comparisons,
			equalityDownloads: candidateEqualityHashes.downloads,
			remoteRefreshes: 0,
			remoteReuses: 0,
			inventoryFiles: candidateLocalFiles.size,
			inventoryDirs: this.localScanSnapshot?.scan.dirs.size ?? 0,
			scanMs,
			planMs,
			localScanMs: scanMs,
			baselineMs: 0,
			remoteScanMs: 0,
			equalityMs: 0,
		};
	}

	/** Full or reconcile pass: reads baseline, local and remote inventories concurrently. */
	private async scanFull(
		pathFilter: SyncPathFilter,
		direction: SyncDirection,
		verifyContents: boolean,
		remotePlan: RemoteReadPlan,
		bulkThresholds: BulkGuardThresholds | undefined,
		onProgress: ((progress: SyncProgress) => void) | undefined,
		scanStart: number,
		epoch: number,
	): Promise<PlannedPass> {
		let baselineMs = 0;
		let localScanMs = 0;
		let remoteScanMs = 0;
		let remoteFromCache = false;
		let remoteRefreshes = 0;
		let remoteReuses = 0;

		onProgress?.({ phase: "scanning-local", current: 0, total: 0, path: "" });

		const baselineRead = (async () => {
			const start = performance.now();
			const records = await this.config.db.getAllFiles();
			baselineMs = Math.round(performance.now() - start);
			return filterPrevRecords(records, pathFilter);
		})();
		const localRead = (async () => {
			// Routine scans need baseline paths to defer new-file hashing to equality
			// resolution. Explicit verification can start immediately. walkLocal keeps
			// the existing byte-bounded hashing pool in both cases.
			const baselinePaths = verifyContents ? null : new Set((await baselineRead).keys());
			this.assertScanEpoch(epoch);
			const start = performance.now();
			const local = await this.walkLocal(pathFilter, verifyContents, baselinePaths, epoch);
			localScanMs = Math.round(performance.now() - start);
			// If the remote read is still running, show the remaining scan phase.
			onProgress?.({ phase: "scanning-remote", current: 0, total: 0, path: "" });
			return local;
		})();
		const remoteRead = (async (): Promise<RemoteTreeCache> => {
			const start = performance.now();
			if (
				remotePlan.canFastPoll &&
				!remotePlan.refreshRemote &&
				remotePlan.eventProbeAvailable &&
				!remotePlan.probeHasChanges &&
				remotePlan.remoteCacheValid &&
				this.remoteTreeCache !== null
			) {
				remoteFromCache = true;
				remoteReuses = 1;
				remoteScanMs = Math.round(performance.now() - start);
				return this.remoteTreeCache;
			}
			const fetchStartedAt = Date.now();
			// sync() already creates the root before this concurrent read phase.
			const scan = await this.walkRemote(pathFilter, undefined, { noCreate: true });
			remoteRefreshes = 1;
			remoteScanMs = Math.round(performance.now() - start);
			return {
				fetchedAt: Date.now(),
				eventWatermark: Math.max(remotePlan.newWatermark, fetchStartedAt),
				scan,
			};
		})();
		// Drain every read before rejecting so failed passes cannot leave hashing
		// or remote work running into a retry. Never publish partial inventories.
		const [baselineResult, localResult, remoteResult, dirBaselineResult] =
			await Promise.allSettled([
				baselineRead,
				localRead,
				remoteRead,
				this.readDirectoryBaseline(),
			]);
		if (baselineResult.status === "rejected") throw baselineResult.reason;
		if (localResult.status === "rejected") throw localResult.reason;
		if (remoteResult.status === "rejected") throw remoteResult.reason;
		if (dirBaselineResult.status === "rejected") throw dirBaselineResult.reason;
		this.assertScanEpoch(epoch);
		const filteredPrev = baselineResult.value;
		const local = localResult.value;
		const remote = remoteResult.value.scan;

		const equalityStart = performance.now();
		const equalityHashes = await this.resolveRemoteFileHashes(
			remote.files,
			local.files,
			filteredPrev,
		);
		const equalityMs = Math.round(performance.now() - equalityStart);
		this.assertScanEpoch(epoch);

		// Build planner inputs after equality resolution so no-baseline files use
		// the same-bytes fingerprints derived during equality checking.
		const localFiles = toLocalFileInfos(local.files);
		const remoteFiles = toRemoteFileInfos(remote.files, equalityHashes.resolved);

		// Publish snapshots only after successful scanning, then prune cache.
		this.remoteTreeCache = remoteResult.value;
		this.localScanSnapshot = {
			fetchedAt: Date.now(),
			scan: { files: new Map(local.files), dirs: new Set(local.dirs) },
		};
		this.localHashes.prune(new Set(local.files.keys()));

		const scanMs = Math.round(performance.now() - scanStart);
		const planStart = performance.now();
		onProgress?.({ phase: "planning", current: 0, total: 0, path: "" });
		const planResult = planSync({
			pendingConflicts: new Set(
				((await this.config.db.getConflicts?.()) ?? new Map()).keys(),
			),
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

		return {
			planResult,
			bulkReport,
			localFiles: local.files,
			remoteFiles: remote.files,
			prev: filteredPrev,
			directories: this.planDirectoryPass(
				local.dirs,
				remote.dirs,
				dirBaselineResult.value,
				pathFilter,
				direction,
				remoteFromCache,
			),
			equalityComparisons: equalityHashes.comparisons,
			equalityDownloads: equalityHashes.downloads,
			remoteRefreshes,
			remoteReuses,
			inventoryFiles: local.files.size,
			inventoryDirs: local.dirs.size,
			scanMs,
			planMs,
			localScanMs,
			baselineMs,
			remoteScanMs,
			equalityMs,
		};
	}

	private async readDirectoryBaseline(): Promise<Set<string> | null> {
		return (await this.config.db.getSyncedDirs?.()) ?? null;
	}

	private planDirectoryPass(
		local: Set<string>,
		remote: Set<string>,
		stored: Set<string> | null,
		pathFilter: SyncPathFilter,
		direction: SyncDirection,
		remoteFromCache: boolean,
	): DirectoryPass {
		const baseline = filterDirectoryBaseline(stored, (path) => pathFilter.isIgnored(path));
		const actions = planDirectories({ local, remote, baseline, direction, remoteFromCache });
		return { local, remote, stored, baseline, actions };
	}

	/** See resolveEqualityHashes; kept as a method so tests can observe equality reads. */
	private async resolveRemoteFileHashes(
		remoteEntries: Iterable<[string, RemoteEntry]>,
		localFiles: Map<string, LocalEntry>,
		prevRecords: Map<string, SyncedFileRecord>,
	): Promise<EqualityHashResult> {
		return resolveEqualityHashes(
			this.config.app,
			this.config.remote,
			this.localHashes,
			remoteEntries,
			localFiles,
			prevRecords,
		);
	}

	private async walkLocal(
		pathFilter: SyncPathFilter,
		verifyContents: boolean,
		baselinePaths: Set<string> | null,
		epoch: number,
		exclusionsTracker?: ExclusionsTracker,
	): Promise<LocalScan> {
		const result = await scanLocal(
			this.config.app,
			pathFilter,
			this.localHashes,
			verifyContents,
			baselinePaths,
			this.config.hashingPool,
			exclusionsTracker,
			selectedEngineSettingsPaths(this.config),
		);
		this.assertScanEpoch(epoch);
		return result;
	}

	private async walkRemote(
		pathFilter: SyncPathFilter,
		exclusionsTracker?: ExclusionsTracker,
		options: { noCreate?: boolean } = {},
	): Promise<RemoteScan> {
		return walkRemoteTree(this.config.remote, pathFilter, exclusionsTracker, options);
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
		const pathFilter = createEnginePathFilter(this.config);

		const exclusionsTracker: ExclusionsTracker = {
			ignoredCount: 0,
			tooLargeCount: 0,
			samplePaths: [],
		};

		const previewStart = performance.now();
		const scanStart = performance.now();
		onProgress?.({ phase: "scanning-local", current: 0, total: 0, path: "" });

		// Full fresh scans for preview: verify contents and refresh remote metadata.
		this.localHashes.resetCounters();
		const epoch = this.invalidationEpoch;
		// Preview has no baseline dependency and must remain strictly read-only.
		// Drain failed reads just as sync does, so a subsequent run cannot overlap
		// unfinished hashing or remote work from this preview.
		const [localResult, baselineResult, remoteResult, dirBaselineResult] =
			await Promise.allSettled([
				(async () => {
					const local = await this.walkLocal(
						pathFilter,
						true,
						null,
						epoch,
						exclusionsTracker,
					);
					onProgress?.({ phase: "scanning-remote", current: 0, total: 0, path: "" });
					return local;
				})(),
				(async () => this.config.db.getAllFiles())(),
				this.walkRemote(pathFilter, exclusionsTracker, { noCreate: true }),
				this.readDirectoryBaseline(),
			]);
		if (localResult.status === "rejected") throw localResult.reason;
		if (baselineResult.status === "rejected") throw baselineResult.reason;
		if (remoteResult.status === "rejected") throw remoteResult.reason;
		if (dirBaselineResult.status === "rejected") throw dirBaselineResult.reason;
		this.assertScanEpoch(epoch);
		const local = localResult.value;
		const prevRecords = baselineResult.value;
		const remote = remoteResult.value;

		const filteredPrev = filterPrevRecords(prevRecords, pathFilter);

		const localFiles = toLocalFileInfos(local.files);

		const equalityHashes = await this.resolveRemoteFileHashes(
			remote.files,
			local.files,
			filteredPrev,
		);
		this.assertScanEpoch(epoch);

		const remoteFiles = toRemoteFileInfos(remote.files, equalityHashes.resolved);

		const scanMs = Math.round(performance.now() - scanStart);
		const planStart = performance.now();
		onProgress?.({ phase: "planning", current: 0, total: 0, path: "" });

		const planResult = planSync({
			pendingConflicts: new Set(
				((await this.config.db.getConflicts?.()) ?? new Map()).keys(),
			),
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
		const directoryActions = this.planDirectoryPass(
			local.dirs,
			remote.dirs,
			dirBaselineResult.value,
			pathFilter,
			direction,
			false,
		).actions;
		const actions = [...planResult.actions, ...directoryActions];
		const counts = { ...planResult.counts };
		for (const action of directoryActions) {
			if (action.operation === "upload") counts.upload += 1;
			else if (action.operation === "download") counts.download += 1;
			else if (action.operation === "delete-local") counts.deleteLocal += 1;
			else if (action.operation === "delete-remote") counts.deleteRemote += 1;
		}
		const planMs = Math.round(performance.now() - planStart);
		const totalMs = Math.round(performance.now() - previewStart);

		const totalProposed = actions.filter((a) => a.operation !== "noop").length;

		return {
			target: targetInfo,
			direction,
			createdAt: Date.now(),
			actions,
			counts: {
				...counts,
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
