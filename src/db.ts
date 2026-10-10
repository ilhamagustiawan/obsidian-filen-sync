import localforage from "localforage";
import type { SyncedFileRecord } from "./settings";
import { SYNC_DB_SCHEMA_VERSION } from "./settings";
import { validateSyncPath } from "./sync/path-validation";
import type { ConflictRecord } from "./sync/conflict-types";
import { getOriginalPathFromConflictPath, isConflictFilePath } from "./sync/conflict-utils";

export type SyncDbOptions = {
	vaultId: string;
	userId: number;
	remoteRootUuid: string;
};

// Thin IndexedDB wrapper for persisting per-file sync state.
// Keyed by file path; values are SyncedFileRecord objects.
export type MergeBaseline = { text: string; hash: string; savedAt: number };
export type RecoveryRecord = {
	id: string;
	path: string;
	storagePath: string;
	hash: string;
	size: number;
	timestamp: number;
	source: string;
};
export type DeletedMapping = { uuid: string; path: string; parentUuid?: string };
export interface SyncDb {
	readonly targetKey?: string;
	getConflict?(path: string): Promise<ConflictRecord | undefined>;
	getConflicts?(): Promise<Map<string, ConflictRecord>>;
	setConflict?(record: ConflictRecord): Promise<void>;
	deleteConflict?(path: string): Promise<void>;
	getMergeBaseline?(path: string): Promise<MergeBaseline | undefined>;
	setMergeBaseline?(path: string, baseline: MergeBaseline): Promise<void>;
	addRecovery?(record: RecoveryRecord): Promise<void>;
	getRecovery?(path: string): Promise<RecoveryRecord[]>;
	setDeletedMapping?(record: DeletedMapping): Promise<void>;
	getDeletedMappings?(): Promise<DeletedMapping[]>;
	getFile(path: string): Promise<SyncedFileRecord | undefined>;
	setFile(path: string, record: SyncedFileRecord): Promise<void>;
	deleteFile(path: string): Promise<void>;
	getAllFiles(): Promise<Map<string, SyncedFileRecord>>;

	/** Current schema version (after migrations). */
	schemaVersion: number;

	/** Run any pending migrations. Returns true if migrations were applied. */
	runMigrations(): Promise<boolean>;

	/** Close / destroy localforage references if needed. */
	close(): Promise<void>;
}

const META_KEY = "__filen_sync_meta__";

type DbMeta = {
	schemaVersion: number;
	binding: SyncDbOptions;
};

const bindingKey = (binding: SyncDbOptions): string =>
	JSON.stringify([binding.vaultId, binding.userId, binding.remoteRootUuid]);

async function computeDbName(binding: SyncDbOptions): Promise<string> {
	const cryptoObj = globalThis.crypto;
	if (cryptoObj?.subtle === undefined) {
		throw new Error("Secure target binding is unavailable in this environment.");
	}
	const bytes = new TextEncoder().encode(bindingKey(binding));
	const digest = new Uint8Array(await cryptoObj.subtle.digest("SHA-256", bytes));
	const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `obsidian-filen-sync-v3-${hex}`;
}

export const SyncDb = {
	async open(binding: SyncDbOptions, options: { readOnly?: boolean } = {}): Promise<SyncDb> {
		if (
			binding.vaultId.length === 0 ||
			!Number.isSafeInteger(binding.userId) ||
			binding.userId <= 0 ||
			binding.remoteRootUuid.length === 0
		) {
			throw new Error("Cannot open sync history without a verified target identity.");
		}
		const dbName = await computeDbName(binding);

		const store = localforage.createInstance({
			name: dbName,
			storeName: "synced-files",
		});
		const db = new LocalForageDb(store, binding, options.readOnly ?? false, dbName);
		await db.loadMeta();
		return db;
	},
} as const;

