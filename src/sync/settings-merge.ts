import { supportedText, diffDeadline } from "./diff";

const missing = Symbol("missing");
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string) =>
	Object.prototype.hasOwnProperty.call(value, key) ? value[key] : missing;
export function validSettings(text: string): boolean {
	try {
		return supportedText(text) && object(JSON.parse(text));
	} catch {
		return false;
	}
}
export type SettingsSection = { path: string; base: unknown; local: unknown; remote: unknown };
export type SettingsAnalysis = {
	sections: SettingsSection[];
	result: (choices: ReadonlyMap<number, unknown>) => string;
};
type Node = { value: unknown } | { choice: number } | { keys: Array<[string, Node]> };
export const settingsValueText = (value: unknown): string =>
	value === missing ? "(key deleted)" : JSON.stringify(value, null, 2);

/** Three-way JSON analysis; arrays and concurrently added objects are atomic. */
export function analyzeSettings(
	local: string,
	remote: string,
	base?: string,
): SettingsAnalysis | undefined {
	if (![local, remote].every(validSettings) || (base !== undefined && !validSettings(base)))
		return undefined;
	try {
		const deadline = diffDeadline();
		const equal = (a: unknown, b: unknown, depth = 0): boolean => {
			if (Date.now() >= deadline || depth > 100)
				throw new Error("Settings comparison exceeds limits.");
			if (a === b) return true;
			if (Array.isArray(a) && Array.isArray(b))
				return a.length === b.length && a.every((v, i) => equal(v, b[i], depth + 1));
			if (!object(a) || !object(b)) return false;
			const keys = Object.keys(a);
			return (
				keys.length === Object.keys(b).length &&
				keys.every(
					(key) =>
						Object.prototype.hasOwnProperty.call(b, key) &&
						equal(a[key], b[key], depth + 1),
				)
			);
		};
		const sections: SettingsSection[] = [];
		const merge = (b: unknown, l: unknown, r: unknown, path: string, depth: number): Node => {
			if (depth > 100 || Date.now() >= deadline)
				throw new Error("Settings comparison exceeds limits.");
			if (equal(l, r)) return { value: l };
			if (equal(l, b)) return { value: r };
			if (equal(r, b)) return { value: l };
			if (!object(b) || !object(l) || !object(r)) {
				sections.push({ path: path || "/", base: b, local: l, remote: r });
				return { choice: sections.length - 1 };
			}
			return {
				keys: [...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].map(
					(key) => [
						key,
						merge(
							own(b, key),
							own(l, key),
							own(r, key),
							`${path}/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`,
							depth + 1,
						),
					],
				),
			};
		};
		const root = merge(
			base === undefined ? missing : JSON.parse(base),
			JSON.parse(local),
			JSON.parse(remote),
			"",
			0,
		);
		return {
			sections,
			result: (choices) => {
				const deadline = diffDeadline();
				const build = (node: Node): unknown => {
					if (Date.now() >= deadline)
						throw new Error("Settings result exceeds time limit.");
					if ("value" in node) return node.value;
					if ("choice" in node) {
						if (!choices.has(node.choice))
							throw new Error("Choose a value for every competing settings key.");
						return choices.get(node.choice);
					}
					const result = Object.create(null) as Record<string, unknown>;
					for (const [key, child] of node.keys) {
						const value = build(child);
						if (value !== missing) result[key] = value;
					}
					return result;
				};
				const value = build(root);
				if (!object(value)) throw new Error("The result must be a settings object.");
				const text = JSON.stringify(value, null, 2) + "\n";
				if (!supportedText(text) || Date.now() >= deadline)
					throw new Error("Settings result exceeds limits.");
				return text;
			},
		};
	} catch {
		return undefined;
	}
}
export function mergeSettings(local: string, remote: string, base?: string): string | undefined {
	const analysis = analyzeSettings(local, remote, base);
	if (!analysis || analysis.sections.length) return undefined;
	try {
		return analysis.result(new Map());
	} catch {
		return undefined;
	}
}
