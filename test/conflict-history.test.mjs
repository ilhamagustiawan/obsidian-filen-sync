import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
const dir = await mkdtemp(join(tmpdir(), "filen-conflict-history-"));
const outfile = join(dir, "features.mjs");
await build({
	stdin: {
		contents: `export * from './src/sync/merge.ts'; export * from './src/sync/review-sections.ts'; export * from './src/sync/trash-scope.ts'; export * from './src/sync/settings-paths.ts'; export * from './src/sync/planner.ts'; export * from './src/sync/conflict-utils.ts'; export * from './src/sync/executor.ts'; export * from './src/file-version-modal.ts'; export * from './src/ui/conflict-resolver-modal.ts'; export * from './src/ui/sync-presentation.ts'; export * from 'obsidian';`,
		resolveDir: process.cwd(),
	},
	outfile,
	bundle: true,
	format: "esm",
	platform: "node",
	plugins: [
		{
			name: "obsidian",
			setup(b) {
				b.onResolve({ filter: /^obsidian$/ }, () => ({
					path: resolve("test/helpers/obsidian-ui.mjs"),
				}));
			},
		},
	],
});
const m = await import(pathToFileURL(outfile).href);
test.after(() => rm(dir, { recursive: true, force: true }));
const bytes = (t) => new TextEncoder().encode(t);
const text = (b) => new TextDecoder().decode(b);
const hash = (b) => createHash("sha256").update(b).digest("hex");
function fixture(
	localText = "ONE\ntwo\n",
	remoteText = "one\nTWO\n",
	base = "one\ntwo\n",
	path = "note.md",
) {
	const files = new Map(),
		storage = new Map(),
		recoveries = [],
		baselines = [];
	const file = Object.assign(new m.TFile(), {
		path,
		name: path.split("/").pop(),
		stat: { mtime: 2000, ctime: 1000, size: bytes(localText).length },
		content: bytes(localText),
	});
	files.set(file.path, file);
	let remote = {
		path: file.path,
		uuid: "remote",
		mtime: 3000,
		size: bytes(remoteText).length,
		isDir: false,
		remoteHash: "remote-hash",
		content: bytes(remoteText),
	};
	let record = {
		path: file.path,
		mtime: 1000,
		ctime: 1000,
		size: bytes(base).length,
		hash: hash(bytes(base)),
		remoteMtime: 1000,
	};
	const db = {
		targetKey: "verified-target",
		getFile: async () => record,
		getMergeBaseline: async () => ({ text: base, hash: hash(bytes(base)), savedAt: 1 }),
		setFile: async (p, r) => {
			record = r;
			baselines.push(r);
		},
		setMergeBaseline: async () => {},
		addRecovery: async (r) => recoveries.push(r),
	};
	const app = {
		vault: {
			configDir: ".obsidian",
			getAbstractFileByPath: (p) => files.get(p) ?? null,
			cachedRead: async (f) => text(f.content),
			readBinary: async (f) => f.content.slice().buffer,
			modifyBinary: async (f, b) => {
				f.content = new Uint8Array(b);
				f.stat.size = b.byteLength;
			},
			adapter: {
				stat: async (p) => (files.has(p) ? { type: "file", ...files.get(p).stat } : null),
				exists: async (p) => files.has(p) || storage.has(p),
				mkdir: async (p) => storage.set(p, null),
				readBinary: async (p) =>
					files.get(p)?.content.slice().buffer ?? storage.get(p).slice().buffer,
				writeBinary: async (p, b, stats) => {
					if (files.has(p)) {
						const f = files.get(p);
						f.content = new Uint8Array(b);
						f.stat = { ...f.stat, ...stats, size: b.byteLength };
					} else storage.set(p, new Uint8Array(b));
				},
			},
		},
		fileManager: { trashFile: async (f) => files.delete(f.path) },
		workspace: { getLeaf: () => ({ openFile: async () => {} }) },
	};
	const fs = {
		readFile: async () => remote.content,
		stat: async () => remote,
		writeFile: async (p, b, mtime) => {
			remote = { ...remote, content: b.slice(), size: b.length, mtime, remoteHash: hash(b) };
			return remote;
		},
	};
	return {
		app,
		db,
		fs,
		file,
		files,
		storage,
		recoveries,
		baselines,
		get remote() {
			return remote;
		},
		get record() {
			return record;
		},
		local: () => ({ path: file.path, ...file.stat, file, hash: hash(file.content) }),
	};
}
for (const [name, base, l, r, result] of [
	["independent edits", "one\ntwo\n", "ONE\ntwo\n", "one\nTWO\n", "ONE\nTWO\n"],
	["identical changes", "one", "two", "two", "two"],
	["overlapping edits", "one", "two", "three", undefined],
	["missing baseline", undefined, "one", "two", undefined],
	["Unicode and CRLF", "猫\r\n犬\r\n", "猫咪\r\n犬\r\n", "猫\r\n犬🐕\r\n", "猫咪\r\n犬🐕\r\n"],
	["preserve missing final newline", "a\nb", "A\nb", "a\nB", "A\nB"],
])
	test(`Markdown merge: ${name}`, () => assert.equal(m.mergeMarkdown(base, l, r), result));
