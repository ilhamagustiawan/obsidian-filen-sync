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
let ByteBoundedWorkPool;

before(async () => {
	await mkdir(resolve("tmp"), { recursive: true });
	scratch = await mkdtemp(resolve("tmp/scan-policy-"));
	const stub = join(scratch, "obsidian.mjs");
	await writeFile(
		stub,
		"export class TFile {} export class TFolder {} export const normalizePath=p=>p;",
	);
	const outfile = join(scratch, "engine.mjs");
	await build({
		stdin: {
			contents: `export {SyncEngine} from "./src/sync-engine.ts"; export {TFile, TFolder} from "obsidian"; export {ByteBoundedWorkPool} from "./src/sync/byte-bounded-pool.ts";`,
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
	({ SyncEngine, TFile, TFolder, ByteBoundedWorkPool } = await import(
		pathToFileURL(outfile).href
	));
});
after(async () => {
	if (scratch) await rm(scratch, { recursive: true, force: true });
});
const bytes = (s) => new TextEncoder().encode(s);
const digest = (b) => createHash("sha256").update(b).digest("hex");
const sha512Hex = (b) => createHash("sha512").update(b).digest("hex");

function fixture({ local = {}, remote = {}, baseline = [], hashingPool } = {}) {
	const files = new Map();
	const cloud = new Map();
	const records = new Map();
	let reads = 0;
	let walks = 0;
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
		const raw = typeof text === "string" ? bytes(text) : text;
		cloud.set(path, {
			path,
			mtime: 1000,
			size: raw.length,
			isDir: false,
			uuid: `id-${path}`,
			remoteHash: sha512Hex(raw),
			content: raw,
		});
	}
	for (const path of baseline) {
		const file = files.get(path);
		if (!file) continue;
		const entry = cloud.get(path);
		if (entry)
			records.set(path, {
				path,
				mtime: 1000,
				ctime: 1000,
				size: file.stat.size,
				hash: digest(file.content),
				remoteUuid: entry.uuid,
				remoteHash: entry.remoteHash,
			});
		else
			records.set(path, {
				path,
				mtime: 1000,
				ctime: 1000,
				size: file.stat.size,
				hash: digest(file.content),
			});
	}
	const app = {
		vault: {
			configDir: ".obsidian",
			getAllLoadedFiles: () => [...files.values()],
			getAbstractFileByPath: (path) => files.get(path) ?? null,
			readBinary: async (file) => {
				reads++;
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
			records.set(path, record);
		},
		deleteFile: async (path) => {
			records.delete(path);
		},
	};
	const fs = {
		mkdir: async () => {},
		walk: async () => {
			walks++;
			return [...cloud.values()].map(({ content, ...entry }) => entry);
		},
		checkEvents: async (n) => ({ hasChanges: false, newWatermarkMs: n + 1000 }),
		readFile: async (path) => cloud.get(path)?.content ?? new Uint8Array(),
		stat: async (path) => cloud.get(path) ?? null,
		writeFile: async (path, content, mtime) => {
			const entry = {
				path,
				mtime,
				size: content.length,
				isDir: false,
				uuid: `id-${path}`,
				remoteHash: sha512Hex(content),
				content: content.slice(),
			};
			cloud.set(path, entry);
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
		hashingPool,
	});
	return {
		engine,
		files,
		cloud,
		records,
		get reads() {
			return reads;
		},
		get walks() {
			return walks;
		},
		run: (options = {}, confirmBulk, confirmDeletes) =>
			engine.sync(
				undefined,
				confirmDeletes ?? (async () => true),
				undefined,
				"both",
				confirmBulk ?? (async () => true),
				undefined,
				options,
			),
	};
}

test("byte-bounded pool respects worker count and in-flight byte budget", async () => {
	const pool = new ByteBoundedWorkPool({
		maxWorkers: 2,
		maxInFlightBytes: 12 * 1024 * 1024,
		largeJobThresholdBytes: 8 * 1024 * 1024,
		accountFactor: 2,
	});
	let active = 0;
	let peak = 0;
	let peakBytes = 0;
	const items = Array.from({ length: 20 }, (_, i) => ({ size: 3 * 1024 * 1024, i }));
	const tracked = new Set();
	const started = [];
	// accountFactor 2 -> each job is 6 MiB accounted; budget 12 MiB allows 2 in flight.
	await pool.run(
		items,
		(item) => item.size,
		async (item) => {
			active++;
			peak = Math.max(peak, active);
			started.push(item.i);
			await new Promise((r) => setTimeout(r, 3));
			active--;
		},
	);
	assert.ok(peak <= 2, `pool workers peaked at ${peak}`);
	assert.equal(started.length, 20, "every item ran");
	assert.ok(pool.stats.peakInFlightBytes <= 12 * 1024 * 1024, "byte budget respected");
});

test("byte-bounded pool runs an oversized small job only in isolation", async () => {
	const pool = new ByteBoundedWorkPool({
		maxWorkers: 4,
		maxInFlightBytes: 6 * 1024 * 1024,
		largeJobThresholdBytes: 8 * 1024 * 1024,
		accountFactor: 2,
	});
	// 10 MiB file -> 20 MiB accounted, larger than the budget: runs alone.
	const items = [
		{ size: 10 * 1024 * 1024, name: "big" },
		{ size: 1024, name: "a" },
		{ size: 1024, name: "b" },
	];
	let active = 0;
	let bigSawConcurrent = false;
	await pool.run(
		items,
		(item) => item.size,
		async (item) => {
			active++;
			if (item.name === "big" && active > 1) bigSawConcurrent = true;
			await new Promise((r) => setTimeout(r, 2));
			active--;
		},
	);
	assert.equal(bigSawConcurrent, false, "oversized job ran in isolation");
});

test("byte-bounded pool keeps large jobs serial", async () => {
	const pool = new ByteBoundedWorkPool({
		maxWorkers: 4,
		maxInFlightBytes: 256 * 1024 * 1024,
		largeJobThresholdBytes: 8 * 1024 * 1024,
	});
	let active = 0;
	let peak = 0;
	const items = Array.from({ length: 5 }, () => ({ size: 64 * 1024 * 1024 }));
	await pool.run(
		items,
		(item) => item.size,
		async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 2));
			active--;
		},
	);
	assert.equal(peak, 1, "large jobs never overlap");
});

