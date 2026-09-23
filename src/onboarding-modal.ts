import { Modal, type App } from "obsidian";

type FilenSyncSetupModalConfig = {
	app: App;
	onOpenSettings: () => void;
};

export class FilenSyncSetupModal extends Modal {
	constructor(private readonly config: FilenSyncSetupModalConfig) {
		super(config.app);
		this.modalEl.addClass("filen-sync-setup-modal");
	}

	onOpen(): void {
		this.contentEl.empty();

		// eslint-disable-next-line obsidianmd/ui/sentence-case
		this.contentEl.createEl("h2", { text: "Set up Obsidian Filen Sync" });
		this.contentEl.createEl("p", {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			text: "Mirror this vault to a dedicated Filen folder. Start with a manual sync, then enable auto-sync when you are ready.",
			cls: "filen-sync-setup-copy",
		});

		const steps = this.contentEl.createEl("ol", { cls: "filen-sync-setup-steps" });
		steps.createEl("li", { text: "Open plugin settings" });
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		steps.createEl("li", { text: "Enter your Filen email, password, and optional 2FA code" });
		steps.createEl("li", {
			text: "Keep the default remote folder or choose one dedicated to this vault",
		});
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		steps.createEl("li", { text: "Click Login to authenticate" });
		steps.createEl("li", { text: "Run sync now to create the mirror" });

		const note = this.contentEl.createDiv({ cls: "filen-sync-setup-note" });
		note.createEl("strong", { text: "Privacy and first sync" });
		note.createSpan({
			text: " Password and 2FA stay in memory. Remembered derived credentials are stored in Obsidian SecretStorage. Existing sync history stays inactive; the first sync is conservative and may create conflict copies.",
		});

		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		const later = actions.createEl("button", { text: "Later" });
		later.addEventListener("click", () => this.close());

		const openSettings = actions.createEl("button", { text: "Open settings" });
		openSettings.addClass("mod-cta");
		openSettings.addEventListener("click", () => {
			this.close();
			this.config.onOpenSettings();
		});
	}
}
