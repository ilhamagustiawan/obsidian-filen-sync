import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const lockQueues = new Map();
const lockRequests = [];
const locks = {
	request(name, options, callback) {
		assert.equal(options.mode, "exclusive");
		lockRequests.push(name);
		const next = (lockQueues.get(name) ?? Promise.resolve()).then(callback);
		lockQueues.set(
			name,
			next.catch(() => {}),
		);
		return next;
	},
};
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks } });
test.after(() => {
	if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
	else delete globalThis.navigator;
	delete globalThis[Symbol.for("filen-baseline-test-stores")];
});

// Bundle in memory: no generated test artifacts or dependency on IndexedDB timing.
const bundle = await build({
	stdin: {
		contents: `export { SyncDb } from './src/db.ts'; export { stores } from 'localforage';`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
	plugins: [
		{
			name: "baseline-budget-stores",
			setup(b) {
				b.onResolve({ filter: /^(localforage|obsidian)$/ }, ({ path }) => ({
					path,
					namespace: "baseline-test",
				}));
				b.onLoad({ filter: /.*/, namespace: "baseline-test" }, ({ path }) => ({
					contents:
						path === "obsidian"
							? `
					export class Modal {} export class Notice {} export class PluginSettingTab {}
					export class Setting {} export const Platform = { isMobile: false };
					export const normalizePath = p => p;
				`
							: `
					export const stores = globalThis[Symbol.for('filen-baseline-test-stores')] ??= new Map();
					export default { createInstance({name, storeName}) {
						const id = name + ':' + storeName;
						if (!stores.has(id)) stores.set(id, {
							data: new Map(), iterations: 0, visits: 0, reads: 0, fail: null, active: 0, maxActive: 0,
						});
						const s = stores.get(id);
						async function mutate(op, key, value) {
							s.active++; s.maxActive = Math.max(s.maxActive, s.active);
							try {
								await Promise.resolve();
								const fail = s.fail?.op === op && s.fail?.key === key ? s.fail : null;
								if (fail && --fail.remaining === 0) {
									s.fail = null;
									if (!fail.after) throw new Error('injected storage failure');
								} else if (fail) return apply();
								const result = apply();
								if (fail?.after) throw new Error('injected storage failure');
								return result;
							} finally { s.active--; }
							function apply() {
								if (op === 'set') { s.data.set(key, value); return value; }
								s.data.delete(key);
							}
						}
						return {
							async getItem(key) { s.reads++; return s.data.get(key) ?? null; },
							setItem: (key, value) => mutate('set', key, value),
							removeItem: key => mutate('remove', key),
							async iterate(cb) {
								s.iterations++;
								const fail = s.fail?.op === 'iterate' ? s.fail : null;
								if (fail) s.fail = null;
								if (fail && !fail.after) throw new Error('injected storage failure');
								for (const [key, value] of s.data) {
									s.visits++;
									const result = cb(value, key);
									if (fail) throw new Error('injected storage failure');
									if (result !== undefined) return result;
								}
							},
						};
					}};
				`,
				}));
			},
		},
	],
});
const bundleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`;
const { SyncDb, stores } = await import(bundleUrl);
// Independent module evaluation gives each simulated window its own queues and
// indexes, while the localforage stub shares persistent storage and Web Locks.
const { SyncDb: OtherContextDb } = await import(`${bundleUrl}#other-window`);
const MiB = 1024 * 1024;
const fullText = "x".repeat(MiB);
const baseline = (text, savedAt = 1000) => ({ text, savedAt, hash: "baseline-hash" });
let target = 0;
async function fixture(count = 0, size = MiB) {
	const binding = { vaultId: `budget-${++target}`, userId: 1, remoteRootUuid: "root" };
	const db = await SyncDb.open(binding);
	const meta = stores.get(`${db.targetKey}:merge-meta`);
	const text = stores.get(`${db.targetKey}:merge-text`);
	for (let i = 0; i < count; i++) {
		const content = size === MiB ? fullText : "x".repeat(size);
		meta.data.set(`${i}.md`, { size, at: i });
		text.data.set(`${i}.md`, baseline(content, i));
	}
	return { db, binding, meta, text };
}
function fail(store, op, key, after, remaining = 1) {
	store.fail = { op, key, after, remaining };
}
function assertBudget({ meta, text }) {
	let actual = 0,
		accounted = 0;
	for (const [key, value] of text.data) {
		const size = Buffer.byteLength(value.text);
		assert.ok(size <= MiB);
		assert.ok(meta.data.get(key)?.size >= size, `metadata accounts for ${key}`);
		actual += size;
	}
	for (const entry of meta.data.values()) accounted += entry.size;
	assert.ok(actual <= 64 * MiB, `actual bytes: ${actual}`);
	assert.ok(accounted <= 64 * MiB, `accounted bytes: ${accounted}`);
}

test("loads metadata once; under-budget writes neither iterate nor sort the index", async () => {
	const f = await fixture(1000, 10);
	let sorts = 0;
	const originalSort = Array.prototype.sort;
	Array.prototype.sort = function (...args) {
		if (this.length && Array.isArray(this[0]) && typeof this[0][1]?.size === "number") sorts++;
		return originalSort.apply(this, args);
	};
	try {
		for (let i = 0; i < 100; i++) await f.db.setMergeBaseline(`new-${i}.md`, baseline("small"));
	} finally {
		Array.prototype.sort = originalSort;
	}
	assert.equal(f.meta.iterations, 1);
	assert.equal(f.meta.visits, 1000);
	assert.equal(sorts, 0);
	assert.equal(stores.get(`${f.db.targetKey}:merge-budget`).reads, 100);
});

test("overwrite growth/shrink uses UTF-8 byte deltas and oversized removal frees budget", async () => {
	const f = await fixture(64);
	await f.db.setMergeBaseline("0.md", baseline("é".repeat(MiB / 2), 100));
	assert.equal(f.text.data.size, 64, "equal byte size does not evict");
	await f.db.setMergeBaseline("0.md", baseline("", 101));
	await f.db.setMergeBaseline("new.md", baseline(fullText, 102));
	assert.equal(f.text.data.size, 65, "shrinking credits the overwritten bytes");
	await f.db.setMergeBaseline("0.md", baseline(fullText, 103));
	assert.equal(await f.db.getMergeBaseline("1.md"), undefined, "growth evicts the oldest entry");
	await f.db.setMergeBaseline("new.md", baseline(`${fullText}x`, 104));
	assert.equal(await f.db.getMergeBaseline("new.md"), undefined);
	await f.db.setMergeBaseline("replacement.md", baseline(fullText, 105));
	assert.ok(await f.db.getMergeBaseline("2.md"), "oversized removal credits its old size");
	assert.equal(f.meta.iterations, 1);
	assertBudget(f);
});

test("evicts by savedAt rather than insertion order, only above the exact 64 MiB cap", async () => {
	const f = await fixture(63);
	await f.db.setMergeBaseline("newest.md", baseline(fullText, 500));
	assert.ok(await f.db.getMergeBaseline("0.md"));
	await f.db.setMergeBaseline("backdated.md", baseline(fullText, -1));
	assert.equal(await f.db.getMergeBaseline("backdated.md"), undefined);
	assert.ok(await f.db.getMergeBaseline("0.md"));
	assertBudget(f);
});

test("contexts reload stale indexes under the same target lock and serialize concurrent writes", async () => {
	const f = await fixture(63);
	assert.equal(stores.has(`${f.db.targetKey}:merge-budget`), false, "coordination store is lazy");
	const other = await OtherContextDb.open(f.binding);
	await f.db.setMergeBaseline("62.md", baseline(fullText, 62));
	await other.setMergeBaseline("62.md", baseline(fullText, 62));
	assert.equal(f.meta.iterations, 2, "each context has an independent index");
	const before = lockRequests.length;
	await Promise.all([
		f.db.setMergeBaseline("window-one.md", baseline(fullText, 100)),
		other.setMergeBaseline("window-two.md", baseline(fullText, 101)),
	]);
	assert.deepEqual(
		lockRequests.slice(before),
		Array(2).fill(`filen-merge-baseline:${f.db.targetKey}`),
	);
	assert.equal(f.meta.iterations, 4, "generation changes invalidate both cached indexes");
	assert.equal(f.meta.maxActive, 1);
	assert.equal(f.text.maxActive, 1);
	await f.db.setMergeBaseline("third.md", baseline(fullText, 102));
	assert.equal(f.meta.iterations, 5);
	assert.equal(await other.getMergeBaseline("0.md"), undefined);
	assert.equal(await other.getMergeBaseline("1.md"), undefined);
	assertBudget(f);
});

test("without Web Locks metadata is reloaded on every write and after external writes", async () => {
	const f = await fixture(63);
	const other = await OtherContextDb.open(f.binding);
	const navigator = globalThis.navigator;
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: undefined });
	try {
		const before = lockRequests.length;
		await f.db.setMergeBaseline("first.md", baseline(fullText, 100));
		await other.setMergeBaseline("external.md", baseline(fullText, 101));
		await f.db.setMergeBaseline("last.md", baseline(fullText, 102));
		assert.equal(f.meta.iterations, 3);
		assert.equal(lockRequests.length, before);
		assertBudget(f);
		const second = await SyncDb.open(f.binding);
		await Promise.all([
			f.db.setMergeBaseline("queued-one.md", baseline(fullText, 103)),
			second.setMergeBaseline("queued-two.md", baseline(fullText, 104)),
		]);
		assert.equal(f.meta.iterations, 5);
		assert.equal(f.meta.maxActive, 1, "same-runtime writes remain serialized");
		assertBudget(f);
	} finally {
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
	}
	await f.db.setMergeBaseline("locked-again.md", baseline(fullText, 105));
	assert.equal(f.meta.iterations, 6, "fallback does not leave an index to trust later");
	assertBudget(f);
});

