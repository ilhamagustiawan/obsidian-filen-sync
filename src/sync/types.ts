import type { SyncedFileRecord } from "../settings";

export type SyncDirection = "both" | "push" | "pull";

export type SyncOperation =
	| "upload"
	| "download"
	| "delete-local"
	| "delete-remote"
	| "conflict"
	| "noop";

export type LocalFileInfo = {
	path: string;
	mtime: number;
	ctime: number;
	size: number;
	hash?: string;
};

export type RemoteFileInfo = {
	path: string;
	mtime: number;
	size: number;
	isDir: boolean;
	uuid?: string;
	remoteHash?: string;
	hash?: string;
};

export type ActionReasonCode =
	| "missing_both"
	| "delete_modify_local_survivor"
	| "delete_modify_remote_survivor"
	| "remote_deleted_push_reupload"
	| "remote_deleted_delete_local"
	| "new_local_pull_skip"
	| "new_local_upload"
	| "local_deleted_pull_download"
	| "local_deleted_delete_remote"
	| "new_remote_push_skip"
	| "new_remote_download"
	| "file_unavailable"
	| "identical_content"
	| "first_sync_identical"
	| "first_sync_conflict_no_baseline"
	| "first_sync_push_overwrite"
	| "first_sync_pull_overwrite"
	| "first_sync_conflict_newer"
	| "both_unchanged"
	| "local_changed_pull_skip"
	| "local_changed_upload"
	| "remote_changed_push_skip"
	| "remote_changed_download"
	| "both_changed_push_overwrite"
	| "both_changed_pull_overwrite"
	| "both_changed_conflict";

export type PlannedAction = {
	path: string;
	operation: SyncOperation;
	detail: string;
	reasonCode?: ActionReasonCode | string;
	destinationSide?: "local" | "remote";
	destinationExists?: boolean;
	isOverwrite?: boolean;
	preservesSurvivor?: boolean;
	hash?: string;
	conflictWinner?: "local" | "remote";
	isDir?: boolean;
};

export type ConflictCopy = {
	originalPath: string;
	copyPath: string;
};

export type SyncTimingSummary = {
	totalMs: number;
	scanMs?: number;
	planMs?: number;
	transferMs?: number;
	firstTransferMs?: number;
};

export type SyncOutcome = {
	applied: number;
	conflicts: number;
	conflictCopies: ConflictCopy[];
	uploaded?: number;
	downloaded?: number;
	deletedLocal?: number;
	deletedRemote?: number;
	cancelled?: boolean;
	cancelReason?: string;
	timing?: SyncTimingSummary;
};

export type SyncProgress = {
	current: number;
	total: number;
	path: string;
	phase?:
		| "scanning-local"
		| "scanning-remote"
		| "planning"
		| "directories"
		| "confirming"
		| "transferring";
	operation?: Exclude<SyncOperation, "noop">;
	completedBytes?: number;
	totalBytes?: number;
};

export type SyncActivityEvent =
	| { type: "connected" }
	| { type: "diagnostic"; message: string }
	| { type: "operation-planned"; operation: SyncOperation; path: string; detail: string }
	| { type: "operation-start"; operation: SyncOperation; path: string; detail: string }
	| { type: "operation-complete"; operation: SyncOperation; path: string; detail: string }
	| { type: "accepted"; operation: SyncOperation; path: string };

export type { SyncedFileRecord };
