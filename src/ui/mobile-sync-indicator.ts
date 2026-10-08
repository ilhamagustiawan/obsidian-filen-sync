import { ItemView, Platform, setIcon } from "obsidian";
import type { Plugin } from "obsidian";
import type { OpeningCheckState, StatusBarState } from "../sync/coordinator";
import {
	formatSyncProgress,
	shouldShowMobileSyncIndicator,
	transferPercent,
} from "./sync-presentation";

/** One movable, non-blocking status row outside the active view's scrolling content. */
export class MobileSyncIndicator {
	private state: StatusBarState | null = null;
	private row: HTMLElement | null = null;
	private button: HTMLButtonElement | null = null;
	private icon: HTMLElement | null = null;
	private label: HTMLElement | null = null;
	private bar: HTMLElement | null = null;
	private announcement: HTMLElement | null = null;
	private visible = false;
	private opening = false;
	private openingRun = false;
	private dismissedIssue = "";
	private showTimer: number | null = null;
	private hideTimer: number | null = null;
	private renderTimer: number | null = null;
	private lastRender = 0;
	private lastAnnouncement = "";
	private closed = false;

	constructor(
		private readonly plugin: Plugin,
		private readonly enabled: () => boolean,
		private readonly onDetails: () => void,
		private readonly onMenu: (event: MouseEvent) => void,
	) {
		plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", () => this.render()));
		plugin.registerEvent(plugin.app.workspace.on("layout-change", () => this.render()));
		plugin.register(() => this.close());
	}

	onOpeningCheckChange(check: OpeningCheckState): void {
		if (this.closed) return;
		this.opening = check.kind === "scheduled";
		if (this.state?.kind === "syncing" || this.isIssue()) return;
		if (check.kind === "blocked") {
			this.onStatusChange({
				kind: "warning",
				text: check.text,
				detail: check.text,
				updatedAt: null,
			});
		} else if (this.opening) {
			this.clearTimers();
			this.visible = true;
			this.render();
		} else if (!this.state?.syncCompleted) {
			this.visible = false;
			this.attach();
		}
	}

	onStatusChange(state: StatusBarState): void {
		if (this.closed || state === this.state) return;
		const newRun = state.kind === "syncing" && this.state?.kind !== "syncing";
		const wasVisible = this.visible;
		this.state = state;
		if (newRun) {
			this.clearTimers();
			this.openingRun = this.opening;
			this.opening = false;
			this.dismissedIssue = "";
			this.visible = state.isManual === true || this.openingRun || wasVisible;
			if (!this.visible) {
				this.showTimer = window.setTimeout(() => {
					this.showTimer = null;
					this.visible = true;
					this.render();
				}, 300);
			}
		}
		if (state.kind === "syncing") {
			if (newRun && this.visible) this.render();
			else this.queueRender();
			return;
		}
		this.clearTimers();
		if (this.isIssue()) {
			this.visible = this.issueKey() !== this.dismissedIssue;
		} else if (state.kind === "pending") {
			this.visible = wasVisible || this.openingRun;
		} else if (state.syncCompleted || state.kind === "success") {
			this.visible = wasVisible || this.openingRun || state.isManual === true;
			if (this.visible) {
				this.hideTimer = window.setTimeout(() => {
					this.hideTimer = null;
					this.visible = false;
					this.attach();
				}, 2000);
			}
			this.openingRun = false;
		} else {
			this.visible = this.opening;
		}
		this.render();
	}

	refreshVisibility(): void {
		this.render();
	}

	private isIssue(): boolean {
		return this.state?.kind === "error" || this.state?.kind === "warning";
	}

	private issueKey(): string {
		return `${this.state?.kind}:${this.state?.text}`;
	}

	private queueRender(): void {
		const wait = Math.max(0, 100 - (Date.now() - this.lastRender));
		if (wait === 0) this.render();
		else if (this.renderTimer === null) {
			this.renderTimer = window.setTimeout(() => {
				this.renderTimer = null;
				this.render();
			}, wait);
		}
	}

	private attach(): void {
		if (this.closed) return;
		if (!this.visible || !shouldShowMobileSyncIndicator(Platform.isMobile, this.enabled())) {
			this.row?.remove();
			return;
		}
		const view = this.plugin.app.workspace.getActiveViewOfType(ItemView);
		if (!view || view.contentEl.parentElement !== view.containerEl) {
			this.row?.remove();
			return;
		}
		this.createRow();
		if (this.row?.parentElement !== view.containerEl) {
			view.containerEl.insertBefore(this.row!, view.contentEl);
		}
	}

