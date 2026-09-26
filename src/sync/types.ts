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

export type PlannedAction = {
	path: string;
	operation: SyncOperation;
	detail: string;
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
