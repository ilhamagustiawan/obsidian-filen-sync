import type {
	LocalFileInfo,
	PlannedAction,
	RemoteFileInfo,
	SyncDirection,
	SyncedFileRecord,
} from "./types";

export type PlanInput = {
	localFiles: Map<string, LocalFileInfo>;
	remoteFiles: Map<string, RemoteFileInfo>;
	prevRecords: Map<string, SyncedFileRecord>;
	direction?: SyncDirection;
};

export type PlanResult = {
	actions: PlannedAction[];
	counts: {
		upload: number;
		download: number;
		deleteLocal: number;
		deleteRemote: number;
		conflict: number;
		noop: number;
	};
};

/**
 * Pure planning function.
 * Given local files, remote files, and the previous sync baseline,
 * computes the list of operations needed to reconcile them.
 * Has no side effects (no network, disk, or DB operations).
 */
export function planSync(input: PlanInput): PlanResult {
	const { localFiles, remoteFiles, prevRecords, direction = "both" } = input;
	const allPaths = new Set<string>([
		...localFiles.keys(),
		...remoteFiles.keys(),
		...prevRecords.keys(),
	]);

	const sortedPaths = [...allPaths].sort();
	const actions: PlannedAction[] = [];
	const counts = {
		upload: 0,
		download: 0,
		deleteLocal: 0,
		deleteRemote: 0,
		conflict: 0,
		noop: 0,
	};

	for (const path of sortedPaths) {
		const local = localFiles.get(path);
		const remote = remoteFiles.get(path);
		const prev = prevRecords.get(path);

		const action = planPath(path, local, remote, prev, direction);
		actions.push(action);

		switch (action.operation) {
			case "upload":
				counts.upload += 1;
				break;
			case "download":
				counts.download += 1;
				break;
			case "delete-local":
				counts.deleteLocal += 1;
				break;
			case "delete-remote":
				counts.deleteRemote += 1;
				break;
			case "conflict":
				counts.conflict += 1;
				break;
			case "noop":
				counts.noop += 1;
				break;
		}
	}

	return { actions, counts };
}

