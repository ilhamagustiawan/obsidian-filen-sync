import { Platform, setIcon, type Plugin } from "obsidian";
import type { OpeningCheckState, StatusBarState } from "../sync/coordinator";
import { syncIconPresentation, shouldShowMobileSyncIndicator } from "./sync-presentation";

/** Persistent right-sidebar button; remount after Obsidian rebuilds its layout. */
export class MobileSyncIndicator {
	private state: StatusBarState | null = null;
	private row: HTMLElement | null = null;
	private icon: HTMLElement | null = null;
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
			return;
		}
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
			this.plugin.registerDomEvent(this.row, "click", (event) => this.onMenu(event));
		}
		if (this.row.parentElement !== container) container.appendChild(this.row);
		const model = this.model?.() ?? syncIconPresentation(this.state);
		this.row.setAttr("data-sync-state", model.state);
		this.row.setAttr("aria-label", `Filen: ${model.label}. Open sync menu`);
		this.row.setAttr("title", `Filen: ${model.label}`);
		setIcon(this.icon!, model.icon);
	}
	close(): void {
		this.closed = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.row?.remove();
	}
}
