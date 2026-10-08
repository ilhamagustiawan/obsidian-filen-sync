import { textEdits, editsOverlap, reconstruct, textBytes, type Edit } from "./merge";
export type ReviewSection = {
	start: number;
	end: number;
	alternatives: Array<{ label: string; text: string }>;
};
export function reviewSections(
	current: string,
	copies: Array<{ label: string; text: string }>,
): ReviewSection[] | undefined {
	if (textBytes(current) + copies.reduce((n, c) => n + textBytes(c.text), 0) > 1024 * 1024)
		return undefined;
	const changes: Array<Edit & { label: string }> = [];
	for (const c of copies) {
		if ((current.split("\n").length + 1) * (c.text.split("\n").length + 1) > 1_000_000)
			return undefined;
		changes.push(...textEdits(current, c.text).map((e) => ({ ...e, label: c.label })));
	}
	const groups: Array<{ start: number; end: number; changes: typeof changes }> = [];
	for (const e of changes.sort((a, b) => a.start - b.start || a.end - b.end)) {
		const last = groups[groups.length - 1];
		if (last && editsOverlap({ ...last, text: "" }, e)) {
			last.end = Math.max(last.end, e.end);
			last.changes.push(e);
		} else groups.push({ start: e.start, end: e.end, changes: [e] });
	}
	return groups.map((g) => {
		const alternatives = [{ label: "Keep current", text: current.slice(g.start, g.end) }];
		for (const c of copies) {
			const edits = g.changes
				.filter((e) => e.label === c.label)
				.map((e) => ({ start: e.start - g.start, end: e.end - g.start, text: e.text }));
			if (!edits.length) continue;
			const text = reconstruct(current.slice(g.start, g.end), edits);
			const same = alternatives.find((a) => a.text === text);
			if (same) same.label += ` / ${c.label}`;
			else alternatives.push({ label: c.label, text });
		}
		return { start: g.start, end: g.end, alternatives };
	});
}
export function reconstructReview(
	current: string,
	sections: ReviewSection[],
	choices: number[],
): string {
	if (sections.some((s, i) => !s.alternatives[choices[i] ?? -1]))
		throw new Error("Choose an alternative for every changed section.");
	return reconstruct(
		current,
		sections.map((s, i) => ({
			start: s.start,
			end: s.end,
			text: s.alternatives[choices[i]!]!.text,
		})),
	);
}
