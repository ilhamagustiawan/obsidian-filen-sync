import test, { before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

let SyncEngine;
before(async () => {
	// Bundle in memory: these concurrency tests leave no build artifacts behind.
	const result = await build({
		stdin: {
			contents: 'export { SyncEngine } from "./src/sync-engine.ts";',
			resolveDir: process.cwd(),
		},
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		plugins: [
			{
				name: "obsidian-stub",
				setup(b) {
					b.onResolve({ filter: /^obsidian$/ }, () => ({
						path: "obsidian",
						namespace: "stub",
					}));
					b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
						contents:
							"export class TFile {} export class TFolder {} export const normalizePath=p=>p;",
					}));
				},
			},
		],
	});
	({ SyncEngine } = await import(
		`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
	));
});

function gate() {
	let resolve, reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
const emptyScan = () => ({ files: new Map(), dirs: new Set() });

function fixture({ preview = false, manual = true } = {}) {
	const reads = Object.fromEntries(
		["baseline", "local", "remote"].map((name) => [
			name,
			{
				started: gate(),
				done: gate(),
				calls: 0,
			},
		]),
	);
	const root = { started: gate(), done: gate(), calls: 0 };
	const read = async (name, value) => {
		const state = reads[name];
		state.calls++;
		state.started.resolve();
		await state.done.promise;
		return value;
	};
	const records = new Map([
		["tracked.md", { path: "tracked.md", size: 1 }],
		["ignored.md", { path: "ignored.md", size: 1 }],
	]);
	const engine = new SyncEngine({
		app: { vault: { configDir: ".obsidian", getAbstractFileByPath: () => null } },
		db: { getAllFiles: () => read("baseline", records) },
		pluginId: "filen-sync",
		settings: {
			ignorePatterns: ["ignored.md"],
			fastRemotePolling: false,
			skipLargeFiles: false,
		},
		remote: {
			mkdir: async (path) => {
				assert.equal(path, "");
				root.calls++;
				root.started.resolve();
				await root.done.promise;
			},
			walk: (options) => {
				assert.deepEqual(options, { noCreate: true });
				return read("remote", []);
			},
		},
	});
	let localArgs;
	// Isolate inventory orchestration; scan-policy tests exercise the real byte-bounded scanner.
	engine.walkLocal = (...args) => {
		localArgs = args;
		return read("local", emptyScan());
	};
	// Stop after successful inventories, before planner/executor effects.
	let equalityCalls = 0;
	const complete = new Error("inventories complete");
	engine.resolveRemoteFileHashes = async () => {
		equalityCalls++;
		throw complete;
	};
	const run = () =>
		preview
			? engine.previewPlan("both", {})
			: engine.sync(undefined, undefined, undefined, "both", undefined, undefined, {
					isManual: manual,
				});
	return {
		engine,
		reads,
		root,
		run,
		complete,
		get localArgs() {
			return localArgs;
		},
		get equalityCalls() {
			return equalityCalls;
		},
	};
}

test("sync creates the root before starting any inventory reads", async () => {
	const f = fixture();
	const result = assert.rejects(f.run(), f.complete);
	await f.root.started.promise;
	assert.deepEqual(
		Object.values(f.reads).map((r) => r.calls),
		[0, 0, 0],
	);
	f.root.done.resolve();
	await Promise.all(Object.values(f.reads).map((r) => r.started.promise));
	for (const r of Object.values(f.reads)) r.done.resolve();
	await result;
});

for (const preview of [false, true]) {
	test(`${preview ? "preview" : "manual verified sync"} overlaps all three independent reads`, async () => {
		const f = fixture({ preview });
		f.root.done.resolve();
		const result = assert.rejects(f.run(), f.complete);
		await Promise.all(Object.values(f.reads).map((r) => r.started.promise));
		assert.equal(f.localArgs[1], true);
		assert.equal(f.localArgs[2], null, "verified scans do not depend on baseline paths");
		assert.equal(f.root.calls, preview ? 0 : 1);
		f.reads.remote.done.resolve();
		await turn();
		assert.equal(
			f.engine.remoteTreeCache,
			null,
			"remote completion alone publishes no snapshot",
		);
		assert.equal(f.engine.localScanSnapshot, null);
		assert.equal(f.equalityCalls, 0);
		f.reads.local.done.resolve();
		f.reads.baseline.done.resolve();
		await result;
	});

	for (const failed of ["baseline", "local", "remote"]) {
		test(`${preview ? "preview" : "sync"} drains sibling reads after ${failed} fails`, async () => {
			const f = fixture({ preview });
			f.root.done.resolve();
			const failure = new Error(`${failed} failed`);
			let settled = false;
			const result = assert.rejects(f.run(), failure).then(() => {
				settled = true;
			});
			await Promise.all(Object.values(f.reads).map((r) => r.started.promise));
			f.reads[failed].done.reject(failure);
			await turn();
			assert.equal(settled, false, "failure must wait for outstanding inventory work");
			assert.equal(f.equalityCalls, 0);
			assert.equal(f.engine.remoteTreeCache, null);
			assert.equal(f.engine.localScanSnapshot, null);
			for (const r of Object.values(f.reads)) r.done.resolve();
			await result;
		});
	}
}

test("routine reconcile overlaps remote with baseline but waits for filtered baseline paths locally", async () => {
	const f = fixture({ manual: false });
	f.root.done.resolve();
	const result = assert.rejects(f.run(), f.complete);
	await Promise.all([f.reads.baseline.started.promise, f.reads.remote.started.promise]);
	assert.equal(f.reads.local.calls, 0);
	f.reads.baseline.done.resolve();
	await f.reads.local.started.promise;
	assert.equal(f.localArgs[1], false);
	assert.deepEqual([...f.localArgs[2]], ["tracked.md"]);
	f.reads.local.done.resolve();
	f.reads.remote.done.resolve();
	await result;
});

test("a failed pass drains inventory work before starting its retry", async () => {
	const f = fixture();
	f.root.done.resolve();
	const complete = new Error("retry stopped");
	const originalRead = f.engine.config.db.getAllFiles;
	f.engine.config.db.getAllFiles = () => {
		if (f.reads.baseline.calls === 1) throw complete;
		return originalRead();
	};
	const result = assert.rejects(f.run(), complete);
	await Promise.all(Object.values(f.reads).map((r) => r.started.promise));
	f.reads.remote.done.reject(new Error("Remote changed. Replan the sync."));
	await turn();
	assert.equal(f.reads.baseline.calls, 1);
	assert.equal(f.reads.local.calls, 1);
	f.reads.local.done.resolve();
	await turn();
	assert.equal(f.reads.local.calls, 1, "baseline still draining prevents retry");
	f.reads.baseline.done.resolve();
	await result;
	assert.equal(f.reads.local.calls, 2);
	assert.equal(f.reads.remote.calls, 2);
	assert.equal(f.equalityCalls, 0);
});

for (const preview of [false, true]) {
	test(`${preview ? "preview" : "sync"} rejects an inventory invalidated while remote remains in flight`, async () => {
		const f = fixture({ preview });
		if (!preview) {
			const walk = f.engine.config.remote.walk;
			f.engine.config.remote.walk = async (options) => {
				const entries = await walk(options);
				// Sync retries once; invalidate that pass as well so neither stale
				// inventory can reach equality resolution or snapshot publication.
				if (f.reads.remote.calls === 2) f.engine.invalidateLocal("tracked.md");
				return entries;
			};
		}
		f.root.done.resolve();
		let settled = false;
		const result = assert.rejects(f.run(), /Local files changed while scanning/).then(() => {
			settled = true;
		});
		await Promise.all(Object.values(f.reads).map((r) => r.started.promise));
		f.reads.baseline.done.resolve();
		f.reads.local.done.resolve();
		await turn();
		f.engine.invalidateLocal("tracked.md");
		await turn();
		assert.equal(settled, false);
		assert.equal(f.engine.remoteTreeCache, null);
		assert.equal(f.engine.localScanSnapshot, null);
		f.reads.remote.done.resolve();
		await result;
		assert.equal(f.equalityCalls, 0, "invalidated evidence never reaches equality or planning");
		assert.equal(f.engine.remoteTreeCache, null);
		assert.equal(f.engine.localScanSnapshot, null);
	});
}
