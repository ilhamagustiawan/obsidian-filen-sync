import type { RecoveryRecord } from "../db";

export type RemoteIdentity = {
	uuid: string;
	mtime: number;
	size: number;
	remoteHash?: string;
	version?: number;
};
export type ConflictSnapshot = {
	/** No recovery means the file was absent, never an unreadable file. */
	recovery?: RecoveryRecord;
	mtime: number;
	ctime: number;
	identity?: RemoteIdentity;
};
export type ConflictRecord = {
	path: string;
	revision: string;
	reason: string;
	kind: "markdown" | "settings" | "file";
	createdAt: number;
	local: ConflictSnapshot;
	remote: ConflictSnapshot;
	base?: RecoveryRecord;
	/** Legacy copies reviewed alongside the live originals, then trashed on both sides. */
	copies?: Array<{ path: string; local: ConflictSnapshot; remote: ConflictSnapshot }>;
	/** Persisted before the first write; null means an approved deletion. */
	approval?: { result: RecoveryRecord | null; remoteApplied?: boolean; localApplied?: boolean };
};
export type ConflictResolution = { path: string; revision: string; bytes: Uint8Array | null };

export class ConflictReviewRequiredError extends Error {}
