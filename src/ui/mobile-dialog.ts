import { Modal, Platform } from "obsidian";
import { trackVisibleViewport } from "./visible-viewport";

/** Own viewport listeners for exactly the lifetime of an open mobile dialog. */
export class MobileDialog extends Modal {
	private viewportCleanup?: () => void;
	open(): void {
		if (Platform.isMobile && !this.viewportCleanup) {
			this.modalEl.addClass("filen-mobile-dialog");
			this.viewportCleanup = trackVisibleViewport(this.modalEl);
		}
		super.open();
	}
	close(): void {
		this.viewportCleanup?.();
		this.viewportCleanup = undefined;
		super.close();
	}
}
