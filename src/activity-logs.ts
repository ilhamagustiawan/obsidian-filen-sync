import type { App } from "obsidian";
import { Modal } from "obsidian";

export const MAX_ACTIVITY_LOG_ENTRIES = 500;

export type ActivityLogKind = "general" | "error" | "skipped" | "conflict" | "account" | "network";

export type ActivityLogEntry = {
	at: number;
	message: string;
	kind: ActivityLogKind;
};

export type ActivityLogFilter = "all" | "activity" | "issues";

export const filterActivityLogs = (
	entries: readonly ActivityLogEntry[],
	filter: ActivityLogFilter = "all",
	search = "",
): ActivityLogEntry[] => {
	const query = search.trim().toLowerCase();
	return [...entries]
		.filter((entry) => {
			const isIssue = entry.kind !== "general";
			return (
				(filter === "all" || (filter === "issues" ? isIssue : !isIssue)) &&
				(entry.message.toLowerCase().includes(query) ||
					formatActivityLogTimestamp(entry.at).toLowerCase().includes(query))
			);
		})
		.sort((a, b) => b.at - a.at);
};

export const summarizeActivityLogs = (visible: number, total: number): string =>
	`Showing ${visible} of ${total}`;

export type ActivityLogHost = {
	getActivityLogs(): readonly ActivityLogEntry[];
	clearActivityLogs(): Promise<void>;
	onActivityLogsChanged(listener: () => void): () => void;
	isOffline?: () => boolean;
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
	return `${year}-${month}-${day} ${hours}:${minutes}:${pad2(date.getSeconds())}`;
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
	private summaryEl: HTMLElement | null = null;
	private filter: ActivityLogFilter = "all";
	private search = "";

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

		const isOffline = this.host.isOffline?.() ?? false;
		const connDiv = this.contentEl.createDiv({ cls: "filen-sync-activity-log-connection" });
		connDiv.createSpan({ text: "Connection: " });
		connDiv.createSpan({
			text: isOffline ? "Offline" : "Online",
			cls: `filen-sync-connection-badge ${isOffline ? "is-offline" : "is-online"}`,
		});

		const actions = this.contentEl.createDiv({ cls: "filen-sync-activity-log-actions" });
		const clearButton = actions.createEl("button", { text: "Clear logs" });
		clearButton.addClass("mod-warning");
		clearButton.addEventListener("click", () => {
			void this.host.clearActivityLogs();
		});
		const filters = this.contentEl.createDiv({
			cls: "filen-sync-activity-log-filters",
			attr: { role: "group", "aria-label": "Filter activity logs" },
		});
		for (const [value, label] of [
			["all", "All"],
			["activity", "Activity"],
			["issues", "Issues"],
		] as const) {
			const button = filters.createEl("button", {
				text: label,
				cls: "filen-sync-activity-log-filter",
			});
			button.setAttr("aria-pressed", String(this.filter === value));
			if (this.filter === value) button.addClass("is-active");
			button.addEventListener("click", () => {
				this.filter = value;
				this.renderLogs();
			});
		}
		const search = this.contentEl.createDiv({ cls: "filen-sync-activity-log-search" });
		const input = search.createEl("input", {
			attr: {
				type: "search",
				placeholder: "Search activity",
				"aria-label": "Search activity logs",
			},
		});
		input.value = this.search;
		input.addEventListener("input", () => {
			this.search = input.value;
			this.renderLogs();
		});
		this.summaryEl = this.contentEl.createDiv({
			cls: "filen-sync-activity-log-summary",
			attr: { "aria-live": "polite" },
		});

		this.listEl = this.contentEl.createDiv({ cls: "filen-sync-activity-log-list" });
		this.renderLogs();
		this.unsubscribe = this.host.onActivityLogsChanged(() => this.renderLogs());
	}

	onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.listEl = null;
		this.summaryEl = null;
		this.contentEl.empty();
	}

	private renderLogs(): void {
		if (this.listEl === null) return;
		this.listEl.empty();
		const allLogs = this.host.getActivityLogs();
		const logs = filterActivityLogs(allLogs, this.filter, this.search);
		this.summaryEl?.setText(summarizeActivityLogs(logs.length, allLogs.length));
		if (allLogs.length === 0 || logs.length === 0) {
			this.listEl.createDiv({
				cls: "filen-sync-activity-log-empty",
				text:
					allLogs.length === 0 ? "No activity yet." : "No activity matches your filters.",
			});
			return;
		}

		for (const entry of logs) {
			const row = this.listEl.createDiv({
				cls: `filen-sync-activity-log-row is-${entry.kind}`,
			});
			const meta = row.createDiv({ cls: "filen-sync-activity-log-row-meta" });
			meta.createEl("time", {
				text: formatActivityLogTimestamp(entry.at),
				attr: { datetime: new Date(entry.at).toISOString(), "aria-label": "Timestamp" },
				cls: "filen-sync-activity-log-time",
			});
			meta.createSpan({
				text: entry.kind,
				cls: `filen-sync-activity-log-kind is-${entry.kind}`,
			});
			row.createDiv({ text: entry.message, cls: "filen-sync-activity-log-message" });
		}
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
