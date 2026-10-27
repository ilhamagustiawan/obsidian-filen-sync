import type { App, TFile } from "obsidian";
import type { SyncDb } from "../db";
import type { FilenRemoteFs, RemoteEntry } from "../fs-remote";
import type { SyncedFileRecord } from "../settings";
import { sha256Hex } from "./content-hash";

export type ForceUploadDeps = {
	app: App;
	/** Read lazily: the target can be refreshed while the upload is in flight. */
	db: () => SyncDb | null;
	remote: FilenRemoteFs;
	/** Ask before overwriting a remote copy that changed since the last sync. */
	confirmOverwrite: (file: TFile) => Promise<boolean>;
	onUploading: () => void;
};

export type ForceUploadResult = { kind: "uploaded" } | { kind: "cancelled" };

/**
 * Stricter than the planner's change check on purpose: a force upload bypasses
 * planning, so any identity or metadata drift from the baseline needs consent.
 */
export function isRemoteChangedSinceBaseline(
	remoteEntry: RemoteEntry | null | undefined,
	baseline: SyncedFileRecord | null | undefined,
): boolean {
	if (remoteEntry === undefined || remoteEntry === null) return false;
	if (!baseline) return true;
	return (
		baseline.remoteUuid === undefined ||
		remoteEntry.uuid !== baseline.remoteUuid ||
		(remoteEntry.remoteHash !== undefined &&
			baseline.remoteHash !== undefined &&
			remoteEntry.remoteHash !== baseline.remoteHash) ||
		remoteEntry.mtime !== baseline.mtime ||
		remoteEntry.size !== baseline.size
	);
}

/** Upload one local file directly, bypassing the planner, and record its baseline. */
export async function forceUploadFile(
	file: TFile,
	deps: ForceUploadDeps,
): Promise<ForceUploadResult> {
	const { app, remote } = deps;
	if (await deps.db()?.getConflict?.(file.path))
		throw new Error("This file is paused for conflict review. Review it before uploading.");
	const baselineDb = deps.db();
	const baseline = baselineDb ? await baselineDb.getFile(file.path) : null;
	const remoteEntry = await remote.stat(file.path);

	if (isRemoteChangedSinceBaseline(remoteEntry, baseline)) {
		if (!(await deps.confirmOverwrite(file))) return { kind: "cancelled" };
	}

	deps.onUploading();
	const expectedMtime = file.stat.mtime;
	const expectedSize = file.stat.size;
	const content = await app.vault.readBinary(file);
	const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
	const localHash = await sha256Hex(bytes);
	if (file.stat.mtime !== expectedMtime || file.stat.size !== expectedSize) {
		throw new Error("Local file changed while it was being read. Run a fresh sync.");
	}

	const uploadedRemote = await remote.writeFile(
		file.path,
		bytes,
		expectedMtime,
		file.stat.ctime,
		remoteEntry?.uuid,
	);
	if (file.stat.mtime !== expectedMtime || file.stat.size !== expectedSize) {
		throw new Error("Local file changed during upload. Run a fresh sync.");
	}

	const db = deps.db();
	if (db) {
		await db.setFile(file.path, {
			path: file.path,
			mtime: expectedMtime,
			ctime: file.stat.ctime,
			size: bytes.byteLength,
			hash: localHash,
			remoteUuid: uploadedRemote.uuid,
			remoteHash: uploadedRemote.remoteHash,
			lastSyncAt: Date.now(),
			lastKnownSide: "local",
		});
	}
	return { kind: "uploaded" };
}
