import type { Plugin, TFile } from "obsidian";
import { Menu, Platform, setIcon, setTooltip } from "obsidian";
import type { FilenSyncSettings } from "../settings";
import { formatRelativeTime, type StatusBarState, type SyncCoordinator } from "../sync/coordinator";
import type { SyncDirection } from "../sync/types";
import { formatLastSyncSummary, syncIconPresentation } from "./sync-presentation";

export type StatusBarActions = {
	reviewConflicts(): void;
	togglePaused(): void;
	openVersionHistory(file: TFile): void;
	openActivityLogs(): void;
	openDeletedFiles(): void;
	openSettings(): void;
	syncNow(): void;
	showProgress(): void;
	preview(direction: SyncDirection): void;
	forceSync(file: TFile): void;
	pushLocal(): void;
	pullRemote(): void;
	openDiagnosticHistory(): void;
};

export type StatusBarHost = {
	plugin: Plugin;
	settings: () => FilenSyncSettings;
	state: () => StatusBarState;
	coordinator: () => SyncCoordinator;
	connected: () => boolean;
	offline: () => boolean;
	lastSync: () => { timestamp: number | null; summary: string | null };
	actions: StatusBarActions;
};

/** Desktop status bar item, ribbon icon state, and the shared sync menu. */
export class StatusBar {
	private itemEl: HTMLElement | null = null;
	private iconEl: HTMLElement | null = null;
	private textEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;

	constructor(private readonly host: StatusBarHost) {}