for (const after of [false, true]) {
	test(`other context invalidates after partial write ${after ? "after" : "before"} text mutation`, async () => {
		const f = await fixture(64);
		const other = await OtherContextDb.open(f.binding);
		await f.db.setMergeBaseline("63.md", baseline(fullText, 63));
		await other.setMergeBaseline("63.md", baseline(fullText, 63));
		const coordination = stores.get(`${f.db.targetKey}:merge-budget`);
		const previous = coordination.data.get("generation");
		fail(f.text, "set", "interrupted.md", after);
		await assert.rejects(
			f.db.setMergeBaseline("interrupted.md", baseline(fullText, 100)),
			/injected storage failure/,
		);
		assert.notEqual(
			coordination.data.get("generation"),
			previous,
			"invalidation precedes baseline mutation",
		);
		await other.setMergeBaseline("next-window.md", baseline(fullText, 101));
		assert.equal(f.meta.iterations, 4);
		assertBudget(f);
	});
	test(`failed generation advance ${after ? "after" : "before"} commit leaves baseline stores untouched`, async () => {
		const f = await fixture(1);
		await f.db.setMergeBaseline("0.md", baseline(fullText, 0));
		const coordination = stores.get(`${f.db.targetKey}:merge-budget`);
		fail(coordination, "set", "generation", after);
		await assert.rejects(
			f.db.setMergeBaseline("not-written.md", baseline("x")),
			/injected storage failure/,
		);
		assert.equal(f.meta.data.has("not-written.md"), false);
		assert.equal(f.text.data.has("not-written.md"), false);
		await f.db.setMergeBaseline("retry.md", baseline("x"));
		assert.equal(f.meta.iterations, 2);
		assertBudget(f);
	});
}