test("byte-bounded pool stops new work on failure and drains in-flight operations", async () => {
	const pool = new ByteBoundedWorkPool({
		maxWorkers: 2,
		maxInFlightBytes: 1024 * 1024,
		largeJobThresholdBytes: 8 * 1024 * 1024,
	});
	let started = 0;
	let finished = 0;
	const items = Array.from({ length: 10 }, (_, i) => ({ i }));
	await assert.rejects(
		pool.run(
			items,
			() => 10,
			async (item) => {
				started++;
				if (item.i === 1) throw new Error("hash worker failed");
				await new Promise((r) => setTimeout(r, 5));
				finished++;
			},
		),
		/hash worker failed/u,
	);
	assert.ok(started < 10, `no new work after failure (started ${started})`);
	assert.equal(finished, started - 1, "in-flight work drained before rejection");
});

test("unchanged routine reconcile performs zero content reads with valid hashes", async () => {
	const s = fixture({
		local: { "a.md": "a", "b.md": "b", "c.md": "c" },
		remote: { "a.md": "a", "b.md": "b", "c.md": "c" },
		baseline: ["a.md", "b.md", "c.md"],
	});
	const cold = await s.run();
	// First run: cold session caches everything once per file.
	assert.ok(cold.scanDiagnostics.mode === "reconcile", "first run is a reconcile");
	const coldReads = cold.scanDiagnostics?.localReads ?? 0;

	const warm = await s.run();
	assert.equal(warm.applied, 0);
	assert.equal(warm.provenance, "reconcile");
	assert.equal(warm.scanDiagnostics?.mode, "reconcile");
	assert.equal(warm.scanDiagnostics?.fallbackReason, "missing-hints");
	assert.equal(warm.scanDiagnostics?.hashMisses, 0, "no misses with valid hashes");
	assert.equal(warm.scanDiagnostics?.localReads, 0, "zero content reads on an unchanged run");
	assert.ok(
		(coldReads ?? 0) > 0,
		"cold run read content at least once",
	);
});

