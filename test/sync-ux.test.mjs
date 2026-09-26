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
let TFolder;
before(async () => {
	await mkdir(resolve("tmp"), { recursive: true });
	scratch = await mkdtemp(resolve("tmp/sync-ux-"));
	const stub = join(scratch, "obsidian.mjs");
	await writeFile(
		stub,
		"export class TFile {} export class TFolder {} export const normalizePath=p=>p;",
	);
	const outfile = join(scratch, "engine.mjs");
	await build({
		stdin: {
			contents:
				'export {SyncEngine} from "./src/sync-engine.ts"; export {TFile, TFolder} from "obsidian";',
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
	({ SyncEngine, TFile, TFolder } = await import(pathToFileURL(outfile).href));
});
after(async () => {
	if (scratch) await rm(scratch, { recursive: true, force: true });
});
const bytes = (s) => new TextEncoder().encode(s);
const digest = (b) => createHash("sha256").update(b).digest("hex");
function fixture({
	local = {},
	remote = {},
	baseline = [],
	delay = 0,
	readDelay = 0,
	concurrency,
	failPath,
} = {}) {
	const files = new Map();
	const cloud = new Map();
	const records = new Map();
	let reads = 0;
	let fullVaultScans = 0;
	let readPaths = [];
	let mkdirCalls = [];
	let dbWrites = 0;
	let walks = 0;
	let active = 0;
	let peak = 0;
	for (const [path, text] of Object.entries(local)) {
		const file = new TFile();
		Object.assign(file, {
			path,
			stat: { mtime: 1000, ctime: 1000, size: bytes(text).length },
			content: bytes(text),
		});
		files.set(path, file);
	}
	for (const [path, text] of Object.entries(remote)) {
		cloud.set(path, {
			path,
			mtime: 1000,
			size: bytes(text).length,
			isDir: false,
			uuid: `id-${path}`,
			remoteHash: digest(bytes(text)),
			content: bytes(text),
		});
	}
	for (const path of baseline) {
		const file = files.get(path);
		const entry = cloud.get(path);
		if (file && entry)
			records.set(path, {
				path,
				mtime: 1000,
				ctime: 1000,
				size: file.stat.size,
				hash: digest(file.content),
				remoteUuid: entry.uuid,
				remoteHash: entry.remoteHash,
			});
	}
	const app = {
		vault: {
			configDir: ".obsidian",
			getAllLoadedFiles: () => {
				fullVaultScans++;
				return [...files.values()];
			},
			getAbstractFileByPath: (path) => files.get(path) ?? null,
			readBinary: async (file) => {
				reads++;
				readPaths.push(file.path);
				if (readDelay) await new Promise((r) => setTimeout(r, readDelay));
				return file.content.slice().buffer;
			},
			adapter: {
				writeBinary: async (path, content) => {
					const file = new TFile();
					Object.assign(file, {
						path,
						stat: { mtime: 1000, ctime: 1000, size: content.byteLength },
						content: new Uint8Array(content),
					});
					files.set(path, file);
				},
				exists: async () => true,
				mkdir: async () => {},
			},
			createFolder: async () => {},
		},
		fileManager: {
			trashFile: async (file) => {
				files.delete(file.path);
			},
		},
	};
	const db = {
		getAllFiles: async () => new Map(records),
		getFile: async (path) => records.get(path),
		setFile: async (path, record) => {
			dbWrites++;
			records.set(path, record);
		},
		deleteFile: async (path) => {
			records.delete(path);
		},
	};
	const fs = {
		mkdir: async (path) => {
			if (path.length > 0) mkdirCalls.push(path);
		},
		walk: async () => {
			walks++;
			return [...cloud.values()].map(({ content, ...entry }) => entry);
		},
		checkEvents: async (n) => ({ hasChanges: false, newWatermarkMs: n + 1000 }),
		readFile: async (path) => cloud.get(path)?.content ?? new Uint8Array(),
		stat: async (path) => cloud.get(path) ?? null,
		writeFile: async (path, content, mtime, ctime) => {
			active++;
			peak = Math.max(active, peak);
			if (delay) await new Promise((r) => setTimeout(r, delay));
			if (path === failPath) {
				active--;
				throw new Error("Simulated upload failure");
			}
			const entry = {
				path,
				mtime,
				size: content.length,
				isDir: false,
				uuid: `id-${path}`,
				remoteHash: digest(content),
				content: content.slice(),
			};
			cloud.set(path, entry);
			active--;
			return entry;
		},
		rm: async (path) => cloud.delete(path),
		close: () => {},
	};
	const engine = new SyncEngine({
		app,
		db,
		pluginId: "filen-sync",
		settings: {
			deviceId: "device",
			vaultName: "vault",
			ignorePatterns: [],
			fastRemotePolling: true,
			skipLargeFiles: false,
			skipSizeLargerThanMB: 50,
		},
		remote: fs,
		transferConcurrency: concurrency,
	});
	return {
		engine,
		files,
		cloud,
		records,
		get reads() {
			return reads;
		},
		get fullVaultScans() {
			return fullVaultScans;
		},
		get readPaths() {
			return [...readPaths];
		},
		get mkdirCalls() {
			return [...mkdirCalls];
		},
		resetTracking() {
			readPaths = [];
			mkdirCalls = [];
		},
		get dbWrites() {
			return dbWrites;
		},
		get walks() {
			return walks;
		},
		get peak() {
			return peak;
		},
		get active() {
			return active;
		},
		run: (options = {}, onProgress) =>
			engine.sync(
				onProgress,
				undefined,
				undefined,
				"both",
				async () => true,
				undefined,
				options,
			),
	};
}
test("progress counts only completed changed files, not unchanged notes", async () => {
	const s = fixture({
		local: { "old.md": "old", "new.md": "new" },
		remote: { "old.md": "old" },
		baseline: ["old.md"],
		delay: 5,
	});
	const p = [];
	await s.run({}, (e) => p.push({ ...e, finished: s.cloud.has("new.md") }));
	const transfers = p.filter((e) => e.phase === "transferring");
	assert.ok(p.some((e) => e.phase === "scanning-local"));
	assert.ok(p.some((e) => e.phase === "scanning-remote"));
	assert.ok(p.some((e) => e.phase === "planning"));
	assert.ok(p.some((e) => e.phase === "directories"));
	assert.ok(transfers.every((e) => e.total === 1 && e.current <= Number(e.finished)));
	assert.equal(transfers.at(-1).current, 1);
});
test("background repeat skips content reads; manual and initial sync verify same-stat edits", async () => {
	const s = fixture({
		local: { "note.md": "old" },
		remote: { "note.md": "old" },
		baseline: ["note.md"],
	});
	await s.run();
	const reads = s.reads;
	await s.run();
	assert.equal(s.reads, reads);
	s.files.get("note.md").content = bytes("new");
	await s.run({ isManual: true });
	assert.equal(new TextDecoder().decode(s.cloud.get("note.md").content), "new");
	s.files.get("note.md").content = bytes("one");
	await s.run({ initialSync: true });
	assert.equal(new TextDecoder().decode(s.cloud.get("note.md").content), "one");
	assert.ok(s.records.has("note.md"));
});
test("vault event invalidates cached hash, including same-stat content replacement", async () => {
	const s = fixture({
		local: { "note.md": "old" },
		remote: { "note.md": "old" },
		baseline: ["note.md"],
	});
	await s.run();
	s.files.get("note.md").content = bytes("new");
	s.engine.invalidateLocal("note.md");
	await s.run();
	assert.equal(new TextDecoder().decode(s.cloud.get("note.md").content), "new");
});
test("own upload invalidates remote tree despite silent events feed", async () => {
	const s = fixture({ local: { "note.md": "new" } });
	await s.run();
	assert.equal(s.walks, 1);
	await s.run();
	assert.equal(s.walks, 2);
	await s.run();
	assert.equal(s.walks, 2);
});
test("small independent uploads overlap at most two, with a serial override", async () => {
	const notes = { "a.md": "a", "b.md": "b", "c.md": "c", "d.md": "d" };
	const parallel = fixture({ local: notes, delay: 8 });
	await parallel.run();
	assert.equal(parallel.peak, 2);
	const serial = fixture({ local: notes, delay: 8, concurrency: 1 });
	await serial.run();
	assert.equal(serial.peak, 1);
});

test("synthetic benchmark records warm-scan and bounded-upload time", async (t) => {
	const notes = Object.fromEntries(
		Array.from({ length: 100 }, (_, i) => [`note-${i}.md`, "x".repeat(4096)]),
	);
	const s = fixture({ local: notes, remote: notes, baseline: Object.keys(notes), readDelay: 1 });
	let start = performance.now();
	await s.run();
	const cold = performance.now() - start;
	const coldReads = s.reads;
	start = performance.now();
	await s.run();
	const warm = performance.now() - start;
	assert.equal(s.reads, coldReads);
	t.diagnostic(
		`100 unchanged 4 KiB notes: cold ${cold.toFixed(1)}ms / ${coldReads} reads; warm ${warm.toFixed(1)}ms / 0 reads`,
	);
	const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`upload-${i}.md`, "x"]));
	const serial = fixture({ local: files, delay: 10, concurrency: 1 });
	start = performance.now();
	await serial.run();
	const serialMs = performance.now() - start;
	const parallel = fixture({ local: files, delay: 10 });
	start = performance.now();
	await parallel.run();
	const parallelMs = performance.now() - start;
	assert.equal(serial.peak, 1);
	assert.equal(parallel.peak, 2);
	t.diagnostic(
		`8 small uploads at synthetic 10ms latency: serial ${serialMs.toFixed(1)}ms; two workers ${parallelMs.toFixed(1)}ms`,
	);
});

