import { readLocalBytes } from "./local-io";
import { decodeText, mergeMarkdown, mergeSettings } from "./merge";
import { preserveRecovery } from "./recovery";
import type { App, TAbstractFile } from "obsidian";
import { TFile, normalizePath } from "obsidian";
import type { SyncDb } from "../db";
import type { RemoteEntry, RemoteFs } from "../fs-remote";
import { conflictCopyPath } from "./conflict-utils";
import { sha256Hex } from "./content-hash";
import type { ConflictCopy, PlannedAction, SyncedFileRecord } from "./types";

export type LocalEntry = {
	adapterOnly?: boolean;
	path: string;
	mtime: number;
	ctime: number;
	size: number;
	hash?: string;
	/** SHA-512 of the same verified bytes as `hash` (single-read equality pairs). */
	sha512?: string;
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
	pluginId?: string;
	conflictResolution?: "auto" | "copy";
	selectedSettings?: string[];
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
				if (this.config.remote.stat) {
					const remoteStat = await this.config.remote.stat(action.path);
					if (remoteStat !== null) {
						throw new Error(
							`Remote file reappeared before local deletion: ${action.path}. Replan the sync.`,
						);
					}
				}
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
					this.config.selectedSettings?.includes(action.path) &&
					(await this.config.app.vault.adapter.exists(action.path))
				)
					throw new Error(
						`Local settings file reappeared: ${action.path}. Replan the sync.`,
					);
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
				await this.config.remote.rm(action.path, remote.uuid, {
					remoteHash: remote.remoteHash,
					version: remote.version,
				});
				if (prev !== undefined) {
					await this.config.db.setDeletedMapping?.({
						uuid: remote.uuid,
						path: action.path,
					});
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
				if (this.config.conflictResolution === "auto" && local && remote) {
					const auto = await this.automaticallyResolve(action.path, local, remote);
					if (auto) return auto;
				}
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
				// Publish equality evidence only while both identities still match the verified scan.
				if (
					local &&
					remote &&
					action.hash &&
					(prev === undefined || action.detail === "Verified identical content")
				) {
					assertLocalUnchanged(this.config.app, action.path, local);
					if (this.config.remote.stat)
						await this.assertRemoteUnchanged(action.path, remote);
					let verifiedBytes: Uint8Array | undefined;
					if (
						this.config.db.setMergeBaseline &&
						action.path.toLowerCase().endsWith(".md")
					) {
						verifiedBytes = new Uint8Array(
							await readLocalBytes(this.config.app, local),
						);
						if ((await sha256Hex(verifiedBytes)) !== action.hash)
							throw new Error(
								`Local content changed before accepting equality: ${action.path}. Replan the sync.`,
							);
					}
					if (
						!prev ||
						prev.hash !== action.hash ||
						prev.mtime !== local.mtime ||
						prev.remoteMtime !== remote.mtime ||
						prev.remoteUuid !== remote.uuid ||
						prev.remoteHash !== remote.remoteHash
					) {
						await this.config.db.setFile(action.path, {
							path: action.path,
							mtime: local.mtime,
							ctime: local.ctime,
							size: local.size,
							hash: action.hash,
							remoteUuid: remote.uuid,
							remoteHash: remote.remoteHash,
							remoteMtime: remote.mtime,
							lastSyncAt: Date.now(),
							lastKnownSide: "both",
						});
					}
					if (verifiedBytes)
						await this.seedMergeText(action.path, verifiedBytes, action.hash);
				}
				// Clean up baseline for files gone from both sides
				if (prev !== undefined && local === undefined && remote === undefined) {
					await this.config.db.deleteFile(action.path);
				}
				return { applied: 0, conflicts: 0 };
			}
		}
	}

	private async seedMergeText(path: string, bytes: Uint8Array, hash: string): Promise<void> {
		if (!path.toLowerCase().endsWith(".md")) return;
		const text = decodeText(bytes);
		if (text !== undefined)
			await this.config.db.setMergeBaseline?.(path, { text, hash, savedAt: Date.now() });
	}

	private async automaticallyResolve(
		path: string,
		local: LocalEntry,
		remote: RemoteEntry,
	): Promise<ExecutionResult | undefined> {
		if (!this.config.db.addRecovery || !this.config.db.targetKey) return undefined;
		assertLocalUnchanged(this.config.app, path, local);
		const localBytes = new Uint8Array(await readLocalBytes(this.config.app, local));
		const remoteBytes = await this.config.remote.readFile(path, remote.uuid);
		const localHash = await sha256Hex(localBytes);
		if (local.hash && local.hash !== localHash)
			throw new Error(`Local file changed: ${path}. Replan the sync.`);
		let result: Uint8Array;
		if (path.toLowerCase().endsWith(".md") || this.config.selectedSettings?.includes(path)) {
			const l = decodeText(localBytes),
				r = decodeText(remoteBytes);
			if (l === undefined || r === undefined) return undefined;
			const stored = await this.config.db.getMergeBaseline?.(path);
			const previous = await this.config.db.getFile(path);
			const baseline =
				stored &&
				stored.hash === previous?.hash &&
				(await sha256Hex(new TextEncoder().encode(stored.text))) === stored.hash
					? stored
					: undefined;
			const merged = this.config.selectedSettings?.includes(path)
				? mergeSettings(l, r)
				: mergeMarkdown(baseline?.text, l, r);
			if (merged === undefined) return undefined;
			result = new TextEncoder().encode(merged);
		} else result = local.mtime >= remote.mtime ? localBytes : remoteBytes;
		await preserveRecovery(
			this.config.app,
			this.config.db,
			this.config.pluginId ?? "obsidian-filen-sync",
			path,
			localBytes,
			"Before automatic resolution: local",
		);
		await preserveRecovery(
			this.config.app,
			this.config.db,
			this.config.pluginId ?? "obsidian-filen-sync",
			path,
			remoteBytes,
			"Before automatic resolution: Filen",
		);
		await assertLocalBytesUnchanged(this.config.app, path, local, localHash);
		await this.assertRemoteUnchanged(path, remote);
		// Upload first. A partial failure keeps the old baseline and both recovery copies.
		const mtime = Math.max(local.mtime, remote.mtime);
		const uploaded = await this.config.remote.writeFile(
			path,
			result,
			mtime,
			local.ctime,
			remote.uuid,
		);
		await assertLocalBytesUnchanged(this.config.app, path, local, localHash);
		await this.config.app.vault.adapter.writeBinary(path, result.slice().buffer, {
			mtime,
			ctime: local.ctime,
		});
		const written = new Uint8Array(await this.config.app.vault.adapter.readBinary(path));
		const hash = await sha256Hex(result);
		if ((await sha256Hex(written)) !== hash)
			throw new Error(`Resolved file changed: ${path}. Replan the sync.`);
		await this.assertRemoteUnchanged(path, uploaded);
		await this.config.db.setFile(path, {
			path,
			mtime,
			ctime: local.ctime,
			size: result.length,
			hash,
			remoteUuid: uploaded.uuid,
			remoteHash: uploaded.remoteHash,
			remoteMtime: uploaded.mtime,
			lastSyncAt: Date.now(),
			lastKnownSide: "both",
		});
		await this.seedMergeText(path, result, hash);
		return {
			applied: 1,
			conflicts: 0,
			localFile: { ...local, mtime, size: result.length, hash },
			remoteFile: uploaded,
		};
	}

	private async assertRemoteUnchanged(path: string, expected: RemoteEntry): Promise<void> {
		const current = await this.config.remote.stat?.(path);
		if (
			!current ||
			current.uuid !== expected.uuid ||
			current.remoteHash !== expected.remoteHash ||
			current.mtime !== expected.mtime ||
			current.size !== expected.size ||
			(expected.version !== undefined && current.version !== expected.version)
		)
			throw new Error(`Remote file changed: ${path}. Replan the sync.`);
	}

	private async pushLocal(
		path: string,
		local: LocalEntry,
		remote?: RemoteEntry,
		onProgress?: (completedBytes: number, totalBytes: number) => void,
	): Promise<{ hash: string; local: LocalEntry; remote: RemoteEntry }> {
		const file = this.asFile(local.file);
		assertLocalUnchanged(this.config.app, path, local);
		const content = await readLocalBytes(this.config.app, local);
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
			mtime: local.mtime,
			ctime: local.ctime,
			size: bytes.byteLength,
			hash,
			remoteUuid: uploaded.uuid,
			remoteHash: uploaded.remoteHash,
			remoteMtime: uploaded.mtime,
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

		await this.seedMergeText(path, bytes, hash);
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

		if (this.config.selectedSettings?.includes(path)) {
			if (expectedLocal)
				await assertLocalBytesUnchanged(
					this.config.app,
					path,
					expectedLocal,
					expectedLocal.hash ??
						(await sha256Hex(
							new Uint8Array(await readLocalBytes(this.config.app, expectedLocal)),
						)),
				);
			else if (await this.config.app.vault.adapter.exists(path))
				throw new Error(`Local destination appeared: ${path}. Replan the sync.`);
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
			remoteMtime: remote.mtime,
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
			adapterOnly: this.config.selectedSettings?.includes(path),
			file: writtenFile ?? expectedLocal?.file ?? currentFile ?? null!,
		};
		const updatedRemote: RemoteEntry = {
			...remote,
			remoteHash: remote.remoteHash ?? verifiedRemote?.remoteHash,
		};
		await this.seedMergeText(path, content, hash);
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
				const copyInfo = await this.writeLocalConflictCopy(local.path, local);
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
		if (expected?.adapterOnly) {
			if (!(await this.config.app.vault.adapter.exists(path))) return true;
			if (!expected.hash)
				throw new Error("Settings deletion requires a verified fingerprint.");
			await assertLocalBytesUnchanged(this.config.app, path, expected, expected.hash);
			await this.config.app.vault.adapter.trashLocal(path);
			return true;
		}
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

	private conflictPath(path: string, side: "local" | "remote"): string {
		const visiblePath = this.config.selectedSettings?.includes(path)
			? `Filen Sync conflicts/settings-${encodeURIComponent(path)}`
			: path;
		return conflictCopyPath(visiblePath, this.config.deviceId, Date.now(), side);
	}

	private async writeLocalConflictCopy(
		path: string,
		expected?: LocalEntry,
	): Promise<{ copyPath: string; local: LocalEntry } | null> {
		const file = expected?.adapterOnly
			? expected.file
			: this.config.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) return null;
		const copyPath = this.conflictPath(path, "local");
		const content = expected?.adapterOnly
			? await readLocalBytes(this.config.app, expected)
			: await this.config.app.vault.readBinary(file);
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
		const copyPath = this.conflictPath(path, "remote");
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
	if (!expected.adapterOnly && !(file instanceof TFile)) {
		throw new Error(`Local file changed during sync: ${path}. Replan the sync.`);
	}
	const content = await readLocalBytes(app, expected);
	const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
	if ((await sha256Hex(bytes)) !== expectedHash) {
		throw new Error(`Local file content changed during sync: ${path}. Replan the sync.`);
	}
};

const assertLocalUnchanged = (app: App, path: string, expected: LocalEntry): void => {
	if (expected.adapterOnly) return;
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
		if (
			app.vault.getAbstractFileByPath(current) === null &&
			!(await app.vault.adapter.exists(current))
		) {
			await app.vault.adapter.mkdir(current);
		}
	}
};