class LocalForageDb implements SyncDb {
	private _schemaVersion = 0;
	private readonly baselines: ReturnType<typeof localforage.createInstance>;
	private readonly mergeMeta: ReturnType<typeof localforage.createInstance>;
	private baselineWrite: Promise<void> = Promise.resolve();
	private readonly recovery: ReturnType<typeof localforage.createInstance>;
	private readonly deleted: ReturnType<typeof localforage.createInstance>;
	private readonly conflicts: ReturnType<typeof localforage.createInstance>;

	constructor(
		private readonly store: ReturnType<typeof localforage.createInstance>,
		private readonly binding: SyncDbOptions,
		private readonly readOnly: boolean = false,
		readonly targetKey: string = "",
	) {
		this.baselines = localforage.createInstance({ name: targetKey, storeName: "merge-text" });
		this.mergeMeta = localforage.createInstance({ name: targetKey, storeName: "merge-meta" });
		this.recovery = localforage.createInstance({ name: targetKey, storeName: "recovery" });
		this.deleted = localforage.createInstance({ name: targetKey, storeName: "deleted-items" });
		this.conflicts = localforage.createInstance({ name: targetKey, storeName: "conflicts" });
	}

	private assertWritable(): void {
		if (this.readOnly) throw new Error("Cannot modify sync history in read-only mode.");
	}
	async getConflict(path: string): Promise<ConflictRecord | undefined> {
		validateSyncPath(path);
		const record = await this.conflicts.getItem<ConflictRecord>(path);
		if (record) this.validateConflict(record, path);
		return record ?? undefined;
	}
	async getConflicts(): Promise<Map<string, ConflictRecord>> {
		const records = new Map<string, ConflictRecord>();
		await this.conflicts.iterate<ConflictRecord, void>((record, path) => {
			this.validateConflict(record, path);
			records.set(path, record);
		});
		return records;
	}
	async setConflict(record: ConflictRecord): Promise<void> {
		this.assertWritable();
		this.validateConflict(record, record.path);
		await this.conflicts.setItem(record.path, record);
	}
	async deleteConflict(path: string): Promise<void> {
		this.assertWritable();
		validateSyncPath(path);
		await this.conflicts.removeItem(path);
	}
	private validateConflict(record: ConflictRecord, path: string): void {
		validateSyncPath(path);
		if (
			!record ||
			record.path !== path ||
			typeof record.revision !== "string" ||
			!record.revision ||
			!record.local ||
			!record.remote ||
			!["markdown", "settings", "file"].includes(record.kind) ||
			typeof record.reason !== "string" ||
			!Number.isFinite(record.createdAt) ||
			(record.approval &&
				(!("result" in record.approval) || record.approval.result === undefined))
		)
			throw new Error("Invalid conflict history. Sync paused to protect this target.");
		for (const copy of record.copies ?? []) {
			validateSyncPath(copy.path);
			if (
				!isConflictFilePath(copy.path) ||
				getOriginalPathFromConflictPath(copy.path) !== path
			)
				throw new Error("Conflict copy does not belong to the reviewed file.");
		}
		for (const snapshot of [
			record.local,
			record.remote,
			...(record.copies ?? []).flatMap((copy) => [copy.local, copy.remote]),
		]) {
			if (
				!snapshot ||
				!Number.isFinite(snapshot.mtime) ||
				!Number.isFinite(snapshot.ctime) ||
				(snapshot.identity && (!snapshot.identity.uuid || !snapshot.recovery))
			)
				throw new Error("Invalid conflict snapshot. Sync paused to protect originals.");
		}
		for (const recovery of [
			record.local.recovery,
			record.remote.recovery,
			record.base,
			record.approval?.result,
			...(record.copies ?? []).flatMap((copy) => [copy.local.recovery, copy.remote.recovery]),
		]) {
			if (
				recovery &&
				(recovery.path !== path ||
					typeof recovery.hash !== "string" ||
					!/^[a-f0-9]{64}$/u.test(recovery.hash) ||
					!Number.isSafeInteger(recovery.size) ||
					recovery.size < 0 ||
					!recovery.storagePath.includes(`/recovery/${this.targetKey}/`))
			)
				throw new Error("Conflict recovery target does not match.");
			if (recovery) validateSyncPath(recovery.storagePath);
		}
	}
	async getMergeBaseline(path: string): Promise<MergeBaseline | undefined> {
		validateSyncPath(path);
		return (await this.baselines.getItem<MergeBaseline>(path)) ?? undefined;
	}
	setMergeBaseline(path: string, baseline: MergeBaseline): Promise<void> {
		const write = this.baselineWrite.then(() => this.writeMergeBaseline(path, baseline));
		this.baselineWrite = write.catch(() => {});
		return write;
	}
	private async writeMergeBaseline(path: string, baseline: MergeBaseline): Promise<void> {
		this.assertWritable();
		validateSyncPath(path);
		const size = new TextEncoder().encode(baseline.text).length;
		if (size > 1024 * 1024) {
			await this.baselines.removeItem(path);
			await this.mergeMeta.removeItem(path);
			return;
		}
		await this.baselines.setItem(path, baseline);
		await this.mergeMeta.setItem(path, { size, at: baseline.savedAt });
		const entries: Array<{ path: string; size: number; at: number }> = [];
		await this.mergeMeta.iterate<{ size: number; at: number }, void>((b, key) => {
			entries.push({ path: key, size: b.size, at: b.at });
		});
		let total = entries.reduce((n, e) => n + e.size, 0);
		for (const e of entries.sort((a, b) => a.at - b.at)) {
			if (total <= 64 * 1024 * 1024) break;
			await this.baselines.removeItem(e.path);
			await this.mergeMeta.removeItem(e.path);
			total -= e.size;
		}
	}
	async addRecovery(record: RecoveryRecord): Promise<void> {
		this.assertWritable();
		validateSyncPath(record.path);
		await this.recovery.setItem(record.id, record);
	}
	async getRecovery(path: string): Promise<RecoveryRecord[]> {
		validateSyncPath(path);
		const records: RecoveryRecord[] = [];
		await this.recovery.iterate<RecoveryRecord, void>((r) => {
			if (r.path === path) records.push(r);
		});
		return records.sort((a, b) => b.timestamp - a.timestamp);
	}
	async setDeletedMapping(record: DeletedMapping): Promise<void> {
		this.assertWritable();
		validateSyncPath(record.path);
		await this.deleted.setItem(record.uuid, record);
	}
	async getDeletedMappings(): Promise<DeletedMapping[]> {
		const records: DeletedMapping[] = [];
		await this.deleted.iterate<DeletedMapping, void>((r) => {
			records.push(r);
		});
		return records;
	}

