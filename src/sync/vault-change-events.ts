import type { App, TAbstractFile } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { createSyncPathFilter } from "../path-filters";
import type { FilenSyncSettings } from "../settings";
import { isConflictFilePath } from "./conflict-utils";
import { selectedSettingsPaths } from "./settings-paths";

/**
 * Applies a vault event to the conflict-copy index. Returns true when the
 * event added or refreshed a conflict copy.
 */
export function updateConflictIndex(
	index: Map<string, TFile>,
	action: string,
	file: TAbstractFile,
	oldPath?: string,
): boolean {
	for (const [path, entry] of index) {
		if (
			file instanceof TFolder &&
			action === "renamed" &&
			oldPath &&
			path.startsWith(`${oldPath}/`)
		) {
			index.delete(path);
			index.set(entry.path, entry);
			continue;
		}
		if (
			entry === file ||
			(oldPath && (path === oldPath || path.startsWith(`${oldPath}/`))) ||
			(action === "deleted" && (path === file.path || path.startsWith(`${file.path}/`)))
		)
			index.delete(path);
	}
	if (file instanceof TFile && action !== "deleted" && isConflictFilePath(file.path)) {
		index.set(file.path, file);
		return true;
	}
	return false;
}

export function shouldAutoSyncForFileEvent(
	app: App,
	pluginId: string,
	settings: FilenSyncSettings,
	file: TAbstractFile,
	oldPath?: string,
): boolean {
	if (!(file instanceof TFile) && !(file instanceof TFolder)) return false;
	const pathFilter = createSyncPathFilter({
		configDir: app.vault.configDir,
		pluginId,
		selectedSettings: selectedSettingsPaths(
			app.vault.configDir,
			pluginId,
			settings.syncSettings,
			settings.selectedSettings,
		),
		ignorePatterns: settings.ignorePatterns,
		maxFileSizeBytes: settings.skipLargeFiles
			? settings.skipSizeLargerThanMB * 1048576
			: undefined,
	});
	if (
		pathFilter.isIgnored(file.path, file instanceof TFile ? file.stat?.size : undefined) &&
		(oldPath === undefined ||
			pathFilter.isIgnored(oldPath, file instanceof TFile ? file.stat?.size : undefined))
	) {
		return false;
	}

	return true;
}
