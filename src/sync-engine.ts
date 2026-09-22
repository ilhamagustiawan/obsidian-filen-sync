import type { App, TAbstractFile } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import { createSyncPathFilter, type SyncPathFilter } from "./path-filters";
import type { SyncDb } from "./db";
import type { RemoteEntry, RemoteFs } from "./fs-remote";
import type { SyncedFileRecord } from "./settings";

type SyncEngineConfig = {
	app: App;
	db: SyncDb;
	pluginId: string;
	settings: {
		deviceId: string;
		vaultName: string;
		ignorePatterns: string[];
	};
	remote: RemoteFs;
};

type SyncResult = {
	applied: number;
	conflicts: number;
};

export type ConflictCopy = {
	originalPath: string;
	copyPath: string;
};

export type SyncOutcome = SyncResult & {
	conflictCopies: ConflictCopy[];
	/** True if the sync was aborted because a local-delete confirmation was declined. */
	cancelled?: boolean;
};

type EntrySyncResult = SyncResult & {
	detail: string;
	operation: SyncOperation;
	/** Pre-computed SHA-256 hash (set for upload/conflict-local-wins operations). */
	hash?: string;
	conflictCopyPath?: string;
	conflictWinner?: "local" | "remote";
};

export type SyncOperation =
	| "upload"
	| "download"
	| "delete-local"
	| "delete-remote"
	| "conflict"
	| "noop";

export type SyncProgress = {
	current: number;
	total: number;
	path: string;
};

export type SyncActivityEvent =
	| { type: "connected" }
	| { type: "operation-planned"; operation: SyncOperation; path: string; detail: string }
	| { type: "operation-start"; operation: SyncOperation; path: string; detail: string }
	| { type: "operation-complete"; operation: SyncOperation; path: string; detail: string }
	| { type: "accepted"; operation: SyncOperation; path: string };

type MixedEntry = {
	path: string;
	local?: LocalEntry;
	remote?: RemoteEntry;
	prev?: SyncedFileRecord;
};

type LocalEntry = {
	path: string;
	mtime: number;
	ctime: number;
	size: number;
	file: TAbstractFile;
};

type LocalScan = {
	files: Map<string, LocalEntry>;
	dirs: Set<string>;
};

type RemoteScan = {
	files: Map<string, RemoteEntry>;
	dirs: Set<string>;
};

type PrevRecord = {
	path: string;
	mtime: number;
	ctime: number;
	size: number;
	hash?: string;
	remoteUuid?: string;
	lastSyncAt?: number;
	lastKnownSide?: "local" | "remote" | "both";
};

export class SyncEngine {
	constructor(private readonly config: SyncEngineConfig) {}

	close(): void {
		this.config.remote.close();
	}

	async testRemote(): Promise<void> {
		await this.config.remote.checkConnect();
	}