test("routine reconcile discovers additions, deletions, renames, and folders with empty hints", async () => {
	const initial = { "a.md": "alpha", "b.md": "beta", "c.md": "gamma" };
	const s = fixture({
		local: { ...initial },
		remote: { ...initial },
		baseline: Object.keys(initial),
	});
	await s.run();

	// Delete a.md locally, create d.md, rename b.md -> folder/x.md, add a folder.
	s.files.delete("a.md");
	const dFile = new TFile();
	Object.assign(dFile, {
		path: "d.md",
		stat: { mtime: 2000, ctime: 2000, size: bytes("delta").length },
		content: bytes("delta"),
	});
	s.files.set("d.md", dFile);
	const renamed = new TFile();
	Object.assign(renamed, {
		path: "folder/x.md",
		stat: { mtime: 2000, ctime: 2000, size: bytes("beta").length },
		content: bytes("beta"),
	});
	s.files.set("folder/x.md", renamed);
	s.files.delete("b.md");
	const folder = new TFolder();
	folder.path = "folder";
	s.files.set("folder", folder);

	// No hints at all - a pure periodic reconcile.
	const result = await s.run();
	assert.equal(result.applied, 5, "2 deletes + 2 uploads + 1 folder creation");
	assert.equal(s.cloud.has("a.md"), false, "local deletion propagated");
	assert.equal(s.cloud.has("b.md"), false, "rename old path removed");
	assert.equal(new TextDecoder().decode(s.cloud.get("folder/x.md").content), "beta");
	assert.equal(new TextDecoder().decode(s.cloud.get("d.md").content), "delta");
});

test("reconcile and full fresh scans agree on identical waves of changes", async () => {
	const initial = { "a.md": "aa", "b.md": "bb", "c.md": "cc" };
	const wave = (s) => {
		s.files.delete("c.md");
		const dFile = new TFile();
		Object.assign(dFile, {
			path: "d.md",
			stat: { mtime: 2000, ctime: 2000, size: 2 },
			content: bytes("dd"),
		});
		s.files.set("d.md", dFile);
	};
	const reconcile = fixture({ local: initial, remote: initial, baseline: Object.keys(initial) });
	const full = fixture({ local: initial, remote: initial, baseline: Object.keys(initial) });
	await reconcile.run();
	await full.run();
	wave(reconcile);
	wave(full);

	const reconcileOutcome = await reconcile.run();
	const fullOutcome = await full.run();
	assert.equal(reconcileOutcome.applied, fullOutcome.applied);
	assert.equal(reconcileOutcome.conflicts, fullOutcome.conflicts);
	assert.equal(
		[...reconcile.cloud.entries()].sort().map(([, e]) => e.path).join(","),
		[...full.cloud.entries()].sort().map(([, e]) => e.path).join(","),
	);
});

test("typecheck: manual and initial runs force full verification with accurate provenance", async () => {
	const s = fixture({
		local: { "note.md": "old" },
		remote: { "note.md": "old" },
		baseline: ["note.md"],
	});
	await s.run();
	s.files.get("note.md").content = bytes("new");
	const manual = await s.run({ isManual: true });
	assert.equal(manual.provenance, "full");
	assert.equal(manual.scanDiagnostics?.fallbackReason, "manual-sync");
	s.files.get("note.md").content = bytes("one");
	const initial = await s.run({ initialSync: true });
	assert.equal(initial.provenance, "full");
	assert.equal(initial.scanDiagnostics?.fallbackReason, "initial-sync");
	assert.equal(new TextDecoder().decode(s.cloud.get("note.md").content), "one");
});

test("narrow provenance is reported only when the engine actually selected narrow", async () => {
	const initial = { "a.md": "a", "b.md": "b" };
	const s = fixture({ local: initial, remote: initial, baseline: Object.keys(initial) });
	await s.run();
	s.files.get("a.md").content = bytes("a-mod");
	s.files.get("a.md").stat.mtime = 2000;
	s.engine.invalidateLocal("a.md");
	const narrow = await s.run({ autoSync: true, scanHints: ["a.md"] });
	assert.equal(narrow.provenance, "narrow");
	assert.equal(narrow.scanDiagnostics?.mode, "narrow");
	assert.ok((narrow.scanDiagnostics?.localReads ?? 0) <= 1, "narrow read only the hinted file");

	// Supplied folder hints must not report narrow provenance.
	const folder = new TFolder();
	folder.path = "new-folder";
	s.files.set("new-folder", folder);
	const folderRun = await s.run({ autoSync: true, scanHints: ["new-folder"] });
	assert.equal(folderRun.provenance, "reconcile");
	assert.equal(folderRun.scanDiagnostics?.fallbackReason, "folder-hints");
});

