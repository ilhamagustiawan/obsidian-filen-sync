import type { StatusBarState } from "../sync/coordinator";
import type { SyncProgress } from "../sync/types";

export const shouldShowMobileSyncIndicator = (isMobile = false, enabled = false): boolean =>
	isMobile && enabled;

export const shouldShowFloatingIndicator = shouldShowMobileSyncIndicator;

export const shouldShowAutomaticProgressNotice = (_isMobile = false, _enabled = false): boolean =>
	false;

/** Transfer progress is not whole-run completion; byte totals include in-flight work. */
export function transferPercent(progress?: SyncProgress): number | null {
	if (progress?.phase !== "transferring") return null;
	const useBytes = Number.isFinite(progress.totalBytes) && (progress.totalBytes ?? 0) > 0;
	const total = useBytes ? progress.totalBytes! : progress.total;
	const current = useBytes ? (progress.completedBytes ?? 0) : progress.current;
	if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(current)) return null;
	return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function formatFilename(path: string): string {
	if (!path) return "";
	const parts = path.split("/").filter(Boolean);
	if (parts.length <= 1) return path;
	return `…/${parts.slice(-1)[0]}`;
}

export function formatTransferDetails(progress: SyncProgress): {
	countText: string;
	fileText: string;
} {
	const current = Math.min(progress.current ?? 0, progress.total ?? 0);
	const total = progress.total ?? 0;
	let countText = total > 0 ? `${current} of ${total} changes` : "Transferring changes";
	if (progress.totalBytes !== undefined && progress.totalBytes > 0) {
		const completedBytes = progress.completedBytes ?? 0;
		countText += ` · ${formatBytes(completedBytes)}/${formatBytes(progress.totalBytes)}`;
	}
	const fileText = formatFilename(progress.path ?? "");
	return { countText, fileText };
}

export function formatSyncProgress(progress: SyncProgress): string {
	if (progress.phase === "scanning-local") return "Scanning local files";
	if (progress.phase === "scanning-remote") return "Scanning Filen";
	if (progress.phase === "planning") return "Comparing changes";
	if (progress.phase === "directories") return "Preparing folders";
	if (progress.phase === "confirming") return "Waiting for confirmation";
	if (progress.phase === "transferring" && progress.total > 0) {
		const current = Math.min(progress.current, progress.total);
		return `${current} of ${progress.total} changes`;
	}
	return "Transferring changes";
}

export function formatLastSyncSummary(
	timestamp: number | null,
	formatRelativeTime: (timestamp: number) => string,
): string {
	return timestamp === null ? "Not synced yet" : `Last synced ${formatRelativeTime(timestamp)}`;
}

export type SyncIconState =
	| "synced"
	| "syncing"
	| "paused"
	| "disconnected"
	| "pending"
	| "conflict"
	| "error";
/** One precedence model for every sync entry point. Persisted timestamps never imply completion. */
export function syncIconPresentation(
	state: StatusBarState | null,
	options: {
		connected?: boolean;
		offline?: boolean;
		paused?: boolean;
		pending?: number;
		conflicts?: number;
	} = {},
) {
	let kind: SyncIconState;
	if (state?.kind === "syncing") kind = "syncing";
	else if (options.connected === false || options.offline) kind = "disconnected";
	else if (state?.kind === "error") kind = "error";
	else if (options.conflicts || (state?.kind === "warning" && !options.paused)) kind = "conflict";
	else if (options.paused) kind = "paused";
	else if (options.pending || state?.kind !== "success" || !state.syncCompleted) kind = "pending";
	else kind = "synced";
	const icons = {
		synced: "circle-check",
		syncing: "refresh-cw",
		paused: "circle-pause",
		disconnected: "cloud-off",
		pending: "circle",
		conflict: "triangle-alert",
		error: "circle-alert",
	};
	const labels = {
		synced: "Synced",
		syncing: "Syncing",
		paused: "Paused",
		disconnected: "Disconnected",
		pending: "Pending/checking",
		conflict: "Conflicts need review",
		error: "Sync error",
	};
	return { state: kind, icon: icons[kind], label: labels[kind] };
}
