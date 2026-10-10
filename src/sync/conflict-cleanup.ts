import type { ConflictContext, LiveSide } from "./conflict-store";
import { readLocalSide, readRemoteSide, matchesSnapshot } from "./conflict-store";
import {
	ConflictReviewRequiredError,
	type ConflictRecord,
	type ConflictSnapshot,
} from "./conflict-types";
import { getOriginalPathFromConflictPath, isConflictFilePath } from "./conflict-utils";
import { preserveRecovery } from "./recovery";

/** Discover copies once when opening review, not on every background sync. */
async function copyPaths(context: ConflictContext, path: string): Promise<string[]> {
	const remote = await context.remote.walk({ noCreate: true });
	return [
		...new Set([
			...(context.app.vault.getFiles?.() ?? []).map((file) => file.path),
			...remote.filter((entry) => !entry.isDir).map((entry) => entry.path),
		]),
	]
		.filter(
			(candidate) =>
				isConflictFilePath(candidate) &&
				getOriginalPathFromConflictPath(candidate) === path,
		)
		.sort();
}
export async function collectConflictCopies(
	context: ConflictContext,
	record: ConflictRecord,
): Promise<ConflictRecord> {
	if (record.approval) return record;
	const paths = await copyPaths(context, record.path);
	const copies: NonNullable<ConflictRecord["copies"]> = [];
	let changed = record.copies === undefined || paths.length !== record.copies.length;
	for (const path of paths) {
		const old = record.copies?.find((copy) => copy.path === path);
		const local = await readLocalSide(context, path),
			remote = await readRemoteSide(context, path);
		if (
			!old ||
			!matchesSnapshot(local, old.local) ||
			!matchesSnapshot(remote, old.remote, true)
		)
			changed = true;
		const snapshot = async (
			side: LiveSide,
			previous?: ConflictSnapshot,
		): Promise<ConflictSnapshot> => ({
			mtime: side.mtime,
			ctime: side.ctime,
			identity: side.identity,
			recovery:
				side.bytes === undefined
					? undefined
					: previous?.recovery && previous.recovery.hash === side.hash
						? previous.recovery
						: await preserveRecovery(
								context.app,
								context.db,
								context.pluginId,
								record.path,
								side.bytes,
								`Conflict copy: ${path}`,
							),
		});
		copies.push({
			path,
			local: await snapshot(local, old?.local),
			remote: await snapshot(remote, old?.remote),
		});
	}
	if (!changed) return record;
	const next = { ...record, revision: globalThis.crypto.randomUUID(), copies };
	await context.db.setConflict?.(next);
	return next;
}

/** Validate the complete reviewed set before deleting any copy. */
export async function verifyConflictCopies(
	context: ConflictContext,
	record: ConflictRecord,
	allowMissing = false,
): Promise<void> {
	const paths = await copyPaths(context, record.path);
	if (paths.some((path) => !record.copies?.some((copy) => copy.path === path)))
		throw new ConflictReviewRequiredError(
			"New conflict copies appeared. Refresh and review them before cleanup.",
		);
	for (const copy of record.copies ?? []) {
		const local = await readLocalSide(context, copy.path),
			remote = await readRemoteSide(context, copy.path);
		if (
			(!matchesSnapshot(local, copy.local) && !(allowMissing && local.bytes === undefined)) ||
			(!matchesSnapshot(remote, copy.remote, true) &&
				!(allowMissing && remote.bytes === undefined))
		)
			throw new ConflictReviewRequiredError(
				"A conflict copy changed. Refresh and review it before cleanup.",
			);
	}
}
export async function cleanupConflictCopies(
	context: ConflictContext,
	record: ConflictRecord,
): Promise<void> {
	await verifyConflictCopies(context, record, true);
	for (const copy of record.copies ?? []) {
		const remote = await readRemoteSide(context, copy.path);
		await context.verifyTarget?.();
		if (remote.identity) {
			if (!matchesSnapshot(remote, copy.remote, true))
				throw new ConflictReviewRequiredError(
					"A Filen conflict copy changed; cleanup paused.",
				);
			await context.remote.rm(copy.path, remote.identity.uuid, remote.identity);
		}
		const local = await readLocalSide(context, copy.path);
		if (local.bytes !== undefined) {
			if (!matchesSnapshot(local, copy.local))
				throw new ConflictReviewRequiredError(
					"A local conflict copy changed; cleanup paused.",
				);
			await context.app.vault.adapter.trashLocal(copy.path);
		}
		await context.db.deleteFile(copy.path);
	}
	if ((await copyPaths(context, record.path)).length)
		throw new ConflictReviewRequiredError(
			"Conflict copies remain. Refresh the review to finish cleanup.",
		);
}
