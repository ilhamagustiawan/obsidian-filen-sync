import type { App } from "obsidian";
import { setIcon } from "obsidian";
import type { FilenSyncSettings } from "../settings";
import type { StatusBarState } from "../sync/coordinator";
import { formatSyncProgress } from "./sync-presentation";

const formatFilename = (path: string): string => {
	if (!path) return "";
	const parts = path.split("/").filter(Boolean);
	if (parts.length <= 1) return path;
	return `…/${parts.slice(-1)[0]}`;
};

export class FloatingSyncIndicator {
	private pillEl: HTMLElement | null = null;
	private iconSpan: HTMLElement | null = null;
	private titleEl: HTMLElement | null = null;
	private pctEl: HTMLElement | null = null;
	private barFill: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private fileEl: HTMLElement | null = null;
	private hideTimer: number | null = null;
	private showTimer: number | null = null;
	private latestState: StatusBarState | null = null;
	private isVisible = false;
	private wasManual = false;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => FilenSyncSettings,
		private readonly onOpenMenu: (e: MouseEvent) => void,
	) {}

	initialize(): void {
		if (this.pillEl !== null && this.pillEl.isConnected) return;
		if (this.pillEl !== null && !this.pillEl.isConnected) {
			this.pillEl.remove();
			this.pillEl = null;
		}

		const parent = this.app.workspace.containerEl ?? document.body;
		const pill = parent.createDiv({ cls: "filen-floating-pill is-hidden" });
		this.pillEl = pill;
		pill.setAttr("role", "button");
		pill.setAttr("tabindex", "0");
		pill.setAttr("aria-live", "polite");

		const content = pill.createDiv({ cls: "filen-floating-pill-content" });
		this.iconSpan = content.createSpan({ cls: "filen-floating-pill-icon" });
		setIcon(this.iconSpan, "refresh-cw");

		const body = content.createDiv({ cls: "filen-floating-pill-body" });
		const row1 = body.createDiv({ cls: "filen-floating-pill-row1" });
		this.titleEl = row1.createSpan({ cls: "filen-floating-pill-title", text: "Filen Sync" });
		this.pctEl = row1.createSpan({ cls: "filen-floating-pill-pct", text: "0%" });

		const track = body.createDiv({ cls: "filen-floating-pill-track" });
		this.barFill = track.createDiv({ cls: "filen-floating-pill-fill" });

		const row2 = body.createDiv({ cls: "filen-floating-pill-row2" });
		this.countEl = row2.createSpan({ cls: "filen-floating-pill-count", text: "Starting…" });
		this.fileEl = row2.createSpan({ cls: "filen-floating-pill-file", text: "" });

		pill.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onOpenMenu(e);
		});
		pill.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			event.stopPropagation();
			const bounds = pill.getBoundingClientRect();
			this.onOpenMenu(new MouseEvent("click", { clientX: bounds.left, clientY: bounds.top }));
		});
	}

	onStatusChange(state: StatusBarState): void {
		if (!this.getSettings().showFloatingSyncIndicator) {
			this.hideImmediate();
			return;
		}
		if (this.pillEl === null) this.initialize();
		this.latestState = state;

		if (state.kind === "syncing") {
			if (state.isManual) this.wasManual = true;
			this.clearHideTimer();
			if (this.isVisible) {
				this.renderSyncing(state);
				return;
			}
			if (this.showTimer === null) {
				this.showTimer = window.setTimeout(() => {
					this.showTimer = null;
					if (this.latestState?.kind !== "syncing") return;
					this.renderSyncing(this.latestState);
					this.show();
				}, 300);
			}
			return;
		}

		this.clearShowTimer();
		if (state.kind === "pending") {
			this.clearHideTimer();
			this.renderPending(state);
			this.setAccessibilityLabel(state);
			this.show();
			this.wasManual = false;
			return;
		}
		if (state.kind === "error" || state.kind === "warning") {
			this.clearHideTimer();
			if (state.kind === "error") this.renderError(state);
			else this.renderWarning(state);
			this.setAccessibilityLabel(state);
			this.show();
			this.wasManual = false;
			return;
		}
		if (state.kind === "success" && (this.isVisible || this.wasManual)) {
			this.renderSuccess(state);
			this.setAccessibilityLabel(state);
			this.show();
		} else if (this.isVisible) {
			this.scheduleHide(1000);
		}
		this.wasManual = false;
	}

	refreshVisibility(enabled = this.getSettings().showFloatingSyncIndicator): void {
		if (!enabled) this.hideImmediate();
	}

	destroy(): void {
		this.clearShowTimer();
		this.clearHideTimer();
		if (this.pillEl) {
			this.pillEl.remove();
			this.pillEl = null;
		}
		this.iconSpan = null;
		this.titleEl = null;
		this.pctEl = null;
		this.barFill = null;
		this.countEl = null;
		this.fileEl = null;
		this.isVisible = false;
	}

	private show(): void {
		if (!this.pillEl) return;
		this.pillEl.removeClass("is-hidden");
		this.isVisible = true;
	}

	private hideImmediate(): void {
		this.clearShowTimer();
		this.clearHideTimer();
		if (this.pillEl) {
			this.pillEl.addClass("is-hidden");
		}
		this.isVisible = false;
	}

	private clearShowTimer(): void {
		if (this.showTimer !== null) {
			window.clearTimeout(this.showTimer);
			this.showTimer = null;
		}
	}

	private clearHideTimer(): void {
		if (this.hideTimer !== null) {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = null;
		}
	}

	private scheduleHide(ms: number): void {
		this.clearHideTimer();
		this.hideTimer = window.setTimeout(() => {
			this.hideTimer = null;
			this.hideImmediate();
		}, ms);
	}

	private renderSyncing(state: StatusBarState): void {
		if (
			!this.pillEl ||
			!this.iconSpan ||
			!this.titleEl ||
			!this.pctEl ||
			!this.barFill ||
			!this.countEl ||
			!this.fileEl
		) {
			return;
		}

		this.pillEl.removeClass("is-success", "is-error", "is-warning", "is-pending");
		this.pillEl.addClass("is-syncing");

		setIcon(this.iconSpan, "refresh-cw");

		const progress = state.progress;
		const total = progress?.phase === "transferring" ? (progress.total ?? 0) : 0;
		const current = progress?.current ?? 0;
		const path = progress?.path ?? "";
		const label = progress?.phase ? formatSyncProgress(progress) : state.text;
		this.titleEl.setText(label);
		this.countEl.setText(path ? formatFilename(path) : state.detail);
		this.fileEl.setText("");
		if (path) this.fileEl.setAttr("title", path);
		else this.fileEl.removeAttribute("title");

		if (total > 0) {
			const boundedCurrent = Math.min(current, total);
			const pct = Math.round((boundedCurrent / total) * 100);
			this.pctEl.setText(`${boundedCurrent}/${total}`);
			this.barFill.removeClass("is-indeterminate");
			this.barFill.style.width = `${pct}%`;
		} else {
			this.pctEl.setText("");
			this.barFill.addClass("is-indeterminate");
			this.barFill.style.width = "40%";
		}
		this.pillEl.setAttr(
			"aria-label",
			`${label}${path ? `: ${path}` : ""}. Click for sync options.`,
		);
	}

	private renderSuccess(state: StatusBarState): void {
		if (
			!this.pillEl ||
			!this.iconSpan ||
			!this.titleEl ||
			!this.pctEl ||
			!this.barFill ||
			!this.countEl ||
			!this.fileEl
		) {
			return;
		}

		this.pillEl.removeClass("is-syncing", "is-error", "is-warning", "is-pending");
		this.pillEl.addClass("is-success");

		setIcon(this.iconSpan, "check");

		this.titleEl.setText("Filen Sync");
		this.pctEl.setText("Done");
		this.barFill.removeClass("is-indeterminate");
		this.barFill.style.width = "100%";

		const summary = state.text === "up to date" ? "Vault is up to date" : state.detail;
		this.countEl.setText(summary || "Sync complete");
		this.fileEl.setText("");
		this.fileEl.removeAttribute("title");

		this.scheduleHide(2400);
	}

	private renderError(state: StatusBarState): void {
		if (
			!this.pillEl ||
			!this.iconSpan ||
			!this.titleEl ||
			!this.pctEl ||
			!this.barFill ||
			!this.countEl ||
			!this.fileEl
		) {
			return;
		}

		this.pillEl.removeClass("is-syncing", "is-success", "is-warning", "is-pending");
		this.pillEl.addClass("is-error");

		setIcon(this.iconSpan, "alert-circle");

		this.titleEl.setText("Filen Sync Failed");
		this.pctEl.setText("Error");
		this.barFill.removeClass("is-indeterminate");
		this.barFill.style.width = "100%";

		this.countEl.setText(state.detail || "An error occurred");
		this.fileEl.setText("Click for sync options");

		this.clearHideTimer();
	}

	private renderWarning(state: StatusBarState): void {
		if (
			!this.pillEl ||
			!this.iconSpan ||
			!this.titleEl ||
			!this.pctEl ||
			!this.barFill ||
			!this.countEl ||
			!this.fileEl
		) {
			return;
		}

		this.pillEl.removeClass("is-syncing", "is-success", "is-error", "is-pending");
		this.pillEl.addClass("is-warning");

		setIcon(this.iconSpan, "pause");

		this.titleEl.setText(state.text);
		const warningLabel = state.text.toLowerCase();
		this.pctEl.setText(
			/confirmation|conflict|review/u.test(warningLabel)
				? "Review"
				: warningLabel.includes("offline")
					? "Offline"
					: "Paused",
		);
		this.barFill.removeClass("is-indeterminate");
		this.barFill.style.width = "100%";

		this.countEl.setText(state.detail || state.text);
		this.fileEl.setText("");

		this.clearHideTimer();
	}

	private setAccessibilityLabel(state: StatusBarState): void {
		this.pillEl?.setAttr(
			"aria-label",
			`${state.text}${state.detail ? `: ${state.detail}` : ""}. Select for sync options.`,
		);
	}

	private renderPending(state: StatusBarState): void {
		if (
			!this.pillEl ||
			!this.iconSpan ||
			!this.titleEl ||
			!this.pctEl ||
			!this.barFill ||
			!this.countEl ||
			!this.fileEl
		)
			return;
		this.pillEl.removeClass("is-syncing", "is-success", "is-error", "is-warning");
		this.pillEl.addClass("is-pending");
		setIcon(this.iconSpan, "cloud-upload");
		this.titleEl.setText("Filen Sync");
		this.pctEl.setText("Pending");
		this.barFill.removeClass("is-indeterminate");
		this.barFill.style.width = "0%";
		this.countEl.setText(state.text);
		this.fileEl.setText(state.detail);
	}
}
