import type { SyncOperation, SyncProgress, SyncTimingSummary } from "./types";

export function formatTimingSummary(timing?: SyncTimingSummary): string {
	if (!timing) return "";
	const parts: string[] = [`total ${(timing.totalMs / 1000).toFixed(1)}s`];
	if (timing.scanMs !== undefined && timing.scanMs > 0) parts.push(`scan ${timing.scanMs}ms`);
	if (timing.planMs !== undefined && timing.planMs > 0) parts.push(`plan ${timing.planMs}ms`);
	if (timing.transferMs !== undefined && timing.transferMs > 0)
		parts.push(`transfer ${timing.transferMs}ms`);
	if (timing.firstTransferMs !== undefined)
		parts.push(`first file in ${timing.firstTransferMs}ms`);
	// Stage timings distinguish where time went; they overlap and are not summed.
	if (timing.targetPrepMs !== undefined && timing.targetPrepMs > 0)
		parts.push(`target prep ${timing.targetPrepMs}ms`);
	if (timing.eventProbeMs !== undefined && timing.eventProbeMs > 0)
		parts.push(`probe ${timing.eventProbeMs}ms`);
	if (timing.localScanMs !== undefined && timing.localScanMs > 0)
		parts.push(`local scan ${timing.localScanMs}ms`);
	if (timing.baselineMs !== undefined && timing.baselineMs > 0)
		parts.push(`baseline ${timing.baselineMs}ms`);
	if (timing.remoteScanMs !== undefined && timing.remoteScanMs > 0)
		parts.push(`remote ${timing.remoteScanMs}ms`);
	if (timing.equalityMs !== undefined && timing.equalityMs > 0)
		parts.push(`equality ${timing.equalityMs}ms`);
	if (timing.directoriesMs !== undefined && timing.directoriesMs > 0)
		parts.push(`dirs ${timing.directoriesMs}ms`);
	if (timing.executeMs !== undefined && timing.executeMs > 0)
		parts.push(`apply ${timing.executeMs}ms`);
	return ` (${parts.join(", ")})`;
}

export function progressLabel(progress: SyncProgress): string {
	switch (progress.phase) {
		case "scanning-local":
			return "Checking local files…";
		case "scanning-remote":
			return "Checking Filen…";
		case "planning":
			return "Comparing changes…";
		case "directories":
			return "Preparing folders…";
		case "confirming":
			return "Waiting for confirmation…";
		case "transferring":
			return `${progress.operation === "upload" ? "Uploading" : progress.operation === "download" ? "Downloading" : "Applying changes"} · ${progress.current}/${progress.total}`;
		default:
			return "Syncing…";
	}
}

export function progressDetail(p: SyncProgress): string {
	return p.phase === "transferring"
		? `${p.current}/${p.total} changes complete · ${p.path}${p.totalBytes === undefined ? "" : ` · ${((p.completedBytes ?? 0) / 1048576).toFixed(1)} / ${(p.totalBytes / 1048576).toFixed(1)} MB`}`
		: progressLabel(p);
}

export const syncOperationCompleteMessage = (operation: SyncOperation, path: string): string => {
	switch (operation) {
		case "upload":
			return `Uploaded ${path}`;
		case "download":
			return `Downloaded ${path}`;
		case "delete-local":
			return `Deleted locally ${path}`;
		case "delete-remote":
			return `Deleted remotely ${path}`;
		case "conflict":
			return `Conflict copy created for ${path}`;
		default:
			return `Synced ${path}`;
	}
};

export function formatRelativeTime(epochMs: number, now = Date.now()): string {
	const diffMs = Math.max(0, now - epochMs);
	const diffSecs = Math.floor(diffMs / 1000);
	if (diffSecs < 60) return "just now";
	const diffMins = Math.floor(diffSecs / 60);
	if (diffMins === 1) return "1 minute ago";
	if (diffMins < 60) return `${diffMins} minutes ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours === 1) return "1 hour ago";
	if (diffHours < 24) return `${diffHours} hours ago`;
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays === 1) return "1 day ago";
	return `${diffDays} days ago`;
}
