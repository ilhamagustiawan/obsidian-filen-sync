import type { ConflictRecord, ConflictResolution } from "./conflict-types";
import {
	captureConflict,
	readLocalSide,
	readRemoteSide,
	type ConflictContext,
} from "./conflict-store";
import { applyConflict } from "./conflict-apply";
import { sha256Hex } from "./content-hash";
import { collectConflictCopies } from "./conflict-cleanup";

/** Re-captures a pending conflict so review always shows the live sides. */
export async function loadConflictForReview(
	context: ConflictContext,
	path: string,
): Promise<ConflictRecord> {
	const record = await context.db.getConflict?.(path);
	if (!record) throw new Error("This conflict was already resolved.");
	if (record.kind === "settings" && !context.selectedSettings?.includes(path))
		throw new Error("Select this settings file for sync before reviewing it.");
	if (record.approval && !record.approval.localApplied) return record;
	const refreshed = (await captureConflict(context, path, record.reason)).record;
	return collectConflictCopies(context, refreshed);
}

export async function applyConflictResolution(
	context: ConflictContext,
	resolution: ConflictResolution,
): Promise<void> {
	const apply = () => applyConflict(context, resolution);
	if (context.remote.withMutationSession) await context.remote.withMutationSession(apply);
	else await apply();
}

/**
 * Verifies that a legacy `(conflict)` copy review still matches the live
 * files, captures it as a managed conflict, and returns the reviewed record.
 */
export async function captureReviewedLegacyConflict(
	context: ConflictContext,
	path: string,
	hash: string,
	copies: Array<{ path: string; hash: string }>,
): Promise<ConflictRecord> {
	for (const copy of copies) {
		if (
			(await sha256Hex(
				new Uint8Array(await context.app.vault.adapter.readBinary(copy.path)),
			)) !== copy.hash
		)
			throw new Error("A legacy copy changed. Refresh the review.");
	}
	if ((await readLocalSide(context, path)).hash !== hash)
		throw new Error("Local file changed. Refresh the review.");
	const remote = await readRemoteSide(context, path);
	const captured = await captureConflict(context, path, "Legacy conflict review");
	if (remote.hash !== hash)
		throw new Error(
			"Filen differs from the reviewed current file. Reopen this conflict to review both originals.",
		);
	const reviewed = await collectConflictCopies(context, captured.record);
	if (
		reviewed.copies?.some(
			(copy) =>
				!copies.some(
					(known) =>
						known.path === copy.path &&
						known.hash === copy.local.recovery?.hash &&
						(!copy.remote.recovery || copy.remote.recovery.hash === known.hash),
				),
		)
	)
		throw new Error("Additional copies need review. Reopen this conflict to review them.");
	return reviewed;
}