test("text and JSON limits fail safely; local keys replace nested values and arrays", () => {
	assert.equal(m.decodeText(new Uint8Array([0xff])), undefined);
	assert.equal(m.mergeMarkdown("x", "x".repeat(m.TEXT_LIMIT + 1), "y"), undefined);
	assert.equal(m.mergeSettings("[]", "{}"), undefined);
	assert.equal(m.mergeSettings("oops", "{}"), undefined);
	assert.deepEqual(
		JSON.parse(
			m.mergeSettings('{"a":{"local":1},"list":[1]}', '{"a":{"remote":2},"list":[2],"b":3}'),
		),
		{ a: { local: 1 }, list: [1], b: 3 },
	);
});
test("review sections reconstruct untouched bytes and require each explicit choice", () => {
	const original = "intro\r\none\r\ntwo\r\nend";
	const sections = m.reviewSections(original, [
		{ label: "A", text: "intro\r\nONE\r\ntwo\r\nend" },
		{ label: "B", text: "intro\r\nONE\r\ntwo\r\nend" },
	]);
	assert.equal(sections.length, 1);
	assert.equal(sections[0].alternatives.length, 2);
	assert.throws(() => m.reconstructReview(original, sections, []), /Choose/);
	assert.equal(m.reconstructReview(original, sections, [1]), "intro\r\nONE\r\ntwo\r\nend");
	assert.equal(
		m.reviewSections("a\n".repeat(1100), [{ label: "A", text: "b\n".repeat(1100) }]),
		undefined,
	);
});
test("verified identical hashes suppress timestamp conflicts and independent timestamps remain unchanged", () => {
	const local = { path: "n.md", mtime: 1, ctime: 1, size: 1, hash: "same" },
		remote = { path: "n.md", mtime: 2, size: 1, hash: "same", uuid: "r", isDir: false };
	const actions = m.planSync({
		localFiles: new Map([[local.path, local]]),
		remoteFiles: new Map([[remote.path, remote]]),
		prevRecords: new Map(),
	}).actions;
	assert.equal(actions[0].operation, "noop");
	const prev = { ...local, remoteMtime: 2, remoteUuid: "r" };
	delete remote.hash;
	assert.equal(
		m.planSync({
			localFiles: new Map([[local.path, local]]),
			remoteFiles: new Map([[remote.path, remote]]),
			prevRecords: new Map([[local.path, prev]]),
		}).actions[0].operation,
		"noop",
	);
});
test("automatic merging preserves originals before both writes and publishes a successful baseline", async () => {
	const f = fixture();
	const executor = new m.SyncExecutor({
		app: f.app,
		db: f.db,
		remote: f.fs,
		deviceId: "device",
		pluginId: "filen-sync",
		conflictResolution: "auto",
	});
	const result = await executor.execute(
		{ path: "note.md", operation: "conflict" },
		f.local(),
		f.remote,
	);
	assert.equal(result.conflicts, 0);
	assert.equal(result.conflictCopy, undefined);
	assert.equal(text(f.file.content), "ONE\nTWO\n");
	assert.equal(text(f.remote.content), "ONE\nTWO\n");
	assert.equal(f.recoveries.length, 2);
	assert.equal(f.baselines.length, 1);
	assert.equal(f.record.remoteMtime, 3000);
	for (const r of f.recoveries) assert.equal(hash(f.storage.get(r.storagePath)), r.hash);
});
test("an interrupted automatic resolution retains recovery data and the old baseline", async () => {
	const f = fixture();
	const write = f.app.vault.adapter.writeBinary;
	f.app.vault.adapter.writeBinary = async (p, ...args) => {
		if (p === "note.md") throw Error("disk full");
		return write(p, ...args);
	};
	const executor = new m.SyncExecutor({
		app: f.app,
		db: f.db,
		remote: f.fs,
		deviceId: "device",
		pluginId: "filen-sync",
		conflictResolution: "auto",
	});
	await assert.rejects(
		executor.execute({ path: "note.md", operation: "conflict" }, f.local(), f.remote),
		/disk full/,
	);
	assert.equal(f.recoveries.length, 2);
	assert.equal(f.baselines.length, 0);
	assert.equal(text(f.file.content), "ONE\ntwo\n");
});
test("remote revalidation rejects a stale automatic merge before writing", async () => {
	const f = fixture();
	const expected = { ...f.remote };
	f.fs.stat = async () => ({ ...f.remote, uuid: "replacement" });
	const executor = new m.SyncExecutor({
		app: f.app,
		db: f.db,
		remote: f.fs,
		deviceId: "device",
		pluginId: "filen-sync",
		conflictResolution: "auto",
	});
	await assert.rejects(
		executor.execute({ path: "note.md", operation: "conflict" }, f.local(), expected),
		/Remote file changed/,
	);
	assert.equal(f.baselines.length, 0);
	assert.equal(f.recoveries.length, 2);
	assert.equal(text(f.remote.content), "one\nTWO\n");
});
test("settings selections exclude workspace files, executables, traversal, and this plugin", () => {
	assert.deepEqual(
		m.selectedSettingsPaths(".obsidian", "filen-sync", true, [
			"app.json",
			"plugins/tasks/data.json",
			"workspace.json",
			"plugins/filen-sync/data.json",
			"plugins/tasks/main.js",
			"../app.json",
		]),
		[".obsidian/app.json", ".obsidian/plugins/tasks/data.json"],
	);
	assert.deepEqual(m.selectedSettingsPaths(".obsidian", "filen-sync", false, ["app.json"]), []);
});
test("trash filtering follows verified ancestry, isolates historical mappings, and rejects cycles", async () => {
	const nodes = [
		{ uuid: "owned", parent: "folder", name: "note.md", isDir: false, size: 1, deletedAt: 1 },
		{
			uuid: "other",
			parent: "other-root",
			name: "other.md",
			isDir: false,
			size: 1,
			deletedAt: 1,
		},
		{ uuid: "cycle", parent: "cycle", name: "cycle.md", isDir: false, size: 1, deletedAt: 1 },
		{ uuid: "mapped", parent: "gone", name: "old.md", isDir: false, size: 1, deletedAt: 1 },
	];
	const scoped = await m.scopeTrash(
		"root",
		nodes,
		[{ uuid: "mapped", path: "old.md" }],
		async (uuid) =>
			uuid === "folder" ? { parent: "root", name: "notes", trash: false } : undefined,
	);
	assert.deepEqual(
		scoped.map((s) => s.path),
		["notes/note.md", "old.md"],
	);
	assert.equal(scoped[1].parentMissing, true);
	assert.equal((await m.scopeTrash("another-root", nodes, [], async () => undefined)).length, 0);
});
test("shared icon precedence never claims completion for pending, paused, offline, or conflicts", () => {
	const done = { kind: "success", syncCompleted: true };
	assert.equal(m.syncIconPresentation(done).state, "synced");
	for (const [options, state] of [
		[{ pending: 1 }, "pending"],
		[{ paused: true }, "paused"],
		[{ offline: true }, "disconnected"],
		[{ conflicts: 2 }, "conflict"],
	])
		assert.equal(m.syncIconPresentation(done, options).state, state);
	assert.equal(m.syncIconPresentation({ kind: "idle", syncCompleted: true }).state, "pending");
	assert.equal(m.syncIconPresentation({ kind: "syncing" }, { paused: true }).state, "syncing");
});
test("history ignores stale selections, renders Markdown tables, and unloads render resources", async () => {
	const f = fixture();
	let resolveFirst;
	globalThis.__renderLoads = 0;
	globalThis.__renderUnloads = 0;
	const rendered = [];
	globalThis.__markdown = (t) => rendered.push(t);
	const versions = [
		{ uuid: "one", version: 1, timestamp: 1 },
		{ uuid: "two", version: 2, timestamp: 2 },
	];
	const remote = {
		getFileVersions: async () => [],
		readFileVersion: async (v) =>
			v.uuid === "one"
				? await new Promise((r) => (resolveFirst = r))
				: bytes("| a | b |\n|---|---|\n| 1 | 2 |"),
	};
	const modal = new m.FileVersionModal({
		app: f.app,
		remote,
		filePath: "note.md",
		fileName: "note.md",
		onRestored: () => {},
	});
	await modal.onOpen();
	const first = modal.selectVersion(versions[0]);
	await modal.selectVersion(versions[1]);
	resolveFirst(bytes("stale"));
	await first;
	assert.match(modal.state.preview.text, /\| a \| b \|/);
	assert.ok(rendered.some((t) => t.includes("|---|---|")));
	assert.ok(!rendered.includes("stale"));
	modal.onClose();
	assert.equal(globalThis.__renderLoads, globalThis.__renderUnloads);
	assert.match(m.computeDiff("a\n".repeat(1100), "b\n".repeat(1100))[0].text, /limits/);
	delete globalThis.__markdown;
});
test("resolver preview equals saved content; stale reviews and closing do not mutate files", async () => {
	const f = fixture("one\r\ntwo\r\n", "unused");
	const copy = Object.assign(new m.TFile(), {
		path: "note.sync-conflict-remote-device-123.md",
		name: "copy.md",
		stat: { mtime: 1, ctime: 1, size: 10 },
		content: bytes("ONE\r\ntwo\r\n"),
	});
	f.files.set(copy.path, copy);
	let queued = 0;
	globalThis.__autoConfirm = true;
	globalThis.__notices = [];
	const modal = new m.ConflictResolverModal({
		app: f.app,
		db: f.db,
		pluginId: "filen-sync",
		files: () => [copy],
		onResolved: () => queued++,
		onClosed: () => {},
	});
	modal.onOpen();
	await modal.select("note.md");
	const review = modal.reviews.get("note.md");
	review.choices = [1];
	const expected = modal.result(review);
	await modal.apply(review);
	assert.deepEqual(f.file.content, expected);
	assert.equal(queued, 1);
	assert.equal(f.recoveries.length, 1);
	assert.ok(!f.files.has(copy.path));
	const second = new m.ConflictResolverModal({
		app: f.app,
		db: f.db,
		pluginId: "filen-sync",
		files: () => [],
		onResolved: () => queued++,
		onClosed: () => {},
	});
	second.onOpen();
	await second.select("note.md");
	const stale = second.reviews.get("note.md");
	f.file.content = bytes("new edits");
	await second.apply(stale);
	assert.equal(text(f.file.content), "new edits");
	assert.equal(queued, 1);
	second.onClose();
	assert.equal(text(f.file.content), "new edits");
	delete globalThis.__autoConfirm;
	delete globalThis.__notices;
});

