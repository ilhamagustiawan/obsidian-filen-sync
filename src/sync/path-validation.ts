/** Validate vault-relative Filen paths before they enter either filesystem boundary. */
export function validateSyncPath(path: string): string {
	if (typeof path !== "string" || path.length === 0) {
		throw new Error("Sync path must not be empty.");
	}
	if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/u.test(path)) {
		throw new Error("Sync path must be relative.");
	}
	if (path.includes("\\")) {
		throw new Error("Sync path contains an ambiguous separator.");
	}
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/u.test(path)) {
		throw new Error("Sync path contains a control character.");
	}
	const segments = path.split("/");
	if (path === "__filen_sync_meta__") {
		throw new Error("Sync path is reserved for plugin metadata.");
	}
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new Error("Sync path contains an invalid segment.");
	}
	return path;
}

/** Validate an absolute Filen root while preserving its Unicode segments. */
export function assertNoPathCollisions(entries: Iterable<{ path: string; isDir: boolean }>): void {
	const exact = new Map<string, boolean>();
	const canonical = new Map<string, string>();
	for (const entry of entries) {
		const path = validateSyncPath(entry.path);
		const existingType = exact.get(path);
		if (existingType !== undefined) {
			if (existingType !== entry.isDir) throw new Error(`File/folder path clash: ${path}`);
			throw new Error(`Duplicate sync path: ${path}`);
		}
		exact.set(path, entry.isDir);
		const segments = path.split("/");
		for (let index = 1; index <= segments.length; index += 1) {
			const prefix = segments.slice(0, index).join("/");
			const key = prefix.normalize("NFC").toLowerCase();
			const previous = canonical.get(key);
			if (previous !== undefined && previous !== prefix) {
				throw new Error(`Case or Unicode path collision: ${previous} and ${prefix}`);
			}
			canonical.set(key, prefix);
			const priorType = exact.get(prefix);
			if (index < segments.length && priorType === false) {
				throw new Error(`File/folder path clash: ${prefix} and ${path}`);
			}
		}
		if (!entry.isDir) {
			for (const otherPath of exact.keys()) {
				if (otherPath.startsWith(`${path}/`)) {
					throw new Error(`File/folder path clash: ${path} and ${otherPath}`);
				}
			}
		}
	}
}

export function validateRemoteRoot(root: string): string {
	if (typeof root !== "string" || root.length === 0 || !root.startsWith("/")) {
		throw new Error("Remote root must be an absolute Filen path.");
	}
	// eslint-disable-next-line no-control-regex
	if (root.startsWith("//") || root.includes("\\") || /[\u0000-\u001f\u007f]/u.test(root)) {
		throw new Error("Remote root contains an invalid separator or control character.");
	}
	const segments = root.slice(1).split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new Error("Remote root contains an invalid segment.");
	}
	return root;
}