	/**
	 * Bidirectional sync. Plan all operations first (one pass), then apply.
	 *
	 * The two-pass design lets us ask for confirmation before any local files
	 * are deleted — a safety guard for the "must be really careful" deletion case.
	 *
	 * @param onProgress called for each file during the apply phase
	 * @param confirmLocalDeletes called before any local deletions; return false to abort
	 */
	async sync(
		onProgress?: (progress: SyncProgress) => void,
		confirmLocalDeletes?: (paths: string[]) => Promise<boolean>,
		onActivity?: (event: SyncActivityEvent) => void,
	): Promise<SyncOutcome> {
		await this.config.remote.mkdir("");
		onActivity?.({ type: "connected" });

		const pathFilter = createSyncPathFilter({
			configDir: this.config.app.vault.configDir,
			pluginId: this.config.pluginId,
			ignorePatterns: this.config.settings.ignorePatterns,
		});

		const [local, remote, prevRecords] = await Promise.all([
			this.walkLocal(pathFilter),
			this.walkRemote(pathFilter),
			this.config.db.getAllFiles(),
		]);

		const prev = filterPrevRecords(prevRecords, pathFilter);
		const entries = this.ensemble(local.files, remote.files, prev);

		// Plan phase: determine what each file needs without touching disk/network
		const planned: Array<{ entry: MixedEntry; plan: EntrySyncResult }> = [];
		for (const entry of entries) {
			const plan = await this.planFile(entry);
			planned.push({ entry, plan });
		}

		// Deletion safety: confirm before any local files are removed.
		// Only files proven to exist in the baseline are ever deleted locally —
		// a missing-but-never-synced file is downloaded, not deleted.
		if (confirmLocalDeletes !== undefined) {
			const deleteLocalPaths = planned
				.filter(({ plan }) => plan.operation === "delete-local")
				.map(({ entry }) => entry.path);
			if (deleteLocalPaths.length > 0) {
				const confirmed = await confirmLocalDeletes(deleteLocalPaths);
				if (!confirmed)
					return { applied: 0, conflicts: 0, conflictCopies: [], cancelled: true };
			}
		}

		// Apply phase
		let applied = 0;
		let conflicts = 0;
		const conflictCopies: ConflictCopy[] = [];
		const total = planned.length;

		applied += await this.syncDirectories(local.dirs, remote.dirs);

		for (const [index, { entry, plan }] of planned.entries()) {
			onProgress?.({ current: index + 1, total, path: entry.path });
			if (plan.operation !== "noop") {
				onActivity?.({
					type: "operation-planned",
					operation: plan.operation,
					path: entry.path,
					detail: plan.detail,
				});
				onActivity?.({
					type: "operation-start",
					operation: plan.operation,
					path: entry.path,
					detail: plan.detail,
				});
			}
			const result = await this.applySyncEntry(entry, plan);
			applied += result.applied;
			conflicts += result.conflicts;
			if (result.operation !== "noop" && result.applied > 0) {
				onActivity?.({
					type: "operation-complete",
					operation: result.operation,
					path: entry.path,
					detail: result.detail,
				});
				onActivity?.({ type: "accepted", operation: result.operation, path: entry.path });
			}
			if (result.conflictCopyPath !== undefined) {
				conflictCopies.push({
					originalPath: entry.path,
					copyPath: result.conflictCopyPath,
				});
			}
		}

		return { applied, conflicts, conflictCopies };
	}

	private async walkLocal(pathFilter: SyncPathFilter): Promise<LocalScan> {
		const files = new Map<string, LocalEntry>();
		const dirs = new Set<string>();
		for (const file of this.config.app.vault.getAllLoadedFiles()) {
			if (file.path.length === 0 || pathFilter.isIgnored(file.path)) continue;
			if (file instanceof TFile) {
				files.set(file.path, {
					path: file.path,
					mtime: file.stat.mtime,
					ctime: file.stat.ctime,
					size: file.stat.size,
					file,
				});
			} else if (file instanceof TFolder) {
				dirs.add(file.path);
			}
		}
		return { files, dirs };
	}

	private async walkRemote(pathFilter: SyncPathFilter): Promise<RemoteScan> {
		const files = new Map<string, RemoteEntry>();
		const dirs = new Set<string>();
		for (const entry of await this.config.remote.walk()) {
			if (pathFilter.isIgnored(entry.path)) continue;
			if (entry.isDir) {
				dirs.add(entry.path);
			} else {
				files.set(entry.path, entry);
			}
		}
		return { files, dirs };
	}

	private async syncDirectories(
		localDirs: Set<string>,
		remoteDirs: Set<string>,
	): Promise<number> {
		let applied = 0;
		for (const path of sortDirs(localDirs)) {
			if (!remoteDirs.has(path)) {
				await this.config.remote.mkdir(path);
				applied++;
			}
		}
		for (const path of sortDirs(remoteDirs)) {
			if (!localDirs.has(path)) {
				await ensureLocalDirectory(this.config.app, path);
				applied++;
			}
		}
		return applied;
	}

