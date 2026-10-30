import { TFolder, normalizePath, type App } from "obsidian";
import type { RemoteFs } from "../fs-remote";
import type { DirectoryOutcome } from "./dir-planner";
import { ensureLocalDirectory } from "./local-io";
import type { PlannedAction, SyncActivityEvent } from "./types";

export type DirectoryApplyContext = {
	app: App;
	remote: RemoteFs;
	outcomes: Map<string, DirectoryOutcome>;
	onActivity?: (event: SyncActivityEvent) => void;
};

export type DirectoryApplyCounts = { applied: number; deletedLocal: number; deletedRemote: number };

/** Phase 1, before file transfers: create folders parents first. */
export async function createDirectories(
	ctx: DirectoryApplyContext,
	actions: PlannedAction[],
): Promise<number> {
	let applied = 0;
	for (const action of actions) {
		if (action.operation === "upload") await ctx.remote.mkdir(action.path);
		else if (action.operation === "download") await ensureLocalDirectory(ctx.app, action.path);
		else continue;
		ctx.outcomes.set(action.path, "applied");
		applied += 1;
		complete(ctx, action);
	}
	return applied;
}

/**
 * Phase 2, after file transfers: delete folders children first. Each delete
 * re-checks fresh state on both sides; anything doubtful is skipped and keeps
 * its baseline membership so the deletion is planned again next sync.
 */
export async function pruneDirectories(
	ctx: DirectoryApplyContext,
	actions: PlannedAction[],
): Promise<DirectoryApplyCounts> {
	const counts = { applied: 0, deletedLocal: 0, deletedRemote: 0 };
	for (const action of actions) {
		if (action.operation === "delete-local") {
			if (await pruneLocal(ctx, action)) {
				counts.applied += 1;
				counts.deletedLocal += 1;
			}
		} else if (action.operation === "delete-remote") {
			if (await pruneRemote(ctx, action)) {
				counts.applied += 1;
				counts.deletedRemote += 1;
			}
		}
	}
	return counts;
}

async function pruneLocal(ctx: DirectoryApplyContext, action: PlannedAction): Promise<boolean> {
	const { app, remote } = ctx;
	const path = action.path;
	if (remote.statDir === undefined) return false;
	const folder = app.vault.getAbstractFileByPath(normalizePath(path));
	if (!(folder instanceof TFolder)) {
		if (!(await app.vault.adapter.exists(path)) && (await remote.statDir(path)) === null)
			ctx.outcomes.set(path, "applied");
		return false;
	}
	// The adapter listing includes hidden and ignored children the vault index omits.
	const listing = await app.vault.adapter.list(path);
	if (listing.files.length > 0 || listing.folders.length > 0) {
		skipped(ctx, path, "it is not empty");
		return false;
	}
	// Uploads in this pass or another client may have recreated the remote folder.
	if ((await remote.statDir(path)) !== null) {
		ctx.outcomes.set(path, "both-present");
		return false;
	}
	await app.fileManager.trashFile(folder);
	ctx.outcomes.set(path, "applied");
	complete(ctx, action);
	return true;
}

async function pruneRemote(ctx: DirectoryApplyContext, action: PlannedAction): Promise<boolean> {
	const { app, remote } = ctx;
	const path = action.path;
	if (remote.rmdir === undefined) return false;
	// A download in this pass may have recreated the local folder.
	if (
		app.vault.getAbstractFileByPath(normalizePath(path)) !== null ||
		(await app.vault.adapter.exists(path))
	) {
		if (remote.statDir !== undefined && (await remote.statDir(path)) !== null)
			ctx.outcomes.set(path, "both-present");
		return false;
	}
	const result = await remote.rmdir(path);
	if (result === "not-empty") {
		skipped(ctx, path, "it is not empty in Filen");
		return false;
	}
	ctx.outcomes.set(path, "applied");
	if (result === "absent") return false;
	complete(ctx, action);
	return true;
}

const complete = (ctx: DirectoryApplyContext, action: PlannedAction): void =>
	ctx.onActivity?.({
		type: "operation-complete",
		operation: action.operation,
		path: action.path,
		detail: action.detail,
	});

const skipped = (ctx: DirectoryApplyContext, path: string, reason: string): void =>
	ctx.onActivity?.({
		type: "diagnostic",
		message: `Kept folder ${path} because ${reason}. Sync will retry the deletion.`,
	});
