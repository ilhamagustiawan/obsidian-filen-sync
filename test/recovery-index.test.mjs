import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// In-memory bundle: no generated repository files or persistent test databases.
const bundle = await build({
	stdin: {
		contents: `export { SyncDb } from './src/db.ts'; export { RecoveryIndex, RECOVERY_LOOKUP_TTL_MS } from './src/sync/recovery-index.ts'; export { stores } from 'localforage';`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
	plugins: [
		{
			name: "recovery-localforage",
			setup(b) {
				b.onResolve({ filter: /^obsidian$/ }, () => ({
					path: "obsidian",
					namespace: "obsidian-stub",
				}));
				b.onLoad({ filter: /.*/, namespace: "obsidian-stub" }, () => ({
					contents: `
export class Modal {}
export const Platform = { isMobile: false };
export class Notice {}
export class PluginSettingTab {}
export class Setting {}
export const normalizePath = (path) => path;
`,
				}));
				b.onResolve({ filter: /^localforage$/ }, () => ({
					path: "localforage",
					namespace: "stub",
				}));
				b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
					contents: `
export const stores = new Map();
export default { createInstance({name, storeName}) {
  const key = JSON.stringify([name, storeName]);
  if (!stores.has(key)) stores.set(key, { values: new Map(), scans: 0, writes: 0 });
  const state = stores.get(key);
  return {
    async getItem(key) { return structuredClone(state.values.get(key) ?? null); },
    async setItem(key, value) {
      state.writes++;
      await state.beforeSet?.();
      state.values.set(key, structuredClone(value));
      await state.afterSet?.();
      return value;
    },
    async removeItem(key) { state.values.delete(key); },
    async iterate(fn) {
      state.scans++;
      const snapshot = structuredClone([...state.values]);
      await state.beforeScan?.();
      for (const [key, value] of snapshot) fn(value, key);
      await state.afterScan?.();
    }
  };
}};`,
				}));
			},
		},
	],
});
const { SyncDb, stores, RecoveryIndex, RECOVERY_LOOKUP_TTL_MS } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
let sequence = 0;
async function fixture() {
	const binding = { vaultId: `recovery-test-${sequence++}`, userId: 1, remoteRootUuid: "root" };
	const db = await SyncDb.open(binding);
	const state = stores.get(JSON.stringify([db.targetKey, "recovery"]));
	return { db, state, open: (options) => SyncDb.open(binding, options) };
}
const record = (id, path = "note.md", timestamp = 1) => ({
	id,
	path,
	timestamp,
	storagePath: `.obsidian/recovery/${id}`,
	hash: "a".repeat(64),
	size: 42,
	source: "local",
});
const ids = (records) => records.map((r) => r.id);
function deferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test("legacy recovery metadata is lazily indexed by exact original path without writes", async () => {
	const { db, state, open } = await fixture();
	const legacy = [record("old"), record("new", "note.md", 9), record("other", "Note.md")];
	for (const r of legacy) state.values.set(r.id, structuredClone(r));
	const reader = await open({ readOnly: true });
	assert.deepEqual(ids(await reader.getRecovery("note.md")), ["new", "old"]);
	assert.deepEqual(ids(await db.getRecovery("note.md")), ["new", "old"]);
	assert.equal(state.scans, 1);
	assert.equal(state.writes, 0);
	assert.deepEqual([...state.values.values()], legacy);
	assert.deepEqual(await db.getRecovery("missing.md"), []);
	assert.deepEqual(await db.getRecovery("missing.md"), []);
	assert.equal(state.scans, 2);
	const history = await db.getRecovery("note.md");
	history[0].path = "mutated.md";
	history.pop();
	assert.deepEqual(ids(await reader.getRecovery("note.md")), ["new", "old"]);
	await assert.rejects(reader.addRecovery(record("denied")), /read-only/);
	await assert.rejects(db.getRecovery("../outside.md"));
});

test("writes invalidate all paths across instances, including ID replacement; targets stay isolated", async () => {
	const a = await fixture(),
		b = await fixture();
	const peer = await a.open();
	await a.db.addRecovery(record("shared"));
	await b.db.addRecovery(record("shared", "note.md", 7));
	await a.db.getRecovery("note.md");
	await a.db.getRecovery("moved.md");
	await b.db.getRecovery("note.md");
	const bScans = b.state.scans;
	await peer.addRecovery(record("shared", "moved.md"));
	assert.deepEqual(await a.db.getRecovery("note.md"), []);
	assert.deepEqual(ids(await a.db.getRecovery("moved.md")), ["shared"]);
	assert.equal((await b.db.getRecovery("note.md"))[0].timestamp, 7);
	assert.equal(b.state.scans, bScans);
});

test("failed writes, including commit-then-reject, cannot leave stale cached history", async () => {
	const { db, state } = await fixture();
	await db.addRecovery(record("existing"));
	await db.getRecovery("note.md");
	state.beforeSet = () => {
		throw new Error("before commit");
	};
	await assert.rejects(db.addRecovery(record("failed")), /before commit/);
	state.beforeSet = undefined;
	assert.deepEqual(ids(await db.getRecovery("note.md")), ["existing"]);
	state.afterSet = () => {
		throw new Error("after commit");
	};
	await assert.rejects(db.addRecovery(record("committed", "note.md", 2)), /after commit/);
	state.afterSet = undefined;
	assert.deepEqual(ids(await db.getRecovery("note.md")), ["committed", "existing"]);
});