	private ensemble(
		local: Map<string, LocalEntry>,
		remote: Map<string, RemoteEntry>,
		prev: Map<string, SyncedFileRecord>,
	): MixedEntry[] {
		const paths = new Set<string>([...local.keys(), ...remote.keys(), ...prev.keys()]);
		return [...paths].sort().map((path) => ({
			path,
			local: local.get(path),
			remote: remote.get(path),
			prev: prev.get(path),
		}));
	}

	private async planFile(entry: MixedEntry): Promise<EntrySyncResult> {
		const { local, remote, prev } = entry;

		if (local === undefined && remote === undefined) {
			return skipped("Missing on both sides");
		}

		// Local only
		if (local !== undefined && remote === undefined) {
			if (prev !== undefined) {
				// Baseline proves it was on both sides → remote was deleted
				// If local changed since baseline, it's delete-vs-modify: keep local
				const localChange = await this.detectLocalChange(prev, local);
				if (localChange.changed) {
					return {
						applied: 1,
						conflicts: 1,
						detail: "Remote deleted; local changed (conflict copy made)",
						operation: "conflict",
						hash: localChange.hash,
						conflictWinner: "local",
					};
				}
				return {
					applied: 1,
					conflicts: 0,
					detail: "Remote deleted; removing local",
					operation: "delete-local",
				};
			}
			// Never synced → new local file
			const hash = await this.hashLocal(local);
			return {
				applied: 1,
				conflicts: 0,
				detail: "New local file; uploading",
				operation: "upload",
				hash,
			};
		}

		// Remote only
		if (local === undefined && remote !== undefined) {
			if (prev !== undefined) {
				// Baseline proves it was on both sides → local was deleted
				// If remote changed since baseline, it's delete-vs-modify: keep remote
				if (!sameRemoteRecord(prev, remote)) {
					return {
						applied: 1,
						conflicts: 1,
						detail: "Local deleted; remote changed (conflict copy made)",
						operation: "conflict",
						conflictWinner: "remote",
					};
				}
				return {
					applied: 1,
					conflicts: 0,
					detail: "Local deleted; removing remote",
					operation: "delete-remote",
				};
			}
			// Never synced → new remote file
			return {
				applied: 1,
				conflicts: 0,
				detail: "New remote file; downloading",
				operation: "download",
			};
		}

		// Both exist — TypeScript narrowing fallback
		if (local === undefined || remote === undefined) return skipped("File unavailable");

		// Both exist, no baseline → first sync for this path
		if (prev === undefined) {
			const newer = chooseNewer(local, remote);
			if (newer === "local") {
				const hash = await this.hashLocal(local);
				return {
					applied: 1,
					conflicts: 1,
					detail: "No baseline; local is newer (conflict copy made)",
					operation: "conflict",
					hash,
					conflictWinner: "local",
				};
			}
			return {
				applied: 1,
				conflicts: 1,
				detail: "No baseline; remote is newer (conflict copy made)",
				operation: "conflict",
				conflictWinner: "remote",
			};
		}

		// Both exist, with baseline → detect what changed
		const localChange = await this.detectLocalChange(prev, local);
		const remoteChanged = !sameRemoteRecord(prev, remote);

		if (!localChange.changed && !remoteChanged) return skipped("Unchanged");
		if (localChange.changed && !remoteChanged) {
			return {
				applied: 1,
				conflicts: 0,
				detail: "Local changed; uploading",
				operation: "upload",
				hash: localChange.hash,
			};
		}
		if (!localChange.changed && remoteChanged) {
			return {
				applied: 1,
				conflicts: 0,
				detail: "Remote changed; downloading",
				operation: "download",
			};
		}

		// Both changed → conflict: keep the newer side, save a conflict copy of the other
		const newer = chooseNewer(local, remote);
		if (newer === "local") {
			return {
				applied: 1,
				conflicts: 1,
				detail: "Both changed; local newer (conflict copy made)",
				operation: "conflict",
				hash: localChange.hash,
				conflictWinner: "local",
			};
		}
		return {
			applied: 1,
			conflicts: 1,
			detail: "Both changed; remote newer (conflict copy made)",
			operation: "conflict",
			conflictWinner: "remote",
		};
	}

