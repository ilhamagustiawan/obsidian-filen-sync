/** A stale local snapshot needs another sync pass, not conflict review. */
export class LocalEditPendingError extends Error {
	constructor(path: string) {
		super(`Local file changed during sync: ${path}. Replan the sync.`);
		this.name = "LocalEditPendingError";
	}
}
