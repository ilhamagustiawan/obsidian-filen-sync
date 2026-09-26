import type { SyncProgress } from "../sync/types";

export const shouldShowMobileSyncIndicator = (_isMobile = false, _enabled = false): boolean =>
	false;

export const shouldShowFloatingIndicator = shouldShowMobileSyncIndicator;

export const shouldShowAutomaticProgressNotice = (_isMobile = false, _enabled = false): boolean =>
	false;

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