	private createRow(): void {
		if (this.row) return;
		this.row = document.createElement("div");
		this.row.className = "filen-mobile-sync-row";
		this.button = this.row.createEl("button", { cls: "filen-mobile-sync-chip" });
		this.button.type = "button";
		this.icon = this.button.createSpan({ cls: "filen-mobile-sync-icon" });
		this.label = this.button.createSpan({ cls: "filen-mobile-sync-label" });
		this.bar = this.button.createSpan({ cls: "filen-mobile-sync-bar" });
		this.bar.setAttr("role", "progressbar");
		this.bar.setAttr("aria-label", "Filen transfer progress");
		this.bar.setAttr("aria-valuemin", "0");
		this.bar.setAttr("aria-valuemax", "100");
		this.announcement = this.row.createSpan({ cls: "filen-mobile-sync-announcement" });
		this.announcement.setAttr("role", "status");
		this.announcement.setAttr("aria-live", "polite");
		const dismiss = this.row.createEl("button", { cls: "filen-mobile-sync-dismiss" });
		dismiss.type = "button";
		dismiss.setAttr("aria-label", "Dismiss sync status");
		setIcon(dismiss, "x");
		this.plugin.registerDomEvent(this.button, "click", (event) => {
			if (this.isIssue()) this.onMenu(event);
			else this.onDetails();
		});
		this.plugin.registerDomEvent(dismiss, "click", () => {
			this.dismissedIssue = this.isIssue() ? this.issueKey() : "";
			this.visible = false;
			this.clearTimers();
			this.attach();
		});
	}

	private render(): void {
		this.lastRender = Date.now();
		this.attach();
		if (!this.row || !this.button || !this.label || !this.icon || !this.bar) return;
		const state = this.state;
		const syncing = state?.kind === "syncing";
		const percent = syncing ? transferPercent(state.progress) : null;
		let label = state?.text ?? "Checking shortly…";
		if (this.opening && !syncing && !this.isIssue()) label = "Checking shortly…";
		else if (syncing) {
			label =
				percent === 100
					? "Finishing…"
					: state.progress?.phase
						? formatSyncProgress(state.progress)
						: state.text;
			if (state.progress?.phase === "transferring" && percent !== 100)
				label = `Syncing · ${label}`;
		} else if (state?.syncCompleted && !this.isIssue()) {
			label =
				state.kind === "idle"
					? "Changes queued"
					: state.text === "up to date"
						? "Up to date"
						: "Synced";
		}
		this.label.setText(label);
		this.button.setAttr(
			"aria-label",
			`Filen: ${label}. ${this.isIssue() ? "Open sync menu" : "Show sync progress"}.`,
		);
		this.button.setAttr("title", state?.detail || label);
		this.row.setAttr(
			"data-kind",
			this.isIssue() ? state!.kind : syncing || this.opening ? "syncing" : "success",
		);
		setIcon(
			this.icon,
			this.isIssue() ? "alert-circle" : syncing || this.opening ? "refresh-cw" : "check",
		);
		this.bar.hidden = !syncing && !this.opening;
		this.bar.toggleClass("is-indeterminate", percent === null);
		this.bar.style.setProperty("--filen-progress", `${percent ?? 35}%`);
		if (percent === null) this.bar.removeAttribute("aria-valuenow");
		else this.bar.setAttr("aria-valuenow", String(percent));
		const announcement = syncing
			? percent === 100
				? "finishing"
				: (state.progress?.phase ?? "connecting")
			: label;
		if (announcement !== this.lastAnnouncement) {
			this.lastAnnouncement = announcement;
			this.announcement?.setText(
				syncing
					? percent === 100
						? "Finishing sync"
						: state.progress?.phase === "transferring"
							? "Transferring changes"
							: label
					: label,
			);
		}
	}

	private clearTimers(): void {
		for (const timer of [this.showTimer, this.hideTimer, this.renderTimer]) {
			if (timer !== null) window.clearTimeout(timer);
		}
		this.showTimer = this.hideTimer = this.renderTimer = null;
	}

	close(): void {
		this.closed = true;
		this.clearTimers();
		this.row?.remove();
	}
}