test("unchanged notes do not rewrite existing sync history", async () => {
	const s = fixture({
		local: { "same.md": "same" },
		remote: { "same.md": "same" },
		baseline: ["same.md"],
	});
	await s.run();
	await s.run();
	assert.equal(s.dbWrites, 0);
	const first = fixture({ local: { "same.md": "same" }, remote: { "same.md": "same" } });
	await first.run();
	assert.equal(first.dbWrites, 1, "first equal-content sync establishes baseline once");
});

test("failed parallel transfer drains in-flight work; completed files retain baseline", async () => {
	const s = fixture({ local: { "a.md": "a", "b.md": "b" }, delay: 5, failPath: "b.md" });
	await assert.rejects(s.run(), /Simulated upload failure/);
	assert.equal(s.active, 0);
	assert.equal(s.peak, 2);
	assert.ok(s.records.has("a.md"));
	assert.equal(s.records.has("b.md"), false);
});
test("same-stat local edit cannot be deleted from a cached scan", async () => {
	const s = fixture({
		local: { "note.md": "old" },
		remote: { "note.md": "old" },
		baseline: ["note.md"],
	});
	await s.run();
	s.files.get("note.md").content = bytes("new");
	s.cloud.delete("note.md");
	s.engine.remoteTreeCache.fetchedAt = 0;
	await s.run();
	assert.equal(new TextDecoder().decode(s.files.get("note.md").content), "new");
	assert.equal(new TextDecoder().decode(s.cloud.get("note.md").content), "new");
});
test("same-stat local edit is copied before a remote replacement", async () => {
	const s = fixture({
		local: { "note.md": "old" },
		remote: { "note.md": "old" },
		baseline: ["note.md"],
	});
	await s.run();
	s.files.get("note.md").content = bytes("own");
	const remote = s.cloud.get("note.md");
	remote.content = bytes("new");
	remote.size = 3;
	remote.remoteHash = digest(remote.content);
	s.engine.remoteTreeCache.fetchedAt = 0;
	await s.run();
	const copies = [...s.files.entries()].filter(([path]) => path !== "note.md");
	assert.ok(copies.some(([, file]) => new TextDecoder().decode(file.content) === "own"));
	assert.equal(new TextDecoder().decode(s.files.get("note.md").content), "new");
});

