import { Notice, setIcon } from "obsidian";
import type { StatusBarState } from "../sync/coordinator";

const formatFilename = (path: string): string => {
	if (!path) return "";
	const parts = path.split("/").filter(Boolean);
	if (parts.length <= 1) return path;
	return `…/${parts.slice(-1)[0]}`;
};

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
	private wasManual = false;
	private onDemand = false;

	constructor(
		private readonly onOpenLogs: () => void,
		private readonly getLastSyncSummary: () => string,
	) {}

	onStatusChange(state: StatusBarState): void {
		if (!this.onDemand) {
			this.closeNotice();
			return;
		}
		this.renderState(state);
		this.appendLastSyncSummary();
		if (state.kind !== "syncing") this.onDemand = false;
	}

	showOnDemand(state: StatusBarState): void {
		this.onDemand = true;
		this.ensureNoticeCreated();
		this.renderState(state);
		this.appendLastSyncSummary();
		if (state.kind !== "syncing") this.onDemand = false;
	}

	private appendLastSyncSummary(): void {
		if (!this.countEl) return;
		this.countEl.setText(
			[this.countEl.textContent, this.getLastSyncSummary()].filter(Boolean).join(" · "),
		);
	}

	private renderState(state: StatusBarState): void {
		this.ensureNoticeCreated();
		if (state.kind === "syncing") {
			this.renderSyncing(state);
		} else if (state.kind === "success") {
			this.renderSuccess(state);
		} else if (state.kind === "error") {
			this.renderError(state);
		} else if (state.kind === "warning") {
			this.renderWarning(state);
		} else {
			this.renderReady(state);
		}
	}

	closeNotice(): void {
		this.clearDismissTimer();
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
		this.wasManual = false;
		this.onDemand = false;
	}

	private clearDismissTimer(): void {
		if (this.dismissTimer !== null) {
			window.clearTimeout(this.dismissTimer);
			this.dismissTimer = null;
		}
	}

	private scheduleDismiss(ms: number): void {
		this.clearDismissTimer();
		this.dismissTimer = window.setTimeout(() => {
			this.dismissTimer = null;
			this.closeNotice();
		}, ms);
	}

	private ensureNoticeCreated(): void {
		if (this.activeNotice !== null && this.noticeEl !== null && this.noticeEl.isConnected) {
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
		this.noticeEl.removeClass("is-syncing", "is-error", "is-warning");
		this.noticeEl.addClass("is-success");
		setIcon(this.iconSpan, "refresh-cw");
		this.iconSpan.removeClass("filen-notice-spin");
		this.titleEl.setText("Filen Sync details");
		this.badgeEl.setText("Ready");
		this.countEl.setText(state.detail || state.text);
		this.fileEl.setText("");
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

		this.noticeEl.removeClass("is-success", "is-error", "is-warning");
		this.noticeEl.addClass("is-syncing");

		setIcon(this.iconSpan, "refresh-cw");
		this.iconSpan.addClass("filen-notice-spin");

		this.titleEl.setText("Filen Sync");

		const total = state.progress?.phase === "transferring" ? state.progress.total : 0;
		const current = state.progress?.current ?? 0;
		const path = state.progress?.path ?? "";

		if (total > 0) {
			const pct = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
			this.badgeEl.setText(`${pct}%`);
			this.barFill.removeClass("is-indeterminate");
			this.barFill.style.width = `${pct}%`;
			this.countEl.setText(
				`${current} of ${total} changes${state.progress?.totalBytes === undefined ? "" : ` · ${((state.progress.completedBytes ?? 0) / 1048576).toFixed(1)}/${(state.progress.totalBytes / 1048576).toFixed(1)} MB`}`,
			);
		} else {
			this.badgeEl.setText("Syncing");
			this.barFill.addClass("is-indeterminate");
			this.barFill.style.width = "40%";
			this.countEl.setText(state.text);
		}

		if (path) {
			this.fileEl.setText(formatFilename(path));
			this.fileEl.setAttr("title", path);
		} else {
			this.fileEl.setText(state.detail && state.detail !== "Starting..." ? state.detail : "");
			this.fileEl.removeAttribute("title");
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

		this.noticeEl.removeClass("is-syncing", "is-error", "is-warning");
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

		if (!this.onDemand) this.scheduleDismiss(2800);
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

		this.noticeEl.removeClass("is-syncing", "is-success", "is-warning");
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

		if (!this.onDemand) this.scheduleDismiss(6000);
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

		this.noticeEl.removeClass("is-syncing", "is-success", "is-error");
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

		if (!this.onDemand) this.scheduleDismiss(3500);
	}
}
