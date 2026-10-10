import type { ConflictContext, LiveSide } from "./conflict-store";
import {
	captureConflict,
	readLocalSide,
	readRemoteSide,
	matchesSnapshot,
	conflictVersions,
} from "./conflict-store";
import {
	ConflictReviewRequiredError,
	type ConflictRecord,
	type ConflictResolution,
} from "./conflict-types";
import { preserveRecovery } from "./recovery";
import { decodeText, validSettings } from "./merge";
import { sha256Hex } from "./content-hash";
import { verifyConflictCopies, cleanupConflictCopies } from "./conflict-cleanup";

function assertSelected(context: ConflictContext, record: ConflictRecord): void {
	if (record.kind === "settings" && !context.selectedSettings?.includes(record.path))
		throw new Error("Select this settings file for sync before applying its review.");
}
const hashOf = (record: ConflictRecord): string | undefined => record.approval?.result?.hash;
function acceptable(live: LiveSide, record: ConflictRecord, side: "local" | "remote"): boolean {
	return (
		matchesSnapshot(live, record[side], side === "remote") ||
		(record.approval !== undefined && live.hash === hashOf(record))
	);
}

/** Explicit approval or crash recovery. Originals and approval remain durable on every failure. */
export async function applyConflict(
	context: ConflictContext,
	resolution: ConflictResolution,
): Promise<void> {
	await context.verifyTarget?.();
	const record = await context.db.getConflict?.(resolution.path);
	if (!record || record.revision !== resolution.revision)
		throw new Error("Review changed. Refresh before applying.");
	assertSelected(context, record);
	if (
		resolution.bytes !== null &&
		record.kind === "settings" &&
		!validSettings(decodeText(resolution.bytes) ?? "")
	)
		throw new Error("The result must be a valid JSON settings object.");
	if (!context.db.setConflict || !context.db.deleteConflict)
		throw new Error("Conflict storage is unavailable.");
	let local = await readLocalSide(context, record.path);
	let remote = await readRemoteSide(context, record.path);
	if (!record.approval) {
		if (
			!matchesSnapshot(local, record.local) ||
			!matchesSnapshot(remote, record.remote, true)
		) {
			await captureConflict(context, record.path, "Reviewed files changed");
			throw new Error("Reviewed files changed. Refresh and review the new versions.");
		}
		if (record.copies) await verifyConflictCopies(context, record);
		record.approval = {
			result:
				resolution.bytes === null
					? null
					: await preserveRecovery(
							context.app,
							context.db,
							context.pluginId,
							record.path,
							resolution.bytes,
							"Approved conflict result",
						),
		};
		await context.db.setConflict(record);
	} else {
		const selectedHash =
			resolution.bytes === null ? undefined : await sha256Hex(resolution.bytes);
		if (selectedHash !== hashOf(record))
			throw new Error(
				"An interrupted application must finish or be refreshed before choosing another result.",
			);
	}
	const versions = await conflictVersions(context, record);
	const bytes = record.approval.result === null ? null : versions.approved!;
	if (!acceptable(local, record, "local") || !acceptable(remote, record, "remote")) {
		await captureConflict(
			context,
			record.path,
			"Files changed during an interrupted application",
		);
		throw new Error("Files changed. Refresh and review the new versions.");
	}
	const mtime = Math.max(record.local.mtime, record.remote.mtime, Date.now());
	if (remote.hash !== hashOf(record)) {
		// Recheck the local file immediately before mutating Filen.
		local = await readLocalSide(context, record.path);
		if (!acceptable(local, record, "local"))
			throw new Error("Local file changed; review remains pending.");
		if (bytes === null) {
			await context.verifyTarget?.();
			if (remote.identity)
				await context.remote.rm(record.path, remote.identity.uuid, remote.identity);
		} else {
			await context.remote.writeFile(
				record.path,
				bytes,
				mtime,
				record.local.ctime || mtime,
				remote.identity?.uuid,
				undefined,
				{
					identity: remote.identity,
					contentHash: remote.hash,
					beforeCommit: async () => {
						await context.verifyTarget?.();
						if (!acceptable(await readLocalSide(context, record.path), record, "local"))
							throw new Error(
								"Local file changed before upload commit; review remains pending.",
							);
					},
				},
			);
		}
	}
	remote = await readRemoteSide(context, record.path);
	if (remote.hash !== hashOf(record))
		throw new Error("Filen result changed; review remains pending.");
	record.approval.remoteApplied = true;
	await context.db.setConflict(record);
	await context.verifyTarget?.();
	local = await readLocalSide(context, record.path);
	if (!acceptable(local, record, "local"))
		throw new Error("Local file changed; review remains pending.");
	if (local.hash !== hashOf(record)) {
		if (bytes === null) await context.app.vault.adapter.trashLocal(record.path);
		else {
			let parent = "";
			for (const part of record.path.split("/").slice(0, -1)) {
				parent = parent ? `${parent}/${part}` : part;
				if (!(await context.app.vault.adapter.exists(parent)))
					await context.app.vault.adapter.mkdir(parent);
			}
			await context.app.vault.adapter.writeBinary(record.path, bytes.slice().buffer, {
				mtime,
				ctime: record.local.ctime || mtime,
			});
		}
	}
	local = await readLocalSide(context, record.path);
	remote = await readRemoteSide(context, record.path);
	if (local.hash !== hashOf(record) || remote.hash !== hashOf(record))
		throw new Error("Saved result changed; review remains pending.");
	record.approval.localApplied = true;
	await context.db.setConflict(record);
	if (bytes === null) await context.db.deleteFile(record.path);
	else {
		await context.db.setFile(record.path, {
			path: record.path,
			hash: local.hash,
			size: bytes.length,
			mtime: local.mtime,
			ctime: local.ctime,
			remoteUuid: remote.identity?.uuid,
			remoteHash: remote.identity?.remoteHash,
			remoteMtime: remote.mtime,
			lastSyncAt: Date.now(),
			lastKnownSide: "both",
		});
		if (record.kind !== "file") {
			const text = decodeText(bytes);
			if (text !== undefined)
				await context.db.setMergeBaseline?.(record.path, {
					text,
					hash: local.hash!,
					savedAt: Date.now(),
				});
		}
	}
	if (record.copies) await cleanupConflictCopies(context, record);
	await context.verifyTarget?.();
	if (
		(await readLocalSide(context, record.path)).hash !== hashOf(record) ||
		(await readRemoteSide(context, record.path)).hash !== hashOf(record)
	)
		throw new Error("Resolved file changed during cleanup; review remains pending.");
	await context.db.deleteConflict(record.path);
}

export async function resumeConflict(
	context: ConflictContext,
	record: ConflictRecord,
): Promise<boolean> {
	if (!record.approval) return false;
	const local = await readLocalSide(context, record.path),
		remote = await readRemoteSide(context, record.path);
	if (!acceptable(local, record, "local") || !acceptable(remote, record, "remote")) return false;
	const versions = await conflictVersions(context, record);
	try {
		await applyConflict(context, {
			path: record.path,
			revision: record.revision,
			bytes: record.approval.result === null ? null : versions.approved!,
		});
	} catch (error) {
		if (error instanceof ConflictReviewRequiredError) return false;
		throw error;
	}
	return true;
}
