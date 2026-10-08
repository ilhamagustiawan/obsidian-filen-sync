import DiffMatchPatch from "diff-match-patch";

export const TEXT_LIMIT = 1024 * 1024;
export type Edit = { start: number; end: number; text: string };
export const textBytes = (text: string): number => new TextEncoder().encode(text).length;
export function decodeText(bytes: Uint8Array): string | undefined {
	if (bytes.byteLength > TEXT_LIMIT) return undefined;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return text.includes("\0") ? undefined : text;
	} catch {
		return undefined;
	}
}
export function textEdits(base: string, next: string): Edit[] {
	const dmp = new DiffMatchPatch();
	dmp.Diff_Timeout = 0.25;
	const diffs = dmp.diff_main(base, next, false);
	const edits: Edit[] = [];
	let offset = 0,
		edit: Edit | undefined;
	for (const [kind, text] of diffs) {
		if (kind === 0) {
			if (edit) edits.push(edit);
			edit = undefined;
			offset += text.length;
		} else {
			edit ??= { start: offset, end: offset, text: "" };
			if (kind === -1) {
				offset += text.length;
				edit.end = offset;
			} else edit.text += text;
		}
	}
	if (edit) edits.push(edit);
	return edits;
}
export function editsOverlap(a: Edit, b: Edit): boolean {
	if (a.start === a.end || b.start === b.end) return a.start <= b.end && b.start <= a.end;
	return a.start < b.end && b.start < a.end;
}
export function reconstruct(base: string, edits: Edit[]): string {
	let result = "",
		cursor = 0;
	for (const e of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
		if (e.start < cursor) throw new Error("Overlapping choices require review.");
		result += base.slice(cursor, e.start) + e.text;
		cursor = e.end;
	}
	return result + base.slice(cursor);
}
/** Conservative three-way merge: no fuzzy patch application to overlapping edits. */
export function mergeMarkdown(
	base: string | undefined,
	local: string,
	remote: string,
): string | undefined {
	if (local === remote) return local;
	if (
		base === undefined ||
		[base, local, remote].some((t) => textBytes(t) > TEXT_LIMIT || t.includes("\0"))
	)
		return undefined;
	const left = textEdits(base, local),
		right = textEdits(base, remote);
	const combined = [...left];
	for (const r of right) {
		const overlap = left.filter((l) => editsOverlap(l, r));
		if (overlap.some((l) => l.start !== r.start || l.end !== r.end || l.text !== r.text))
			return undefined;
		if (!overlap.length) combined.push(r);
	}
	const result = reconstruct(base, combined);
	return textBytes(result) <= TEXT_LIMIT ? result : undefined;
}
export function mergeSettings(local: string, remote: string): string | undefined {
	try {
		const l: unknown = JSON.parse(local),
			r: unknown = JSON.parse(remote);
		const object = (v: unknown): v is Record<string, unknown> =>
			v !== null && typeof v === "object" && !Array.isArray(v);
		if (!object(l) || !object(r)) return undefined;
		return JSON.stringify({ ...r, ...l }, null, 2) + "\n";
	} catch {
		return undefined;
	}
}
