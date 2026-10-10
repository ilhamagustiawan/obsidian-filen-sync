const safePathSegment = (value: string): string => {
	const cleaned = value.replace(/[^a-zA-Z0-9_-]/gu, "_");
	return (cleaned.length > 0 ? cleaned : "node").slice(0, 64);
};

export const conflictCopyPath = (
	path: string,
	deviceId: string,
	timestamp: number,
	side: "local" | "remote",
): string => {
	const dotIndex = path.lastIndexOf(".");
	const suffix = `.sync-conflict-${side}-${safePathSegment(deviceId)}-${timestamp}`;
	return dotIndex <= path.lastIndexOf("/") + 1
		? `${path}${suffix}`
		: `${path.slice(0, dotIndex)}${suffix}${path.slice(dotIndex)}`;
};

export const isConflictFilePath = (path: string): boolean => {
	return /\.sync-conflict-(?:local|remote)-[a-zA-Z0-9_-]+-\d+(?:\.[^/]*)?$/i.test(
		path.split("/").pop() ?? "",
	);
};

export const getOriginalPathFromConflictPath = (conflictPath: string): string => {
	const slash = conflictPath.lastIndexOf("/");
	const original =
		conflictPath.slice(0, slash + 1) +
		conflictPath
			.slice(slash + 1)
			.replace(/\.sync-conflict-(?:local|remote)-[a-zA-Z0-9_-]+-\d+(?=\.|$)/i, "");
	if (original.startsWith("Filen Sync conflicts/settings-")) {
		try {
			return decodeURIComponent(original.slice("Filen Sync conflicts/settings-".length));
		} catch {
			return original;
		}
	}
	return original;
};