test("instances share serialization/index and targets retain independent budgets", async () => {
	const f = await fixture(63);
	const second = await SyncDb.open(f.binding);
	await Promise.all(
		Array.from({ length: 20 }, (_, i) =>
			(i % 2 ? second : f.db).setMergeBaseline(
				`concurrent-${i}.md`,
				baseline(fullText, 100 + i),
			),
		),
	);
	assert.equal(f.meta.iterations, 1);
	assert.equal(f.meta.visits, 63);
	assert.equal(f.meta.maxActive, 1);
	assert.equal(f.text.maxActive, 1);
	assert.equal(f.text.data.size, 64);
	for (let i = 0; i < 19; i++) assert.equal(await second.getMergeBaseline(`${i}.md`), undefined);
	assertBudget(f);
	const other = await SyncDb.open({ ...f.binding, remoteRootUuid: "other-root" });
	await other.setMergeBaseline("isolated.md", baseline(fullText));
	assert.equal(await second.getMergeBaseline("isolated.md"), undefined);
	const readonly = await SyncDb.open(f.binding, { readOnly: true });
	await assert.rejects(readonly.setMergeBaseline("blocked.md", baseline("x")), /read-only/);
	await assert.rejects(second.setMergeBaseline("../blocked.md", baseline("x")));
});

