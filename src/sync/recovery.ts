import { validateSyncPath } from "./path-validation";
import type { App } from "obsidian";
import type { SyncDb, RecoveryRecord } from "../db";
import { sha256Hex } from "./content-hash";

/** Bytes stay in the excluded plugin directory; metadata and paths are bound to the verified target. */
export async function preserveRecovery(
	app: App,
	db: SyncDb,
	pluginId: string,
	path: string,
	bytes: Uint8Array,
	source: string,
): Promise<RecoveryRecord> {
	if (!db.targetKey || !db.addRecovery)
		throw new Error("Verified local recovery storage is unavailable.");
	const directory = `${app.vault.configDir}/plugins/${pluginId}/recovery/${db.targetKey}`;
	let parent = "";
	for (const segment of directory.split("/")) {
		parent = parent ? `${parent}/${segment}` : segment;
		if (!(await app.vault.adapter.exists(parent))) await app.vault.adapter.mkdir(parent);
	}
	const id = globalThis.crypto.randomUUID();
	const storagePath = `${directory}/${id}.bin`;
	const hash = await sha256Hex(bytes);
	await app.vault.adapter.writeBinary(storagePath, bytes.slice().buffer);
	const record = {
		id,
		path,
		storagePath,
		hash,
		size: bytes.length,
		timestamp: Date.now(),
		source,
	};
	await db.addRecovery(record);
	return record;
}
export async function readRecovery(
	app: App,
	db: SyncDb,
	record: RecoveryRecord,
): Promise<Uint8Array> {
	validateSyncPath(record.storagePath);
	if (
		!/^[a-f0-9-]{36}$/.test(record.id) ||
		!record.storagePath.startsWith(`${app.vault.configDir}/plugins/`) ||
		!db.targetKey ||
		!record.storagePath.includes(`/recovery/${db.targetKey}/`) ||
		!record.storagePath.endsWith(`/${record.id}.bin`)
	)
		throw new Error("Recovery target does not match.");
	const bytes = new Uint8Array(await app.vault.adapter.readBinary(record.storagePath));
	if ((await sha256Hex(bytes)) !== record.hash)
		throw new Error("Recovery content failed verification.");
	return bytes;
}
