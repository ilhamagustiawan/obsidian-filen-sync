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
		contents: `export * from './src/sync/merge.ts'; export * from './src/sync/diff.ts'; export * from './src/sync/conflict-store.ts'; export * from './src/sync/conflict-apply.ts'; export * from './src/sync/conflict-cleanup.ts'; export * from './src/ui/managed-conflict-review.ts'; export * from './src/sync/review-sections.ts'; export * from './src/sync/trash-scope.ts'; export * from './src/sync/settings-paths.ts'; export * from './src/sync/planner.ts'; export * from './src/sync/conflict-utils.ts'; export * from './src/sync/executor.ts'; export * from './src/file-version-modal.ts'; export * from './src/ui/conflict-resolver-modal.ts'; export * from './src/ui/sync-presentation.ts'; export * from 'obsidian';`,
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
	const conflicts = new Map(),
		remoteCopies = new Map();
	let writes = 0;
	const db = {
		getConflict: async (p) =>
			conflicts.has(p) ? structuredClone(conflicts.get(p)) : undefined,
		getConflicts: async () => new Map([...conflicts].map(([p, r]) => [p, structuredClone(r)])),
		setConflict: async (r) => conflicts.set(r.path, structuredClone(r)),
		deleteConflict: async (p) => conflicts.delete(p),
		targetKey: "verified-target",
		getFile: async () => record,
		deleteFile: async (p) => {
			if (p === path) record = undefined;
		},
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
			getFiles: () => [...files.values()],
			getAbstractFileByPath: (p) => files.get(p) ?? null,
			cachedRead: async (f) => text(f.content),
			readBinary: async (f) => f.content.slice().buffer,
			modifyBinary: async (f, b) => {
				f.content = new Uint8Array(b);
				f.stat.size = b.byteLength;
			},
			adapter: {
				stat: async (p) => (files.has(p) ? { type: "file", ...files.get(p).stat } : null),
				trashLocal: async (p) => files.delete(p),
				exists: async (p) => files.has(p) || storage.has(p),
				mkdir: async (p) => storage.set(p, null),
				readBinary: async (p) =>
					files.get(p)?.content.slice().buffer ?? storage.get(p).slice().buffer,
				writeBinary: async (p, b, stats) => {
					if (files.has(p)) {
						const f = files.get(p);
						f.content = new Uint8Array(b);
						f.stat = { ...f.stat, ...stats, size: b.byteLength };
					} else if (p.includes("/recovery/")) storage.set(p, new Uint8Array(b));
					else
						files.set(
							p,
							Object.assign(new m.TFile(), {
								path: p,
								name: p.split("/").pop(),
								content: new Uint8Array(b),
								stat: { ...stats, size: b.byteLength },
							}),
						);
				},
			},
		},
		fileManager: { trashFile: async (f) => files.delete(f.path) },
		workspace: { getLeaf: () => ({ openFile: async () => {} }) },
	};
	const fs = {
		readFile: async (p) => (p === path ? remote : remoteCopies.get(p)).content,
		stat: async (p) => (p === path ? remote : remoteCopies.get(p)) ?? null,
		walk: async () => [remote, ...remoteCopies.values()].filter(Boolean),
		rm: async (p) => {
			if (p === path) remote = undefined;
			else remoteCopies.delete(p);
		},
		writeFile: async (p, b, mtime, ctime, uuid, progress, expected) => {
			await expected?.beforeCommit?.();
			writes++;
			remote = {
				...remote,
				path: p,
				uuid: `remote-${writes}`,
				isDir: false,
				content: b.slice(),
				size: b.length,
				mtime,
				remoteHash: hash(b),
			};
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
		conflicts,
		remoteCopies,
		get writes() {
			return writes;
		},
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
test("text and JSON limits fail safely; competing settings need review", () => {
	assert.equal(m.decodeText(new Uint8Array([0xff])), undefined);
	assert.equal(m.mergeMarkdown("x", "x".repeat(m.TEXT_LIMIT + 1), "y"), undefined);
	assert.equal(m.mergeSettings("[]", "{}"), undefined);
	assert.equal(m.mergeSettings("oops", "{}"), undefined);
	assert.equal(
		m.mergeSettings('{"a":{"local":1},"list":[1]}', '{"a":{"remote":2},"list":[2],"b":3}'),
		undefined,
	);
	assert.deepEqual(
		JSON.parse(
			m.mergeSettings('{"a":{"x":2},"b":1}', '{"a":{"x":1},"b":2}', '{"a":{"x":1},"b":1}'),
		),
		{ a: { x: 2 }, b: 2 },
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
	const large = m.reviewSections("a\n".repeat(1100), [{ label: "A", text: "b\n".repeat(1100) }]);
	assert.equal(
		m.reconstructReview(
			"a\n".repeat(1100),
			large,
			large.map(() => 1),
		),
		"b\n".repeat(1100),
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
	assert.equal(f.recoveries.length, 4);
	assert.equal(f.baselines.length, 1);
	assert.equal(f.record.remoteMtime, f.remote.mtime);
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
	assert.equal(f.recoveries.length, 4);
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
		/File changed before conflict review/,
	);
	assert.equal(f.baselines.length, 0);
	assert.equal(f.recoveries.length, 0);
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
	assert.ok(
		m
			.computeDiff("a\n".repeat(1100), "b\n".repeat(1100))
			.some((line) => line.kind === "removed"),
	);
	assert.match(m.computeDiff("a".repeat(m.TEXT_LIMIT + 1), "b")[0].text, /limits/);
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

test("other files preserve both originals and require review", async () => {
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
	assert.equal(result.conflicts, 1);
	assert.equal(result.applied, 0);
	assert.equal(text(f.remote.content), "remote");
	assert.ok(f.conflicts.has(f.file.path));
});
test("selected settings merge nested independent changes and invalid JSON remains reviewable", async () => {
	const path = ".obsidian/app.json",
		f = fixture(
			'{"a":{"local":1,"remote":0}}',
			'{"a":{"local":0,"remote":2},"b":3}',
			'{"a":{"local":0,"remote":0}}',
			path,
		);
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
	assert.deepEqual(JSON.parse(text(f.file.content)), { a: { local: 1, remote: 2 }, b: 3 });
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
	assert.equal(unresolved.conflictCopy, undefined);
	assert.equal(unresolved.reviewPending, path);
	assert.equal(text(invalid.file.content), "[]");
	assert.equal(text(invalid.remote.content), "{}");
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

const contextFor = (f, selectedSettings) => ({
	app: f.app,
	db: f.db,
	remote: f.fs,
	pluginId: "filen-sync",
	selectedSettings,
});
const executorFor = (f, mode = "auto") =>
	new m.SyncExecutor({ ...contextFor(f), deviceId: "device", conflictResolution: mode });
const detect = (f, mode = "auto") =>
	executorFor(f, mode).execute({ path: f.file.path, operation: "conflict" }, f.local(), f.remote);
const approve = (f, content) => {
	const record = f.conflicts.get(f.file.path);
	return m.applyConflict(contextFor(f), {
		path: record.path,
		revision: record.revision,
		bytes: content === null ? null : bytes(content),
	});
};
for (const [name, base, local, remote, expected] of [
	[
		"independent words in one sentence",
		"The cat slept.",
		"The dog slept.",
		"The cat ran.",
		"The dog ran.",
	],
	["same word competing edits", "cat", "bat", "car", undefined],
	[
		"different insertions at one position",
		"first\nlast\n",
		"first\nlocal\nlast\n",
		"first\nremote\nlast\n",
		undefined,
	],
	["identical insertion", "a\nb", "a\nx\nb", "a\nx\nb", "a\nx\nb"],
	["delete versus edit", "one\ntwo\n", "two\n", "ONE\ntwo\n", undefined],
	["repeated sections", "a\nx\na\ny\n", "A\nx\na\ny\n", "a\nx\na\nY\n", "A\nx\na\nY\n"],
	["combining marks", "café dog", "café dog", "café cat", "café cat"],
	["BOM preservation", "\ufeffone\ntwo", "\ufeffONE\ntwo", "\ufeffone\nTWO", "\ufeffONE\nTWO"],
])
	test(`smart merge: ${name}`, () => {
		assert.equal(m.mergeMarkdown(base, local, remote), expected);
		assert.equal(
			m.mergeMarkdown(base, remote, local),
			expected,
			"side order cannot change the decision",
		);
	});

test("bounded diffs fail closed and round-trip line endings and Unicode", () => {
	assert.throws(() => m.textEdits("base", "new", Date.now() - 1), /time limit/);
	for (const [base, next] of [
		["😀\r\nx", "🐕\r\ny\n"],
		["", "\n"],
		["a\n", "a"],
		["a\nb", "b\na\n"],
	])
		assert.equal(m.reconstruct(base, m.textEdits(base, next)), next);
	assert.equal(m.decodeText(bytes("\ufeffnote")), "\ufeffnote");
});
for (const [name, base, local, remote, expected] of [
	["delete key and change another", { a: 1, b: 1 }, { b: 1 }, { a: 1, b: 2 }, { b: 2 }],
	["missing differs from null", { a: 1 }, {}, { a: null }, undefined],
	["array competition", { a: [1] }, { a: [1, 2] }, { a: [1, 3] }, undefined],
	["same nested addition", {}, { a: { b: 1 } }, { a: { b: 1 } }, { a: { b: 1 } }],
	["competing new nested objects", {}, { a: { b: 1 } }, { a: { c: 1 } }, undefined],
	[
		"key order equality",
		{ a: { b: 1, c: 2 } },
		{ a: { c: 2, b: 1 } },
		{ a: { b: 3, c: 2 } },
		{ a: { b: 3, c: 2 } },
	],
	[
		"safe prototype keys",
		{},
		JSON.parse('{"__proto__":{"x":1}}'),
		{ b: 2 },
		JSON.parse('{"__proto__":{"x":1},"b":2}'),
	],
])
	test(`settings merge: ${name}`, () => {
		const merged = m.mergeSettings(
			JSON.stringify(local),
			JSON.stringify(remote),
			JSON.stringify(base),
		);
		assert.deepEqual(merged === undefined ? undefined : JSON.parse(merged), expected);
	});

test("review analysis includes independent edits and leaves only competing sections undecided", () => {
	const a = m.analyzeMarkdown(
		"cat sleeps\none\ntwo",
		"dog sleeps\nONE\ntwo",
		"fox sleeps\none\nTWO",
	);
	assert.equal(a.sections.filter((s) => s.resolved === undefined).length, 1);
	assert.equal(
		m.reconstruct(
			a.base,
			a.sections.map((s) => ({ ...s, text: s.resolved ?? s.local })),
		),
		"dog sleeps\nONE\nTWO",
	);
});
test("pending conflicts preserve originals and baseline, deduplicate, and survive a new executor", async () => {
	const f = fixture("bat", "car", "cat");
	const initial = await detect(f);
	const count = f.recoveries.length,
		revision = f.conflicts.get("note.md").revision;
	assert.equal(initial.applied, 0);
	assert.equal(initial.reviewPending, "note.md");
	assert.equal(initial.newConflict, true);
	for (const operation of ["upload", "download", "delete-local", "delete-remote", "noop"]) {
		const result = await executorFor(f).execute(
			{ path: "note.md", operation },
			f.local(),
			f.remote,
		);
		assert.equal(result.reviewPending, "note.md");
		assert.equal(result.newConflict, false);
	}
	assert.equal(f.recoveries.length, count);
	assert.equal(f.conflicts.get("note.md").revision, revision);
	assert.equal(f.record.hash, hash(bytes("cat")));
	assert.equal(text(f.file.content), "bat");
	assert.equal(text(f.remote.content), "car");
	assert.equal(f.writes, 0);
});
test("copy mode requires approval for independent text edits", async () => {
	const f = fixture();
	const result = await detect(f, "copy");
	assert.equal(result.reviewPending, "note.md");
	assert.equal(f.writes, 0);
});
test("planner keeps pending files blocked in push, pull, and both", () => {
	for (const direction of ["push", "pull", "both"]) {
		const plan = m.planSync({
			localFiles: new Map(),
			remoteFiles: new Map(),
			prevRecords: new Map(),
			direction,
			pendingConflicts: new Set(["note.md"]),
		});
		assert.equal(plan.actions[0].operation, "conflict");
		assert.equal(plan.actions[0].reasonCode, "review_pending");
		assert.equal(plan.actions[0].isOverwrite, false);
		assert.equal(plan.actions[0].conflictWinner, undefined);
	}
});
test("approved result is written to both sides and clears persistent review", async () => {
	const f = fixture("bat", "car", "cat");
	await detect(f);
	await approve(f, "reviewed result");
	assert.equal(text(f.file.content), "reviewed result");
	assert.equal(text(f.remote.content), "reviewed result");
	assert.equal(f.conflicts.size, 0);
	assert.equal(f.record.hash, hash(bytes("reviewed result")));
});
test("stale reviews do not write and require a new revision", async () => {
	const f = fixture("bat", "car", "cat");
	await detect(f);
	const old = structuredClone(f.conflicts.get("note.md"));
	f.file.content = bytes("new");
	await assert.rejects(
		m.applyConflict(contextFor(f), {
			path: "note.md",
			revision: old.revision,
			bytes: bytes("chosen"),
		}),
		/Reviewed files changed/,
	);
	assert.notEqual(f.conflicts.get("note.md").revision, old.revision);
	assert.equal(f.writes, 0);
	assert.equal(text(f.file.content), "new");
	await assert.rejects(
		m.applyConflict(contextFor(f), {
			path: "note.md",
			revision: old.revision,
			bytes: bytes("chosen"),
		}),
		/Review changed/,
	);
});
test("remote same-UUID content replacement invalidates review even with unchanged size and time", async () => {
	const f = fixture("bat", "car", "cat");
	await detect(f);
	f.remote.content = bytes("dog");
	await assert.rejects(approve(f, "chosen"), /Reviewed files changed/);
	assert.equal(f.writes, 0);
	assert.equal(text(f.remote.content), "dog");
});
test("approved application resumes after disk failure without another upload", async () => {
	const f = fixture("bat", "car", "cat");
	await detect(f);
	const write = f.app.vault.adapter.writeBinary;
	f.app.vault.adapter.writeBinary = async (path, ...args) => {
		if (path === "note.md") throw Error("disk full");
		return write(path, ...args);
	};
	await assert.rejects(approve(f, "chosen"), /disk full/);
	assert.equal(f.conflicts.get("note.md").approval.remoteApplied, true);
	assert.equal(f.baselines.length, 0);
	assert.equal(f.writes, 1);
	f.app.vault.adapter.writeBinary = write;
	await executorFor(f).execute({ path: "note.md", operation: "conflict" }, f.local(), f.remote);
	assert.equal(text(f.file.content), "chosen");
	assert.equal(f.writes, 1);
	assert.equal(f.conflicts.size, 0);
});
test("offline application leaves originals and review intact", async () => {
	const f = fixture("bat", "car", "cat");
	await detect(f);
	f.fs.stat = async () => {
		throw Error("offline");
	};
	await assert.rejects(approve(f, "chosen"), /offline/);
	assert.equal(f.conflicts.size, 1);
	assert.equal(f.writes, 0);
	assert.equal(text(f.file.content), "bat");
});
test("an edit during upload preserves the edited local file and invalidates automatic retry", async () => {
	const f = fixture("bat", "car", "cat");
	await detect(f);
	const write = f.fs.writeFile;
	f.fs.writeFile = async (...args) => {
		const value = await write(...args);
		f.file.content = bytes("new");
		return value;
	};
	await assert.rejects(approve(f, "chosen"), /Local file changed/);
	assert.equal(text(f.file.content), "new");
	assert.equal(f.baselines.length, 0);
	const result = await executorFor(f).execute(
		{ path: "note.md", operation: "upload" },
		f.local(),
		f.remote,
	);
	assert.equal(result.reviewPending, "note.md");
	assert.equal(f.conflicts.get("note.md").approval, undefined);
	assert.equal(f.writes, 1);
});
for (const chooseDelete of [true, false])
	test(`delete versus edit: explicit ${chooseDelete ? "deletion" : "restoration"}`, async () => {
		const f = fixture("bat", "car", "cat");
		f.files.delete("note.md");
		await executorFor(f).execute(
			{ path: "note.md", operation: "conflict" },
			undefined,
			f.remote,
		);
		assert.equal(f.files.has("note.md"), false);
		await approve(f, chooseDelete ? null : "car");
		assert.equal(f.files.has("note.md"), !chooseDelete);
		assert.equal(f.remote !== undefined, !chooseDelete);
		assert.equal(f.conflicts.size, 0);
	});
function addCopies(f, count = 4) {
	for (let i = 0; i < count; i++) {
		const path = m.conflictCopyPath("note.md", "device", 123 + i, "remote");
		f.files.set(
			path,
			Object.assign(new m.TFile(), {
				path,
				name: path,
				content: bytes(`copy ${i}`),
				stat: { mtime: 1000, ctime: 1000, size: bytes(`copy ${i}`).length },
			}),
		);
		f.remoteCopies.set(path, {
			path,
			uuid: `copy-${i}`,
			mtime: 1000,
			size: bytes(`copy ${i}`).length,
			content: bytes(`copy ${i}`),
			isDir: false,
		});
	}
}
async function collect(f) {
	return m.collectConflictCopies(contextFor(f), f.conflicts.get("note.md"));
}
test("successful review removes every legacy copy from local and Filen", async () => {
	const f = fixture("bat", "car", "cat");
	addCopies(f);
	await detect(f);
	const record = await collect(f);
	assert.equal(record.copies.length, 4);
	await approve(f, "chosen");
	assert.deepEqual([...f.files.keys()], ["note.md"]);
	assert.equal(f.remoteCopies.size, 0);
	assert.equal(f.conflicts.size, 0);
	assert.equal(text(f.file.content), "chosen");
});
test("remote-only and local-only legacy copies are included in review and cleanup", async () => {
	const f = fixture("bat", "car", "cat");
	addCopies(f, 2);
	const [one, two] = [...f.remoteCopies.keys()];
	f.files.delete(one);
	f.remoteCopies.delete(two);
	await detect(f);
	await collect(f);
	assert.equal(f.conflicts.get("note.md").copies.length, 2);
	await approve(f, "chosen");
	assert.deepEqual([...f.files.keys()], ["note.md"]);
	assert.equal(f.remoteCopies.size, 0);
});
test("changed copies are never discarded by an old review", async () => {
	const f = fixture("bat", "car", "cat");
	addCopies(f, 1);
	await detect(f);
	await collect(f);
	const copy = [...f.files.values()].find((v) => v.path !== "note.md");
	copy.content = bytes("edited");
	copy.stat.size = copy.content.length;
	await assert.rejects(approve(f, "chosen"), /copy changed/);
	assert.equal(f.writes, 0);
	assert.equal(f.remoteCopies.size, 1);
	assert.equal(text(copy.content), "edited");
});
test("new copies arriving after review require refresh before any write", async () => {
	const f = fixture("bat", "car", "cat");
	await detect(f);
	await collect(f);
	addCopies(f, 1);
	await assert.rejects(approve(f, "chosen"), /New conflict copies/);
	assert.equal(f.writes, 0);
	assert.equal(f.files.size, 2);
});
test("partial cleanup resumes safely and leaves no orphaned copies", async () => {
	const f = fixture("bat", "car", "cat");
	addCopies(f, 3);
	await detect(f);
	await collect(f);
	const remove = f.fs.rm;
	let removals = 0;
	f.fs.rm = async (...args) => {
		if (++removals === 2) throw Error("network lost");
		return remove(...args);
	};
	await assert.rejects(approve(f, "chosen"), /network lost/);
	assert.equal(f.conflicts.size, 1);
	assert.equal(f.remoteCopies.size, 2);
	f.fs.rm = remove;
	await approve(f, "chosen");
	assert.deepEqual([...f.files.keys()], ["note.md"]);
	assert.equal(f.remoteCopies.size, 0);
	assert.equal(f.conflicts.size, 0);
	assert.equal(f.writes, 1);
});
test("conflict path matching does not touch similarly named folders or unrelated files", () => {
	assert.equal(
		m.conflictCopyPath("folder.with.dots/note", "device", 123, "remote"),
		"folder.with.dots/note.sync-conflict-remote-device-123",
	);
	assert.equal(m.isConflictFilePath("folder.sync-conflict-remote-device-123/note.md"), false);
	assert.equal(
		m.getOriginalPathFromConflictPath("folder.sync-conflict-remote-device-123/note.md"),
		"folder.sync-conflict-remote-device-123/note.md",
	);
	assert.equal(m.isConflictFilePath("note.sync-conflict-remote-placeholder.md"), false);
});

test("settings review requires competing choices and preserves independent keys", () => {
	const analysis = m.analyzeSettings(
		'{"shared":2,"local":true,"remote":false}',
		'{"shared":3,"local":false,"remote":true}',
		'{"shared":1,"local":false,"remote":false}',
	);
	assert.equal(analysis.sections.length, 1);
	assert.equal(analysis.sections[0].path, "/shared");
	assert.throws(() => analysis.result(new Map()), /Choose a value/);
	assert.deepEqual(JSON.parse(analysis.result(new Map([[0, analysis.sections[0].remote]]))), {
		shared: 3,
		local: true,
		remote: true,
	});
});

test("settings review distinguishes deleting a key from setting it to null", () => {
	const analysis = m.analyzeSettings("{}", '{"value":null}', '{"value":1}');
	assert.equal(analysis.sections.length, 1);
	assert.deepEqual(JSON.parse(analysis.result(new Map([[0, analysis.sections[0].local]]))), {});
	assert.deepEqual(JSON.parse(analysis.result(new Map([[0, analysis.sections[0].remote]]))), {
		value: null,
	});
});
