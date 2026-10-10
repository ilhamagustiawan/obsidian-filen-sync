import { textEdits, reconstruct, textBytes, type Edit } from "./merge";
import { diffDeadline, editGroups } from "./diff";
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
	try {
		const deadline = diffDeadline();
		const changes: Array<Edit & { source: number }> = [];
		for (const [source, copy] of copies.entries())
			changes.push(...textEdits(current, copy.text, deadline).map((e) => ({ ...e, source })));
		return editGroups(changes).map((group) => {
			const alternatives = [
				{ label: "Keep current", text: current.slice(group.start, group.end) },
			];
			for (const [source, copy] of copies.entries()) {
				const edits = group.changes
					.filter((e) => e.source === source)
					.map((e) => ({
						start: e.start - group.start,
						end: e.end - group.start,
						text: e.text,
					}));
				if (!edits.length) continue;
				const text = reconstruct(current.slice(group.start, group.end), edits);
				const same = alternatives.find((a) => a.text === text);
				if (same) same.label += ` / ${copy.label}`;
				else alternatives.push({ label: copy.label, text });
			}
			return { start: group.start, end: group.end, alternatives };
		});
	} catch {
		return undefined;
	}
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
