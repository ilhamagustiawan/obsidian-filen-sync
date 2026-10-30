import type { PlannedAction, SyncDirection } from "./types";

export type DirectoryPlanInput = {
	local: Set<string>;
	remote: Set<string>;
	/** Folders present on both sides after the last sync; null when never recorded. */
	baseline: Set<string> | null;
	direction: SyncDirection;
	/** Remote folders came from the cached tree: leave local folders untouched. */
	remoteFromCache: boolean;
};

/** Folder inventories, stored baseline and planned folder actions for one full pass. */
export type DirectoryPass = {
	local: Set<string>;
	remote: Set<string>;
	/** Stored baseline as read from the database (including filtered-out paths). */
	stored: Set<string> | null;
	/** Stored baseline restricted to paths the current filter includes. */
	baseline: Set<string> | null;
	actions: PlannedAction[];
};

/**
 * Apply-time result for one folder action. Actions without an outcome were
 * skipped and keep their previous baseline membership.
 * - applied: the action finished (created, or verified absent on both sides).
 * - both-present: a skipped deletion found the folder on both sides again.
 */
export type DirectoryOutcome = "applied" | "both-present";

const depth = (path: string): number => path.split("/").length;

/**
 * Three-way folder plan mirroring the file rules in planPath: a baselined
 * folder missing on one side was deleted there, an unbaselined one is new.
 * Creates are ordered parents first, deletes children first.
 */
export function planDirectories(input: DirectoryPlanInput): PlannedAction[] {
	const { local, remote, direction, remoteFromCache } = input;
	const baseline = input.baseline ?? new Set<string>();
	const creates: PlannedAction[] = [];
	const deletes: PlannedAction[] = [];

	for (const path of local) {
		if (remote.has(path)) continue;
		if (baseline.has(path)) {
			if (direction === "push") {
				creates.push({
					path,
					operation: "upload",
					reasonCode: "remote_dir_deleted_push_restore",
					destinationSide: "remote",
					destinationExists: false,
					isOverwrite: false,
					preservesSurvivor: true,
					detail: "Push mode: local folder restored to Filen",
					isDir: true,
				});
			} else if (!remoteFromCache) {
				deletes.push({
					path,
					operation: "delete-local",
					reasonCode: "remote_dir_deleted_delete_local",
					destinationSide: "local",
					destinationExists: true,
					isOverwrite: false,
					detail:
						direction === "pull"
							? "Pull mode: folder deleted in Filen; removing empty local folder"
							: "Folder deleted in Filen; removing empty local folder",
					isDir: true,
				});
			}
		} else if (direction !== "pull") {
			creates.push({
				path,
				operation: "upload",
				reasonCode: "new_local_dir_create_remote",
				destinationSide: "remote",
				destinationExists: false,
				isOverwrite: false,
				detail: "New local folder; creating in Filen",
				isDir: true,
			});
		}
	}

	for (const path of remote) {
		if (local.has(path)) continue;
		if (baseline.has(path)) {
			if (direction === "pull") {
				if (!remoteFromCache)
					creates.push({
						path,
						operation: "download",
						reasonCode: "local_dir_deleted_pull_restore",
						destinationSide: "local",
						destinationExists: false,
						isOverwrite: false,
						preservesSurvivor: true,
						detail: "Pull mode: Filen folder restored locally",
						isDir: true,
					});
			} else {
				deletes.push({
					path,
					operation: "delete-remote",
					reasonCode: "local_dir_deleted_delete_remote",
					destinationSide: "remote",
					destinationExists: true,
					isOverwrite: false,
					detail:
						direction === "push"
							? "Push mode: folder deleted locally; removing empty Filen folder"
							: "Folder deleted locally; removing empty Filen folder",
					isDir: true,
				});
			}
		} else if (direction !== "push" && !remoteFromCache) {
			creates.push({
				path,
				operation: "download",
				reasonCode: "new_remote_dir_create_local",
				destinationSide: "local",
				destinationExists: false,
				isOverwrite: false,
				detail: "New Filen folder; creating locally",
				isDir: true,
			});
		}
	}

	creates.sort((l, r) => depth(l.path) - depth(r.path) || l.path.localeCompare(r.path));
	deletes.sort((l, r) => depth(r.path) - depth(l.path) || l.path.localeCompare(r.path));
	return [...creates, ...deletes];
}

/**
 * Next folder baseline. Folders on both sides and finished creates join it;
 * finished deletes and folders gone from both sides leave it. Every other
 * baselined folder is retained so an unfinished deletion is planned again
 * instead of the survivor being treated as new.
 */
export function nextDirectoryBaseline(
	baseline: Set<string> | null,
	local: Set<string>,
	remote: Set<string>,
	actions: PlannedAction[],
	outcomes: Map<string, DirectoryOutcome>,
): Set<string> {
	const next = new Set<string>();
	for (const path of local) if (remote.has(path)) next.add(path);
	for (const path of baseline ?? []) if (local.has(path) || remote.has(path)) next.add(path);
	for (const action of actions) {
		const outcome = outcomes.get(action.path);
		if (outcome === undefined) continue;
		const isDelete =
			action.operation === "delete-local" || action.operation === "delete-remote";
		if (isDelete && outcome === "applied") next.delete(action.path);
		else next.add(action.path);
	}
	return next;
}

/** Filters the stored baseline to included paths; ignored ones are carried over untouched. */
export function filterDirectoryBaseline(
	stored: Set<string> | null,
	isIgnored: (path: string) => boolean,
): Set<string> | null {
	return stored === null ? null : new Set([...stored].filter((path) => !isIgnored(path)));
}