	attach(itemEl: HTMLElement | null): void {
		this.itemEl = itemEl;
		if (itemEl === null) return;
		const { plugin } = this.host;
		itemEl.empty();
		itemEl.addClass("filen-sync-status-item");
		itemEl.setAttr("role", "button");
		itemEl.setAttr("tabindex", "0");
		plugin.registerDomEvent(itemEl, "keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			const bounds = this.itemEl?.getBoundingClientRect();
			this.openMenuAt(bounds?.left ?? 0, bounds?.top ?? 0);
		});
		this.iconEl = itemEl.createSpan({ cls: "filen-sync-status-icon" });
		this.textEl = itemEl.createSpan({ cls: "filen-sync-status-text" });
		plugin.registerDomEvent(itemEl, "click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openMenu(event);
		});
		plugin.registerDomEvent(itemEl, "contextmenu", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openMenu(event);
		});
	}

	attachRibbon(ribbonEl: HTMLElement): void {
		this.ribbonEl = ribbonEl;
	}

	openMenu(event: MouseEvent): void {
		this.buildMenu().showAtMouseEvent(event);
	}

	openMenuAt(x: number, y: number): void {
		this.buildMenu().showAtPosition({ x, y });
	}

	buildMenu(): Menu {
		const { actions } = this.host;
		const coordinator = this.host.coordinator();
		const settings = this.host.settings();
		const menu = new Menu();
		if (Platform.isMobile) {
			menu.addItem((item) => item.setTitle(this.iconModel().label).setDisabled(true));
			menu.addItem((item) => item.setTitle(this.lastSyncSummary()).setDisabled(true));
			menu.addSeparator();
		}
		const add = (
			target: Menu,
			title: string,
			icon: string,
			action: () => void,
			disabled = false,
		) =>
			target.addItem((item) =>
				item.setTitle(title).setIcon(icon).setDisabled(disabled).onClick(action),
			);
		const count = coordinator.conflictCount;
		if (count)
			add(menu, `Review conflicts (${count})`, "triangle-alert", actions.reviewConflicts);
		add(
			menu,
			settings.syncPaused ? "Resume" : "Pause",
			settings.syncPaused ? "circle-play" : "circle-pause",
			actions.togglePaused,
		);
		const active = this.host.plugin.app.workspace.getActiveFile();
		add(
			menu,
			"Version history",
			"history",
			() => {
				if (active) actions.openVersionHistory(active);
			},
			!active || active.extension !== "md",
		);
		add(menu, "Open Sync log", "align-left", actions.openActivityLogs);
		add(menu, "Deleted files", "trash-2", actions.openDeletedFiles);
		add(menu, "Sync settings", "settings", actions.openSettings);
		menu.addSeparator();
		add(menu, "Sync now", "refresh-cw", actions.syncNow, coordinator.active);
		add(menu, "Show sync progress", "align-left", actions.showProgress);
		menu.addItem((item) => {
			item.setTitle("Advanced").setIcon("sliders-horizontal");
			const advanced = (item as unknown as { setSubmenu(): Menu }).setSubmenu();
			add(advanced, "Preview changes", "eye", () => actions.preview("both"));
			if (active)
				add(advanced, `Force sync "${active.name}"`, "file-up", () =>
					actions.forceSync(active),
				);
			add(advanced, "Push local files", "arrow-up", actions.pushLocal);
			add(advanced, "Pull remote files", "arrow-down", actions.pullRemote);
			add(advanced, "Preview push (local → Filen)", "arrow-up", () =>
				actions.preview("push"),
			);
			add(advanced, "Preview pull (Filen → local)", "arrow-down", () =>
				actions.preview("pull"),
			);
			add(advanced, "Open diagnostic plan history", "history", actions.openDiagnosticHistory);
		});
		return menu;
	}

	render(): void {
		if (!this.itemEl || !this.iconEl || !this.textEl) return;
		this.itemEl.toggleClass("is-mobile-hidden", Platform.isMobile);
		this.itemEl.toggleClass(
			"is-icon-only",
			this.host.settings().statusBarIndicatorStyle === "icon",
		);
		const model = this.iconModel();
		this.itemEl.setAttr("data-sync-state", model.state);
		setIcon(this.iconEl, model.icon);
		this.textEl.setText(`Filen: ${model.label}`);
		const tooltip = this.buildTooltip();
		setTooltip(this.itemEl, tooltip);
		this.itemEl.setAttr("aria-label", tooltip);
	}

	renderRibbon(): void {
		if (!this.ribbonEl) return;
		const model = this.iconModel();
		setIcon(this.ribbonEl, model.icon);
		this.ribbonEl.setAttr("data-sync-state", model.state);
		setTooltip(this.ribbonEl, `Filen: ${model.label}. Select to open sync menu`);
	}

	iconModel() {
		const coordinator = this.host.coordinator();
		return syncIconPresentation(this.host.state(), {
			connected: this.host.connected(),
			offline: this.host.offline(),
			paused: this.host.settings().syncPaused,
			pending: coordinator.pendingCount,
			conflicts: coordinator.conflictCount,
		});
	}

	exactLastSyncSummary(): string {
		const { timestamp, summary } = this.host.lastSync();
		const label =
			timestamp === null
				? "Not synced yet"
				: `Last synced ${new Date(timestamp).toLocaleString()}`;
		return summary ? `${label} · ${summary}` : label;
	}

	private lastSyncSummary(): string {
		return formatLastSyncSummary(this.host.lastSync().timestamp, formatRelativeTime);
	}

	private buildTooltip(): string {
		const state = this.host.state();
		const settings = this.host.settings();
		const coordinator = this.host.coordinator();
		const { timestamp, summary } = this.host.lastSync();
		const lines: string[] = ["Filen Sync", this.lastSyncSummary()];
		if (summary) lines.push(summary);

		if (!this.host.connected()) {
			lines.push("Not connected", "Click to configure account.");
			return lines.join("\n");
		}

		if (settings.syncPaused) {
			lines.push("Sync paused", "Click to resume or view actions.");
			if (coordinator.pendingCount > 0)
				lines.push(`${coordinator.pendingCount} local changes pending.`);
			return lines.join("\n");
		}

		if (this.host.offline()) {
			lines.push("Offline", "Sync will resume automatically when reconnected.");
			if (coordinator.pendingCount > 0)
				lines.push(`${coordinator.pendingCount} local changes pending.`);
			return lines.join("\n");
		}

		if (state.kind === "syncing") {
			const label = isAllFilesSyncedStatus(state) ? "All files synced" : state.text;
			lines.push(label ? `Syncing: ${label}` : "Syncing…");
			if (state.progress?.phase === "transferring" && state.progress.total > 0) {
				const pct = Math.round((state.progress.current / state.progress.total) * 100);
				lines.push(
					`Progress: ${state.progress.current}/${state.progress.total} files (${pct}%)`,
				);
				if (state.progress.path) {
					lines.push(`File: ${state.progress.path}`);
				}
			} else if (state.detail) {
				lines.push(state.detail);
			}
			lines.push("Click for sync actions.");
			return lines.join("\n");
		}

		if (state.kind === "error") {
			lines.push("Sync error");
			if (coordinator.retryAt !== null)
				lines.push(
					`Retry in ${Math.max(0, Math.ceil((coordinator.retryAt - Date.now()) / 1000))}s.`,
				);
			if (state.detail) {
				lines.push(state.detail);
			}
			if (coordinator.pendingCount > 0)
				lines.push(`${coordinator.pendingCount} local changes pending.`);
			lines.push("Click to view activity log.");
			return lines.join("\n");
		}

		if (state.kind === "warning") {
			lines.push(state.text, state.detail);
			if (coordinator.pendingCount > 0) {
				lines.push(`Pending local changes: ${coordinator.pendingCount}`);
			}
			return lines.join("\n");
		}

		// Idle / fully synced
		if (timestamp === null) lines.push("Ready");

		if (state.detail && state.text !== "Ready") {
			lines.push(state.detail);
		}

		lines.push(`Auto-sync: ${describeAutoSync(settings)}`);
		lines.push("Click for sync menu.");
		return lines.join("\n");
	}
}

function describeAutoSync(settings: FilenSyncSettings): string {
	if (settings.syncPaused) return "paused";
	const parts: string[] = [];
	if (settings.syncOnSave)
		parts.push(
			`on save (${settings.syncOnSaveDelaySeconds}s delay, min ${settings.minimumAutoSyncIntervalSeconds}s gap)`,
		);
	if (settings.syncIntervalMinutes > 0) parts.push(`every ${settings.syncIntervalMinutes} min`);
	parts.push("after opening");
	return parts.length > 0 ? parts.join(", ") : "off";
}

const isAllFilesSyncedStatus = (state: StatusBarState): boolean =>
	state.kind === "success" && (state.text === "up to date" || state.text === "Ready");
