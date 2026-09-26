import type { App, TAbstractFile } from "obsidian";
import { TFile, normalizePath } from "obsidian";
import type { SyncDb } from "../db";
import type { RemoteEntry, RemoteFs } from "../fs-remote";
import { sha256Hex } from "./content-hash";
import type { ConflictCopy, PlannedAction, SyncedFileRecord } from "./types";

export type LocalEntry = {
	path: string;
	mtime: number;
	ctime: number;
	size: number;
	hash?: string;
	file: TAbstractFile;
};

export type ExecutionResult = {
	applied: number;
	conflicts: number;
	conflictCopy?: ConflictCopy;
	localFile?: LocalEntry;
	remoteFile?: RemoteEntry;
	deletedLocalPath?: string;
	deletedRemotePath?: string;
	conflictLocalFile?: LocalEntry;
	conflictRemoteFile?: RemoteEntry;
};

export type SyncExecutorConfig = {
	app: App;
	db: SyncDb;
	deviceId: string;
	remote: RemoteFs;
};

export class SyncExecutor {
	constructor(private readonly config: SyncExecutorConfig) {}

	async syncDirectories(
		localDirs: Set<string>,
		remoteDirs: Set<string>,
		options: { skipRemoteFolderPrune?: boolean } = {},
	): Promise<number> {
		let applied = 0;
		for (const path of sortDirs(localDirs)) {
			if (!remoteDirs.has(path)) {
				await this.config.remote.mkdir(path);
				applied += 1;
			}
		}
		if (!options.skipRemoteFolderPrune) {
			for (const path of sortDirs(remoteDirs)) {
				if (!localDirs.has(path)) {
					await ensureLocalDirectory(this.config.app, path);
					applied += 1;
				}
			}
		}
		return applied;
	}

	async execute(
		action: PlannedAction,
		local?: LocalEntry,
		remote?: RemoteEntry,
		prev?: SyncedFileRecord,
		onProgress?: (completedBytes: number, totalBytes: number) => void,
	): Promise<ExecutionResult> {
		switch (action.operation) {
			case "delete-local": {
				const deleted = await this.deleteLocal(action.path, local);
				if (deleted && prev !== undefined) {
					await this.config.db.deleteFile(action.path);
				}
				return {
					applied: deleted ? 1 : 0,
					conflicts: 0,
					deletedLocalPath: deleted ? action.path : undefined,
				};
			}

			case "delete-remote": {
				if (
					this.config.app.vault.getAbstractFileByPath(normalizePath(action.path)) !== null
				) {
					return { applied: 0, conflicts: 0 };
				}
				if (remote === undefined) return { applied: 0, conflicts: 0 };
				if (remote.uuid === undefined) {
					throw new Error(
						`Remote identity unavailable for deletion: ${action.path}. Replan the sync.`,
					);
				}
				await this.config.remote.rm(action.path, remote.uuid);
				if (prev !== undefined) {
					await this.config.db.deleteFile(action.path);
				}
				return { applied: 1, conflicts: 0, deletedRemotePath: action.path };
			}

			case "upload": {
				if (local === undefined) return { applied: 0, conflicts: 0 };
				const uploadResult = await this.pushLocal(action.path, local, remote, onProgress);
				return {
					applied: 1,
					conflicts: 0,
					localFile: uploadResult.local,
					remoteFile: uploadResult.remote,
				};
			}

			case "download": {
				if (remote === undefined) return { applied: 0, conflicts: 0 };
				const pullResult = await this.pullRemote(action.path, remote, local, onProgress);
				return {
					applied: 1,
					conflicts: 0,
					localFile: pullResult.local,
					remoteFile: pullResult.remote,
				};
			}

			case "conflict": {
				const conflictRes = await this.resolveConflict(action, local, remote);
				return {
					applied: 1,
					conflicts: 1,
					conflictCopy: conflictRes.conflictCopy,
					localFile: conflictRes.localFile,
					remoteFile: conflictRes.remoteFile,
					conflictLocalFile: conflictRes.conflictLocalFile,
					conflictRemoteFile: conflictRes.conflictRemoteFile,
				};
			}

			case "noop": {
				// A freshly verified equal-content first sync establishes a trusted baseline.
				if (
					prev === undefined &&
					local !== undefined &&
					remote !== undefined &&
					action.hash !== undefined
				) {
					await this.config.db.setFile(action.path, {
						path: action.path,
						mtime: local.mtime,
						ctime: local.ctime,
						size: local.size,
						hash: action.hash,
						remoteUuid: remote.uuid,
						remoteHash: remote.remoteHash,
						lastSyncAt: Date.now(),
						lastKnownSide: "both",
					});
				}
				// Clean up baseline for files gone from both sides
				if (prev !== undefined && local === undefined && remote === undefined) {
					await this.config.db.deleteFile(action.path);
				}
				return { applied: 0, conflicts: 0 };
			}
		}
	}

