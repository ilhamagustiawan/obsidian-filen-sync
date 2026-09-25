import type { App } from "obsidian";
import { normalizePath, TFile, TFolder } from "obsidian";
import type { SyncDb } from "./db";
import type { RemoteEntry, RemoteFs } from "./fs-remote";
import { createSyncPathFilter, type SyncPathFilter } from "./path-filters";
import type { SyncedFileRecord } from "./settings";
import { checkBulkGuard, type BulkGuardReport, type BulkGuardThresholds } from "./sync/bulk-guard";
import { sha256Hex, SyncExecutor, type ExecutionResult, type LocalEntry } from "./sync/executor";
import { assertNoPathCollisions } from "./sync/path-validation";
import { planSync } from "./sync/planner";
import { LocalHashCache } from "./sync/local-hash-cache";
import { mapPool } from "./sync/pool";
import type {
	ConflictCopy,
	LocalFileInfo,
	RemoteFileInfo,
	SyncActivityEvent,
	SyncDirection,
	SyncOperation,
	SyncOutcome,
	SyncProgress,
} from "./sync/types";

export type {
	BulkGuardReport,
	ConflictCopy,
	SyncActivityEvent,
	SyncDirection,
	SyncOperation,
	SyncOutcome,
	SyncProgress,
};

export const REMOTE_TREE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const LOCAL_SCAN_SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
	};
	remote: RemoteFs;
	transferConcurrency?: 1 | 2;
};

type LocalScan = {
	files: Map<string, LocalEntry>;
	dirs: Set<string>;
};

type RemoteScan = {
	files: Map<string, RemoteEntry>;
	dirs: Set<string>;
};

export class SyncEngine {
	private remoteTreeCache: RemoteTreeCache | null = null;
	private localScanSnapshot: LocalScanSnapshot | null = null;
	private localHashes = new LocalHashCache();

