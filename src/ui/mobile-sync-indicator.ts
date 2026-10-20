import { MarkdownView, Platform, setIcon, type Plugin } from "obsidian";
import type { OpeningCheckState, StatusBarState } from "../sync/coordinator";
import {
	syncIconPresentation,
	shouldShowMobileSyncIndicator,
	transferPercent,
} from "./sync-presentation";

/** Persistent right-sidebar button; remount after Obsidian rebuilds its layout. */
export class MobileSyncIndicator {
	private state: StatusBarState | null = null;
	private row: HTMLElement | null = null;
	private icon: HTMLElement | null = null;
	private progress: HTMLElement | null = null;
	private fill: HTMLElement | null = null;
	private completionTimer: number | null = null;
	private lastPresentation: string | null = null;
	private completionVisible = false;
	private timer: number | null = null;
	private closed = false;
	constructor(
		private plugin: Plugin,
		private enabled: () => boolean,
		_onDetails: () => void,
		private onMenu: (event: MouseEvent) => void,
		private model?: () => ReturnType<typeof syncIconPresentation>,
	) {
		plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", () => this.render()));
		plugin.registerEvent(plugin.app.workspace.on("layout-change", () => this.render()));
		plugin.register(() => this.close());
	}
	onOpeningCheckChange(check: OpeningCheckState): void {
		if (check.kind === "scheduled" && this.state?.kind !== "syncing")
			this.state = {
				kind: "pending",
				text: "Checking",
				detail: "Checking shortly…",
				updatedAt: null,
			};
		this.render();
	}
	onStatusChange(state: StatusBarState): void {
		this.state = state;
		if (state.kind !== "syncing") {
			this.render();
			return;
		}
		if (this.timer === null)
			this.timer = window.setTimeout(() => {
				this.timer = null;
				this.render();
			}, 100);
	}
	refreshVisibility(): void {
		this.render();
	}
	private render(): void {
		if (this.closed) return;
		if (!shouldShowMobileSyncIndicator(Platform.isMobile, this.enabled())) {
			this.row?.remove();
			this.progress?.remove();
			return;
		}
		const model = this.model?.() ?? syncIconPresentation(this.state);
		this.renderProgress(model);
		const split = this.plugin.app.workspace.rightSplit as unknown as {
			containerEl?: HTMLElement;
		};
		const container = split?.containerEl;
		if (!container) {
			this.row?.remove();
			return;
		}
		if (!this.row) {
			this.row = document.createElement("button");
			this.row.className = "filen-mobile-sidebar-status clickable-icon";
			this.row.setAttribute("type", "button");
			this.icon = this.row.createSpan();
			this.icon.setAttr("aria-hidden", "true");
			this.plugin.registerDomEvent(this.row, "click", (event) => this.onMenu(event));
		}
		if (this.row.parentElement !== container) container.appendChild(this.row);
		this.row.setAttr("data-sync-state", model.state);
		this.row.setAttr("aria-label", `Filen: ${model.label}. Open sync menu`);
		this.row.setAttr("title", `Filen: ${model.label}`);
		setIcon(this.icon!, model.icon);
	}
	private renderProgress(model: ReturnType<typeof syncIconPresentation>): void {
		if (model.state !== this.lastPresentation) {
			if (this.completionTimer !== null) window.clearTimeout(this.completionTimer);
			this.completionTimer = null;
			this.completionVisible = model.state === "synced";
			this.lastPresentation = model.state;
			if (this.completionVisible) {
				this.completionTimer = window.setTimeout(() => {
					this.completionTimer = null;
					this.completionVisible = false;
					this.render();
				}, 2000);
			}
		}
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const header = view?.containerEl.querySelector<HTMLElement>(".view-header");
		const visible =
			model.state !== "pending" && (model.state !== "synced" || this.completionVisible);
		if (!visible || !header?.parentElement) {
			this.progress?.remove();
			return;
		}
		if (!this.progress) {
			this.progress = document.createElement("div");
			this.progress.className = "filen-mobile-note-progress";
			this.progress.setAttr("role", "progressbar");
			this.progress.setAttr("aria-valuemin", "0");
			this.progress.setAttr("aria-valuemax", "100");
			this.fill = this.progress.createSpan({ cls: "filen-mobile-note-progress-fill" });
		}
		header.parentElement.insertBefore(this.progress, header);
		this.progress.setAttr("data-sync-state", model.state);
		this.progress.setAttr("aria-label", `Filen: ${model.label}`);
		const percent = model.state === "syncing" ? transferPercent(this.state?.progress) : 100;
		this.progress.toggleClass("is-indeterminate", percent === null);
		if (percent === null) this.progress.removeAttribute("aria-valuenow");
		else this.progress.setAttr("aria-valuenow", String(percent));
		this.fill!.style.setProperty("width", `${percent ?? 35}%`);
	}
	close(): void {
		this.closed = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		if (this.completionTimer !== null) window.clearTimeout(this.completionTimer);
		this.completionTimer = null;
		this.row?.remove();
		this.progress?.remove();
	}
}