test("other files use latest timestamps and local wins ties", async () => {
	const f = fixture("local", "remote", "base", "drawing.canvas");
	f.remote.mtime = f.file.stat.mtime;
	const executor = new m.SyncExecutor({
		app: f.app,
		db: f.db,
		remote: f.fs,
		deviceId: "device",
		pluginId: "filen-sync",
		conflictResolution: "auto",
	});
	const result = await executor.execute(
		{ path: f.file.path, operation: "conflict" },
		f.local(),
		f.remote,
	);
	assert.equal(result.conflicts, 0);
	assert.equal(text(f.remote.content), "local");
	assert.equal(f.recoveries.length, 2);
});
test("selected settings merge whole nested values and invalid JSON remains reviewable", async () => {
	const path = ".obsidian/app.json",
		f = fixture('{"a":{"local":1}}', '{"a":{"remote":2},"b":3}', "{}", path);
	const executor = new m.SyncExecutor({
		app: f.app,
		db: f.db,
		remote: f.fs,
		deviceId: "device",
		pluginId: "filen-sync",
		conflictResolution: "auto",
		selectedSettings: [path],
	});
	const local = { ...f.local(), adapterOnly: true };
	const result = await executor.execute({ path, operation: "conflict" }, local, f.remote);
	assert.equal(result.conflicts, 0);
	assert.deepEqual(JSON.parse(text(f.file.content)), { a: { local: 1 }, b: 3 });
	const invalid = fixture("[]", "{}", "{}", path);
	const other = new m.SyncExecutor({
		app: invalid.app,
		db: invalid.db,
		remote: invalid.fs,
		deviceId: "device",
		pluginId: "filen-sync",
		conflictResolution: "auto",
		selectedSettings: [path],
	});
	const unresolved = await other.execute(
		{ path, operation: "conflict", conflictWinner: "local" },
		{ ...invalid.local(), adapterOnly: true },
		invalid.remote,
	);
	assert.equal(unresolved.conflicts, 1);
	assert.ok(unresolved.conflictCopy.copyPath.startsWith("Filen Sync conflicts/settings-"));
	assert.equal(m.getOriginalPathFromConflictPath(unresolved.conflictCopy.copyPath), path);
});
test("recovery failure prevents any automatic mutation", async () => {
	const f = fixture();
	f.db.addRecovery = async () => {
		throw Error("recovery unavailable");
	};
	const executor = new m.SyncExecutor({
		app: f.app,
		db: f.db,
		remote: f.fs,
		deviceId: "device",
		pluginId: "filen-sync",
		conflictResolution: "auto",
	});
	await assert.rejects(
		executor.execute({ path: f.file.path, operation: "conflict" }, f.local(), f.remote),
		/recovery unavailable/,
	);
	assert.equal(text(f.file.content), "ONE\ntwo\n");
	assert.equal(text(f.remote.content), "one\nTWO\n");
	assert.equal(f.baselines.length, 0);
});