test("initial sync bypasses a quiet remote-events cache", async () => {
	const s = fixture({
		local: { "note.md": "old" },
		remote: { "note.md": "old" },
		baseline: ["note.md"],
	});
	await s.run();
	const oldWalks = s.walks;
	const remote = s.cloud.get("note.md");
	remote.content = bytes("new");
	remote.remoteHash = digest(remote.content);
	await s.run({ initialSync: true });
	assert.equal(s.walks, oldWalks + 1);
	assert.equal(new TextDecoder().decode(s.files.get("note.md").content), "new");
});
test("background hash cache expires and discovers a missed same-stat edit", async (t) => {
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);
	const s = fixture({
		local: { "note.md": "old" },
		remote: { "note.md": "old" },
		baseline: ["note.md"],
	});
	await s.run();
	s.files.get("note.md").content = bytes("new");
	now += 5 * 60_000 + 1;
	await s.run();
	assert.equal(new TextDecoder().decode(s.cloud.get("note.md").content), "new");
});

test("eligible narrow pass processes local create/modify/delete/rename without reading unrelated unchanged files", async () => {
	const initialNotes = Object.fromEntries(
		Array.from({ length: 8 }, (_, i) => [`note-${i}.md`, `content-${i}`]),
	);
	const s = fixture({
		local: initialNotes,
		remote: initialNotes,
		baseline: Object.keys(initialNotes),
	});

	// Initial full sync establishes localScanSnapshot and remoteTreeCache
	await s.run();
	const initialReads = s.reads;
	const initialWalks = s.walks;

	// 1. Modify single note
	s.files.get("note-0.md").content = bytes("content-0-updated");
	s.files.get("note-0.md").stat.mtime = 2000;
	s.engine.invalidateLocal("note-0.md");
	const scansBefore1 = s.fullVaultScans;
	s.resetTracking();

	// Run narrow pass with scanHints
	const res1 = await s.run({ autoSync: true, scanHints: ["note-0.md"] });
	assert.equal(res1.applied, 1);
	assert.equal(s.fullVaultScans, scansBefore1, "no full vault scan was performed");
	assert.ok(
		s.readPaths.length > 0 && s.readPaths.every((p) => p === "note-0.md"),
		`only note-0.md was read, got reads: ${s.readPaths.join(", ")}`,
	);
	assert.equal(s.walks, initialWalks, "no remote walk was performed");
	assert.equal(new TextDecoder().decode(s.cloud.get("note-0.md").content), "content-0-updated");

	// 2. Create single note
	const newFile = new TFile();
	Object.assign(newFile, {
		path: "new-note.md",
		stat: { mtime: 3000, ctime: 3000, size: bytes("brand-new").length },
		content: bytes("brand-new"),
	});
	s.files.set("new-note.md", newFile);
	const scansBefore2 = s.fullVaultScans;
	s.resetTracking();

	const res2 = await s.run({ autoSync: true, scanHints: ["new-note.md"] });
	assert.equal(res2.applied, 1);
	assert.equal(s.fullVaultScans, scansBefore2);
	assert.ok(
		s.readPaths.length > 0 && s.readPaths.every((p) => p === "new-note.md"),
		"only candidate file was read",
	);
	assert.equal(s.walks, initialWalks);
	assert.equal(new TextDecoder().decode(s.cloud.get("new-note.md").content), "brand-new");

	// 3. Delete single note
	s.files.delete("note-7.md");
	const scansBefore3 = s.fullVaultScans;
	s.resetTracking();

	const res3 = await s.run({ autoSync: true, scanHints: ["note-7.md"] });
	assert.equal(res3.applied, 1);
	assert.equal(s.fullVaultScans, scansBefore3);
	assert.equal(s.readPaths.length, 0, "local delete does not read vault content");
	assert.equal(s.walks, initialWalks);
	assert.equal(s.cloud.has("note-7.md"), false, "deleted from cloud");

	// 4. Rename note: old path deleted, new path created
	const renamedFile = new TFile();
	Object.assign(renamedFile, {
		path: "note-6-renamed.md",
		stat: { mtime: 4000, ctime: 4000, size: bytes("content-6").length },
		content: bytes("content-6"),
	});
	s.files.delete("note-6.md");
	s.files.set("note-6-renamed.md", renamedFile);
	const scansBefore4 = s.fullVaultScans;
	s.resetTracking();

	const res4 = await s.run({ autoSync: true, scanHints: ["note-6.md", "note-6-renamed.md"] });
	assert.equal(res4.applied, 2);
	assert.equal(s.fullVaultScans, scansBefore4);
	assert.ok(
		s.readPaths.length > 0 && s.readPaths.every((p) => p === "note-6-renamed.md"),
		"only new path read, old path deleted",
	);
	assert.equal(s.walks, initialWalks);
	assert.equal(s.cloud.has("note-6.md"), false);
	assert.equal(s.cloud.has("note-6-renamed.md"), true);
});

