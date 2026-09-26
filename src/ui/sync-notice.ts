import { Notice, setIcon } from "obsidian";
import type { StatusBarState } from "../sync/coordinator";
import { formatSyncProgress, formatTransferDetails } from "./sync-presentation";

export class SyncNoticeController {
	private activeNotice: Notice | null = null;
	private noticeEl: HTMLElement | null = null;
	private iconSpan: HTMLElement | null = null;
	private titleEl: HTMLElement | null = null;
	private badgeEl: HTMLElement | null = null;
	private barFill: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private fileEl: HTMLElement | null = null;
	private dismissTimer: number | null = null;
	private showTimer: number | null = null;
	private coalesceTimer: number | null = null;
	private lastRenderTime = 0;
	private pendingSyncState: StatusBarState | null = null;
	private latestState: StatusBarState | null = null;
	private mode: "compact" | "detailed" = "detailed";
	private wasManual = false;
	private onDemand = false;
	private isVisible = false;

	constructor(
		private readonly onOpenLogs: () => void,
		private readonly getLastSyncSummary: () => string,
		private readonly onOpenMenu?: (e: MouseEvent) => void,
		private readonly isMobile: () => boolean = () => false,
		private readonly isEnabled: () => boolean = () => true,
	) {}

	onStatusChange(state: StatusBarState): void {
		this.latestState = state;

		if (this.onDemand) {
			this.clearShowTimer();
			if (state.kind === "syncing") {
				this.coalesceSyncRender(state);
				return;
			}
			this.clearCoalesceTimer();
			this.renderState(state);
			this.appendLastSyncSummary();
			this.onDemand = false;
			return;
		}

		const allowMobile = this.isMobile() && this.isEnabled();
		if (!allowMobile) {
			this.closeNotice();
			return;
		}

		// Mobile automatic mode
		this.mode = "compact";

		if (state.kind === "syncing") {
			if (state.isManual) this.wasManual = true;
			this.clearDismissTimer();

			if (this.isVisible) {
				this.coalesceSyncRender(state);
				return;
			}

			if (this.showTimer === null) {
				this.showTimer = window.setTimeout(() => {
					this.showTimer = null;
					if (this.latestState?.kind !== "syncing") return;
					this.ensureNoticeCreated("compact");
					this.renderState(this.latestState);
					this.lastRenderTime = Date.now();
					this.isVisible = true;
				}, 300);
			}
			return;
		}

		this.clearShowTimer();
		this.clearCoalesceTimer();
		this.pendingSyncState = null;

		if (state.kind === "pending") {
			this.clearDismissTimer();
			this.ensureNoticeCreated("compact");
			this.renderPending(state);
			this.isVisible = true;
			this.wasManual = false;
			return;
		}

		if (state.kind === "error" || state.kind === "warning") {
			this.clearDismissTimer();
			this.ensureNoticeCreated("compact");
			if (state.kind === "error") this.renderError(state);
			else this.renderWarning(state);
			this.isVisible = true;
			this.wasManual = false;
			return;
		}

		if (state.kind === "success") {
			if (this.isVisible || this.wasManual) {
				this.ensureNoticeCreated("compact");
				this.renderSuccess(state);
				this.isVisible = true;
				this.scheduleDismiss(2400);
			} else {
				this.closeNotice();
			}
			this.wasManual = false;
			return;
		}

		if (state.kind === "idle") {
			this.closeNotice();
		}
	}

	showOnDemand(state: StatusBarState): void {
		this.clearShowTimer();
		this.clearCoalesceTimer();
		this.pendingSyncState = null;
		this.onDemand = true;
		this.mode = "detailed";
		this.latestState = state;
		this.ensureNoticeCreated("detailed");
		this.renderState(state);
		this.appendLastSyncSummary();
		this.isVisible = true;
		if (state.kind !== "syncing") this.onDemand = false;
	}

	refreshVisibility(enabled = this.isEnabled()): void {
		if (!enabled && !this.onDemand) {
			this.closeNotice();
		}
	}