	get schemaVersion(): number {
		return this._schemaVersion;
	}

	async close(): Promise<void> {
		// localforage doesn't require explicit close, but interface is clean
	}

	async getFile(path: string): Promise<SyncedFileRecord | undefined> {
		validateSyncPath(path);
		const record = await this.store.getItem<SyncedFileRecord>(path);
		return record ?? undefined;
	}

	async setFile(path: string, record: SyncedFileRecord): Promise<void> {
		if (this.readOnly) {
			throw new Error("Cannot modify sync history in read-only mode.");
		}
		validateSyncPath(path);
		if (record.path !== path || !isValidSyncedFileRecord(record)) {
			throw new Error("Cannot save invalid sync history for this path.");
		}
		await this.store.setItem(path, record);
		if (record.remoteUuid) await this.setDeletedMapping({ uuid: record.remoteUuid, path });
	}

	async deleteFile(path: string): Promise<void> {
		if (this.readOnly) {
			throw new Error("Cannot modify sync history in read-only mode.");
		}
		validateSyncPath(path);
		await this.store.removeItem(path);
	}

	async getAllFiles(): Promise<Map<string, SyncedFileRecord>> {
		const result = new Map<string, SyncedFileRecord>();
		await this.store.iterate<SyncedFileRecord, void>((value, key) => {
			if (key === META_KEY || !isValidSyncedFileRecord(value) || value.path !== key) return;
			try {
				validateSyncPath(key);
				result.set(key, value);
			} catch {
				// Ignore invalid legacy/corrupt keys; never turn them into sync actions.
			}
		});
		return result;
	}