test("narrow and full reconciliation outcomes agree on identical changes", async () => {
	const initial = { "a.md": "alpha", "b.md": "beta", "c.md": "gamma" };

	// Fixture 1: Full reconciliation pass
	const fFull = fixture({
		local: { ...initial },
		remote: { ...initial },
		baseline: Object.keys(initial),
	});
	await fFull.run();

	// Fixture 2: Narrow reconciliation pass
	const fNarrow = fixture({
		local: { ...initial },
		remote: { ...initial },
		baseline: Object.keys(initial),
	});
	await fNarrow.run();

	// Apply identical changes to both: modify a.md, create d.md, delete c.md
	for (const f of [fFull, fNarrow]) {
		f.files.get("a.md").content = bytes("alpha-v2");
		f.files.get("a.md").stat.mtime = 2000;
		f.engine.invalidateLocal("a.md");

		const dFile = new TFile();
		Object.assign(dFile, {
			path: "d.md",
			stat: { mtime: 2000, ctime: 2000, size: bytes("delta").length },
			content: bytes("delta"),
		});
		f.files.set("d.md", dFile);
		f.files.delete("c.md");
	}

	const fullResult = await fFull.run();
	const narrowResult = await fNarrow.run({ autoSync: true, scanHints: ["a.md", "d.md", "c.md"] });

	assert.equal(narrowResult.applied, fullResult.applied);
	assert.equal(narrowResult.conflicts, fullResult.conflicts);

	// Both clouds match
	assert.equal(fNarrow.cloud.size, fFull.cloud.size);
	for (const [path, entry] of fFull.cloud) {
		assert.ok(fNarrow.cloud.has(path));
		assert.equal(
			new TextDecoder().decode(fNarrow.cloud.get(path).content),
			new TextDecoder().decode(entry.content),
		);
	}

	// Both DB records match
	assert.equal(fNarrow.records.size, fFull.records.size);
	for (const [path, rec] of fFull.records) {
		assert.ok(fNarrow.records.has(path));
		assert.equal(fNarrow.records.get(path).hash, rec.hash);
		assert.equal(fNarrow.records.get(path).size, rec.size);
	}
});