function planPath(
	path: string,
	local: LocalFileInfo | undefined,
	remote: RemoteFileInfo | undefined,
	prev: SyncedFileRecord | undefined,
	direction: SyncDirection,
): PlannedAction {
	// Case 1: Missing on both sides
	if (local === undefined && remote === undefined) {
		return { path, operation: "noop", detail: "Missing on both sides" };
	}

	// Case 2: Local only
	if (local !== undefined && remote === undefined) {
		if (prev !== undefined) {
			// Remote was deleted
			const localChanged = isLocalChanged(local, prev);
			if (localChanged) {
				// Delete-vs-modify conflict
				if (direction === "pull") {
					// In pull mode, remote deleted => delete local unless user edit
					return {
						path,
						operation: "conflict",
						detail: "Remote deleted; local changed (conflict copy made)",
						conflictWinner: "local",
						hash: local.hash,
					};
				}
				return {
					path,
					operation: "conflict",
					detail: "Remote deleted; local changed (conflict copy made)",
					conflictWinner: "local",
					hash: local.hash,
				};
			}

			// Local unchanged, remote deleted
			if (direction === "push") {
				// In push-only mode, local file exists so we re-upload it
				return {
					path,
					operation: "upload",
					detail: "Local file pushed to remote",
					hash: local.hash,
				};
			}

			// In both or pull mode: delete local to match remote deletion
			return {
				path,
				operation: "delete-local",
				detail: "Remote deleted; removing local",
			};
		}

		// New local file (never synced)
		if (direction === "pull") {
			return { path, operation: "noop", detail: "Pull mode: skipping local-only file" };
		}
		return {
			path,
			operation: "upload",
			detail: "New local file; uploading",
			hash: local.hash,
		};
	}

	// Case 3: Remote only
	if (local === undefined && remote !== undefined) {
		if (prev !== undefined) {
			// Local was deleted
			const remoteChanged = isRemoteChanged(remote, prev);
			if (remoteChanged) {
				// Delete-vs-modify conflict
				if (direction === "push") {
					return {
						path,
						operation: "conflict",
						detail: "Local deleted; remote changed (conflict copy made)",
						conflictWinner: "remote",
					};
				}
				return {
					path,
					operation: "conflict",
					detail: "Local deleted; remote changed (conflict copy made)",
					conflictWinner: "remote",
				};
			}

			// Remote unchanged, local deleted
			if (direction === "pull") {
				// In pull-only mode, remote file exists so download it
				return {
					path,
					operation: "download",
					detail: "Remote file pulled to local",
				};
			}

			// In both or push mode: delete remote to match local deletion
			return {
				path,
				operation: "delete-remote",
				detail: "Local deleted; removing remote",
			};
		}

		// New remote file (never synced)
		if (direction === "push") {
			return { path, operation: "noop", detail: "Push mode: skipping remote-only file" };
		}
		return {
			path,
			operation: "download",
			detail: "New remote file; downloading",
		};
	}

	// Case 4: Both exist (local !== undefined && remote !== undefined)
	if (local === undefined || remote === undefined) {
		return { path, operation: "noop", detail: "File unavailable" };
	}

	// A replaced remote object is a change even when its path/metadata are unchanged.
	const remoteIdentityChanged =
		prev?.remoteUuid !== undefined &&
		remote.uuid !== undefined &&
		prev.remoteUuid !== remote.uuid;
	const remoteHashChanged =
		prev?.remoteHash !== undefined &&
		remote.remoteHash !== undefined &&
		prev.remoteHash !== remote.remoteHash;

	// Hash fast paths only use a freshly computed local digest and a stable remote identity and hash.
	if (
		!remoteIdentityChanged &&
		!remoteHashChanged &&
		local.hash !== undefined &&
		prev?.hash !== undefined &&
		local.hash === prev.hash
	) {
		if (remote.size === prev.size && remote.mtime === prev.mtime) {
			return { path, operation: "noop", detail: "Unchanged", hash: local.hash };
		}
	}

	// First sync for this path (no baseline)
	if (prev === undefined) {
		if (local.size === remote.size && local.mtime === remote.mtime) {
			if (
				local.hash !== undefined &&
				remote.hash !== undefined &&
				local.hash === remote.hash
			) {
				return {
					path,
					operation: "noop",
					detail: "Verified identical content",
					hash: local.hash,
				};
			}
			if (direction === "both") {
				return {
					path,
					operation: "conflict",
					detail: "No trusted baseline or matching content fingerprint (conflict copy made)",
					conflictWinner: "local",
					hash: local.hash,
				};
			}
		}

		if (direction === "push") {
			return {
				path,
				operation: "upload",
				detail: "Push mode: overwriting remote with local",
				hash: local.hash,
			};
		}
		if (direction === "pull") {
			return {
				path,
				operation: "download",
				detail: "Pull mode: overwriting local with remote",
			};
		}

		const winner = local.mtime >= remote.mtime ? "local" : "remote";
		return {
			path,
			operation: "conflict",
			detail:
				winner === "local"
					? "No baseline; local is newer (conflict copy made)"
					: "No baseline; remote is newer (conflict copy made)",
			conflictWinner: winner,
			hash: winner === "local" ? local.hash : undefined,
		};
	}

	// Both exist with baseline
	const localChanged = isLocalChanged(local, prev);
	const remoteChanged = isRemoteChanged(remote, prev);

	if (!localChanged && !remoteChanged) {
		return { path, operation: "noop", detail: "Unchanged", hash: prev.hash ?? local.hash };
	}

	if (localChanged && !remoteChanged) {
		if (direction === "pull") {
			return { path, operation: "noop", detail: "Pull mode: skipping local change" };
		}
		return {
			path,
			operation: "upload",
			detail: "Local changed; uploading",
			hash: local.hash,
		};
	}

	if (!localChanged && remoteChanged) {
		if (direction === "push") {
			return { path, operation: "noop", detail: "Push mode: skipping remote change" };
		}
		return {
			path,
			operation: "download",
			detail: "Remote changed; downloading",
		};
	}

	// Both changed: conflict
	if (direction === "push") {
		return {
			path,
			operation: "upload",
			detail: "Push mode: local overwrites remote",
			hash: local.hash,
		};
	}
	if (direction === "pull") {
		return {
			path,
			operation: "download",
			detail: "Pull mode: remote overwrites local",
		};
	}

	const winner = local.mtime >= remote.mtime ? "local" : "remote";
	return {
		path,
		operation: "conflict",
		detail:
			winner === "local"
				? "Both changed; local newer (conflict copy made)"
				: "Both changed; remote newer (conflict copy made)",
		conflictWinner: winner,
		hash: winner === "local" ? local.hash : undefined,
	};
}

function isLocalChanged(local: LocalFileInfo, prev: SyncedFileRecord): boolean {
	if (local.size !== prev.size) return true;
	if (local.hash !== undefined && prev.hash !== undefined) return local.hash !== prev.hash;
	if (local.mtime !== prev.mtime) {
		// If mtime drifted but hash is provided and identical to baseline, not changed
		if (local.hash !== undefined && prev.hash !== undefined && local.hash === prev.hash) {
			return false;
		}
		return true;
	}
	return false;
}

function isRemoteChanged(remote: RemoteFileInfo, prev: SyncedFileRecord): boolean {
	return (
		(remote.uuid !== undefined &&
			prev.remoteUuid !== undefined &&
			remote.uuid !== prev.remoteUuid) ||
		(remote.remoteHash !== undefined &&
			prev.remoteHash !== undefined &&
			remote.remoteHash !== prev.remoteHash) ||
		remote.size !== prev.size ||
		remote.mtime !== prev.mtime
	);
}
