import { normalizePath } from "obsidian";

export const DEFAULT_IGNORE_PATTERNS = [
	// eslint-disable-next-line obsidianmd/hardcoded-config-path
	".obsidian/cache",
	// eslint-disable-next-line obsidianmd/hardcoded-config-path
	".obsidian/workspace*.json",
	".git",
	"node_modules",
] as const;

type PathFilterConfig = {
	configDir: string;
	pluginId: string;
	ignorePatterns: string[];
	maxFileSizeBytes?: number;
};

type CompiledIgnoreRule = {
	literalPrefix: string | null;
	regex: RegExp | null;
};

export type SyncPathFilter = {
	patterns: string[];
	isIgnored(path: string, size?: number): boolean;
};

export const normalizeIgnorePatterns = (patterns: Iterable<string>): string[] => {
	const normalized = new Set<string>();

	for (const pattern of patterns) {
		const trimmed = pattern.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) {
			continue;
		}

		const value = normalizePattern(trimmed);
		if (value.length > 0) {
			normalized.add(value);
		}
	}

	return [...normalized];
};

export const createSyncPathFilter = (config: PathFilterConfig): SyncPathFilter => {
	const builtInPatterns = normalizeIgnorePatterns([
		`${config.configDir}/plugins/${config.pluginId}`,
	]);
	const patterns = normalizeIgnorePatterns([...builtInPatterns, ...config.ignorePatterns]);
	const rules = patterns.map(compileIgnoreRule);

	return {
		patterns,
		isIgnored(path: string, size?: number): boolean {
			if (
				size !== undefined &&
				config.maxFileSizeBytes !== undefined &&
				size > config.maxFileSizeBytes
			) {
				return true;
			}

			const normalizedPath = normalizePattern(path);
			if (normalizedPath.length === 0) {
				return true;
			}

			for (const rule of rules) {
				if (matchesRule(normalizedPath, rule)) {
					return true;
				}
			}

			return false;
		},
	};
};

const normalizePattern = (value: string): string =>
	normalizePath(value).replace(/^\/+/, "").replace(/\/+$/, "");

const compileIgnoreRule = (pattern: string): CompiledIgnoreRule => {
	if (!hasWildcards(pattern)) {
		return {
			literalPrefix: pattern,
			regex: null,
		};
	}

	return {
		literalPrefix: null,
		regex: new RegExp(`^${globToRegexSource(pattern)}$`),
	};
};

const matchesRule = (path: string, rule: CompiledIgnoreRule): boolean => {
	if (rule.literalPrefix !== null) {
		return path === rule.literalPrefix || path.startsWith(`${rule.literalPrefix}/`);
	}

	return rule.regex?.test(path) ?? false;
};

const hasWildcards = (pattern: string): boolean => pattern.includes("*") || pattern.includes("?");

const globToRegexSource = (pattern: string): string => {
	let source = "";

	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern.charAt(index);
		const next = pattern[index + 1];
		if (char === "*" && next === "*") {
			source += ".*";
			index += 1;
			continue;
		}

		if (char === "*") {
			source += "[^/]*";
			continue;
		}

		if (char === "?") {
			source += "[^/]";
			continue;
		}

		source += escapeRegexChar(char);
	}

	return source;
};

const escapeRegexChar = (char: string): string => char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