test("repeated inventory refreshes never extend the content verification deadline", async (t) => {
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);
	const s = fixture({
		local: { "a.md": "a", "b.md": "b", "c.md": "c" },
		remote: { "a.md": "a", "b.md": "b", "c.md": "c" },
		baseline: ["a.md", "b.md", "c.md"],
	});
	await s.run();
	assert.equal((await s.run()).scanDiagnostics?.localReads, 0);

	// Advance 2 minutes: unchanged reconcile still zero reads and must not extend the deadline.
	now += 2 * 60_000;
	assert.equal((await s.run()).scanDiagnostics?.localReads, 0);

	// Total elapsed crosses the 5-minute verification deadline: the hashes are stale.
	now += 3 * 60_000 + 1;
	const overdue = await s.run();
	assert.equal(overdue.scanDiagnostics?.hashMisses, 3, "expired hashes were re-read");
	assert.equal(overdue.scanDiagnostics?.localReads, 3, "expired hashes cost one read each");
});

test("missed same-stat edits surface on the next content verification run", async (t) => {
	let now = 2_000_000;
	t.mock.method(Date, "now", () => now);
	const s = fixture({
		local: { "note.md": "old" },
		remote: { "note.md": "old" },
		baseline: ["note.md"],
	});
	await s.run();
	// Same-stat content replacement with NO vault event invalidation.
	s.files.get("note.md").content = bytes("new");
	assert.equal((await s.run()).applied, 0, "within TTL, cached hash hides the change");

	now += 5 * 60_000 + 1;
	const result = await s.run();
	assert.equal(result.applied, 1, "after the TTL, the missed edit is discovered and applied");
	assert.equal(new TextDecoder().decode(s.cloud.get("note.md").content), "new");
});

test("edit arriving during scanning discards evidence and replans conservatively", async () => {
	const s = fixture({
		local: { "a.md": "a", "b.md": "b" },
		remote: { "a.md": "a", "b.md": "b" },
		baseline: ["a.md", "b.md"],
	});
	await s.run();
	s.files.get("a.md").content = bytes("a-edited");
	s.files.get("a.md").stat.mtime = 2000;
	s.engine.invalidateLocal("a.md");
	// Invalidate a path again during the remote scan (between local hashing and
	// snapshot publication) so the first pass must discard its evidence.
	const originalWalk = s.engine.config.remote.walk;
	let bumped = false;
	s.engine.config.remote.walk = async (o) => {
		const entries = await originalWalk(o);
		if (!bumped) {
			bumped = true;
			s.engine.invalidateLocal("b.md");
		}
		return entries;
	};
	// The first scan notices the invalidation, replans once, and succeeds on the retry.
	const outcome = await s.run();
	assert.equal(outcome.applied, 1);
	assert.equal(outcome.provenance, "reconcile");
	assert.equal(new TextDecoder().decode(s.cloud.get("a.md").content), "a-edited");
	assert.ok(s.engine.localScanSnapshot !== null, "snapshot published after successful scan");
});

test("failed hashing never publishes a partial snapshot or deletes evidence", async () => {
	const s = fixture({
		local: { "a.md": "a", "b.md": "b" },
		remote: { "a.md": "a", "b.md": "b" },
		baseline: ["a.md", "b.md"],
	});
	await s.run();
	// Force b.md's hash to be re-read so the injected failure actually occurs.
	s.engine.invalidateLocal("b.md");
	const originalRead = s.engine.config.app.vault.readBinary;
	let shouldFail = false;
	s.engine.config.app.vault.readBinary = async (file) => {
		if (shouldFail && file.path === "b.md") throw new Error("hash read failed");
		return originalRead(file);
	};
	shouldFail = true;
	await assert.rejects(s.run(), /hash read failed/u);
	shouldFail = false;
	assert.equal(s.engine.localScanSnapshot, null, "failed scan published no snapshot");
	s.files.get("a.md").content = bytes("new-a");
	await s.run();
	assert.equal(new TextDecoder().decode(s.cloud.get("a.md").content), "new-a", "recovery still works");
});

test("first sync equality derives both fingerprints from one read per file", async () => {
	const files = {};
	const remoteFiles = {};
	for (let i = 0; i < 20; i++) {
		const content = `identical-${i}`;
		files[`n-${i}.md`] = content;
		remoteFiles[`n-${i}.md`] = content;
	}
	const s = fixture({ local: files, remote: remoteFiles });
	const outcome = await s.run();
	assert.equal(outcome.applied, 0, "identical first sync applies nothing");
	assert.equal(outcome.scanDiagnostics?.equalityComparisons, 20);
	assert.equal(outcome.scanDiagnostics?.equalityDownloads, 0, "no remote downloads");
	assert.equal(outcome.scanDiagnostics?.localReads, 20, "one local planning read per file");
});

