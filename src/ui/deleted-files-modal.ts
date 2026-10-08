import { assertNoPathCollisions } from "../sync/path-validation";
import { Modal, Notice, TFile, type App } from "obsidian";
import type { SyncDb } from "../db";
import type { DeletedItem, RemoteFs } from "../fs-remote";
import { confirmAction } from "./confirm";
export class DeletedFilesModal extends Modal {
	private generation = 0;
	private closed = false;
	private restoring = false;
	constructor(
		app: App,
		private remote: RemoteFs,
		private db: SyncDb,
		private reconcile: (path: string) => void,
		private verifyTarget?: () => Promise<void>,
	) {
		super(app);
	}
	onOpen(): void {
		this.titleEl.setText("Deleted files");
		void this.refresh();
	}
	onClose(): void {
		this.closed = true;
		this.generation++;
		this.contentEl.empty();
	}
	private async refresh(): Promise<void> {
		const generation = ++this.generation;
		this.contentEl.setText("Loading Filen trash…");
		try {
			if (!this.remote.listDeleted) throw new Error("Trash browsing is unavailable.");
			const items = await this.remote.listDeleted(
				(await this.db.getDeletedMappings?.()) ?? [],
			);
			if (this.closed || generation !== this.generation) return;
			this.contentEl.empty();
			const search = this.contentEl.createEl("input", {
				type: "search",
				placeholder: "Search deleted files",
			});
			const list = this.contentEl.createDiv({ cls: "filen-deleted-list" });
			const render = () => {
				list.empty();
				for (const item of items.filter((i) =>
					i.path.toLowerCase().includes(search.value.toLowerCase()),
				)) {
					const row = list.createDiv();
					row.createSpan({ text: item.path });
					row.createEl("button", { text: "Restore" }).onclick = () => {
						void this.restore(item);
					};
					if (item.parentMissing)
						row.createEl("p", {
							text: "Restore the original parent folder in Filen first.",
						});
				}
				if (!items.length) list.setText("No deleted items with verified vault ownership.");
			};
			search.oninput = render;
			render();
		} catch (e) {
			if (!this.closed)
				this.contentEl.setText(
					e instanceof Error ? e.message : "Could not load deleted files.",
				);
		}
	}
	private async restore(item: DeletedItem): Promise<void> {
		if (this.restoring) return;
		this.restoring = true;
		try {
			if (
				!(await confirmAction(
					this.app,
					"Restore deleted file",
					`Restore ${item.path} from Filen trash?`,
					"Restore",
				))
			)
				return;
			if (this.closed) return;
			await this.verifyTarget?.();
			if (await this.app.vault.adapter.exists(item.path))
				throw new Error("The local destination is occupied. Move it before restoring.");
			assertNoPathCollisions([
				...this.app.vault
					.getAllLoadedFiles()
					.filter((f) => f.path)
					.map((f) => ({ path: f.path, isDir: !(f instanceof TFile) })),
				{ path: item.path, isDir: item.isDir },
			]);
			if (!this.remote.restoreDeleted) throw new Error("Trash restoration is unavailable.");
			await this.remote.restoreDeleted(item, (await this.db.getDeletedMappings?.()) ?? []);
			this.reconcile(item.path);
			new Notice(`Restored ${item.path}.`);
			await this.refresh();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : "Restoration failed.");
		} finally {
			this.restoring = false;
		}
	}
}
