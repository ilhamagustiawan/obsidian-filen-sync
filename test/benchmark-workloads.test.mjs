import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

let scratch;
let SyncEngine;
let TFile;

before(async () => {
	await mkdir(resolve("tmp"), { recursive: true });
	scratch = await mkdtemp(resolve("tmp/bench-"));
	const stub = join(scratch, "obsidian.mjs");
	await writeFile(
		stub,
		"export class TFile {} export class TFolder {} export const normalizePath=p=>p;",
	);
	const outfile = join(scratch, "engine.mjs");
	await build({
		stdin: {
			contents:
				'export {SyncEngine} from "./src/sync-engine.ts"; export {TFile} from "obsidian";',
			resolveDir: process.cwd(),
		},
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		plugins: [
			{
				name: "obsidian-stub",
				setup(b) {
					b.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
				},
			},
		],
	});
	({ SyncEngine, TFile } = await import(pathToFileURL(outfile).href));
});

after(async () => {
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

const bytes = (s) => new TextEncoder().encode(s);
const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
const sha512Hex = (b) => createHash("sha512").update(b).digest("hex");

function createBenchmarkFixture({
	localFiles = {},
	remoteFiles = {},
	baseline = [],
	delayMs = 1,
} = {}) {
	const local = new Map();
	const cloud = new Map();
	const records = new Map();

	let localReads = 0;
	let remoteTreeCalls = 0;
	let remoteMkdirCalls = 0;
	let remoteReadCalls = 0;
	let remoteWriteCalls = 0;
	let remoteSdkResets = 0;
	let progressUpdates = 0;
	let activeFiles = 0;
	let peakFileConcurrency = 0;
	let firstCompletionMs = null;
	const startTime = performance.now();

	for (const [path, content] of Object.entries(localFiles)) {
		const f = new TFile();
		const raw = typeof content === "string" ? bytes(content) : content;
		Object.assign(f, {
			path,
			stat: { mtime: 1000, ctime: 1000, size: raw.length },
			content: raw,
		});
		local.set(path, f);
	}

	for (const [path, item] of Object.entries(remoteFiles)) {
		const raw = typeof item.content === "string" ? bytes(item.content) : item.content;
		cloud.set(path, {
			path,
			mtime: item.mtime ?? 1000,
			size: raw.length,
			isDir: Boolean(item.isDir),
			uuid: item.uuid ?? `uuid-${path}`,
			remoteHash: item.remoteHash ?? sha512Hex(raw),
			content: raw,
		});
	}

	for (const path of baseline) {
		const l = local.get(path);
		const r = cloud.get(path);
		if (l && r) {
			records.set(path, {
				path,
				mtime: l.stat.mtime,
				ctime: l.stat.ctime,
				size: l.stat.size,
				hash: sha256Hex(l.content),
				remoteUuid: r.uuid,
				remoteHash: r.remoteHash,
			});
		}
	}

	const delay = () =>
		delayMs > 0 ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve();

	const app = {
		vault: {
			configDir: ".obsidian",
			getAllLoadedFiles: () => [...local.values()],
			getAbstractFileByPath: (p) => local.get(p) ?? null,
			readBinary: async (file) => {
				localReads++;
				return file.content.slice().buffer;
			},
			adapter: {
				writeBinary: async (p, content) => {
					const f = new TFile();
					const raw = new Uint8Array(content);
					Object.assign(f, {
						path: p,
						stat: { mtime: 1000, ctime: 1000, size: raw.length },
						content: raw,
					});
					local.set(p, f);
				},
				exists: async () => true,
				mkdir: async () => {},
			},
			createFolder: async () => {},
		},
		fileManager: {
			trashFile: async (f) => {
				local.delete(f.path);
			},
		},
	};

	const db = {
		getAllFiles: async () => new Map(records),
		getFile: async (p) => records.get(p),
		setFile: async (p, r) => {
			records.set(p, r);
		},
		deleteFile: async (p) => {
			records.delete(p);
		},
	};

	const remote = {
		mkdir: async (_p) => {
			remoteMkdirCalls++;
			await delay();
		},
		walk: async () => {
			remoteTreeCalls++;
			await delay();
			return [...cloud.values()].map(({ content, ...entry }) => entry);
		},
		checkEvents: async (wm) => ({ hasChanges: false, newWatermarkMs: wm + 1000 }),
		readFile: async (p) => {
			remoteReadCalls++;
			await delay();
			return cloud.get(p)?.content ?? new Uint8Array();
		},
		stat: async (p) => {
			await delay();
			return cloud.get(p) ?? null;
		},
		writeFile: async (p, content, mtime) => {
			activeFiles++;
			peakFileConcurrency = Math.max(peakFileConcurrency, activeFiles);
			remoteWriteCalls++;
			remoteSdkResets++;
			await delay();
			activeFiles--;
			const entry = {
				path: p,
				mtime,
				size: content.length,
				isDir: false,
				uuid: `uuid-${p}`,
				remoteHash: sha512Hex(content),
				content: content.slice(),
			};
			cloud.set(p, entry);
			return entry;
		},
		rm: async (p) => {
			remoteSdkResets++;
			cloud.delete(p);
		},
		close: () => {},
	};

	const engine = new SyncEngine({
		app,
		db,
		pluginId: "filen-sync",
		settings: {
			deviceId: "test-device",
			vaultName: "test-vault",
			ignorePatterns: [],
			fastRemotePolling: true,
			skipLargeFiles: false,
			skipSizeLargerThanMB: 50,
		},
		remote,
	});

	const onProgress = (p) => {
		progressUpdates++;
		if (p.phase === "transferring" && p.current === 1 && firstCompletionMs === null) {
			firstCompletionMs = performance.now() - startTime;
		}
	};

	return {
		engine,
		local,
		cloud,
		records,
		runSync: (options = {}) =>
			engine.sync(
				onProgress,
				undefined,
				undefined,
				"both",
				async () => true,
				undefined,
				options,
			),
		get metrics() {
			return {
				totalMs: performance.now() - startTime,
				firstCompletionMs: firstCompletionMs ?? performance.now() - startTime,
				localReads,
				remoteTreeCalls,
				remoteMkdirCalls,
				remoteReadCalls,
				remoteWriteCalls,
				remoteSdkResets,
				progressUpdates,
				peakFileConcurrency,
			};
		},
	};
}

test("Benchmark Workload A: 294 small file transfers", async (t) => {
	const localFiles = {};
	for (let i = 0; i < 294; i++) {
		localFiles[`note-${i}.md`] = `Note content ${i} ` + "x".repeat(100);
	}
	const fixture = createBenchmarkFixture({ localFiles, delayMs: 1 });
	const outcome = await fixture.runSync();
	assert.equal(outcome.applied, 294);
	const m = fixture.metrics;
	t.diagnostic(
		`[Workload A - 294 Transfers] totalMs: ${m.totalMs.toFixed(1)}ms | firstTransferMs: ${m.firstCompletionMs.toFixed(1)}ms | peakWorkers: ${m.peakFileConcurrency} | writes: ${m.remoteWriteCalls} | sdkResets: ${m.remoteSdkResets} | progressUpdates: ${m.progressUpdates}`,
	);
});

test("Benchmark Workload B: first sync of 100 identical files", async (t) => {
	const files = {};
	const remoteFiles = {};
	for (let i = 0; i < 100; i++) {
		const content = `Shared identical content ${i}`;
		files[`shared-${i}.md`] = content;
		remoteFiles[`shared-${i}.md`] = {
			content,
			mtime: 1000,
			remoteHash: sha512Hex(bytes(content)),
		};
	}
	const fixture = createBenchmarkFixture({ localFiles: files, remoteFiles, delayMs: 1 });
	const outcome = await fixture.runSync();
	const m = fixture.metrics;
	t.diagnostic(
		`[Workload B - 100 Identical Files First Sync] totalMs: ${m.totalMs.toFixed(1)}ms | remoteDownloads: ${m.remoteReadCalls} | localReads: ${m.localReads}`,
	);
	// Before Step 3, remoteReadCalls is 100 (downloads each file to calculate hash)
	// In Step 3, remoteReadCalls must drop to 0!
	assert.equal(outcome.applied, 0);
});

test("Benchmark Workload C: automatic sync after 1 edit (no regression)", async (t) => {
	const files = {};
	const remoteFiles = {};
	for (let i = 0; i < 100; i++) {
		const content = `Content ${i}`;
		files[`note-${i}.md`] = content;
		remoteFiles[`note-${i}.md`] = { content, mtime: 1000 };
	}
	// Initial run to populate snapshot and baseline
	const fixture = createBenchmarkFixture({
		localFiles: files,
		remoteFiles,
		baseline: Object.keys(files),
		delayMs: 1,
	});
	// Initial sync (no-op) to prime caches
	await fixture.runSync();

	// Make 1 local modification
	fixture.local.get("note-0.md").content = bytes("Modified content 0");
	fixture.local.get("note-0.md").stat.mtime = 2000;

	// Run narrow sync with hint
	const editStart = performance.now();
	const outcome = await fixture.runSync({ scanHints: ["note-0.md"] });
	const autoSyncMs = performance.now() - editStart;
	assert.equal(outcome.applied, 1);
	t.diagnostic(`[Workload C - 1 Edit Auto-Sync] elapsedMs: ${autoSyncMs.toFixed(1)}ms`);
});

test("First sync content fingerprint: mismatch creates conflict and fallback downloads when hash invalid", async () => {
	// Case 1: Mismatched content with identical size and mtime detected without download during planning
	const local1 = { "same-stat.md": "Hello World 123" };
	const remote1 = {
		"same-stat.md": {
			content: "Diffs World 123", // same length (15 bytes)
			mtime: 1000,
			remoteHash: sha512Hex(bytes("Diffs World 123")),
		},
	};
	const fixture1 = createBenchmarkFixture({
		localFiles: local1,
		remoteFiles: remote1,
		delayMs: 0,
	});
	// Run with push direction: if identical, it would be noop (0 uploads). Since mismatched, it uploads (1 upload, 0 downloads).
	const outcome1 = await fixture1.engine.sync(
		undefined,
		undefined,
		undefined,
		"push",
		async () => true,
	);
	assert.equal(outcome1.applied, 1, "Applies upload because content was proven mismatched");
	assert.equal(
		fixture1.metrics.remoteReadCalls,
		0,
		"No remote read required to prove mismatch with valid SHA-512",
	);

	// Case 2: Invalid or absent remoteHash falls back to remote download
	const local2 = { "fallback.md": "Same content here" };
	const remote2 = {
		"fallback.md": {
			content: "Same content here",
			mtime: 1000,
			remoteHash: "invalid-short-hash", // not 128 chars
		},
	};
	const fixture2 = createBenchmarkFixture({
		localFiles: local2,
		remoteFiles: remote2,
		delayMs: 0,
	});
	const outcome2 = await fixture2.runSync();
	assert.equal(outcome2.applied, 0, "Recognizes identical content via download fallback");
	assert.equal(
		fixture2.metrics.remoteReadCalls,
		1,
		"Fell back to downloading remote file because hash was invalid",
	);
});
