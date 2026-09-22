import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";

export const MAX_ACTIVITY_LOG_ENTRIES = 500;

export type ActivityLogKind = "general" | "error" | "skipped" | "conflict" | "account" | "network";

export type ActivityLogEntry = {
	at: number;
	message: string;
	kind: ActivityLogKind;
};

export type ActivityLogHost = {
	getActivityLogs(): readonly ActivityLogEntry[];
	clearActivityLogs(): Promise<void>;
	onActivityLogsChanged(listener: () => void): () => void;
};

export const formatActivityLogEntry = (entry: ActivityLogEntry): string =>
	`${formatActivityLogTimestamp(entry.at)} - ${entry.message}`;

export const formatActivityLogTimestamp = (epochMs: number): string => {
	const date = new Date(epochMs);
	const year = date.getFullYear();
	const month = pad2(date.getMonth() + 1);
	const day = pad2(date.getDate());
	const hours = pad2(date.getHours());
	const minutes = pad2(date.getMinutes());
	return `${year}-${month}-${day} ${hours}:${minutes}`;
};

export const readActivityLogs = (value: unknown): ActivityLogEntry[] => {
	if (!Array.isArray(value)) return [];
	const entries = value
		.map(readActivityLogEntry)
		.filter((entry): entry is ActivityLogEntry => entry !== null);
	return trimActivityLogs(entries);
};

export const trimActivityLogs = (entries: ActivityLogEntry[]): ActivityLogEntry[] =>
	entries.slice(Math.max(0, entries.length - MAX_ACTIVITY_LOG_ENTRIES));

export const inferActivityLogKind = (message: string): ActivityLogKind => {
	const lower = message.toLowerCase();
	if (lower.includes("conflict")) return "conflict";
	if (
		lower.includes("skipped") ||
		lower.includes("ignored") ||
		lower.includes("need deletion confirmation")
	)
		return "skipped";
	if (
		lower.includes("not logged in") ||
		lower.includes("auth") ||
		lower.includes("password missing") ||
		lower.includes("email missing") ||
		lower.includes("account")
	)
		return "account";
	if (
		lower.includes("network") ||
		lower.includes("timeout") ||
		lower.includes("unable to connect") ||
		lower.includes("disconnected from server")
	)
		return "network";
	if (
		lower.includes("failed") ||
		lower.includes("error") ||
		lower.includes("unable to") ||
		lower.includes("out of memory")
	)
		return "error";
	return "general";
};

export class ActivityLogModal extends Modal {
	private unsubscribe: (() => void) | null = null;
	private listEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly host: ActivityLogHost,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("filen-sync-activity-log-modal");
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "Activity logs" });
		this.contentEl.createEl("p", {
			text: "Recent connection and sync activity.",
			cls: "filen-sync-activity-log-description",
		});

		const actions = this.contentEl.createDiv({ cls: "filen-sync-activity-log-actions" });
		const copyButton = actions.createEl("button", { text: "Copy logs" });
		copyButton.addEventListener("click", () => {
			void this.copyLogs();
		});

		const clearButton = actions.createEl("button", { text: "Clear logs" });
		clearButton.addClass("mod-warning");
		clearButton.addEventListener("click", () => {
			void this.clearLogs();
		});

		this.listEl = this.contentEl.createDiv({ cls: "filen-sync-activity-log-list" });
		this.renderLogs();
		this.unsubscribe = this.host.onActivityLogsChanged(() => this.renderLogs());
	}

	onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.listEl = null;
		this.contentEl.empty();
	}

	private renderLogs(): void {
		if (this.listEl === null) return;
		this.listEl.empty();
		const logs = [...this.host.getActivityLogs()].reverse();
		if (logs.length === 0) {
			this.listEl.createDiv({
				cls: "filen-sync-activity-log-empty",
				text: "No activity yet.",
			});
			return;
		}

		for (const entry of logs) {
			this.listEl.createDiv({
				cls: "filen-sync-activity-log-line",
				text: formatActivityLogEntry(entry),
			});
		}
	}

	private async copyLogs(): Promise<void> {
		const text = this.host.getActivityLogs().map(formatActivityLogEntry).join("\n");
		if (text.length === 0) {
			new Notice("No activity logs to copy.");
			return;
		}

		try {
			await navigator.clipboard.writeText(text);
			new Notice("Activity logs copied.");
		} catch (error) {
			console.error("Filen Sync: failed to copy activity logs", error);
			new Notice("Could not copy activity logs.");
		}
	}

	private clearLogs(): void {
		void confirmAction(
			this.app,
			"Clear activity logs?",
			"This removes recent sync activity from plugin settings.",
			"Clear logs",
		).then(async (confirmed) => {
			if (!confirmed) return;
			await this.host.clearActivityLogs();
			new Notice("Activity logs cleared.");
		});
	}
}

const confirmAction = (
	app: App,
	title: string,
	message: string,
	confirmText: string,
): Promise<boolean> =>
	new Promise((resolve) => {
		new ConfirmModal(app, title, message, confirmText, resolve).open();
	});

class ConfirmModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly confirmText: string,
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: this.title });
		this.contentEl.createEl("p", { text: this.message });
		const btns = this.contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = btns.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => {
			this.finish(false);
		});
		const confirm = btns.createEl("button", { text: this.confirmText });
		confirm.addClass("mod-warning");
		confirm.addEventListener("click", () => {
			this.finish(true);
		});
	}

	onClose(): void {
		if (!this.resolved) this.resolve(false);
		this.contentEl.empty();
	}

	private finish(confirmed: boolean): void {
		this.resolved = true;
		this.resolve(confirmed);
		this.close();
	}
}

const readActivityLogEntry = (value: unknown): ActivityLogEntry | null => {
	if (typeof value === "string") {
		return { at: Date.now(), message: value, kind: inferActivityLogKind(value) };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : null;
	const message = typeof record.message === "string" ? record.message.trim() : "";
	const kind = readActivityLogKind(record.kind, message);
	if (at === null || message.length === 0) return null;
	return { at, message, kind };
};

const readActivityLogKind = (value: unknown, message: string): ActivityLogKind => {
	if (
		value === "general" ||
		value === "error" ||
		value === "skipped" ||
		value === "conflict" ||
		value === "account" ||
		value === "network"
	) {
		return value;
	}
	return inferActivityLogKind(message);
};

const pad2 = (value: number): string => value.toString().padStart(2, "0");
