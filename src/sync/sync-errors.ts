const AUTO_SYNC_FAILURE_BASE_BACKOFF_MS = 30_000;
const AUTO_SYNC_FAILURE_MAX_BACKOFF_MS = 5 * 60_000;

export function isTransientError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();
	if (lower.includes("timed out") || lower.includes("request was cancelled")) return false;
	const transientPatterns = [
		"network",
		"timeout",
		"econnreset",
		"econnrefused",
		"etimedout",
		"enotfound",
		"dns",
		"socket",
		"tls",
		"abort",
		"fetch failed",
		"too many requests",
		"rate limit",
		"503",
		"502",
		"504",
		"429",
		"internal server error",
	];
	return transientPatterns.some((pattern) => lower.includes(pattern));
}

export const getAutoSyncBackoffMs = (error: unknown, failureCount: number): number => {
	const retryAfterMs = readRetryAfterMs(error);
	if (retryAfterMs !== null) {
		return Math.min(
			Math.max(retryAfterMs, AUTO_SYNC_FAILURE_BASE_BACKOFF_MS),
			AUTO_SYNC_FAILURE_MAX_BACKOFF_MS,
		);
	}
	return Math.min(
		AUTO_SYNC_FAILURE_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, failureCount - 1)),
		AUTO_SYNC_FAILURE_MAX_BACKOFF_MS,
	);
};

const readRetryAfterMs = (error: unknown): number | null => {
	const message = error instanceof Error ? error.message : String(error);
	const secondsMatch = message.match(/retry[- ]after[^0-9]*(\d+)\s*(seconds?|secs?|s)\b/iu);
	const secondsValue = secondsMatch?.[1];
	if (secondsValue !== undefined) return Number.parseInt(secondsValue, 10) * 1000;
	const msMatch = message.match(/retry[- ]after[^0-9]*(\d+)\s*(milliseconds?|msecs?|ms)\b/iu);
	const msValue = msMatch?.[1];
	if (msValue !== undefined) return Number.parseInt(msValue, 10);
	return null;
};

export function isNetworkClassError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();
	const patterns = [
		"network",
		"econnrefused",
		"econnreset",
		"etimedout",
		"enotfound",
		"timeout",
		"timed out",
		"dns",
		"socket",
		"tls",
		"offline",
		"fetch failed",
		"connection refused",
		"connection closed",
		"unreachable",
		"gateway",
		"502",
		"503",
		"504",
	];
	return patterns.some((p) => lower.includes(p));
}

export function isReplanError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("Replan the sync") || message.includes("Changes detected during sync");
}