	invalidateLocal(path: string): void {
		this.localHashes.invalidate(path);
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
		options: {
			isManual?: boolean;
			initialSync?: boolean;
			fullScan?: boolean;
			scanHints?: string[];
		} = {},
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

	private async executeSyncPass(
		pathFilter: SyncPathFilter,
		direction: SyncDirection,
		onProgress?: (progress: SyncProgress) => void,
		confirmLocalDeletes?: (paths: string[]) => Promise<boolean>,
		onActivity?: (event: SyncActivityEvent) => void,
		confirmBulkOperations?: (report: BulkGuardReport) => Promise<boolean>,
		bulkThresholds?: BulkGuardThresholds,
		options: {
			isManual?: boolean;
			initialSync?: boolean;
			fullScan?: boolean;
			scanHints?: string[];
		} = {},
		replanAttempts = 0,
	): Promise<SyncOutcome> {
		const forceScan =
			options.isManual === true || options.initialSync === true || options.fullScan === true;

		const localSnapshotValid =
			this.localScanSnapshot !== null &&
			Date.now() - this.localScanSnapshot.fetchedAt < LOCAL_SCAN_SNAPSHOT_TTL_MS;

		const remoteCacheValid =
			this.remoteTreeCache !== null &&
			Date.now() - this.remoteTreeCache.fetchedAt < REMOTE_TREE_CACHE_TTL_MS;

		const canFastPoll =
			this.config.settings.fastRemotePolling &&
			!forceScan &&
			this.config.remote.checkEvents !== undefined;

		let probeHasChanges = true;
		let newWatermark = Date.now();

		if (canFastPoll && this.config.remote.checkEvents !== undefined) {
			const currentWatermark = this.remoteTreeCache?.eventWatermark ?? 0;
			try {
				const probe = await this.config.remote.checkEvents(currentWatermark);
				probeHasChanges = probe.hasChanges;
				newWatermark = probe.newWatermarkMs;
			} catch {
				probeHasChanges = true;
			}
		}

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

		const isNarrow =
			!forceScan &&
			replanAttempts === 0 &&
			localSnapshotValid &&
			remoteCacheValid &&
			!probeHasChanges &&
			hasValidFileHints;

		let planResult: ReturnType<typeof planSync>;
		let bulkReport: ReturnType<typeof checkBulkGuard>;
		let effectiveLocalFiles: Map<string, LocalEntry>;
		let effectiveRemoteFiles: Map<string, RemoteEntry>;
		let effectivePrev: Map<string, SyncedFileRecord>;
		let localDirs = new Set<string>();
		let remoteDirs = new Set<string>();
		let remoteFromCache = false;

		if (isNarrow) {
			onProgress?.({ phase: "scanning-local", current: 0, total: 0, path: "" });
			const candidatePaths = new Set(options.scanHints!);
			const candidateLocalFiles = new Map<string, LocalEntry>();
			for (const path of candidatePaths) {
				const file = this.config.app.vault.getAbstractFileByPath(normalizePath(path));
				if (file instanceof TFile) {
					if (pathFilter.isIgnored(file.path, file.stat.size)) continue;
					const hash = await this.localHashes.read(
						file,
						() => this.config.app.vault.readBinary(file),
						false,
					);
					candidateLocalFiles.set(file.path, {
						path: file.path,
						mtime: file.stat.mtime,
						ctime: file.stat.ctime,
						size: file.stat.size,
						hash,
						file,
					});
				}
			}

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
			const candidateRemoteFiles = new Map<string, RemoteFileInfo>();
			for (const path of candidatePaths) {
				const entry = this.remoteTreeCache!.scan.files.get(path);
				if (entry !== undefined && !entry.isDir) {
					if (pathFilter.isIgnored(entry.path, entry.size)) continue;
					let hash: string | undefined;
					const localEntry = candidateLocalFiles.get(path);
					if (
						localEntry !== undefined &&
						!candidatePrev.has(path) &&
						localEntry.size === entry.size &&
						localEntry.mtime === entry.mtime
					) {
						const remoteBytes = await this.config.remote.readFile(path, entry.uuid);
						hash = await sha256Hex(remoteBytes);
					}
					candidateRemoteFiles.set(path, {
						path: entry.path,
						mtime: entry.mtime,
						size: entry.size,
						isDir: false,
						uuid: entry.uuid,
						remoteHash: entry.remoteHash,
						hash,
					});
				}
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

			effectiveLocalFiles = candidateLocalFiles;
			effectiveRemoteFiles = this.remoteTreeCache!.scan.files;
			effectivePrev = candidatePrev;
		} else {
			onProgress?.({ phase: "scanning-local", current: 0, total: 0, path: "" });
			const [local, prevRecords] = await Promise.all([
				this.walkLocal(pathFilter, forceScan),
				this.config.db.getAllFiles(),
			]);
			this.localScanSnapshot = {
				fetchedAt: Date.now(),
				scan: { files: new Map(local.files), dirs: new Set(local.dirs) },
			};

			onProgress?.({ phase: "scanning-remote", current: 0, total: 0, path: "" });
			let remote: RemoteScan;

			if (
				canFastPoll &&
				!probeHasChanges &&
				remoteCacheValid &&
				this.remoteTreeCache !== null
			) {
				remote = this.remoteTreeCache.scan;
				remoteFromCache = true;
			} else {
				const fetchStartedAt = Date.now();
				remote = await this.walkRemote(pathFilter);
				this.remoteTreeCache = {
					fetchedAt: Date.now(),
					eventWatermark: Math.max(newWatermark, fetchStartedAt),
					scan: remote,
				};
			}

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

			const remoteFiles = new Map<string, RemoteFileInfo>();
			for (const [path, entry] of remote.files) {
				const localEntry = local.files.get(path);
				let hash: string | undefined;
				if (
					localEntry !== undefined &&
					!filteredPrev.has(path) &&
					localEntry.size === entry.size &&
					localEntry.mtime === entry.mtime
				) {
					const remoteBytes = await this.config.remote.readFile(path, entry.uuid);
					hash = await sha256Hex(remoteBytes);
				}
				remoteFiles.set(path, {
					path,
					mtime: entry.mtime,
					size: entry.size,
					isDir: entry.isDir,
					uuid: entry.uuid,
					remoteHash: entry.remoteHash,
					hash,
				});
			}

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

			effectiveLocalFiles = local.files;
			effectiveRemoteFiles = remote.files;
			effectivePrev = filteredPrev;
			localDirs = local.dirs;
			remoteDirs = remote.dirs;
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

		if (!isNarrow) {
			onProgress?.({ phase: "directories", current: 0, total: 0, path: "" });
			applied += await executor.syncDirectories(localDirs, remoteDirs, {
				skipRemoteFolderPrune: remoteFromCache,
			});
		}

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
					detail: action.detail,
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
		if (applied > 0 && options.scanHints === undefined) {
			this.remoteTreeCache = null;
		}

		return {
			applied,
			conflicts,
			conflictCopies,
			uploaded,
			downloaded,
			deletedLocal,
			deletedRemote,
		};
	}

	private async walkLocal(pathFilter: SyncPathFilter, forceScan: boolean): Promise<LocalScan> {
		const files = new Map<string, LocalEntry>();
		const dirs = new Set<string>();
		for (const file of this.config.app.vault.getAllLoadedFiles()) {
			if (file.path.length === 0) continue;
			if (file instanceof TFile) {
				if (pathFilter.isIgnored(file.path, file.stat.size)) continue;
				const hash = await this.localHashes.read(
					file,
					() => this.config.app.vault.readBinary(file),
					forceScan,
				);
				files.set(file.path, {
					path: file.path,
					mtime: file.stat.mtime,
					ctime: file.stat.ctime,
					size: file.stat.size,
					hash,
					file,
				});
			} else if (file instanceof TFolder) {
				if (pathFilter.isIgnored(file.path)) continue;
				dirs.add(file.path);
			}
		}
		this.localHashes.prune(new Set(files.keys()));
		assertNoPathCollisions([
			...[...files.keys()].map((path) => ({ path, isDir: false })),
			...[...dirs].map((path) => ({ path, isDir: true })),
		]);
		return { files, dirs };
	}

	private async walkRemote(pathFilter: SyncPathFilter): Promise<RemoteScan> {
		const files = new Map<string, RemoteEntry>();
		const dirs = new Set<string>();
		const remoteEntries = await this.config.remote.walk();
		assertNoPathCollisions(remoteEntries.map(({ path, isDir }) => ({ path, isDir })));
		for (const entry of remoteEntries) {
			if (pathFilter.isIgnored(entry.path, entry.size)) continue;
			if (entry.isDir) {
				dirs.add(entry.path);
			} else {
				files.set(entry.path, entry);
			}
		}
		return { files, dirs };
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