test("invalid remote hashes retain the equality fallback without falsely declaring identity", async () => {
	const s = fixture({
		local: { "same.md": "same content" },
		remote: { "same.md": "same content" },
	});
	// Invalid remoteHash: same-size/mtime file falls back to a download.
	s.cloud.get("same.md").remoteHash = "not-a-valid-sha512";
	const outcome = await s.run();
	assert.equal(outcome.applied, 0, "identical content recognized via download fallback");
	assert.equal(outcome.scanDiagnostics?.equalityDownloads, 1);

	const s2 = fixture({
		local: { "diff.md": "content-one" },
		remote: { "diff.md": "content-two" },
	});
	s2.cloud.get("diff.md").remoteHash = "invalid-hash";
	const mismatch = await s2.run();
	assert.equal(mismatch.applied, 1, "mismatched fallback content does not declare identity");
	assert.equal(mismatch.scanDiagnostics?.equalityDownloads, 1);
});

test("hash pool keeps one-file auto-sync reads bounded and concurrently hashes small files", async () => {
	const notes = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`n${i}.md`, `c${i}`]));
	const s = fixture({
		local: notes,
		remote: notes,
		baseline: Object.keys(notes),
		hashingPool: new ByteBoundedWorkPool({
			maxWorkers: 2,
			maxInFlightBytes: 8 * 1024 * 1024,
			largeJobThresholdBytes: 8 * 1024 * 1024,
		}),
	});
	// Cold run hashes 30 small files through the pool: still exactly one read each.
	const cold = await s.run();
	assert.equal(cold.scanDiagnostics?.localReads, 30);
	assert.equal(cold.applied, 0);
	// Warm run reuses valid hashes.
	const warm = await s.run();
	assert.equal(warm.scanDiagnostics?.localReads, 0);
});
test("bulk guard and local-delete confirmation still gate reconcile-mode runs", async () => {
	// Empty remote after a populated baseline: mass deletions need confirmation.
	const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`n${i}.md`, `c${i}`]));
	const bulk = fixture({ local: many, remote: {}, baseline: Object.keys(many) });
	const cancelled = await bulk.run({}, async (report) => {
		assert.equal(report.blocked, true);
		return false;
	});
	assert.equal(cancelled.cancelled, true, "bulk guard blocks an empty-side deletion wave");

	// A single local delete still requires the local-delete confirmation pass.
	const s = fixture({
		local: { "a.md": "a", "b.md": "b" },
		remote: { "b.md": "b" },
		baseline: ["a.md", "b.md"],
	});
	const refused = await s.run({}, undefined, async () => false);
	assert.equal(refused.cancelled, true, "reconcile-mode local delete still asks for confirmation");
	assert.match(refused.cancelReason ?? "", /deletes cancelled/);
});

test("failed remote listings never become a clean empty inventory", async () => {
	const s = fixture({
		local: { "a.md": "a", "b.md": "b" },
		remote: { "a.md": "a", "b.md": "b" },
		baseline: ["a.md", "b.md"],
	});
	await s.run();
	const originalWalk = s.engine.config.remote.walk;
	s.engine.config.remote.walk = async () => {
		throw new Error("remote listing failed");
	};
	await assert.rejects(s.run({ refreshRemote: true }), /remote listing failed/u);
	assert.equal(s.engine.localScanSnapshot, null, "failed listing publishes no local snapshot");
	assert.equal(s.engine.remoteTreeCache, null, "failed listing publishes no remote tree");
	// A later healthy run still reconciles normally.
	s.engine.config.remote.walk = originalWalk;
	const recovered = await s.run();
	assert.equal(recovered.provenance, "reconcile");
	assert.equal(recovered.applied, 0);
});

