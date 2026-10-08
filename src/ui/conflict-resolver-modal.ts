import { Modal, Notice, TFile, type App } from "obsidian";
import type { SyncDb } from "../db";
import { getOriginalPathFromConflictPath } from "../sync/conflict-utils";
import { decodeText } from "../sync/merge";
import { sha256Hex } from "../sync/content-hash";
import { preserveRecovery } from "../sync/recovery";
import { reviewSections, reconstructReview, type ReviewSection } from "../sync/review-sections";
import { confirmAction } from "./confirm";

type Version = {
	adapterOnly?: boolean;
	file: TFile;
	bytes: Uint8Array;
	hash: string;
	text?: string;
};
type Review = {
	current: Version;
	copies: Version[];
	sections?: ReviewSection[];
	choices: number[];
	whole?: number;
};
type Config = {
	app: App;
	db: SyncDb;
	pluginId: string;
	files: () => TFile[];
	onResolved: (path: string) => void;
	onClosed: () => void;
	selectedSettings?: string[];
	verifyTarget?: () => Promise<void>;
};
export class ConflictResolverModal extends Modal {
	private search = "";
	private page = 0;
	private selected = "";
	private reviews = new Map<string, Review>();
	private panel?: HTMLElement;
	private generation = 0;
	private closed = false;
	private saving = false;
	constructor(private config: Config) {
		super(config.app);
		this.modalEl.addClass("filen-conflict-resolver");
	}
	onOpen(): void {
		this.titleEl.setText("Review conflicts");
		this.render();
	}
	onClose(): void {
		this.closed = true;
		this.generation++;
		this.reviews.clear();
		this.contentEl.empty();
		this.config.onClosed();
	}
	private render(): void {
		this.contentEl.empty();
		const search = this.contentEl.createEl("input", {
			type: "search",
			placeholder: "Search files",
		});
		search.value = this.search;
		search.oninput = () => {
			this.search = search.value;
			this.page = 0;
			this.renderList(list);
		};
		const layout = this.contentEl.createDiv({ cls: "filen-review-layout" });
		const list = layout.createDiv({ cls: "filen-review-list" });
		this.panel = layout.createDiv({ cls: "filen-review-preview" });
		this.renderList(list);
		if (this.selected) void this.select(this.selected);
	}
	private renderList(list: HTMLElement): void {
		list.empty();
		const paths = [
			...new Set(this.config.files().map((f) => getOriginalPathFromConflictPath(f.path))),
		]
			.filter((p) => p.toLowerCase().includes(this.search.toLowerCase()))
			.sort();
		for (const path of paths.slice(this.page * 25, (this.page + 1) * 25)) {
			list.createEl("button", {
				text: path,
				cls: path === this.selected ? "mod-cta" : "",
			}).onclick = () => {
				if (!this.saving) void this.select(path);
			};
		}
		const prev = list.createEl("button", { text: "Previous" });
		prev.disabled = !this.page;
		prev.onclick = () => {
			this.page--;
			this.renderList(list);
		};
		const next = list.createEl("button", { text: "Next" });
		next.disabled = (this.page + 1) * 25 >= paths.length;
		next.onclick = () => {
			this.page++;
			this.renderList(list);
		};
		list.createEl("p", { text: `${paths.length} files` });
	}
	private async load(file: TFile): Promise<Version> {
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		return { file, bytes, hash: await sha256Hex(bytes), text: decodeText(bytes) };
	}
	private async loadAdapter(file: TFile): Promise<Version> {
		const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(file.path));
		return {
			file,
			bytes,
			hash: await sha256Hex(bytes),
			text: decodeText(bytes),
			adapterOnly: true,
		};
	}
	private readVersion(version: Version): Promise<ArrayBuffer> {
		return version.adapterOnly
			? this.app.vault.adapter.readBinary(version.file.path)
			: this.app.vault.readBinary(version.file);
	}
	private async select(path: string): Promise<void> {
		const generation = ++this.generation;
		this.selected = path;
		this.panel?.setText("Loading…");
		try {
			let file = this.app.vault.getAbstractFileByPath(path);
			const adapterOnly = this.config.selectedSettings?.includes(path);
			if (!file && adapterOnly) {
				const stat = await this.app.vault.adapter.stat(path);
				if (stat?.type === "file") {
					const f = new TFile();
					f.path = path;
					f.name = path.split("/").pop()!;
					f.stat = stat;
					file = f;
				}
			}
			if (!(file instanceof TFile))
				throw new Error("Open a conflict copy to recover the missing original first.");
			const copies = this.config
				.files()
				.filter((f) => getOriginalPathFromConflictPath(f.path) === path);
			const current = adapterOnly ? await this.loadAdapter(file) : await this.load(file),
				versions = await Promise.all(copies.map((f) => this.load(f)));
			if (this.closed || generation !== this.generation) return;
			const previous = this.reviews.get(path);
			if (
				previous?.current.hash === current.hash &&
				previous.copies.length === versions.length &&
				versions.every(
					(v, i) =>
						v.file.path === previous.copies[i]?.file.path &&
						v.hash === previous.copies[i]?.hash,
				)
			) {
				this.show(previous);
				return;
			}
			const sections =
				current.text !== undefined && versions.every((v) => v.text !== undefined)
					? reviewSections(
							current.text,
							versions.map((v) => ({ label: v.file.name, text: v.text! })),
						)
					: undefined;
			const review: Review = { current, copies: versions, sections, choices: [] };
			this.reviews.set(path, review);
			this.show(review);
		} catch (e) {
			if (!this.closed && generation === this.generation)
				this.panel?.setText(e instanceof Error ? e.message : "Could not load conflict.");
		}
	}
	private result(review: Review): Uint8Array {
		if (review.sections && review.current.text !== undefined)
			return new TextEncoder().encode(
				reconstructReview(review.current.text, review.sections, review.choices),
			);
		const version = [review.current, ...review.copies][review.whole ?? -1];
		if (!version) throw new Error("Choose a whole file.");
		return version.bytes;
	}
	private show(review: Review): void {
		const panel = this.panel!;
		panel.empty();
		panel.createEl("h3", { text: this.selected });
		for (const [i, version] of [review.current, ...review.copies].entries())
			panel.createEl("button", {
				text: i ? `Open copy: ${version.file.name}` : "Open current",
			}).onclick = () => {
				void this.app.workspace.getLeaf(false).openFile(version.file);
			};
		if (review.sections) {
			for (const [i, section] of review.sections.entries()) {
				panel.createEl("h4", { text: `Changed section ${i + 1}` });
				for (const [choice, alternative] of section.alternatives.entries()) {
					const label = panel.createEl("label", { cls: "filen-review-choice" });
					const radio = label.createEl("input", { type: "radio" });
					radio.name = `section-${i}`;
					radio.checked = review.choices[i] === choice;
					label.createSpan({ text: alternative.label });
					label.createEl("pre", { text: alternative.text });
					radio.onchange = () => {
						review.choices[i] = choice;
						update();
					};
				}
			}
		} else {
			panel.createEl("p", {
				text: "Comparison exceeds limits or contains binary data. Choose a whole file.",
			});
			for (const [i, v] of [review.current, ...review.copies].entries()) {
				const button = panel.createEl("button", {
					text: i ? `Use ${v.file.name}` : "Keep current",
				});
				button.onclick = () => {
					review.whole = i;
					update();
				};
			}
		}
		panel.createEl("h4", { text: "Saved result preview" });
		const preview = panel.createEl("pre");
		const save = panel.createEl("button", { text: "Apply and trash copies", cls: "mod-cta" });
		const update = () => {
			try {
				const bytes = this.result(review);
				preview.setText(decodeText(bytes) ?? "Binary file selected");
				save.disabled = false;
			} catch (e) {
				preview.setText((e as Error).message);
				save.disabled = true;
			}
		};
		save.onclick = () => {
			void this.apply(review);
		};
		update();
	}
	private async apply(review: Review): Promise<void> {
		if (this.saving) return;
		const path = this.selected;
		this.saving = true;
		try {
			const bytes = this.result(review);
			if (
				!(await confirmAction(
					this.app,
					"Resolve conflict",
					`Save the preview to ${path} and move ${review.copies.length} conflict copies to trash?`,
					"Apply and trash copies",
				))
			)
				return;
			if (this.closed) return;
			await this.config.verifyTarget?.();
			for (const version of [review.current, ...review.copies]) {
				const file = this.app.vault.getAbstractFileByPath(version.file.path);
				if (
					(!version.adapterOnly && file !== version.file) ||
					(await sha256Hex(new Uint8Array(await this.readVersion(version)))) !==
						version.hash
				)
					throw new Error("Reviewed files changed. Select the file again to refresh.");
			}
			await preserveRecovery(
				this.app,
				this.config.db,
				this.config.pluginId,
				path,
				review.current.bytes,
				"Before conflict review",
			);
			if (review.current.adapterOnly)
				await this.app.vault.adapter.writeBinary(path, bytes.slice().buffer);
			else await this.app.vault.modifyBinary(review.current.file, bytes.slice().buffer);
			if (
				(await sha256Hex(new Uint8Array(await this.readVersion(review.current)))) !==
				(await sha256Hex(bytes))
			)
				throw new Error("Saved result changed; copies were retained.");
			for (const v of review.copies) {
				if (
					(await sha256Hex(new Uint8Array(await this.app.vault.readBinary(v.file)))) !==
					v.hash
				)
					throw new Error("A copy changed; remaining copies were retained.");
				await this.app.fileManager.trashFile(v.file);
			}
			this.config.onResolved(path);
			this.reviews.delete(path);
			this.selected = "";
			this.render();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : "Resolution failed.");
		} finally {
			this.saving = false;
		}
	}
}
