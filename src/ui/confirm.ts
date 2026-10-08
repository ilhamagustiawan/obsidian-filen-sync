import { Modal, type App } from "obsidian";
export function confirmAction(
	app: App,
	title: string,
	message: string,
	action = "Apply",
): Promise<boolean> {
	return new Promise((resolve) => new Confirmation(app, title, message, action, resolve).open());
}
class Confirmation extends Modal {
	private answered = false;
	constructor(
		app: App,
		private heading: string,
		private message: string,
		private action: string,
		private answer: (value: boolean) => void,
	) {
		super(app);
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