	private async applySyncEntry(
		entry: MixedEntry,
		plan: EntrySyncResult,
	): Promise<EntrySyncResult> {
		switch (plan.operation) {
			case "delete-local": {
				if (entry.prev !== undefined) await this.config.db.deleteFile(entry.path);
				await this.deleteLocal(entry.path);
				return plan;
			}
			case "delete-remote": {
				await this.config.remote.rm(entry.path);
				if (entry.prev !== undefined) await this.config.db.deleteFile(entry.path);
				return plan;
			}
			case "upload": {
				if (entry.local === undefined) return plan;
				const hash = plan.hash ?? (await this.hashLocal(entry.local));
				await this.pushLocal(entry.path, entry.local, hash);
				return plan;
			}
			case "download": {
				if (entry.remote === undefined) return plan;
				await this.pullRemote(entry.path, entry.remote);
				return plan;
			}
			case "conflict": {
				let conflictCopyPath: string | undefined;
				if (entry.local !== undefined && entry.remote !== undefined) {
					// plan.hash is set when local wins (computed during plan phase)
					if (plan.hash !== undefined) {
						// Local wins — preserve remote as the conflict copy
						conflictCopyPath = await this.writeRemoteConflictCopy(
							entry.path,
							entry.remote,
						);
						await this.pushLocal(entry.path, entry.local, plan.hash);
					} else {
						// Remote wins — preserve local as the conflict copy
						conflictCopyPath =
							(await this.writeLocalConflictCopy(entry.local.path)) ?? undefined;
						await this.pullRemote(entry.path, entry.remote);
					}
				} else if (entry.local !== undefined) {
					// Delete-vs-modify: remote deleted, local changed → re-upload local
					const hash = plan.hash ?? (await this.hashLocal(entry.local));
					await this.pushLocal(entry.path, entry.local, hash);
				} else if (entry.remote !== undefined) {
					// Delete-vs-modify: local deleted, remote changed → restore remote locally
					await this.pullRemote(entry.path, entry.remote);
				}
				return conflictCopyPath !== undefined ? { ...plan, conflictCopyPath } : plan;
			}
			case "noop": {
				// Clean up baseline records for paths gone from both sides
				if (
					entry.prev !== undefined &&
					entry.local === undefined &&
					entry.remote === undefined
				) {
					await this.config.db.deleteFile(entry.path);
				}
				return plan;
			}
			default:
				return plan;
		}
	}

	private async pushLocal(path: string, local: LocalEntry, hash: string): Promise<void> {
		const content = await this.config.app.vault.readBinary(this.asFile(local.file));
		await this.config.remote.writeFile(
			path,
			content instanceof Uint8Array ? content : new Uint8Array(content),
			local.mtime,
			local.ctime,
		);
		await this.upsertPrev({
			path: local.path,
			mtime: local.mtime,
			ctime: local.ctime,
			size: local.size,
			hash,
			lastSyncAt: Date.now(),
			lastKnownSide: "local",
		});
	}

	private async pullRemote(path: string, remote: RemoteEntry): Promise<void> {
		const content = await this.config.remote.readFile(path);
		const hash = await sha256Hex(content);
		await ensureLocalFolder(this.config.app, path);
		await this.config.app.vault.adapter.writeBinary(
			normalizePath(path),
			toArrayBuffer(content),
			{
				mtime: remote.mtime,
				ctime: remote.mtime,
			},
		);
		await this.upsertPrev({
			path,
			mtime: remote.mtime,
			ctime: remote.mtime,
			size: remote.size,
			hash,
			lastSyncAt: Date.now(),
			lastKnownSide: "remote",
		});
	}

