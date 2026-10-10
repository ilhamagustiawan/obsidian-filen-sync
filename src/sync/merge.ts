import {
	TEXT_LIMIT,
	supportedText,
	diffDeadline,
	textEdits,
	editGroups,
	reconstruct,
} from "./diff";
export { TEXT_LIMIT, textBytes, textEdits, editsOverlap, reconstruct, type Edit } from "./diff";

export function decodeText(bytes: Uint8Array): string | undefined {
	if (bytes.byteLength > TEXT_LIMIT) return undefined;
	try {
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		return text.includes("\0") ? undefined : text;
	} catch {
		return undefined;
	}
}
export type MergeSection = {
	start: number;
	end: number;
	base: string;
	local: string;
	remote: string;
	resolved?: string;
};
export type MarkdownAnalysis = { base: string; sections: MergeSection[]; merged?: string };
export function analyzeMarkdown(
	base: string | undefined,
	local: string,
	remote: string,
): MarkdownAnalysis | undefined {
	if (base === undefined || ![base, local, remote].every(supportedText)) return undefined;
	try {
		const deadline = diffDeadline();
		const changes = [
			...textEdits(base, local, deadline).map((e) => ({ ...e, side: "local" as const })),
			...textEdits(base, remote, deadline).map((e) => ({ ...e, side: "remote" as const })),
		];
		const sections = editGroups(changes).map((group): MergeSection => {
			const original = base.slice(group.start, group.end);
			const version = (side: "local" | "remote") =>
				reconstruct(
					original,
					group.changes
						.filter((e) => e.side === side)
						.map((e) => ({
							...e,
							start: e.start - group.start,
							end: e.end - group.start,
						})),
				);
			const l = version("local"),
				r = version("remote");
			return {
				start: group.start,
				end: group.end,
				base: original,
				local: l,
				remote: r,
				resolved: l === r ? l : l === original ? r : r === original ? l : undefined,
			};
		});
		const merged = sections.every((s) => s.resolved !== undefined)
			? reconstruct(
					base,
					sections.map((s) => ({ ...s, text: s.resolved! })),
				)
			: undefined;
		if (Date.now() >= deadline || (merged !== undefined && !supportedText(merged)))
			return undefined;
		return { base, sections, merged };
	} catch {
		return undefined;
	}
}
export function mergeMarkdown(
	base: string | undefined,
	local: string,
	remote: string,
): string | undefined {
	if (![local, remote].every(supportedText)) return undefined;
	if (local === remote) return local;
	return analyzeMarkdown(base, local, remote)?.merged;
}
export {
	mergeSettings,
	validSettings,
	analyzeSettings,
	settingsValueText,
	type SettingsAnalysis,
} from "./settings-merge";
