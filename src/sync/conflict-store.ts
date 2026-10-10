import type { App } from "obsidian";
import type { SyncDb } from "../db";
import type { RemoteEntry, RemoteFs } from "../fs-remote";
import type { ConflictRecord, ConflictSnapshot, RemoteIdentity } from "./conflict-types";
import { sha256Hex, sha512Hex, isValidFilenSha512 } from "./content-hash";
import { preserveRecovery, readRecovery } from "./recovery";
import { validateSyncPath } from "./path-validation";

export type ConflictContext = {
	app: App;
	db: SyncDb;
	remote: RemoteFs;
	pluginId: string;
	selectedSettings?: string[];
	verifyTarget?: () => Promise<void>;
};
export type LiveSide = {
	bytes?: Uint8Array;
	hash?: string;
	mtime: number;
	ctime: number;
	identity?: RemoteIdentity;
};
export const remoteIdentity = (entry: RemoteEntry): RemoteIdentity => {
	if (!entry.uuid) throw new Error("Remote identity unavailable. Refresh the sync.");
	return {
		uuid: entry.uuid,
		mtime: entry.mtime,
		size: entry.size,
		remoteHash: entry.remoteHash,
		version: entry.version,
	};
};
export function sameIdentity(a?: RemoteIdentity, b?: RemoteIdentity): boolean {
	return (
		a?.uuid === b?.uuid &&
		a?.remoteHash === b?.remoteHash &&
		a?.mtime === b?.mtime &&
		a?.size === b?.size &&
		a?.version === b?.version
	);
}
export async function readLocalSide(context: ConflictContext, path: string): Promise<LiveSide> {
	validateSyncPath(path);
	const adapter = context.app.vault.adapter;
	const before = await adapter.stat(path);
	if (!before) return { mtime: 0, ctime: 0 };
	if (before.type !== "file") throw new Error("Conflict path is no longer a file.");
	const bytes = new Uint8Array(await adapter.readBinary(path));
	const after = await adapter.stat(path);
	if (
		!after ||
		after.type !== "file" ||
		before.mtime !== after.mtime ||
		before.size !== after.size ||
		bytes.length !== after.size
	)
		throw new Error("Local file changed while loading. Refresh the review.");
	return { bytes, hash: await sha256Hex(bytes), mtime: after.mtime, ctime: after.ctime };
}
export async function readRemoteSide(context: ConflictContext, path: string): Promise<LiveSide> {
	if (!context.remote.stat) throw new Error("Verified remote inspection is unavailable.");
	const before = await context.remote.stat(path);
	if (!before) return { mtime: 0, ctime: 0 };
	if (before.isDir) throw new Error("Remote conflict path is no longer a file.");
	const identity = remoteIdentity(before);
	const bytes = await context.remote.readFile(path, identity.uuid);
	const after = await context.remote.stat(path);
	if (
		!after ||
		!sameIdentity(identity, remoteIdentity(after)) ||
		bytes.length !== before.size ||
		(isValidFilenSha512(before.remoteHash) &&
			(await sha512Hex(bytes)) !== before.remoteHash.toLowerCase())
	)
		throw new Error("Filen file changed while loading. Refresh the review.");
	return {
		bytes,
		hash: await sha256Hex(bytes),
		mtime: before.mtime,
		ctime: before.mtime,
		identity,
	};
}
export function matchesSnapshot(
	live: LiveSide,
	snapshot: ConflictSnapshot,
	remote = false,
): boolean {
	return (
		live.hash === snapshot.recovery?.hash &&
		(!remote || sameIdentity(live.identity, snapshot.identity))
	);
}
export async function verifiedBase(
	context: ConflictContext,
	path: string,
): Promise<string | undefined> {
	const stored = await context.db.getMergeBaseline?.(path);
	const previous = await context.db.getFile(path);
	if (
		stored &&
		stored.hash === previous?.hash &&
		(await sha256Hex(new TextEncoder().encode(stored.text))) === stored.hash
	)
		return stored.text;
	return undefined;
}
export async function captureConflict(
	context: ConflictContext,
	path: string,
	reason: string,
	expected?: { local?: { hash?: string; mtime: number; size: number }; remote?: RemoteEntry },
): Promise<{ record: ConflictRecord; changed: boolean }> {
	if (
		!context.db.getConflict ||
		!context.db.setConflict ||
		!context.db.deleteConflict ||
		!context.db.targetKey
	)
		throw new Error(
			"Persistent conflict storage is unavailable. Sync paused to protect originals.",
		);
	const existing = await context.db.getConflict(path);
	const local = await readLocalSide(context, path);
	const remote = await readRemoteSide(context, path);
	if (
		expected &&
		((expected.local
			? local.bytes === undefined ||
				local.mtime !== expected.local.mtime ||
				local.bytes.length !== expected.local.size ||
				(expected.local.hash !== undefined && local.hash !== expected.local.hash)
			: local.bytes !== undefined) ||
			!sameIdentity(
				remote.identity,
				expected.remote ? remoteIdentity(expected.remote) : undefined,
			))
	)
		throw new Error(`File changed before conflict review: ${path}. Replan the sync.`);
	if (
		existing &&
		!existing.approval &&
		matchesSnapshot(local, existing.local) &&
		matchesSnapshot(remote, existing.remote, true)
	)
		return { record: existing, changed: false };
	const snapshot = async (
		side: LiveSide,
		old: ConflictSnapshot | undefined,
		source: string,
	): Promise<ConflictSnapshot> => ({
		mtime: side.mtime,
		ctime: side.ctime,
		identity: side.identity,
		recovery:
			side.bytes === undefined
				? undefined
				: old?.recovery && old.recovery.hash === side.hash
					? old.recovery
					: await preserveRecovery(
							context.app,
							context.db,
							context.pluginId,
							path,
							side.bytes,
							source,
						),
	});
	const base = await verifiedBase(context, path);
	const record: ConflictRecord = {
		path,
		revision: globalThis.crypto.randomUUID(),
		reason,
		createdAt: Date.now(),
		kind:
			existing?.kind ??
			(context.selectedSettings?.includes(path)
				? "settings"
				: path.toLowerCase().endsWith(".md")
					? "markdown"
					: "file"),
		local: await snapshot(local, existing?.local, "Conflict: local"),
		remote: await snapshot(remote, existing?.remote, "Conflict: Filen"),
		base:
			existing?.base ??
			(base === undefined
				? undefined
				: await preserveRecovery(
						context.app,
						context.db,
						context.pluginId,
						path,
						new TextEncoder().encode(base),
						"Conflict: last synced",
					)),
		copies: existing?.copies,
	};
	// Recheck bytes before publishing the revision, including absence states.
	if (
		!matchesSnapshot(await readLocalSide(context, path), record.local) ||
		!matchesSnapshot(await readRemoteSide(context, path), record.remote, true)
	)
		throw new Error("Files changed while saving conflict. Replan the sync.");
	await context.db.setConflict(record);
	return { record, changed: true };
}
export async function conflictVersions(
	context: ConflictContext,
	record: ConflictRecord,
): Promise<{
	base?: Uint8Array;
	local?: Uint8Array;
	remote?: Uint8Array;
	approved?: Uint8Array;
}> {
	const read = (recovery?: ConflictSnapshot["recovery"]) =>
		recovery ? readRecovery(context.app, context.db, recovery) : undefined;
	return {
		base: await read(record.base),
		local: await read(record.local.recovery),
		remote: await read(record.remote.recovery),
		approved: await read(record.approval?.result ?? undefined),
	};
}
