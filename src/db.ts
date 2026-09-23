import localforage from "localforage";
import type { SyncedFileRecord } from "./settings";
import { SYNC_DB_SCHEMA_VERSION } from "./settings";
import { validateSyncPath } from "./sync/path-validation";

export type SyncDbOptions = {
	vaultId: string;
	userId: number;
	remoteRootUuid: string;
};

// Thin IndexedDB wrapper for persisting per-file sync state.
// Keyed by file path; values are SyncedFileRecord objects.
export interface SyncDb {
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
	async open(binding: SyncDbOptions): Promise<SyncDb> {
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
		const db = new LocalForageDb(store, binding);
		await db.loadMeta();
		return db;
	},
} as const;

class LocalForageDb implements SyncDb {
	private _schemaVersion = 0;

	constructor(
		private readonly store: ReturnType<typeof localforage.createInstance>,
		private readonly binding: SyncDbOptions,
	) {}

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
		validateSyncPath(path);
		if (record.path !== path || !isValidSyncedFileRecord(record)) {
			throw new Error("Cannot save invalid sync history for this path.");
		}
		await this.store.setItem(path, record);
	}

	async deleteFile(path: string): Promise<void> {
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

			this._schemaVersion = SYNC_DB_SCHEMA_VERSION;
			await this.store.setItem(META_KEY, {
				schemaVersion: this._schemaVersion,
				binding: this.binding,
			});
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