	async loadMeta(): Promise<void> {
		const meta = await this.store.getItem<DbMeta>(META_KEY);
		if (meta === null) {
			let hasUnboundRecords = false;
			await this.store.iterate<unknown, void>((_value, key) => {
				if (key !== META_KEY) hasUnboundRecords = true;
			});
			if (hasUnboundRecords) {
				throw new Error("Sync history has no verified target binding; refusing to use it.");
			}
			this._schemaVersion = 0;
			if (this.readOnly) {
				return;
			}
			await this.store.setItem(META_KEY, { schemaVersion: 0, binding: this.binding });
			return;
		}
		if (
			typeof meta !== "object" ||
			!Number.isInteger(meta.schemaVersion) ||
			meta.schemaVersion < 0
		) {
			throw new Error(
				"Sync history metadata is corrupt; refusing to open an empty baseline.",
			);
		}
		if (bindingKey(meta.binding) !== bindingKey(this.binding)) {
			throw new Error("Sync history target binding does not match the authenticated target.");
		}
		this._schemaVersion = meta.schemaVersion;
	}

	async runMigrations(): Promise<boolean> {
		if (this.readOnly) {
			throw new Error("Cannot run migrations on sync history in read-only mode.");
		}
		if (this._schemaVersion > SYNC_DB_SCHEMA_VERSION) {
			throw new Error(
				`Sync history schema ${this._schemaVersion} is newer than supported schema ${SYNC_DB_SCHEMA_VERSION}. Update the plugin before syncing.`,
			);
		}
		let migrated = false;

		// Migration 0 → 1: upgrade existing records to v1 schema
		if (this._schemaVersion < 1) {
			const writes: Array<Promise<unknown>> = [];
			await this.store.iterate<Record<string, unknown>, void>((value, key) => {
				if (key === META_KEY) return;

				let changed = false;
				if (typeof value.remoteUuid !== "string") {
					value.remoteUuid = undefined;
					changed = true;
				}
				if (typeof value.remoteHash !== "string") {
					value.remoteHash = undefined;
					changed = true;
				}
				if (typeof value.lastSyncAt !== "number") {
					value.lastSyncAt = undefined;
					changed = true;
				}
				if (
					value.lastKnownSide !== "local" &&
					value.lastKnownSide !== "remote" &&
					value.lastKnownSide !== "both"
				) {
					value.lastKnownSide = undefined;
					changed = true;
				}

				if (changed) writes.push(this.store.setItem(key, value));
			});
			await Promise.all(writes);

			this._schemaVersion = 1;
			await this.store.setItem(META_KEY, {
				schemaVersion: this._schemaVersion,
				binding: this.binding,
			});
			migrated = true;
		}

		if (this._schemaVersion < 2) {
			// Legacy records retain unknown remote timestamps; do not fabricate historical merge text.
			const records = await this.getAllFiles();
			for (const record of records.values())
				if (record.remoteUuid)
					await this.setDeletedMapping({ uuid: record.remoteUuid, path: record.path });
			this._schemaVersion = 2;
			await this.store.setItem(META_KEY, { schemaVersion: 2, binding: this.binding });
			migrated = true;
		}
		if (this._schemaVersion < 3) {
			// Empty conflict store; existing baselines and legacy copies remain readable.
			this._schemaVersion = 3;
			await this.store.setItem(META_KEY, { schemaVersion: 3, binding: this.binding });
			migrated = true;
		}
		return migrated;
	}
}

function isValidSyncedFileRecord(record: unknown): record is SyncedFileRecord {
	if (typeof record !== "object" || record === null) return false;
	const r = record as Record<string, unknown>;
	return (
		typeof r.path === "string" &&
		r.path.length > 0 &&
		typeof r.mtime === "number" &&
		Number.isFinite(r.mtime) &&
		typeof r.ctime === "number" &&
		Number.isFinite(r.ctime) &&
		typeof r.size === "number" &&
		Number.isFinite(r.size) &&
		r.size >= 0
	);
}
