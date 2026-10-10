import { readLocalBytes } from "./local-io";
import { decodeText, mergeMarkdown, mergeSettings } from "./merge";
import { captureConflict, conflictVersions, type ConflictContext } from "./conflict-store";
import { applyConflict, resumeConflict } from "./conflict-apply";
import type { ConflictRecord } from "./conflict-types";
import type { App, TAbstractFile } from "obsidian";
import { TFile, normalizePath } from "obsidian";
import type { SyncDb } from "../db";
import type { RemoteEntry, RemoteFs } from "../fs-remote";
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
	reviewPending?: string;
	newConflict?: boolean;
	cleanedCopies?: string[];
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
	verifyTarget?: () => Promise<void>;
};

export class SyncExecutor {
	constructor(private readonly config: SyncExecutorConfig) {}

	private get conflictContext(): ConflictContext {
		return { ...this.config, pluginId: this.config.pluginId ?? "obsidian-filen-sync" };
	}

	private async pendingResult(
		record: ConflictRecord,
		changed: boolean,
	): Promise<ExecutionResult> {
		return { applied: 0, conflicts: 1, reviewPending: record.path, newConflict: changed };
	}

	private async resolutionResult(path: string): Promise<ExecutionResult> {
		const stat = await this.config.app.vault.adapter.stat(path);
		const remote = await this.config.remote.stat?.(path);
		const record = await this.config.db.getFile(path);
		return {
			applied: 1,
			conflicts: 0,
			localFile:
				stat?.type === "file"
					? {
							path,
							...stat,
							hash: record?.hash,
							adapterOnly: this.config.selectedSettings?.includes(path),
							file: this.config.app.vault.getAbstractFileByPath(path)!,
						}
					: undefined,
			remoteFile: remote ?? undefined,
			deletedLocalPath: !stat ? path : undefined,
			deletedRemotePath: !remote ? path : undefined,
		};
	}

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
		const pending = await this.config.db.getConflict?.(action.path);
		if (pending) {
			if (pending.kind === "settings" && !this.config.selectedSettings?.includes(action.path))
				return this.pendingResult(pending, false);
			if (pending.approval && (await resumeConflict(this.conflictContext, pending)))
				return {
					...(await this.resolutionResult(action.path)),
					cleanedCopies: pending.copies?.map((copy) => copy.path),
				};
			const refreshed = await captureConflict(
				this.conflictContext,
				action.path,
				pending.reason,
			);
			return this.pendingResult(refreshed.record, refreshed.changed);
		}
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
				if ("review" in pullResult)
					return this.pendingResult(pullResult.review.record, pullResult.review.changed);
				return {
					applied: 1,
					conflicts: 0,
					localFile: pullResult.local,
					remoteFile: pullResult.remote,
				};
			}

			case "conflict": {
				const captured = await captureConflict(
					this.conflictContext,
					action.path,
					action.reasonCode ?? "Concurrent changes",
					{ local, remote },
				);
				if (this.config.conflictResolution === "auto" && local && remote) {
					const auto = await this.automaticallyResolve(captured.record);
					if (auto) return auto;
				}
				return this.pendingResult(captured.record, captured.changed);
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
						(action.path.toLowerCase().endsWith(".md") ||
							this.config.selectedSettings?.includes(action.path))
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
		if (!path.toLowerCase().endsWith(".md") && !this.config.selectedSettings?.includes(path))
			return;
		const text = decodeText(bytes);
		if (text !== undefined)
			await this.config.db.setMergeBaseline?.(path, { text, hash, savedAt: Date.now() });
	}

	private async automaticallyResolve(
		record: ConflictRecord,
	): Promise<ExecutionResult | undefined> {
		const versions = await conflictVersions(this.conflictContext, record);
		let result: Uint8Array | undefined;
		if (record.local.recovery?.hash === record.remote.recovery?.hash) result = versions.local;
		else if (record.kind !== "file") {
			const local = versions.local && decodeText(versions.local);
			const remote = versions.remote && decodeText(versions.remote);
			const base = versions.base && decodeText(versions.base);
			if (local === undefined || remote === undefined) return undefined;
			const merged =
				record.kind === "settings"
					? mergeSettings(local, remote, base)
					: mergeMarkdown(base, local, remote);
			if (merged !== undefined) result = new TextEncoder().encode(merged);
		}
		if (result === undefined) return undefined;
		await applyConflict(this.conflictContext, {
			path: record.path,
			revision: record.revision,
			bytes: result,
		});
		return this.resolutionResult(record.path);
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
	): Promise<
		| { local: LocalEntry; remote: RemoteEntry }
		| { review: Awaited<ReturnType<typeof captureConflict>> }
	> {
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
		// pause the file for durable review before writing either original.
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
				return {
					review: await captureConflict(
						this.conflictContext,
						path,
						"Local file changed during download",
					),
				};
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
