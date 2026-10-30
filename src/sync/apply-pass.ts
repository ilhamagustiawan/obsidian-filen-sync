import type { RemoteEntry } from "../fs-remote";
import type { SyncedFileRecord } from "../settings";
import type { BulkGuardReport } from "./bulk-guard";
import { nextDirectoryBaseline, type DirectoryOutcome, type DirectoryPass } from "./dir-planner";
import { createDirectories, pruneDirectories } from "./directory-apply";
import type { SyncEngineConfig } from "./engine-types";
import { SyncExecutor, type ExecutionResult, type LocalEntry } from "./executor";
import { LocalEditPendingError } from "./local-edit-pending";
import type { planSync } from "./planner";
import { mapPool } from "./pool";
import { selectedEngineSettingsPaths } from "./scan-inputs";
import type { ConflictCopy, SyncActivityEvent, SyncOutcome, SyncProgress } from "./types";

type PlannedAction = ReturnType<typeof planSync>["actions"][number];

/** Files at or above this size transfer serially to bound memory. */
const PARALLEL_TRANSFER_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Runs the bulk-guard and local-delete confirmations. Returns a cancelled
 * outcome when the plan must not be applied, otherwise null.
 */
export async function confirmPlannedChanges(
	actions: PlannedAction[],
	bulkReport: BulkGuardReport,
	onProgress?: (progress: SyncProgress) => void,
	confirmLocalDeletes?: (paths: string[]) => Promise<boolean>,
	confirmBulkOperations?: (report: BulkGuardReport) => Promise<boolean>,
): Promise<SyncOutcome | null> {
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
	const deleteLocalPaths = actions
		.filter((a) => a.operation === "delete-local")
		.map((a) => (a.isDir ? `${a.path}/` : a.path));

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
	return null;
}

export type ApplyPassInput = {
	config: SyncEngineConfig;
	actions: PlannedAction[];
	localFiles: Map<string, LocalEntry>;
	remoteFiles: Map<string, RemoteEntry>;
	prevRecords: Map<string, SyncedFileRecord>;
	/** Directory reconciliation only runs on full inventories. */
	directories?: DirectoryPass;
	syncPassStart: number;
	onProgress?: (progress: SyncProgress) => void;
	onActivity?: (event: SyncActivityEvent) => void;
	/** Called for each action that applied changes, to patch scan snapshots. */
	onApplied: (result: ExecutionResult) => void;
	/** Called when conflict-copy cleanup invalidated the scan snapshots. */
	onCopiesCleaned: () => void;
	/** Called when folders were created or deleted, invalidating the scan snapshots. */
	onDirectoriesChanged: () => void;
};

export type ApplyPassResult = {
	applied: number;
	conflicts: number;
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	conflictCopies: ConflictCopy[];
	pendingConflicts: string[];
	newConflicts: string[];
	firstTransferMs?: number;
	directoriesMs: number;
	executeMs: number;
	transferMs: number;
};