	private coalesceSyncRender(state: StatusBarState): void {
		const now = Date.now();
		const elapsed = now - this.lastRenderTime;
		const minInterval = 100; // 10 Hz

		if (elapsed >= minInterval) {
			this.clearCoalesceTimer();
			this.pendingSyncState = null;
			this.renderState(state);
			if (this.onDemand) this.appendLastSyncSummary();
			this.lastRenderTime = now;
			return;
		}

		this.pendingSyncState = state;
		if (this.coalesceTimer === null) {
			this.coalesceTimer = window.setTimeout(() => {
				this.coalesceTimer = null;
				if (this.pendingSyncState) {
					const nextState = this.pendingSyncState;
					this.pendingSyncState = null;
					this.renderState(nextState);
					if (this.onDemand) this.appendLastSyncSummary();
					this.lastRenderTime = Date.now();
				}
			}, minInterval - elapsed);
		}
	}

	private clearCoalesceTimer(): void {
		if (this.coalesceTimer !== null) {
			window.clearTimeout(this.coalesceTimer);
			this.coalesceTimer = null;
		}
	}

	private appendLastSyncSummary(): void {
		if (!this.countEl) return;
		this.countEl.setText(
			[this.countEl.textContent, this.getLastSyncSummary()].filter(Boolean).join(" · "),
		);
	}

	private renderState(state: StatusBarState): void {
		this.ensureNoticeCreated(this.mode);
		if (state.kind === "syncing") {
			this.renderSyncing(state);
		} else if (state.kind === "success") {
			this.renderSuccess(state);
		} else if (state.kind === "error") {
			this.renderError(state);
		} else if (state.kind === "warning") {
			this.renderWarning(state);
		} else if (state.kind === "pending") {
			this.renderPending(state);
		} else {
			this.renderReady(state);
		}
	}

	closeNotice(): void {
		this.clearShowTimer();
		this.clearDismissTimer();
		this.clearCoalesceTimer();
		this.pendingSyncState = null;
		this.latestState = null;
		this.isVisible = false;
		this.wasManual = false;
		this.onDemand = false;
		if (this.activeNotice) {
			this.activeNotice.hide();
			this.activeNotice = null;
		}
		this.noticeEl = null;
		this.iconSpan = null;
		this.titleEl = null;
		this.badgeEl = null;
		this.barFill = null;
		this.countEl = null;
		this.fileEl = null;
	}

	private clearDismissTimer(): void {
		if (this.dismissTimer !== null) {
			window.clearTimeout(this.dismissTimer);
			this.dismissTimer = null;
		}
	}

	private clearShowTimer(): void {
		if (this.showTimer !== null) {
			window.clearTimeout(this.showTimer);
			this.showTimer = null;
		}
	}

	private scheduleDismiss(ms: number): void {
		this.clearDismissTimer();
		this.dismissTimer = window.setTimeout(() => {
			this.dismissTimer = null;
			this.closeNotice();
		}, ms);
	}

