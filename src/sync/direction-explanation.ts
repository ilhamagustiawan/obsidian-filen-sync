import type { SyncDirection } from "./types";

export type DirectionExplanation = {
	title: string;
	summary: string;
	details: string[];
};

/**
 * Explains the exact reconciliation contract for each sync direction,
 * matching the planner's branch table.
 */
export function getDirectionExplanation(direction: SyncDirection): DirectionExplanation {
	switch (direction) {
		case "push":
			return {
				title: "Push local files",
				summary: "Propagate local vault files and deletions to Filen.",
				details: [
					"New and modified local files are uploaded to Filen.",
					"Local deletions propagate to remote, removing remote files.",
					"Unchanged local files are re-uploaded if deleted on remote.",
					"If both local and remote changed, local overwrites remote directly without creating a conflict copy.",
					"Delete-vs-modify: if local was deleted but remote was modified, the remote survivor is preserved by downloading it (reverse transfer, no duplicate).",
					"New remote-only files are skipped.",
				],
			};
		case "pull":
			return {
				title: "Pull remote files",
				summary: "Download remote files and deletions from Filen to your vault.",
				details: [
					"New and modified remote files are downloaded to your vault.",
					"Remote deletions propagate to local, removing local files.",
					"Unchanged remote files are restored locally if deleted locally.",
					"If both local and remote changed, remote overwrites local directly without creating a conflict copy.",
					"Delete-vs-modify: if remote was deleted but local was modified, the local survivor is preserved by uploading it (reverse transfer, no duplicate).",
					"New local-only files are skipped.",
				],
			};
		case "both":
		default:
			return {
				title: "Two-way sync",
				summary: "Reconcile changes bidirectionally between your vault and Filen.",
				details: [
					"Local and remote additions and modifications are synchronized bidirectionally.",
					"Deletions propagate in both directions: missing local deletes remote; missing remote deletes local.",
					"If both changed, the newer file wins and the losing content is saved locally as a conflict copy.",
					"Delete-vs-modify: if one side was deleted while the other was modified, the modified survivor is restored without creating a duplicate copy.",
					"Files with identical content fingerprints establish a trusted baseline without re-transferring.",
				],
			};
	}
}