	private async pushLocal(
		path: string,
		local: LocalEntry,
		remote?: RemoteEntry,
		onProgress?: (completedBytes: number, totalBytes: number) => void,
	): Promise<{ hash: string; local: LocalEntry; remote: RemoteEntry }> {
		const file = this.asFile(local.file);
		assertLocalUnchanged(this.config.app, path, local);
		const content = await this.config.app.vault.readBinary(file);
		const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
		const hash = await sha256Hex(bytes);
		assertLocalUnchanged(this.config.app, path, local);
		await assertLocalBytesUnchanged(this.config.app, path, local, hash);

		const uploaded = await this.config.remote.writeFile(
			path,
			bytes,
			file.stat.mtime,
			file.stat.ctime,
			remote?.uuid,
			onProgress,
		);
		assertLocalUnchanged(this.config.app, path, local);
		await assertLocalBytesUnchanged(this.config.app, path, local, hash);

		await this.config.db.setFile(path, {
			path: local.path,
			mtime: file.stat.mtime,
			ctime: file.stat.ctime,
			size: bytes.byteLength,
			hash,
			remoteUuid: uploaded.uuid,
			remoteHash: uploaded.remoteHash,
			lastSyncAt: Date.now(),
			lastKnownSide: "local",
		});

		const updatedLocal: LocalEntry = {
			...local,
			mtime: file.stat.mtime,
			ctime: file.stat.ctime,
			size: bytes.byteLength,
			hash,
		};
		const updatedRemote: RemoteEntry = {
			path,
			mtime: file.stat.mtime,
			size: bytes.byteLength,
			isDir: false,
			uuid: uploaded.uuid,
			remoteHash: uploaded.remoteHash,
		};

		return { hash, local: updatedLocal, remote: updatedRemote };
	}

	private async pullRemote(
		path: string,
		remote: RemoteEntry,
		expectedLocal?: LocalEntry,
		onProgress?: (completedBytes: number, totalBytes: number) => void,
	): Promise<{ local: LocalEntry; remote: RemoteEntry }> {
		const content = await this.config.remote.readFile(path, remote.uuid, onProgress);
		const hash = await sha256Hex(content);
		const verifiedRemote = await this.config.remote.stat?.(path);
		if (
			verifiedRemote === null ||
			(remote.uuid !== undefined &&
				verifiedRemote !== undefined &&
				verifiedRemote.uuid !== remote.uuid)
		) {
			throw new Error(`Remote file changed during download: ${path}. Replan the sync.`);
		}

		// Revalidation: if local file exists and was modified since the scan,
		// save a conflict copy of the local modification before overwriting!
		const currentFile = this.config.app.vault.getAbstractFileByPath(normalizePath(path));
		if (currentFile !== null) {
			if (!(currentFile instanceof TFile)) {
				throw new Error(`Local destination changed during sync: ${path}. Replan the sync.`);
			}
			if (
				expectedLocal === undefined ||
				currentFile.stat.mtime !== expectedLocal.mtime ||
				currentFile.stat.size !== expectedLocal.size ||
				(expectedLocal.hash !== undefined &&
					(await sha256Hex(
						new Uint8Array(await this.config.app.vault.readBinary(currentFile)),
					)) !== expectedLocal.hash)
			) {
				await this.writeLocalConflictCopy(currentFile.path);
			}
		}

		await ensureLocalFolder(this.config.app, path);
		await this.config.app.vault.adapter.writeBinary(
			normalizePath(path),
			toArrayBuffer(content),
			{
				mtime: remote.mtime,
				ctime: remote.mtime,
			},
		);

		await this.config.db.setFile(path, {
			path,
			mtime: remote.mtime,
			ctime: remote.mtime,
			size: content.byteLength,
			hash,
			remoteUuid: remote.uuid,
			remoteHash: remote.remoteHash ?? verifiedRemote?.remoteHash,
			lastSyncAt: Date.now(),
			lastKnownSide: "remote",
		});

		const writtenFile = this.config.app.vault.getAbstractFileByPath(normalizePath(path));
		const updatedLocal: LocalEntry = {
			path,
			mtime: remote.mtime,
			ctime: remote.mtime,
			size: content.byteLength,
			hash,
			file: writtenFile ?? expectedLocal?.file ?? currentFile ?? null!,
		};
		const updatedRemote: RemoteEntry = {
			...remote,
			remoteHash: remote.remoteHash ?? verifiedRemote?.remoteHash,
		};
		return { local: updatedLocal, remote: updatedRemote };
	}