/** 4. Safe apply pass: executes actions with revalidation and per-file baseline updates. */
export async function runApplyPass(input: ApplyPassInput): Promise<ApplyPassResult> {
	const { config, actions, onProgress, onActivity } = input;
	const executor = new SyncExecutor({
		app: config.app,
		db: config.db,
		deviceId: config.settings.deviceId,
		remote: config.remote,
		pluginId: config.pluginId,
		verifyTarget: config.verifyTarget,
		conflictResolution: config.settings.conflictResolution,
		selectedSettings: selectedEngineSettingsPaths(config),
	});

	let applied = 0;
	let conflicts = 0;
	let uploaded = 0;
	let downloaded = 0;
	let deletedLocal = 0;
	let deletedRemote = 0;
	let directoriesMs = 0;
	const conflictCopies: ConflictCopy[] = [];
	const pendingConflicts: string[] = [];
	const newConflicts: string[] = [];
	const cleanedCopies = new Set<string>();
	const total = actions.filter((action) => action.operation !== "noop").length;
	let completed = 0;
	let pendingLocalEdit: LocalEditPendingError | undefined;
	const executeStart = performance.now();

	const dirOutcomes = new Map<string, DirectoryOutcome>();
	const dirContext = {
		app: config.app,
		remote: config.remote,
		outcomes: dirOutcomes,
		onActivity,
	};
	if (input.directories !== undefined) {
		onProgress?.({ phase: "directories", current: 0, total: 0, path: "" });
		const dirsStart = performance.now();
		applied += await createDirectories(dirContext, input.directories.actions);
		directoriesMs = Math.round(performance.now() - dirsStart);
	}

	let firstTransferMs: number | undefined;
	const transferStart = performance.now();

	const execute = async (action: PlannedAction): Promise<void> => {
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
		if (cleanedCopies.has(action.path)) {
			if (action.operation !== "noop") completed++;
			report();
			return;
		}

		let result: ExecutionResult;
		try {
			result = await executor.execute(
				action,
				input.localFiles.get(action.path),
				input.remoteFiles.get(action.path),
				input.prevRecords.get(action.path),
				report,
			);
		} catch (error) {
			if (!(error instanceof LocalEditPendingError)) throw error;
			// Do not let an actively edited note starve unrelated transfers.
			// Keep it uncompleted and ask the coordinator to retry after idle.
			pendingLocalEdit = error;
			return;
		}
		for (const path of result.cleanedCopies ?? []) cleanedCopies.add(path);
		if (result.cleanedCopies?.length) input.onCopiesCleaned();

		if (action.operation !== "noop") {
			if (result.applied === 0 && !result.reviewPending)
				throw new Error(`File changed before applying ${action.path}. Replan the sync.`);
			completed++;
			if (firstTransferMs === undefined) {
				firstTransferMs = Math.round(performance.now() - input.syncPassStart);
			}
			report();
		}
		if (result.reviewPending) {
			pendingConflicts.push(result.reviewPending);
			if (result.newConflict) newConflicts.push(result.reviewPending);
		}
		applied += result.applied;
		conflicts += result.conflicts;
		if (result.applied > 0) {
			input.onApplied(result);
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
	let batch: PlannedAction[] = [];
	const flush = async (): Promise<void> => {
		await mapPool(batch, config.transferConcurrency ?? 2, execute);
		batch = [];
	};
	const runTransfers = async (): Promise<void> => {
		for (const action of actions) {
			const size = Math.max(
				input.localFiles.get(action.path)?.size ?? 0,
				input.remoteFiles.get(action.path)?.size ?? 0,
			);
			if (
				(action.operation === "upload" || action.operation === "download") &&
				size < PARALLEL_TRANSFER_MAX_BYTES
			)
				batch.push(action);
			else {
				await flush();
				await execute(action);
			}
		}
		await flush();
	};

	// Folder deletions run after transfers so emptied folders can be pruned.
	const runAll = async (): Promise<void> => {
		await runTransfers();
		if (input.directories === undefined) return;
		onProgress?.({ phase: "directories", current: 0, total: 0, path: "" });
		const pruneStart = performance.now();
		const pruned = await pruneDirectories(dirContext, input.directories.actions);
		applied += pruned.applied;
		deletedLocal += pruned.deletedLocal;
		deletedRemote += pruned.deletedRemote;
		directoriesMs += Math.round(performance.now() - pruneStart);
	};

	if (config.remote.withMutationSession) {
		await config.remote.withMutationSession(runAll);
	} else {
		await runAll();
	}
	if (input.directories !== undefined) {
		const dirs = input.directories;
		const next = nextDirectoryBaseline(
			dirs.baseline,
			dirs.local,
			dirs.remote,
			dirs.actions,
			dirOutcomes,
		);
		for (const path of dirs.stored ?? []) if (!dirs.baseline?.has(path)) next.add(path);
		if (dirs.stored === null || !sameSet(next, dirs.stored))
			await config.db.setSyncedDirs?.(next);
		if ([...dirOutcomes.values()].includes("applied")) input.onDirectoriesChanged();
	}
	if (pendingLocalEdit) throw pendingLocalEdit;

	const executeMs = Math.round(performance.now() - executeStart);
	const transferMs = Math.round(performance.now() - transferStart);

	return {
		applied,
		conflicts,
		uploaded,
		downloaded,
		deletedLocal,
		deletedRemote,
		conflictCopies,
		pendingConflicts,
		newConflicts,
		firstTransferMs,
		directoriesMs,
		executeMs,
		transferMs,
	};
}

const sameSet = (left: Set<string>, right: Set<string>): boolean =>
	left.size === right.size && [...left].every((path) => right.has(path));
