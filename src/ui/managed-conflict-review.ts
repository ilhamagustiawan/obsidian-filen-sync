import { Notice, type App } from "obsidian";
import type { SyncDb } from "../db";
import type { ConflictRecord, ConflictResolution } from "../sync/conflict-types";
import { readRecovery } from "../sync/recovery";
import {
	analyzeMarkdown,
	analyzeSettings,
	settingsValueText,
	decodeText,
	validSettings,
	type MarkdownAnalysis,
} from "../sync/merge";
import { readableDiff, reconstruct } from "../sync/diff";
import { confirmAction } from "./confirm";

type Config = {
	app: App;
	db: SyncDb;
	panel: HTMLElement;
	record: ConflictRecord;
	isCurrent: () => boolean;
	apply: (resolution: ConflictResolution) => Promise<void>;
	onApplied: () => void;
	onStale: () => void;
	onBusy: (busy: boolean) => void;
};

/** Review immutable recovery snapshots. Application belongs to the coordinator. */
export async function showManagedConflict(config: Config): Promise<void> {
	const { record, panel } = config;
	const read = (snapshot?: ConflictRecord["local"]["recovery"]) =>
		snapshot ? readRecovery(config.app, config.db, snapshot) : undefined;
	const baseBytes = await read(record.base),
		local = await read(record.local.recovery),
		remote = await read(record.remote.recovery);
	const approved = await read(record.approval?.result ?? undefined);
	const copies: Array<{ label: string; bytes: Uint8Array }> = [];
	for (const copy of record.copies ?? []) {
		for (const side of ["local", "remote"] as const) {
			const bytes = await read(copy[side].recovery);
			if (
				bytes &&
				!copies.some(
					(v) =>
						v.bytes.length === bytes.length && v.bytes.every((b, i) => b === bytes[i]),
				)
			)
				copies.push({
					label: `${side === "local" ? "Local" : "Filen"} copy: ${copy.path}`,
					bytes,
				});
		}
	}
	if (!config.isCurrent()) return;
	panel.empty();
	panel.createEl("h3", { text: record.path });
	panel.createEl("p", {
		text: record.approval
			? "Application was interrupted. Retry the approved result or refresh changed versions."
			: "This file is paused. Both originals are preserved until you apply a reviewed result.",
	});
	panel.createEl("p", { text: `Reason: ${record.reason}` });
	if (record.copies?.length)
		panel.createEl("p", {
			text: `${record.copies.length} legacy copies will be removed from Obsidian and Filen after successful application.`,
		});
	const base = baseBytes && decodeText(baseBytes),
		l = local && decodeText(local),
		r = remote && decodeText(remote);
	const versions = panel.createDiv({ cls: "filen-conflict-versions" });
	for (const [label, value, bytes] of [
		["Last synced", base, baseBytes],
		["Local", l, local],
		["Filen", r, remote],
	] as const) {
		if (label === "Last synced" && !bytes) continue;
		const box = versions.createEl("details");
		box.createEl("summary", { text: label });
		box.createEl("pre", {
			text:
				bytes === undefined
					? "File deleted"
					: (value ?? `Binary or oversized file (${bytes.length} bytes)`),
		});
		if (value !== undefined && base !== undefined && label !== "Last synced") {
			const diff = box.createEl("pre", { cls: "filen-conflict-diff" });
			renderDiff(diff, base, value);
		}
	}
	let analysis: MarkdownAnalysis | undefined =
		record.kind === "markdown" && l !== undefined && r !== undefined
			? analyzeMarkdown(base, l, r)
			: undefined;
	if (record.approval) analysis = undefined;
	const settings =
		!record.approval && record.kind === "settings" && l !== undefined && r !== undefined
			? analyzeSettings(l, r, base)
			: undefined;
	const choices = new Map<number, string>();
	const settingChoices = new Map<number, unknown>();
	let whole: Uint8Array | null | undefined = record.approval
		? record.approval.result === null
			? null
			: approved
		: undefined;
	let edited: string | undefined;
	let saving = false;
	const inputs: Array<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement> = [];
	const result = (): Uint8Array | null => {
		let bytes: Uint8Array | null;
		if (edited !== undefined) bytes = new TextEncoder().encode(edited);
		else if (whole !== undefined) bytes = whole;
		else if (settings) bytes = new TextEncoder().encode(settings.result(settingChoices));
		else if (analysis)
			bytes = new TextEncoder().encode(
				reconstruct(
					analysis.base,
					analysis.sections.map((section, i) => {
						const text = section.resolved ?? choices.get(i);
						if (text === undefined)
							throw new Error("Choose a result for every competing section.");
						return { start: section.start, end: section.end, text };
					}),
				),
			);
		else throw new Error("Choose a whole file or edit the result.");
		if (bytes !== null && record.kind === "settings" && !validSettings(decodeText(bytes) ?? ""))
			throw new Error("The result must be a valid JSON settings object.");
		return bytes;
	};
	const button = (text: string, action: () => void) => {
		const element = panel.createEl("button", { text });
		inputs.push(element);
		element.onclick = () => {
			if (!saving) action();
		};
		return element;
	};
	if (!record.approval) {
		for (const copy of copies) {
			const details = panel.createEl("details");
			details.createEl("summary", { text: copy.label });
			details.createEl("pre", {
				text:
					decodeText(copy.bytes) ??
					`Binary or oversized copy (${copy.bytes.length} bytes)`,
			});
			button(`Use ${copy.label}`, () => {
				whole = copy.bytes;
				edited = undefined;
				update();
			});
		}
		if (local !== undefined)
			button(local && remote === undefined ? "Keep edited version" : "Use local file", () => {
				whole = local;
				edited = undefined;
				update();
			});
		if (remote !== undefined)
			button(local === undefined ? "Keep edited version" : "Use Filen file", () => {
				whole = remote;
				edited = undefined;
				update();
			});
		if (local === undefined || remote === undefined)
			button("Delete from both", () => {
				whole = null;
				edited = undefined;
				update();
			});
		if (analysis) {
			const competing = analysis.sections.filter((s) => s.resolved === undefined).length;
			panel.createEl("p", {
				text: `${analysis.sections.length - competing} independent changes included · ${competing} sections need review`,
			});
			for (const [i, section] of analysis.sections.entries()) {
				if (section.resolved !== undefined) continue;
				panel.createEl("h4", { text: `Competing section ${i + 1}` });
				const prefix = analysis.base
					.slice(0, section.start)
					.split("\n")
					.slice(-3)
					.join("\n");
				const suffix = analysis.base.slice(section.end).split("\n").slice(0, 3).join("\n");
				panel.createEl("pre", { text: prefix, cls: "filen-conflict-context" });
				panel.createEl("pre", {
					text: section.base || "(insertion)",
					cls: "filen-conflict-base",
				});
				for (const [label, text] of [
					["Use local", section.local],
					["Use Filen", section.remote],
				] as const) {
					const row = panel.createEl("label", { cls: "filen-review-choice" });
					const radio = row.createEl("input", { type: "radio" });
					radio.name = `managed-${record.revision}-${i}`;
					inputs.push(radio);
					row.createSpan({ text: label });
					renderDiff(row.createEl("pre"), section.base, text);
					radio.onchange = () => {
						if (!saving) {
							choices.set(i, text);
							whole = undefined;
							edited = undefined;
							update();
						}
					};
				}
				panel.createEl("pre", { text: suffix, cls: "filen-conflict-context" });
			}
		}
		if (settings) {
			panel.createEl("p", {
				text: `Independent settings changes are included. ${settings.sections.length} keys need review.`,
			});
			for (const [i, section] of settings.sections.entries()) {
				panel.createEl("h4", { text: `Settings key: ${section.path}` });
				panel.createEl("pre", {
					text: settingsValueText(section.base),
					cls: "filen-conflict-base",
				});
				for (const [label, value] of [
					["Use local", section.local],
					["Use Filen", section.remote],
				] as const) {
					const row = panel.createEl("label", { cls: "filen-review-choice" });
					const radio = row.createEl("input", { type: "radio" });
					radio.name = `settings-${record.revision}-${i}`;
					inputs.push(radio);
					row.createSpan({ text: label });
					row.createEl("pre", { text: settingsValueText(value) });
					radio.onchange = () => {
						if (!saving) {
							settingChoices.set(i, value);
							whole = undefined;
							edited = undefined;
							update();
						}
					};
				}
			}
		}
	}
	panel.createEl("h4", { text: "Result preview" });
	const preview = panel.createEl("pre", { cls: "filen-conflict-result" });
	const editable =
		!record.approval &&
		record.kind !== "file" &&
		[local, remote].every((v) => v === undefined || decodeText(v) !== undefined);
	const editor = editable
		? panel.createEl("textarea", { cls: "filen-conflict-editor" })
		: undefined;
	if (editor) {
		inputs.push(editor);
		editor.setAttr("aria-label", "Edit conflict result");
		editor.value = l ?? r ?? "";
		editor.oninput = () => {
			if (!saving) {
				edited = editor.value;
				update();
			}
		};
	}
	const save = button(record.approval ? "Retry apply and sync" : "Apply and sync", () => {
		void apply();
	});
	save.addClass("mod-cta");
	function update(): void {
		try {
			const bytes = result();
			const text =
				bytes === null
					? "Delete this file from both Obsidian and Filen."
					: (decodeText(bytes) ?? `Binary file selected (${bytes.length} bytes)`);
			preview.setText(text);
			if (editor && edited === undefined && bytes !== null)
				editor.value = decodeText(bytes) ?? "";
			save.disabled = saving;
		} catch (error) {
			preview.setText((error as Error).message);
			save.disabled = true;
		}
	}
	async function apply(): Promise<void> {
		if (saving || !config.isCurrent()) return;
		saving = true;
		config.onBusy(true);
		for (const input of inputs) input.disabled = true;
		try {
			const bytes = result();
			if (
				!(await confirmAction(
					config.app,
					"Resolve conflict",
					`Apply this reviewed result to ${record.path} in Obsidian and Filen now?${record.copies?.length ? ` Remove all ${record.copies.length} reviewed conflict copies from both sides after verification.` : ""}`,
					"Apply and sync",
				))
			)
				return;
			if (!config.isCurrent()) return;
			await config.apply({ path: record.path, revision: record.revision, bytes });
			if (config.isCurrent()) config.onApplied();
		} catch (error) {
			new Notice(
				error instanceof Error
					? error.message
					: "Resolution failed; review remains pending.",
			);
			if (config.isCurrent()) config.onStale();
		} finally {
			saving = false;
			config.onBusy(false);
			for (const input of inputs) input.disabled = false;
			if (config.isCurrent()) update();
		}
	}
	update();
}
function renderDiff(element: HTMLElement, base: string, next: string): void {
	try {
		for (const [kind, text] of readableDiff(base, next))
			element.createEl(kind === 1 ? "ins" : kind === -1 ? "del" : "span", { text });
	} catch {
		element.setText(next);
	}
}
