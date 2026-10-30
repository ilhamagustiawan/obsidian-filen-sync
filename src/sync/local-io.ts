import { TFile, normalizePath, type App } from "obsidian";
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

export const ensureLocalDirectory = async (app: App, path: string): Promise<void> => {
	let current = "";
	for (const part of normalizePath(path)
		.split("/")
		.filter((p) => p.length > 0)) {
		current = current.length === 0 ? part : `${current}/${part}`;
		if (
			app.vault.getAbstractFileByPath(current) === null &&
			!(await app.vault.adapter.exists(current))
		) {
			await app.vault.adapter.mkdir(current);
		}
	}
};