for (const after of [false, true]) {
	test(`retries a metadata load that fails ${after ? "during" : "before"} iteration`, async () => {
		const f = await fixture(10);
		fail(f.meta, "iterate", "", after);
		await assert.rejects(
			f.db.setMergeBaseline("failed.md", baseline("x")),
			/injected storage failure/,
		);
		await f.db.setMergeBaseline("next.md", baseline("x"));
		assert.equal(f.meta.iterations, 2);
		assertBudget(f);
	});
	test(`recovers a growing overwrite failure ${after ? "after" : "before"} text mutation`, async () => {
		const f = await fixture(64);
		await f.db.setMergeBaseline("63.md", baseline("x", 100));
		fail(f.text, "set", "63.md", after);
		await assert.rejects(
			f.db.setMergeBaseline("63.md", baseline(fullText, 101)),
			/injected storage failure/,
		);
		await f.db.setMergeBaseline("next.md", baseline(fullText, 200));
		assert.equal(f.meta.iterations, 2);
		assertBudget(f);
	});
	for (const stage of [
		"reserve",
		"text",
		"shrink",
		"evict-text",
		"evict-meta",
		"oversize-text",
		"oversize-meta",
	]) {
		test(`recovers after ${stage} failure ${after ? "after" : "before"} storage mutation`, async () => {
			const f = await fixture(64);
			const second = await SyncDb.open(f.binding);
			await f.db.setMergeBaseline("63.md", baseline(fullText, 63));
			let path = "63.md",
				value = baseline("small", 100);
			if (stage === "reserve") fail(f.meta, "set", path, after);
			if (stage === "text") fail(f.text, "set", path, after);
			if (stage === "shrink") fail(f.meta, "set", path, after, 2);
			if (stage.startsWith("evict")) {
				path = "new.md";
				value = baseline(fullText, 100);
				fail(stage === "evict-text" ? f.text : f.meta, "remove", "0.md", after);
			}
			if (stage.startsWith("oversize")) {
				value = baseline(`${fullText}x`, 100);
				fail(stage === "oversize-text" ? f.text : f.meta, "remove", path, after);
			}
			const rejected = assert.rejects(
				f.db.setMergeBaseline(path, value),
				/injected storage failure/,
			);
			// Already queued on a different instance when the first write fails.
			const recovered = second.setMergeBaseline("next.md", baseline(fullText, 200));
			await rejected;
			await recovered;
			assert.ok(await second.getMergeBaseline("next.md"));
			assert.equal(f.meta.iterations, 2, "failed writes invalidate the shared index");
			assertBudget(f);
		});
	}
}