	private async detectLocalChange(
		prev: SyncedFileRecord,
		local: LocalEntry,
	): Promise<{ changed: boolean; hash: string }> {
		// Fast path: metadata matches and we have a stored hash
		if (sameFileRecord(prev, local) && prev.hash !== undefined) {
			return { changed: false, hash: prev.hash };
		}

		const hash = await this.hashLocal(local);

		// Metadata matched but hash was missing — backfill it
		if (sameFileRecord(prev, local)) {
			await this.upsertPrev({
				path: local.path,
				mtime: local.mtime,
				ctime: local.ctime,
				size: local.size,
				hash,
			});
			return { changed: false, hash };
		}

		// Metadata drifted (e.g. touch, copy-on-save) but content is identical — update metadata only
		if (prev.hash !== undefined && prev.hash === hash) {
			await this.upsertPrev({
				path: local.path,
				mtime: local.mtime,
				ctime: local.ctime,
				size: local.size,
				hash,
			});
			return { changed: false, hash };
		}

		return { changed: true, hash };
	}

	private async hashLocal(local: LocalEntry): Promise<string> {
		const content = await this.config.app.vault.readBinary(this.asFile(local.file));
		return sha256Hex(content instanceof Uint8Array ? content : new Uint8Array(content));
	}

	private async writeLocalConflictCopy(path: string): Promise<string | null> {
		const file = this.config.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		const copyPath = conflictCopyPath(
			file.path,
			this.config.settings.deviceId,
			Date.now(),
			"local",
		);
		const content = await this.config.app.vault.readBinary(file);
		await ensureLocalFolder(this.config.app, copyPath);
		await this.config.app.vault.adapter.writeBinary(copyPath, content, {
			mtime: file.stat.mtime,
			ctime: file.stat.ctime,
		});
		return copyPath;
	}

	private async writeRemoteConflictCopy(path: string, remote: RemoteEntry): Promise<string> {
		const bytes = await this.config.remote.readFile(path);
		const copyPath = conflictCopyPath(
			path,
			this.config.settings.deviceId,
			Date.now(),
			"remote",
		);
		await ensureLocalFolder(this.config.app, copyPath);
		await this.config.app.vault.adapter.writeBinary(copyPath, toArrayBuffer(bytes), {
			mtime: remote.mtime,
			ctime: remote.mtime,
		});
		return copyPath;
	}

	private async deleteLocal(path: string): Promise<void> {
		const file = this.config.app.vault.getAbstractFileByPath(normalizePath(path));
		if (file === null) return;
		await this.config.app.fileManager.trashFile(file);
	}

	private async upsertPrev(record: PrevRecord): Promise<void> {
		const existing = await this.config.db.getFile(record.path);
		const merged: SyncedFileRecord = {
			...record,
			remoteUuid: record.remoteUuid ?? existing?.remoteUuid,
		};
		await this.config.db.setFile(record.path, merged);
	}

	private asFile(file: TAbstractFile | null): TFile {
		if (!(file instanceof TFile)) throw new Error("expected file");
		return file;
	}
}

const sameFileRecord = (prev: SyncedFileRecord, local: LocalEntry): boolean =>
	prev.path === local.path &&
	prev.mtime === local.mtime &&
	prev.ctime === local.ctime &&
	prev.size === local.size;

const sameRemoteRecord = (prev: SyncedFileRecord, remote: RemoteEntry): boolean =>
	prev.path === remote.path && prev.mtime === remote.mtime && prev.size === remote.size;

const skipped = (detail: string): EntrySyncResult => ({
	applied: 0,
	conflicts: 0,
	detail,
	operation: "noop",
});

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
	const digest = await window.crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
};

const chooseNewer = (local: LocalEntry, remote: RemoteEntry): "local" | "remote" =>
	local.mtime >= remote.mtime ? "local" : "remote";

const filterPrevRecords = (
	records: Map<string, SyncedFileRecord>,
	pathFilter: SyncPathFilter,
): Map<string, SyncedFileRecord> => {
	const filtered = new Map<string, SyncedFileRecord>();
	for (const [path, record] of records) {
		if (!pathFilter.isIgnored(path)) filtered.set(path, record);
	}
	return filtered;
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
	value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

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
