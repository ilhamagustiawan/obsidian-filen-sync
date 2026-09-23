import type { App } from "obsidian";
import { TFile, TFolder } from "obsidian";
import type { SyncDb } from "./db";
import type { RemoteEntry, RemoteFs } from "./fs-remote";
import { createSyncPathFilter, type SyncPathFilter } from "./path-filters";
import type { SyncedFileRecord } from "./settings";
import { checkBulkGuard, type BulkGuardReport, type BulkGuardThresholds } from "./sync/bulk-guard";
import { sha256Hex, SyncExecutor, type LocalEntry } from "./sync/executor";
import { assertNoPathCollisions } from "./sync/path-validation";
import { planSync } from "./sync/planner";
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

type RemoteTreeCache = {
	fetchedAt: number;
	eventWatermark: number;
	scan: RemoteScan;
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

	constructor(private readonly config: SyncEngineConfig) {}

	close(): void {
		this.config.remote.close();
		this.remoteTreeCache = null;
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
		options: { isManual?: boolean } = {},
	): Promise<SyncOutcome> {
		await this.config.remote.mkdir("");
		onActivity?.({ type: "connected" });

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
				);
			} catch (error) {
				this.remoteTreeCache = null;
				if (
					replanAttempts < maxReplanAttempts &&
					error instanceof Error &&
					error.message.includes("Replan the sync")
				) {
					replanAttempts += 1;
					onActivity?.({
						type: "accepted",
						operation: "noop",
						path: "Changes detected during sync; running fresh pass...",
					});
					continue;
				}
				throw error;
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
		options: { isManual?: boolean } = {},
	): Promise<SyncOutcome> {
		const [local, prevRecords] = await Promise.all([
			this.walkLocal(pathFilter),
			this.config.db.getAllFiles(),
		]);

		// Fast remote polling: probe Filen's events feed after local scan.
		// Safety rails:
		// 1. A failed probe never trusts silence — falls back to full scan.
		// 2. Manual Sync now runs always scan in full.
		// 3. A cache older than 30 minutes is always refreshed.
		// 4. While cached tree is in use, remote-folder cleanup (pruning) is skipped entirely.
		const isManual = options.isManual ?? false;
		const canFastPoll =
			this.config.settings.fastRemotePolling &&
			!isManual &&
			typeof this.config.remote.checkEvents === "function";

		let remote: RemoteScan;
		let remoteFromCache = false;
		let probeHasChanges = true;
		let newWatermark = Date.now();

		if (canFastPoll) {
			const currentWatermark = this.remoteTreeCache?.eventWatermark ?? 0;
			try {
				const probe = await this.config.remote.checkEvents!(currentWatermark);
				probeHasChanges = probe.hasChanges;
				newWatermark = probe.newWatermarkMs;
			} catch {
				// Rail 1: failed probe falls back to full scan
				probeHasChanges = true;
			}
		}

		const cacheAge =
			this.remoteTreeCache !== null ? Date.now() - this.remoteTreeCache.fetchedAt : Infinity;
		const cacheValid = this.remoteTreeCache !== null && cacheAge < REMOTE_TREE_CACHE_TTL_MS;

		if (canFastPoll && !probeHasChanges && cacheValid && this.remoteTreeCache !== null) {
			remote = this.remoteTreeCache.scan;
			remoteFromCache = true;
			onActivity?.({
				type: "accepted",
				operation: "noop",
				path: `Fast polling: using cached remote tree (${Math.round(cacheAge / 60000)}m old)`,
			});
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

		// Convert to pure planner structures
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

		// 1. Pure Plan Pass
		const planResult = planSync({
			localFiles,
			remoteFiles,
			prevRecords: filteredPrev,
			direction,
		});

		// 2. Safety Bulk Guard Check
		const bulkReport = checkBulkGuard(
			planResult.actions,
			{
				totalLocalFiles: local.files.size,
				totalRemoteFiles: remote.files.size,
				totalBaselineFiles: filteredPrev.size,
			},
			bulkThresholds,
		);

		if (bulkReport.blocked) {
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
		const total = planResult.actions.length;

		// Safety rail 4: skip remote folder cleanup/pruning while cached tree is in use
		applied += await executor.syncDirectories(local.dirs, remote.dirs, {
			skipRemoteFolderPrune: remoteFromCache,
		});

		for (const [index, action] of planResult.actions.entries()) {
			onProgress?.({ current: index + 1, total, path: action.path });

			if (action.operation !== "noop") {
				onActivity?.({
					type: "operation-planned",
					operation: action.operation,
					path: action.path,
					detail: action.detail,
				});
				onActivity?.({
					type: "operation-start",
					operation: action.operation,
					path: action.path,
					detail: action.detail,
				});
			}

			const result = await executor.execute(
				action,
				local.files.get(action.path),
				remote.files.get(action.path),
				filteredPrev.get(action.path),
			);

			applied += result.applied;
			conflicts += result.conflicts;
			if (result.applied > 0) {
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
				onActivity?.({
					type: "accepted",
					operation: action.operation,
					path: action.path,
				});
			}

			if (result.conflictCopy !== undefined) {
				conflictCopies.push(result.conflictCopy);
			}
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

	private async walkLocal(pathFilter: SyncPathFilter): Promise<LocalScan> {
		const files = new Map<string, LocalEntry>();
		const dirs = new Set<string>();
		for (const file of this.config.app.vault.getAllLoadedFiles()) {
			if (file.path.length === 0) continue;
			if (file instanceof TFile) {
				if (pathFilter.isIgnored(file.path, file.stat.size)) continue;
				const content = await this.config.app.vault.readBinary(file);
				const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
				files.set(file.path, {
					path: file.path,
					mtime: file.stat.mtime,
					ctime: file.stat.ctime,
					size: file.stat.size,
					hash: await sha256Hex(bytes),
					file,
				});
			} else if (file instanceof TFolder) {
				if (pathFilter.isIgnored(file.path)) continue;
				dirs.add(file.path);
			}
		}
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
