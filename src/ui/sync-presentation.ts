import type { SyncProgress } from "../sync/types";

export const shouldShowFloatingIndicator = (isMobile: boolean, enabled: boolean): boolean =>
	isMobile && enabled;

export const shouldShowAutomaticProgressNotice = (): boolean => false;

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