	private async resolveConflict(
		action: PlannedAction,
		local?: LocalEntry,
		remote?: RemoteEntry,
	): Promise<{
		conflictCopy?: ConflictCopy;
		localFile?: LocalEntry;
		remoteFile?: RemoteEntry;
		conflictLocalFile?: LocalEntry;
		conflictRemoteFile?: RemoteEntry;
	}> {
		if (local !== undefined && remote !== undefined) {
			if (action.conflictWinner === "local") {
				// Local wins: save remote as conflict copy, upload local
				const copyInfo = await this.writeRemoteConflictCopy(action.path, remote);
				const pushRes = await this.pushLocal(action.path, local, remote);
				return {
					conflictCopy: { originalPath: action.path, copyPath: copyInfo.copyPath },
					localFile: pushRes.local,
					remoteFile: pushRes.remote,
					conflictLocalFile: copyInfo.local,
				};
			} else {
				// Remote wins: save local as conflict copy, download remote
				const copyInfo = await this.writeLocalConflictCopy(local.path);
				const pullRes = await this.pullRemote(action.path, remote, local);
				return {
					conflictCopy: copyInfo
						? { originalPath: action.path, copyPath: copyInfo.copyPath }
						: undefined,
					localFile: pullRes.local,
					remoteFile: pullRes.remote,
					conflictLocalFile: copyInfo?.local,
				};
			}
		}

		if (local !== undefined) {
			// Remote deleted, local changed: re-upload local
			const pushRes = await this.pushLocal(action.path, local);
			return { localFile: pushRes.local, remoteFile: pushRes.remote };
		}

		if (remote !== undefined) {
			// Local deleted, remote changed: restore remote
			const pullRes = await this.pullRemote(action.path, remote);
			return { localFile: pullRes.local, remoteFile: pullRes.remote };
		}

		return {};
	}

	private async deleteLocal(path: string, expected?: LocalEntry): Promise<boolean> {
		const file = this.config.app.vault.getAbstractFileByPath(normalizePath(path));
		if (file === null) return true;
		if (!(file instanceof TFile)) return false;

		// Revalidation: if file modified since scan, do not delete!
		if (
			expected !== undefined &&
			(file.stat.mtime !== expected.mtime || file.stat.size !== expected.size)
		) {
			return false;
		}

		if (expected?.hash !== undefined)
			await assertLocalBytesUnchanged(this.config.app, path, expected, expected.hash);
		await this.config.app.fileManager.trashFile(file);
		return true;
	}

