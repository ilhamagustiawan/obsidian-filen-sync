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
		return {
			path,
			operation: "noop",
			reasonCode: "missing_both",
			detail: "Missing on both sides",
		};
	}

	// Case 2: Local only
	if (local !== undefined && remote === undefined) {
		if (prev !== undefined) {
			// Remote was deleted
			const localChanged = isLocalChanged(local, prev);
			if (localChanged) {
				// Delete-vs-modify conflict: survivor preserved, no duplicate created
				return {
					path,
					operation: "conflict",
					reasonCode: "delete_modify_local_survivor",
					destinationSide: "remote",
					destinationExists: false,
					isOverwrite: false,
					preservesSurvivor: true,
					detail: "Remote deleted; local survivor preserved (uploaded to remote, no duplicate)",
					conflictWinner: "local",
					hash: local.hash,
				};
			}

			// Local unchanged, remote deleted
			if (direction === "push") {
				// In push-only mode, local survivor re-uploaded
				return {
					path,
					operation: "upload",
					reasonCode: "remote_deleted_push_reupload",
					destinationSide: "remote",
					destinationExists: false,
					isOverwrite: false,
					preservesSurvivor: true,
					detail: "Push mode: local survivor re-uploaded to remote",
					hash: local.hash,
				};
			}

			// In both or pull mode: delete local to match remote deletion
			return {
				path,
				operation: "delete-local",
				reasonCode: "remote_deleted_delete_local",
				destinationSide: "local",
				destinationExists: true,
				isOverwrite: false,
				detail:
					direction === "pull"
						? "Pull mode: remote deletion propagated (removing local)"
						: "Remote deleted; removing local",
			};
		}

		// New local file (never synced)
		if (direction === "pull") {
			return {
				path,
				operation: "noop",
				reasonCode: "new_local_pull_skip",
				detail: "Pull mode: skipping local-only file",
			};
		}
		return {
			path,
			operation: "upload",
			reasonCode: "new_local_upload",
			destinationSide: "remote",
			destinationExists: false,
			isOverwrite: false,
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
				// Delete-vs-modify conflict: survivor preserved, no duplicate created
				return {
					path,
					operation: "conflict",
					reasonCode: "delete_modify_remote_survivor",
					destinationSide: "local",
					destinationExists: false,
					isOverwrite: false,
					preservesSurvivor: true,
					detail: "Local deleted; remote survivor preserved (downloaded to local, no duplicate)",
					conflictWinner: "remote",
				};
			}

			// Remote unchanged, local deleted
			if (direction === "pull") {
				// In pull-only mode, remote file exists so restore it
				return {
					path,
					operation: "download",
					reasonCode: "local_deleted_pull_download",
					destinationSide: "local",
					destinationExists: false,
					isOverwrite: false,
					preservesSurvivor: true,
					detail: "Pull mode: remote survivor restored to local",
				};
			}

			// In both or push mode: delete remote to match local deletion
			return {
				path,
				operation: "delete-remote",
				reasonCode: "local_deleted_delete_remote",
				destinationSide: "remote",
				destinationExists: true,
				isOverwrite: false,
				detail:
					direction === "push"
						? "Push mode: local deletion propagated (removing remote)"
						: "Local deleted; removing remote",
			};
		}

		// New remote file (never synced)
		if (direction === "push") {
			return {
				path,
				operation: "noop",
				reasonCode: "new_remote_push_skip",
				detail: "Push mode: skipping remote-only file",
			};
		}
		return {
			path,
			operation: "download",
			reasonCode: "new_remote_download",
			destinationSide: "local",
			destinationExists: false,
			isOverwrite: false,
			detail: "New remote file; downloading",
		};
	}

	// Case 4: Both exist (local !== undefined && remote !== undefined)
	if (local === undefined || remote === undefined) {
		return {
			path,
			operation: "noop",
			reasonCode: "file_unavailable",
			detail: "File unavailable",
		};
	}

	if (local.hash !== undefined && remote.hash !== undefined && local.hash === remote.hash) {
		return {
			path,
			operation: "noop",
			reasonCode: prev ? "identical_content" : "first_sync_identical",
			detail: "Verified identical content",
			hash: local.hash,
		};
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
		if (remote.size === prev.size && remote.mtime === (prev.remoteMtime ?? prev.mtime)) {
			return {
				path,
				operation: "noop",
				reasonCode: "identical_content",
				detail: "Unchanged",
				hash: local.hash,
			};
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
					reasonCode: "first_sync_identical",
					detail: "Verified identical content",
					hash: local.hash,
				};
			}
			if (direction === "both") {
				return {
					path,
					operation: "conflict",
					reasonCode: "first_sync_conflict_no_baseline",
					destinationSide: "remote",
					destinationExists: true,
					isOverwrite: true,
					detail: "No trusted baseline or matching content fingerprint (remote saved as conflict copy)",
					conflictWinner: "local",
					hash: local.hash,
				};
			}
		}

		if (direction === "push") {
			return {
				path,
				operation: "upload",
				reasonCode: "first_sync_push_overwrite",
				destinationSide: "remote",
				destinationExists: true,
				isOverwrite: true,
				detail: "Push mode: overwriting remote with local (no conflict copy)",
				hash: local.hash,
			};
		}
		if (direction === "pull") {
			return {
				path,
				operation: "download",
				reasonCode: "first_sync_pull_overwrite",
				destinationSide: "local",
				destinationExists: true,
				isOverwrite: true,
				detail: "Pull mode: overwriting local with remote (no conflict copy)",
			};
		}

		const winner = local.mtime >= remote.mtime ? "local" : "remote";
		return {
			path,
			operation: "conflict",
			reasonCode: "first_sync_conflict_newer",
			destinationSide: winner === "local" ? "remote" : "local",
			destinationExists: true,
			isOverwrite: true,
			detail:
				winner === "local"
					? "No baseline; local is newer (remote saved as conflict copy)"
					: "No baseline; remote is newer (local saved as conflict copy)",
			conflictWinner: winner,
			hash: winner === "local" ? local.hash : undefined,
		};
	}

	// Both exist with baseline
	const localChanged = isLocalChanged(local, prev);
	const remoteChanged = isRemoteChanged(remote, prev);

	if (!localChanged && !remoteChanged) {
		return {
			path,
			operation: "noop",
			reasonCode: "both_unchanged",
			detail: "Unchanged",
			hash: prev.hash ?? local.hash,
		};
	}

	if (localChanged && !remoteChanged) {
		if (direction === "pull") {
			return {
				path,
				operation: "noop",
				reasonCode: "local_changed_pull_skip",
				detail: "Pull mode: skipping local change",
			};
		}
		return {
			path,
			operation: "upload",
			reasonCode: "local_changed_upload",
			destinationSide: "remote",
			destinationExists: true,
			isOverwrite: true,
			detail: "Local changed; uploading (overwriting remote)",
			hash: local.hash,
		};
	}

	if (!localChanged && remoteChanged) {
		if (direction === "push") {
			return {
				path,
				operation: "noop",
				reasonCode: "remote_changed_push_skip",
				detail: "Push mode: skipping remote change",
			};
		}
		return {
			path,
			operation: "download",
			reasonCode: "remote_changed_download",
			destinationSide: "local",
			destinationExists: true,
			isOverwrite: true,
			detail: "Remote changed; downloading (overwriting local)",
		};
	}

	// Both changed: conflict
	if (direction === "push") {
		return {
			path,
			operation: "upload",
			reasonCode: "both_changed_push_overwrite",
			destinationSide: "remote",
			destinationExists: true,
			isOverwrite: true,
			detail: "Push mode: local overwrites remote (no conflict copy)",
			hash: local.hash,
		};
	}
	if (direction === "pull") {
		return {
			path,
			operation: "download",
			reasonCode: "both_changed_pull_overwrite",
			destinationSide: "local",
			destinationExists: true,
			isOverwrite: true,
			detail: "Pull mode: remote overwrites local (no conflict copy)",
		};
	}

	const winner = local.mtime >= remote.mtime ? "local" : "remote";
	return {
		path,
		operation: "conflict",
		reasonCode: "both_changed_conflict",
		destinationSide: winner === "local" ? "remote" : "local",
		destinationExists: true,
		isOverwrite: true,
		detail:
			winner === "local"
				? "Both changed; local newer (remote saved as conflict copy)"
				: "Both changed; remote newer (local saved as conflict copy)",
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
		remote.mtime !== (prev.remoteMtime ?? prev.mtime)
	);
}
