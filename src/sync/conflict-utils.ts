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
	return dotIndex <= 0
		? `${path}${suffix}`
		: `${path.slice(0, dotIndex)}${suffix}${path.slice(dotIndex)}`;
};

export const isConflictFilePath = (path: string): boolean => {
	return /\.sync-conflict-(?:local|remote)-/i.test(path);
};

export const getOriginalPathFromConflictPath = (conflictPath: string): string => {
	return conflictPath.replace(/\.sync-conflict-(?:local|remote)-[a-zA-Z0-9_-]+/i, "");
};