	private ensureNoticeCreated(mode: "compact" | "detailed"): void {
		if (this.activeNotice !== null && this.noticeEl !== null && this.noticeEl.isConnected) {
			if (mode === "compact") {
				this.noticeEl.addClass("filen-notice-compact");
				this.noticeEl.setAttr("role", "button");
				this.noticeEl.setAttr("tabindex", "0");
				this.noticeEl.setAttr("aria-live", "polite");
			} else {
				this.noticeEl.removeClass("filen-notice-compact");
				this.noticeEl.removeAttribute("role");
				this.noticeEl.removeAttribute("tabindex");
			}
			return;
		}

		this.clearDismissTimer();

		if (this.activeNotice !== null && (!this.noticeEl || !this.noticeEl.isConnected)) {
			try {
				this.activeNotice.hide();
			} catch {
				// Ignore if already hidden/pruned
			}
			this.activeNotice = null;
			this.noticeEl = null;
		}

		const frag = document.createDocumentFragment();
		const container = frag.createDiv({ cls: "filen-notice-container" });

		const header = container.createDiv({ cls: "filen-notice-header" });
		const iconWrap = header.createDiv({ cls: "filen-notice-icon-wrapper" });
		this.iconSpan = iconWrap.createSpan({ cls: "filen-notice-icon filen-notice-spin" });
		this.titleEl = iconWrap.createSpan({ cls: "filen-notice-title", text: "Filen Sync" });
		this.badgeEl = header.createSpan({ cls: "filen-notice-badge", text: "0%" });

		const track = container.createDiv({ cls: "filen-notice-bar-track" });
		this.barFill = track.createDiv({ cls: "filen-notice-bar-fill" });

		const details = container.createDiv({ cls: "filen-notice-details" });
		this.countEl = details.createSpan({ cls: "filen-notice-count", text: "Starting…" });
		this.fileEl = details.createSpan({ cls: "filen-notice-file", text: "" });

		this.activeNotice = new Notice(frag, 0);
		this.noticeEl = this.activeNotice.noticeEl;
		this.noticeEl.addClass("filen-sync-progress-notice");

		if (mode === "compact") {
			this.noticeEl.addClass("filen-notice-compact");
			this.noticeEl.setAttr("role", "button");
			this.noticeEl.setAttr("tabindex", "0");
			this.noticeEl.setAttr("aria-live", "polite");
		}

		this.noticeEl.addEventListener("click", (e) => {
			const target = e.target as HTMLElement | null;
			if (typeof target?.closest === "function" && target.closest(".filen-notice-log-link")) {
				return;
			}
			if (this.mode === "compact" && this.onOpenMenu) {
				e.preventDefault();
				e.stopPropagation();
				this.onOpenMenu(e);
			}
		});

		this.noticeEl.addEventListener("keydown", (e) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			if (this.mode === "compact" && this.onOpenMenu) {
				e.preventDefault();
				e.stopPropagation();
				this.onOpenMenu(new MouseEvent("click"));
			}
		});
	}

	private renderReady(state: StatusBarState): void {
		if (
			!this.noticeEl ||
			!this.iconSpan ||
			!this.titleEl ||
			!this.badgeEl ||
			!this.countEl ||
			!this.fileEl
		)
			return;
		this.clearDismissTimer();
		this.noticeEl.removeClass("is-syncing", "is-error", "is-warning", "is-pending");
		this.noticeEl.addClass("is-success");
		setIcon(this.iconSpan, "refresh-cw");
		this.iconSpan.removeClass("filen-notice-spin");
		this.titleEl.setText(this.mode === "compact" ? "Filen Sync" : "Filen Sync details");
		this.badgeEl.setText("Ready");
		this.countEl.setText(state.detail || state.text);
		this.fileEl.setText("");
		this.noticeEl.setAttr("aria-label", `Filen Sync: ${state.text}.`);
	}

	private renderPending(state: StatusBarState): void {
		if (
			!this.noticeEl ||
			!this.iconSpan ||
			!this.titleEl ||
			!this.badgeEl ||
			!this.barFill ||
			!this.countEl ||
			!this.fileEl
		)
			return;
		this.clearDismissTimer();
		this.noticeEl.removeClass("is-syncing", "is-success", "is-error", "is-warning");
		this.noticeEl.addClass("is-pending");

		setIcon(this.iconSpan, "clock");
		this.iconSpan.removeClass("filen-notice-spin");

		this.titleEl.setText("Filen Sync");
		this.badgeEl.setText("Pending");
		this.barFill.removeClass("is-indeterminate");
		this.barFill.style.width = "100%";

		this.countEl.setText(state.text);
		this.fileEl.setText(state.detail || "");
		this.noticeEl.setAttr("aria-label", `Filen Sync: ${state.text}. Tap for options.`);
	}

	private renderSyncing(state: StatusBarState): void {
		this.clearDismissTimer();
		if (
			!this.noticeEl ||
			!this.iconSpan ||
			!this.titleEl ||
			!this.badgeEl ||
			!this.barFill ||
			!this.countEl ||
			!this.fileEl
		) {
			return;
		}

		this.noticeEl.removeClass("is-success", "is-error", "is-warning", "is-pending");
		this.noticeEl.addClass("is-syncing");

		setIcon(this.iconSpan, "refresh-cw");
		this.iconSpan.addClass("filen-notice-spin");

		const progress = state.progress;
		const total = progress?.phase === "transferring" ? (progress.total ?? 0) : 0;
		const current = progress?.current ?? 0;
		const path = progress?.path ?? "";

		if (total > 0 && progress) {
			const boundedCurrent = Math.min(current, total);
			const pct = Math.min(100, Math.max(0, Math.round((boundedCurrent / total) * 100)));
			this.titleEl.setText("Filen Sync");
			this.badgeEl.setText(`${boundedCurrent}/${total}`);
			this.barFill.removeClass("is-indeterminate");
			this.barFill.style.width = `${pct}%`;

			const { countText, fileText } = formatTransferDetails(progress);
			this.countEl.setText(countText);
			this.fileEl.setText(fileText);
			if (path) {
				this.fileEl.setAttr("title", path);
			} else {
				this.fileEl.removeAttribute("title");
			}
			this.noticeEl.setAttr(
				"aria-label",
				`Filen Sync: ${countText}${fileText ? ` · ${fileText}` : ""}. Tap for options.`,
			);
		} else {
			const phaseLabel = progress?.phase ? formatSyncProgress(progress) : "";
			this.titleEl.setText(phaseLabel || "Filen Sync");
			this.badgeEl.setText("Syncing");
			this.barFill.addClass("is-indeterminate");
			this.barFill.style.width = "40%";
			this.countEl.setText(state.text);
			this.fileEl.setText(state.detail && state.detail !== "Starting..." ? state.detail : "");
			this.fileEl.removeAttribute("title");
			this.noticeEl.setAttr("aria-label", `Filen Sync: ${state.text}. Tap for options.`);
		}
	}

	private renderSuccess(state: StatusBarState): void {
		if (
			!this.noticeEl ||
			!this.iconSpan ||
			!this.titleEl ||
			!this.badgeEl ||
			!this.barFill ||
			!this.countEl ||
			!this.fileEl
		) {
			return;
		}

		this.noticeEl.removeClass("is-syncing", "is-error", "is-warning", "is-pending");
		this.noticeEl.addClass("is-success");

		setIcon(this.iconSpan, "check");
		this.iconSpan.removeClass("filen-notice-spin");

		this.titleEl.setText("Filen Sync");
		this.badgeEl.setText("Done");
		this.barFill.removeClass("is-indeterminate");
		this.barFill.style.width = "100%";

		const summary = state.text === "up to date" ? "Vault is up to date" : state.detail;
		this.countEl.setText(summary || "Sync complete");
		this.fileEl.setText("");
		this.fileEl.removeAttribute("title");
		this.noticeEl.setAttr("aria-label", `Filen Sync: ${summary || "Sync complete"}.`);

		if (!this.onDemand) this.scheduleDismiss(2400);
	}

	private renderError(state: StatusBarState): void {
		if (
			!this.noticeEl ||
			!this.iconSpan ||
			!this.titleEl ||
			!this.badgeEl ||
			!this.barFill ||
			!this.countEl ||
			!this.fileEl
		) {
			return;
		}

		this.noticeEl.removeClass("is-syncing", "is-success", "is-warning", "is-pending");
		this.noticeEl.addClass("is-error");

		setIcon(this.iconSpan, "alert-circle");
		this.iconSpan.removeClass("filen-notice-spin");

		this.titleEl.setText("Filen Sync");
		this.badgeEl.setText("Failed");
		this.barFill.removeClass("is-indeterminate");
		this.barFill.style.width = "100%";

		this.countEl.setText(state.detail || "An error occurred");
		this.fileEl.empty();
		const link = this.fileEl.createEl("a", {
			cls: "filen-notice-log-link",
			text: "View logs →",
		});
		link.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.closeNotice();
			this.onOpenLogs();
		});

		this.noticeEl.setAttr(
			"aria-label",
			`Filen Sync: Failed. ${state.detail || "An error occurred"}.`,
		);

		// Actionable errors remain visible until dismissed or retried
		if (this.onDemand) this.scheduleDismiss(6000);
	}

	private renderWarning(state: StatusBarState): void {
		if (
			!this.noticeEl ||
			!this.iconSpan ||
			!this.titleEl ||
			!this.badgeEl ||
			!this.barFill ||
			!this.countEl ||
			!this.fileEl
		) {
			return;
		}

		this.noticeEl.removeClass("is-syncing", "is-success", "is-error", "is-pending");
		this.noticeEl.addClass("is-warning");

		setIcon(this.iconSpan, "pause");
		this.iconSpan.removeClass("filen-notice-spin");

		this.titleEl.setText("Filen Sync");
		this.badgeEl.setText("Paused");
		this.barFill.removeClass("is-indeterminate");
		this.barFill.style.width = "100%";

		this.countEl.setText(state.detail || state.text);
		this.fileEl.setText("");
		this.fileEl.removeAttribute("title");

		this.noticeEl.setAttr(
			"aria-label",
			`Filen Sync: Paused. ${state.detail || state.text}. Tap for options.`,
		);

		// Actionable warnings remain persistent in compact mode, auto-dismiss in detailed mode
		if (this.onDemand) this.scheduleDismiss(3500);
	}
}
