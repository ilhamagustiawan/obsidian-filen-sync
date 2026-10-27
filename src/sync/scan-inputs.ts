import type { RemoteEntry, RemoteFs } from "../fs-remote";
import { createSyncPathFilter, type SyncPathFilter } from "../path-filters";
import type { SyncedFileRecord } from "../settings";
import type { ExclusionsTracker, RemoteScan, SyncEngineConfig } from "./engine-types";
import type { LocalEntry } from "./executor";
import { assertNoPathCollisions } from "./path-validation";
import { selectedSettingsPaths } from "./settings-paths";
import type { LocalFileInfo, RemoteFileInfo } from "./types";

export function selectedEngineSettingsPaths(config: SyncEngineConfig): string[] {
	return selectedSettingsPaths(
		config.app.vault.configDir,
		config.pluginId,
		config.settings.syncSettings,
		config.settings.selectedSettings,
	);
}

export function createEnginePathFilter(config: SyncEngineConfig): SyncPathFilter {
	const maxFileSizeBytes = config.settings.skipLargeFiles
		? config.settings.skipSizeLargerThanMB * 1024 * 1024
		: undefined;

	return createSyncPathFilter({
		configDir: config.app.vault.configDir,
		pluginId: config.pluginId,
		ignorePatterns: config.settings.ignorePatterns,
		maxFileSizeBytes,
		selectedSettings: selectedEngineSettingsPaths(config),
	});
}

export const filterPrevRecords = (
	records: Map<string, SyncedFileRecord>,
	pathFilter: SyncPathFilter,
): Map<string, SyncedFileRecord> => {
	const filtered = new Map<string, SyncedFileRecord>();
	for (const [path, record] of records) {
		if (!pathFilter.isIgnored(path, record.size)) filtered.set(path, record);
	}
	return filtered;
};

export function toLocalFileInfos(files: Map<string, LocalEntry>): Map<string, LocalFileInfo> {
	const localFiles = new Map<string, LocalFileInfo>();
	for (const [path, entry] of files) {
		localFiles.set(path, {
			path,
			mtime: entry.mtime,
			ctime: entry.ctime,
			size: entry.size,
			hash: entry.hash,
		});
	}
	return localFiles;
}

export function toRemoteFileInfos(
	files: Iterable<[string, RemoteEntry]>,
	resolvedHashes: Map<string, string | undefined>,
): Map<string, RemoteFileInfo> {
	const remoteFiles = new Map<string, RemoteFileInfo>();
	for (const [path, entry] of files) {
		remoteFiles.set(path, {
			path,
			mtime: entry.mtime,
			size: entry.size,
			isDir: entry.isDir,
			uuid: entry.uuid,
			remoteHash: entry.remoteHash,
			hash: resolvedHashes.get(path),
		});
	}
	return remoteFiles;
}

export async function walkRemoteTree(
	remote: RemoteFs,
	pathFilter: SyncPathFilter,
	exclusionsTracker?: ExclusionsTracker,
	options: { noCreate?: boolean } = {},
): Promise<RemoteScan> {
	const files = new Map<string, RemoteEntry>();
	const dirs = new Set<string>();
	const remoteEntries = await remote.walk(options);
	assertNoPathCollisions(remoteEntries.map(({ path, isDir }) => ({ path, isDir })));
	for (const entry of remoteEntries) {
		const exclusion = pathFilter.checkExclusion(entry.path, entry.size);
		if (exclusion !== "included") {
			if (exclusionsTracker) {
				if (exclusion === "too_large") exclusionsTracker.tooLargeCount += 1;
				else exclusionsTracker.ignoredCount += 1;
				if (exclusionsTracker.samplePaths.length < 10) {
					exclusionsTracker.samplePaths.push(entry.path);
				}
			}
			continue;
		}
		if (entry.isDir) {
			dirs.add(entry.path);
		} else {
			files.set(entry.path, entry);
		}
	}
	return { files, dirs };
}