test("narrow pass falls back to full scan when local scan snapshot is missing or stale (>5m)", async (t) => {
	let now = 2_000_000;
	t.mock.method(Date, "now", () => now);

	const initial = { "a.md": "a", "b.md": "b" };
	const s = fixture({ local: initial, remote: initial, baseline: Object.keys(initial) });
	await s.run();

	// Advance time past 5-minute integrity TTL
	now += 5 * 60 * 1000 + 1000;

	s.files.get("a.md").content = bytes("a-mod");
	s.files.get("a.md").stat.mtime = 3000;
	s.engine.invalidateLocal("a.md");

	const scansBefore = s.fullVaultScans;
	// Even though scanHints are provided, local snapshot is stale (>5m) -> falls back to full scan!
	await s.run({ autoSync: true, scanHints: ["a.md"] });
	assert.equal(s.fullVaultScans, scansBefore + 1, "stale local snapshot forced full vault scan");
	assert.equal(new TextDecoder().decode(s.cloud.get("a.md").content), "a-mod");
});

test("narrow pass falls back to full scan when remote tree cache is stale (>5m)", async (t) => {
	let now = 3_000_000;
	t.mock.method(Date, "now", () => now);

	const initial = { "a.md": "a", "b.md": "b" };
	const s = fixture({ local: initial, remote: initial, baseline: Object.keys(initial) });
	await s.run();
	const initialWalks = s.walks;

	// Advance time past 30-minute remote tree cache TTL
	now += 30 * 60 * 1000 + 1000;

	s.files.get("a.md").content = bytes("a-mod");
	s.engine.invalidateLocal("a.md");

	// Falls back to full remote scan
	await s.run({ autoSync: true, scanHints: ["a.md"] });
	assert.equal(s.walks, initialWalks + 1, "stale remote cache forced full remote walk");
	assert.equal(new TextDecoder().decode(s.cloud.get("a.md").content), "a-mod");
});