	private async writeLocalConflictCopy(
		path: string,
	): Promise<{ copyPath: string; local: LocalEntry } | null> {
		const file = this.config.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) return null;
		const copyPath = conflictCopyPath(file.path, this.config.deviceId, Date.now(), "local");
		const content = await this.config.app.vault.readBinary(file);
		await ensureLocalFolder(this.config.app, copyPath);
		await this.config.app.vault.adapter.writeBinary(copyPath, content, {
			mtime: file.stat.mtime,
			ctime: file.stat.ctime,
		});
		const copyFile = this.config.app.vault.getAbstractFileByPath(normalizePath(copyPath));
		const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
		const hash = await sha256Hex(bytes);
		return {
			copyPath,
			local: {
				path: copyPath,
				mtime: file.stat.mtime,
				ctime: file.stat.ctime,
				size: bytes.byteLength,
				hash,
				file: copyFile ?? file,
			},
		};
	}

	private async writeRemoteConflictCopy(
		path: string,
		remote: RemoteEntry,
	): Promise<{ copyPath: string; local: LocalEntry }> {
		const bytes = await this.config.remote.readFile(path, remote.uuid);
		const copyPath = conflictCopyPath(path, this.config.deviceId, Date.now(), "remote");
		await ensureLocalFolder(this.config.app, copyPath);
		await this.config.app.vault.adapter.writeBinary(copyPath, toArrayBuffer(bytes), {
			mtime: remote.mtime,
			ctime: remote.mtime,
		});
		const copyFile = this.config.app.vault.getAbstractFileByPath(normalizePath(copyPath));
		const hash = await sha256Hex(bytes);
		return {
			copyPath,
			local: {
				path: copyPath,
				mtime: remote.mtime,
				ctime: remote.mtime,
				size: bytes.byteLength,
				hash,
				file: copyFile ?? (null as unknown as TAbstractFile),
			},
		};
	}

	private asFile(file: TAbstractFile): TFile {
		if (!(file instanceof TFile)) throw new Error("Expected a file");
		return file;
	}
}

export { sha256Hex } from "./content-hash";

const assertLocalBytesUnchanged = async (
	app: App,
	path: string,
	expected: LocalEntry,
	expectedHash: string,
): Promise<void> => {
	const file = app.vault.getAbstractFileByPath(normalizePath(path));
	if (!(file instanceof TFile)) {
		throw new Error(`Local file changed during sync: ${path}. Replan the sync.`);
	}
	const content = await app.vault.readBinary(file);
	const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
	if ((await sha256Hex(bytes)) !== expectedHash) {
		throw new Error(`Local file content changed during sync: ${path}. Replan the sync.`);
	}
};

const assertLocalUnchanged = (app: App, path: string, expected: LocalEntry): void => {
	const current = app.vault.getAbstractFileByPath(normalizePath(path));
	if (
		!(current instanceof TFile) ||
		current.stat.mtime !== expected.mtime ||
		current.stat.size !== expected.size
	) {
		throw new Error(`Local file changed during sync: ${path}. Replan the sync.`);
	}
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
};

const conflictCopyPath = (
	path: string,
	deviceId: string,
	timestamp: number,
	side: "local" | "remote",
): string => {
	const normalized = normalizePath(path);
	const dotIndex = normalized.lastIndexOf(".");
	const suffix = `.sync-conflict-${side}-${safePathSegment(deviceId)}-${timestamp}`;
	return dotIndex <= 0
		? `${normalized}${suffix}`
		: `${normalized.slice(0, dotIndex)}${suffix}${normalized.slice(dotIndex)}`;
};

const safePathSegment = (value: string): string =>
	value.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);

const sortDirs = (dirs: Set<string>): string[] =>
	[...dirs].sort((l, r) => l.split("/").length - r.split("/").length || l.localeCompare(r));

const ensureLocalFolder = async (app: App, path: string): Promise<void> => {
	const parts = normalizePath(path).split("/");
	parts.pop();
	await ensureLocalDirectoryParts(app, parts);
};

const ensureLocalDirectory = async (app: App, path: string): Promise<void> => {
	await ensureLocalDirectoryParts(
		app,
		normalizePath(path)
			.split("/")
			.filter((p) => p.length > 0),
	);
};

const ensureLocalDirectoryParts = async (app: App, parts: string[]): Promise<void> => {
	let current = "";
	for (const part of parts) {
		current = current.length === 0 ? part : `${current}/${part}`;
		if (app.vault.getAbstractFileByPath(current) === null) {
			await app.vault.createFolder(current);
		}
	}
};
