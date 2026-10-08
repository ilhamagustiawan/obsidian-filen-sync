import { TFile, type App } from "obsidian";
import type { LocalEntry } from "./executor";
export async function readLocalBytes(app: App, entry: LocalEntry): Promise<ArrayBuffer> {
	if (entry.adapterOnly) {
		const stat = await app.vault.adapter.stat(entry.path);
		if (
			!stat ||
			stat.type !== "file" ||
			stat.mtime !== entry.mtime ||
			stat.ctime !== entry.ctime ||
			stat.size !== entry.size
		)
			throw new Error(`Local file changed: ${entry.path}. Replan the sync.`);
		return app.vault.adapter.readBinary(entry.path);
	}
	if (!(entry.file instanceof TFile)) throw new Error("Expected a file.");
	return app.vault.readBinary(entry.file);
}