test("narrow pass falls back to full scan when remote change probe reports changes or probe fails", async () => {
	const initial = { "a.md": "a", "b.md": "b" };
	let probeHasChanges = false;
	let probeShouldFail = false;

	const s = fixture({ local: initial, remote: initial, baseline: Object.keys(initial) });
	// Custom checkEvents probe
	s.engine.config.remote.checkEvents = async (watermark) => {
		if (probeShouldFail) throw new Error("Probe network error");
		return { hasChanges: probeHasChanges, newWatermarkMs: watermark + 1000 };
	};

	await s.run();
	const walks1 = s.walks;

	// Probe reports remote changes
	probeHasChanges = true;
	s.files.get("a.md").content = bytes("a-new");
	s.engine.invalidateLocal("a.md");

	await s.run({ autoSync: true, scanHints: ["a.md"] });
	assert.equal(s.walks, walks1 + 1, "remote changes forced full remote walk");

	// Probe fails with error
	probeHasChanges = false;
	probeShouldFail = true;
	const walks2 = s.walks;
	s.files.get("a.md").content = bytes("a-new-2");
	s.engine.invalidateLocal("a.md");

	await s.run({ autoSync: true, scanHints: ["a.md"] });
	assert.equal(s.walks, walks2 + 1, "failed probe forced full remote walk");
});

test("narrow pass falls back to full scan when folders are involved", async () => {
	const initial = { "a.md": "a", "b.md": "b" };
	const s = fixture({ local: initial, remote: initial, baseline: Object.keys(initial) });
	await s.run();
	const scansBefore = s.fullVaultScans;

	// Add a folder to the vault
	const folder = new TFolder();
	folder.path = "new-folder";
	s.files.set("new-folder", folder);

	// scanHints includes the folder path -> should NOT do narrow pass!
	await s.run({ autoSync: true, scanHints: ["new-folder"] });
	assert.equal(s.fullVaultScans, scansBefore + 1, "folder hint forced full vault scan");
	assert.ok(s.mkdirCalls.includes("new-folder"), "folder reconciliation created folder remotely");
});

test("forced full scan options bypass narrow pass even with valid hints", async () => {
	const initial = { "a.md": "a", "b.md": "b" };
	const s = fixture({ local: initial, remote: initial, baseline: Object.keys(initial) });
	await s.run();
	const initialWalks = s.walks;

	s.files.get("a.md").content = bytes("a-manual");
	s.engine.invalidateLocal("a.md");

	// Manual sync always scans in full
	await s.run({ isManual: true, scanHints: ["a.md"] });
	assert.equal(s.walks, initialWalks + 1, "manual sync forced full scan");

	// Initial sync always scans in full
	s.files.get("a.md").content = bytes("a-initial");
	s.engine.invalidateLocal("a.md");
	await s.run({ initialSync: true, scanHints: ["a.md"] });
	assert.equal(s.walks, initialWalks + 2, "initial sync forced full scan");

	// explicit fullScan flag always scans in full
	s.files.get("a.md").content = bytes("a-full");
	s.engine.invalidateLocal("a.md");
	await s.run({ fullScan: true, scanHints: ["a.md"] });
	assert.equal(s.walks, initialWalks + 3, "fullScan option forced full scan");
});