test("a scan racing a write cannot publish an incomplete cache", async () => {
	const { db, state, open } = await fixture();
	const peer = await open();
	const entered = deferred(),
		release = deferred();
	state.beforeScan = async () => {
		entered.resolve();
		await release.promise;
	};
	const lookup = db.getRecovery("note.md");
	await entered.promise;
	await peer.addRecovery(record("concurrent"));
	release.resolve();
	await lookup;
	state.beforeScan = undefined;
	assert.deepEqual(ids(await db.getRecovery("note.md")), ["concurrent"]);
	assert.equal(state.scans, 2);
});

test("lookups during concurrent writes are not retained, even when one writer finishes", async () => {
	const { db, state, open } = await fixture();
	const peer = await open();
	const entered = deferred(),
		release = deferred();
	let calls = 0;
	state.beforeSet = async () => {
		if (++calls === 1) {
			entered.resolve();
			await release.promise;
		}
	};
	const first = db.addRecovery(record("first"));
	await entered.promise;
	await peer.addRecovery(record("second"));
	assert.deepEqual(ids(await peer.getRecovery("note.md")), ["second"]);
	await peer.getRecovery("note.md");
	assert.equal(state.scans, 2);
	release.resolve();
	await first;
	assert.deepEqual(new Set(ids(await db.getRecovery("note.md"))), new Set(["first", "second"]));
});

test("scan failures retry without retaining partial results", async () => {
	const { db, state } = await fixture();
	state.values.set("old", record("old"));
	state.afterScan = () => {
		throw new Error("scan interrupted");
	};
	await assert.rejects(db.getRecovery("note.md"), /scan interrupted/);
	state.afterScan = undefined;
	assert.deepEqual(ids(await db.getRecovery("note.md")), ["old"]);
	assert.equal(state.scans, 2);
});

test("cache eviction and oversized histories never truncate or delete recovery records", async () => {
	const { db, state } = await fixture();
	for (let i = 0; i < 257; i++) state.values.set(`large-${i}`, record(`large-${i}`));
	assert.equal((await db.getRecovery("note.md")).length, 257);
	assert.equal((await db.getRecovery("note.md")).length, 257);
	assert.equal(state.scans, 2);
	await db.getRecovery("evicted.md");
	for (let i = 0; i < 128; i++) await db.getRecovery(`empty-${i}.md`);
	const scans = state.scans;
	await db.getRecovery("evicted.md");
	assert.equal(state.scans, scans + 1);
	assert.equal(state.values.size, 257);
	assert.equal(state.writes, 0);
});

test("external writes expire after a fixed TTL, including cached empty histories and ID moves", async (t) => {
	let now = 0;
	t.mock.method(performance, "now", () => now);
	const { db, state, open } = await fixture();
	const reader = await open({ readOnly: true });
	state.values.set("existing", record("existing"));
	assert.deepEqual(ids(await reader.getRecovery("note.md")), ["existing"]);
	assert.deepEqual(await db.getRecovery("moved.md"), []);
	// Bypass the runtime's invalidation, as a second process or older plugin does.
	// The replacement preserves the store count, so length() is not a revision.
	state.values.set("existing", record("existing", "moved.md"));
	now = RECOVERY_LOOKUP_TTL_MS - 1;
	assert.deepEqual(ids(await reader.getRecovery("note.md")), ["existing"]);
	assert.deepEqual(await db.getRecovery("moved.md"), []);
	assert.equal(state.scans, 2);
	now = RECOVERY_LOOKUP_TTL_MS;
	assert.deepEqual(await reader.getRecovery("note.md"), []);
	assert.deepEqual(ids(await db.getRecovery("moved.md")), ["existing"]);
	assert.equal(state.scans, 4);
	state.values.set("external", record("external", "moved.md", 2));
	now += RECOVERY_LOOKUP_TTL_MS;
	assert.deepEqual(ids(await reader.getRecovery("moved.md")), ["external", "existing"]);
	assert.equal(state.writes, 0);
});

test("slow scans do not start a new TTL at completion, and failed refreshes never serve expired data", async () => {
	let now = 0;
	const index = new RecoveryIndex(() => now);
	let scans = 0;
	const scan = async () => {
		scans++;
		return [record("old")];
	};
	await index.getRecovery("target", "note.md", async () => {
		scans++;
		now += RECOVERY_LOOKUP_TTL_MS;
		return [record("old")];
	});
	await index.getRecovery("target", "note.md", scan);
	assert.equal(scans, 2, "slow result was not retained");
	now += RECOVERY_LOOKUP_TTL_MS;
	await assert.rejects(
		index.getRecovery("target", "note.md", async () => {
			throw new Error("refresh interrupted");
		}),
		/refresh interrupted/,
	);
	assert.deepEqual(await index.getRecovery("target", "note.md", async () => []), []);
	// A clock discontinuity must also fail closed rather than extend freshness.
	now--;
	assert.deepEqual(ids(await index.getRecovery("target", "note.md", scan)), ["old"]);
	assert.equal(scans, 3);
});