test("preview stays fully read-only under the new scan policy", async () => {
	const s = fixture({
		local: { "old.md": "old", "new.md": "new" },
		remote: { "old.md": "old" },
		baseline: ["old.md"],
	});
	const cloudBefore = s.cloud.size;
	const filesBefore = s.files.size;
	const recordsBefore = s.records.size;
	const target = { userId: 1, rootUuid: "root", remoteRoot: "/", vaultId: "vault" };
	const preview = await s.engine.previewPlan("both", target);
	assert.ok(preview.counts.totalProposed >= 1, "preview plans the new file");
	assert.equal(s.cloud.size, cloudBefore, "preview never touches remote");
	assert.equal(s.files.size, filesBefore, "preview never writes local vault");
	assert.equal(s.records.size, recordsBefore, "preview never writes baseline");
	assert.equal(preview.provenance, "full", "preview verifies fresh state");
});

test("diagnostic records carry scan mode and stage timing and older records stay readable", async (t) => {
	const dir = await mkdtemp(resolve("tmp/scan-export-test-"));
	try {
		const outfile = join(dir, "diagnostic-export.mjs");
		await build({
			entryPoints: ["src/sync/diagnostic-export.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
		});
		const { buildRedactedDiagnosticExport } = await import(pathToFileURL(outfile).href);
		const modern = {
			id: "x1",
			kind: "sync",
			timestamp: 1_700_000_000_000,
			direction: "both",
			trigger: "auto",
			target: { userId: 1, rootUuid: "r", remoteRoot: "/", vaultId: "v" },
			provenance: "reconcile",
			scan: {
				mode: "reconcile",
				fallbackReason: "missing-hints",
				localReads: 3,
				localReadBytes: 4096,
				hashHits: 2,
				hashMisses: 1,
				equalityComparisons: 0,
				equalityDownloads: 0,
				remoteProbes: 1,
				remoteRefreshes: 0,
				remoteReuses: 1,
				inventoryFiles: 3,
				inventoryDirs: 1,
			},
			timing: {
				totalMs: 500,
				eventProbeMs: 2,
				localScanMs: 40,
				baselineMs: 1,
				remoteScanMs: 20,
				equalityMs: 0,
				planMs: 5,
				executeMs: 300,
			},
			counts: { upload: 0, download: 0, deleteLocal: 0, deleteRemote: 0, conflict: 0, noop: 3, totalProposed: 0 },
			destructiveStats: { localDeletes: 0, remoteDeletes: 0, localOverwrites: 0, remoteOverwrites: 0, totalDestructiveLocal: 0, totalDestructiveRemote: 0 },
			safetyReport: { blocked: false, stats: { localDeletes: 0, remoteDeletes: 0, localOverwrites: 0, remoteOverwrites: 0, totalDestructiveLocal: 0, totalDestructiveRemote: 0 } },
			outcome: "success",
			actions: [],
			totalActionsCount: 0,
			actionsTruncated: false,
		};
		const legacy = {
			id: "x0",
			kind: "sync",
			timestamp: 1_600_000_000_000,
			direction: "both",
			trigger: "manual",
			target: { userId: 1, rootUuid: "r", remoteRoot: "/", vaultId: "v" },
			provenance: "full",
			timing: { totalMs: 100 },
			counts: { upload: 1, download: 0, deleteLocal: 0, deleteRemote: 0, conflict: 0, noop: 0, totalProposed: 1 },
			destructiveStats: { localDeletes: 0, remoteDeletes: 0, localOverwrites: 0, remoteOverwrites: 0, totalDestructiveLocal: 0, totalDestructiveRemote: 0 },
			safetyReport: { blocked: false, stats: { localDeletes: 0, remoteDeletes: 0, localOverwrites: 0, remoteOverwrites: 0, totalDestructiveLocal: 0, totalDestructiveRemote: 0 } },
			outcome: "success",
			actions: [],
			totalActionsCount: 0,
			actionsTruncated: false,
		};
		const exported = buildRedactedDiagnosticExport([modern, legacy]);
		assert.equal(exported.records.length, 2);
		const modernOut = exported.records.find((r) => r.id === "x1");
		assert.equal(modernOut.scan?.mode, "reconcile");
		assert.equal(modernOut.scan?.fallbackReason, "missing-hints");
		assert.equal(modernOut.timing.eventProbeMs, 2);
		const legacyOut = exported.records.find((r) => r.id === "x0");
		assert.equal(legacyOut.scan, undefined, "older records export without scan fields");
		// No contents, credentials, or raw provider payloads leak into the export.
		assert.equal(JSON.stringify(exported).includes("user@example.com"), false);
		assert.equal(JSON.stringify(exported).includes("masterKeys"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
