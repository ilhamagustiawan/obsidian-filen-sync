import type { App } from "obsidian";
import { MobileDialog } from "./mobile-dialog";
export function confirmAction(
	app: App,
	title: string,
	message: string,
	action = "Apply",
): Promise<boolean> {
	return new Promise((resolve) => new Confirmation(app, title, message, action, resolve).open());
}
class Confirmation extends MobileDialog {
	private answered = false;
	constructor(
		app: App,
		private heading: string,
		private message: string,
		private action: string,
		private answer: (value: boolean) => void,
	) {
		super(app);
		this.modalEl.addClass("filen-confirm-dialog");
	}
	onOpen(): void {
		this.titleEl.setText(this.heading);
		this.contentEl.createEl("p", { text: this.message });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		buttons.createEl("button", { text: this.action, cls: "mod-cta" }).onclick = () => {
			this.answered = true;
			this.answer(true);
			this.close();
		};
	}
	onClose(): void {
		if (!this.answered) this.answer(false);
		this.contentEl.empty();
	}
}

/** Confirmation styled for destructive actions (warning button, inline heading). */
export function confirmDestructiveAction(
	app: App,
	title: string,
	message: string,
	confirmText: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmActionModal(app, title, message, confirmText, resolve).open();
	});
}

class ConfirmActionModal extends MobileDialog {
	private resolved = false;

	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly confirmText: string,
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
		this.modalEl.addClass("filen-confirm-dialog");
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: this.title });
		this.contentEl.createEl("p", { text: this.message });

		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		const cancelButton = actions.createEl("button", { text: "Cancel" });
		cancelButton.addEventListener("click", () => {
			this.finish(false);
		});

		const confirmButton = actions.createEl("button", { text: this.confirmText });
		confirmButton.addClass("mod-warning");
		confirmButton.addEventListener("click", () => {
			this.finish(true);
		});
	}

	onClose(): void {
		if (!this.resolved) this.finish(false);
	}

	private finish(confirmed: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(confirmed);
		this.close();
	}
}
