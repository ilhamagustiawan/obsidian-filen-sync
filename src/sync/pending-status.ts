import type { StatusBarState } from "./coordinator-types";

/**
 * Status to publish for queued edits and conflicts while no sync is running,
 * or null when the current status should be kept.
 */
export function derivePendingStatus(
	conflictCount: number,
	pendingCount: number,
	lastStatus: StatusBarState | null,
): StatusBarState | null {
	if (conflictCount > 0) {
		return {
			kind: "warning",
			text: `${conflictCount} conflict${conflictCount === 1 ? "" : "s"} to review`,
			detail:
				pendingCount > 0
					? `${pendingCount} local changes pending · ${conflictCount} conflict${conflictCount === 1 ? "" : "s"} to review`
					: `${conflictCount} conflict(s) to review in vault.`,
			updatedAt: Date.now(),
		};
	}
	if (lastStatus?.kind === "warning" && !lastStatus.text.toLowerCase().includes("conflict"))
		return null;
	if (lastStatus?.kind === "error") return null;
	if (pendingCount > 0) {
		return {
			kind: "idle",
			text: "Ready",
			detail: "Local changes are queued for automatic sync.",
			updatedAt: Date.now(),
		};
	}
	if (lastStatus?.kind === "warning" && lastStatus.text.toLowerCase().includes("conflict")) {
		return {
			kind: "idle",
			text: "up to date",
			detail: "All conflicts resolved and files up to date.",
			updatedAt: Date.now(),
		};
	}
	return null;
}
