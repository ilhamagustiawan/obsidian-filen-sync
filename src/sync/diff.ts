import DiffMatchPatch from "diff-match-patch";

export const TEXT_LIMIT = 1024 * 1024;
export const DIFF_BUDGET_MS = 250;
export type Edit = { start: number; end: number; text: string };
export type TextDiff = Array<[number, string]>;
export const textBytes = (text: string): number => new TextEncoder().encode(text).length;
export const diffDeadline = (): number => Date.now() + DIFF_BUDGET_MS;
export const supportedText = (text: string): boolean =>
	textBytes(text) <= TEXT_LIMIT && !text.includes("\0");

/** Encode complete tokens, so diff cannot split a Unicode word or a CRLF pair. */
function tokenDiff(a: string[], b: string[], deadline: number): TextDiff {
	const dictionary = new Map<string, number>();
	const tokens = [""];
	const encode = (parts: string[]): string =>
		parts
			.map((part) => {
				let id = dictionary.get(part);
				if (id === undefined) {
					id = tokens.length;
					if (id >= 0xd800) throw new Error("Comparison exceeds token limits.");
					dictionary.set(part, id);
					tokens.push(part);
				}
				return String.fromCharCode(id);
			})
			.join("");
	const left = encode(a),
		right = encode(b);
	if (Date.now() >= deadline) throw new Error("Comparison exceeds time limit.");
	const dmp = new DiffMatchPatch();
	dmp.Diff_Timeout = Math.max(0.001, (deadline - Date.now()) / 1000);
	const diffs = dmp.diff_main(left, right, false, deadline);
	if (Date.now() >= deadline) throw new Error("Comparison exceeds time limit.");
	return diffs.map(([kind, text]) => [
		kind,
		Array.from(text, (char) => tokens[char.charCodeAt(0)]!).join(""),
	]);
}
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
const words = (text: string): string[] =>
	text.match(/[\p{L}\p{N}\p{M}_]+|\r\n|[\r\n]|[^\S\r\n]+|[^\p{L}\p{N}\p{M}_\s]+/gu) ?? [];

export function lineDiff(base: string, next: string, deadline = diffDeadline()): TextDiff {
	if (!supportedText(base) || !supportedText(next))
		throw new Error("Comparison exceeds text limits.");
	return tokenDiff(lines(base), lines(next), deadline);
}
function editsFromDiff(diffs: TextDiff): Edit[] {
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
/** Line alignment followed by word refinement in changed blocks. Never fuzzy-patches. */
export function textEdits(base: string, next: string, deadline = diffDeadline()): Edit[] {
	return editsFromDiff(lineDiff(base, next, deadline)).flatMap((edit) => {
		const refined = tokenDiff(
			words(base.slice(edit.start, edit.end)),
			words(edit.text),
			deadline,
		);
		return editsFromDiff(refined).map((e) => ({
			...e,
			start: e.start + edit.start,
			end: e.end + edit.start,
		}));
	});
}
/** Semantic character cleanup is for display only, never merge coordinates. */
export function readableDiff(base: string, next: string, deadline = diffDeadline()): TextDiff {
	if (!supportedText(base) || !supportedText(next))
		throw new Error("Comparison exceeds text limits.");
	const dmp = new DiffMatchPatch();
	dmp.Diff_Timeout = Math.max(0.001, (deadline - Date.now()) / 1000);
	const diffs = dmp.diff_main(base, next, true, deadline);
	dmp.diff_cleanupSemantic(diffs);
	if (Date.now() >= deadline) throw new Error("Comparison exceeds time limit.");
	return diffs;
}
export function editsOverlap(a: Edit, b: Edit): boolean {
	if (a.start === a.end || b.start === b.end) return a.start <= b.end && b.start <= a.end;
	return a.start < b.end && b.start < a.end;
}
export function reconstruct(base: string, edits: Edit[]): string {
	const parts: string[] = [];
	let cursor = 0;
	for (const e of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
		if (e.start < cursor || e.end < e.start || e.end > base.length)
			throw new Error("Overlapping choices require review.");
		parts.push(base.slice(cursor, e.start), e.text);
		cursor = e.end;
	}
	parts.push(base.slice(cursor));
	return parts.join("");
}
export function editGroups<T extends Edit>(
	edits: T[],
): Array<{ start: number; end: number; changes: T[] }> {
	const groups: Array<{ start: number; end: number; changes: T[] }> = [];
	for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
		const last = groups[groups.length - 1];
		if (last && editsOverlap({ ...last, text: "" }, edit)) {
			last.end = Math.max(last.end, edit.end);
			last.changes.push(edit);
		} else groups.push({ start: edit.start, end: edit.end, changes: [edit] });
	}
	return groups;
}
