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
let planDirectories;
let nextDirectoryBaseline;
before(async () => {
	await mkdir(resolve("tmp"), { recursive: true });
	scratch = await mkdtemp(resolve("tmp/folder-sync-"));
	const stub = join(scratch, "obsidian.mjs");
	await writeFile(
		stub,
		"export class TFile {} export class TFolder {} export const normalizePath=p=>p;",
	);
	const outfile = join(scratch, "engine.mjs");
	await build({
		stdin: {
			contents: [
				'export {SyncEngine} from "./src/sync-engine.ts";',
				'export {planDirectories, nextDirectoryBaseline} from "./src/sync/dir-planner.ts";',
				'export {TFile, TFolder} from "obsidian";',
			].join("\n"),
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
	({ SyncEngine, TFile, TFolder, planDirectories, nextDirectoryBaseline } = await import(
		pathToFileURL(outfile).href
	));
});
after(async () => {
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

const bytes = (s) => new TextEncoder().encode(s);
const digest = (b) => createHash("sha256").update(b).digest("hex");
const parents = (path) => {
	const parts = path.split("/");
	return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
};
const isChild = (parent, path) =>
	path.startsWith(`${parent}/`) && !path.slice(parent.length + 1).includes("/");

/** In-memory vault and Filen tree that both track folders. */
function fixture({ localDirs = [], remoteDirs = [], localFiles = {}, folderApi = true } = {}) {
	const vault = new Map();
	const hiddenLocal = new Map();
	const cloudDirs = new Set(remoteDirs);
	const cloudFiles = new Map();
	const records = new Map();
	let storedDirs = null;
	const calls = { mkdir: [], rmdir: [], trashed: [], localMkdir: [], setDirs: 0, confirms: [] };
	let probeHasChanges = false;
	let statDirOverride = null;

	const addFolder = (path) => {
		const folder = new TFolder();
		folder.path = path;
		vault.set(path, folder);
	};
	const addFile = (path, text) => {
		const file = new TFile();
		Object.assign(file, {
			path,
			stat: { mtime: 1000, ctime: 1000, size: bytes(text).length },
			content: bytes(text),
		});
		vault.set(path, file);
	};
	for (const path of localDirs) addFolder(path);
	for (const [path, text] of Object.entries(localFiles)) addFile(path, text);

	const app = {
		vault: {
			configDir: ".obsidian",
			getAllLoadedFiles: () => [...vault.values()],
			getAbstractFileByPath: (path) => vault.get(path) ?? null,
			readBinary: async (file) => file.content.slice().buffer,
			adapter: {
				exists: async (path) => vault.has(path),
				mkdir: async (path) => {
					calls.localMkdir.push(path);
					addFolder(path);
				},
				list: async (path) => {
					const children = [...vault.keys()].filter((p) => isChild(path, p));
					return {
						files: [
							...children.filter((p) => vault.get(p) instanceof TFile),
							...(hiddenLocal.get(path) ?? []),
						],
						folders: children.filter((p) => vault.get(p) instanceof TFolder),
					};
				},
				writeBinary: async (path, content) => {
					const file = new TFile();
					Object.assign(file, {
						path,
						stat: { mtime: 1000, ctime: 1000, size: content.byteLength },
						content: new Uint8Array(content),
					});
					vault.set(path, file);
				},
			},
		},
		fileManager: {
			trashFile: async (file) => {
				if (file instanceof TFolder) calls.trashed.push(file.path);
				vault.delete(file.path);
			},
		},
	};
	const db = {
		getAllFiles: async () => new Map(records),
		getFile: async (path) => records.get(path),
		setFile: async (path, record) => records.set(path, record),
		deleteFile: async (path) => records.delete(path),
		getSyncedDirs: async () => (storedDirs === null ? null : new Set(storedDirs)),
		setSyncedDirs: async (dirs) => {
			calls.setDirs++;
			storedDirs = new Set(dirs);
		},
	};
	const remote = {
		mkdir: async (path) => {
			if (path.length === 0) return;
			calls.mkdir.push(path);
			cloudDirs.add(path);
		},
		walk: async () => [
			...[...cloudDirs].map((path) => ({ path, mtime: 0, size: 0, isDir: true })),
			...[...cloudFiles.values()].map(({ content, ...entry }) => entry),
		],
		checkEvents: async (n) => ({ hasChanges: probeHasChanges, newWatermarkMs: n + 1000 }),
		readFile: async (path) => cloudFiles.get(path)?.content ?? new Uint8Array(),
		stat: async (path) => cloudFiles.get(path) ?? null,
		writeFile: async (path, content, mtime) => {
			for (const dir of parents(path)) cloudDirs.add(dir);
			const entry = {
				path,
				mtime,
				size: content.length,
				isDir: false,
				uuid: `id-${path}`,
				remoteHash: digest(content),
				content: content.slice(),
			};
			cloudFiles.set(path, entry);
			return entry;
		},
		rm: async (path) => cloudFiles.delete(path),
		close: () => {},
	};
	if (folderApi) {
		remote.statDir = async (path) => {
			if (statDirOverride) return statDirOverride(path);
			return cloudDirs.has(path) ? { uuid: `dir-${path}` } : null;
		};
		remote.rmdir = async (path) => {
			if (!cloudDirs.has(path)) return "absent";
			const occupied = [...cloudDirs, ...cloudFiles.keys()].some((p) =>
				p.startsWith(`${path}/`),
			);
			if (occupied) return "not-empty";
			calls.rmdir.push(path);
			cloudDirs.delete(path);
			return "deleted";
		};
	}
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
		remote,
	});
	let confirmAnswer = true;
	return {
		engine,
		vault,
		cloudDirs,
		cloudFiles,
		calls,
		hiddenLocal,
		addFolder,
		addFile,
		get storedDirs() {
			return storedDirs === null ? null : [...storedDirs].sort();
		},
		set storedDirs(dirs) {
			storedDirs = dirs === null ? null : new Set(dirs);
		},
		set probeHasChanges(value) {
			probeHasChanges = value;
		},
		set statDirOverride(fn) {
			statDirOverride = fn;
		},
		set confirmAnswer(value) {
			confirmAnswer = value;
		},
		resetCalls() {
			for (const key of ["mkdir", "rmdir", "trashed", "localMkdir", "confirms"])
				calls[key] = [];
			calls.setDirs = 0;
		},
		run: (options = { isManual: true }, direction = "both") =>
			engine.sync(
				undefined,
				async (paths) => {
					calls.confirms.push(paths);
					return confirmAnswer;
				},
				undefined,
				direction,
				async () => true,
				undefined,
				options,
			),
	};
}

/** Fixture whose folders are already synced on both sides with a recorded baseline. */
async function synced(dirs, options = {}) {
	const s = fixture({ localDirs: dirs, remoteDirs: dirs, ...options });
	await s.run();
	assert.deepEqual(s.storedDirs, [...dirs].sort());
	s.resetCalls();
	return s;
}

// --- Pure planner ---------------------------------------------------------

const plan = (local, remote, baseline, direction = "both", remoteFromCache = false) =>
	planDirectories({
		local: new Set(local),
		remote: new Set(remote),
		baseline: baseline === null ? null : new Set(baseline),
		direction,
		remoteFromCache,
	}).map((a) => `${a.operation}:${a.path}`);

test("folder planner mirrors file rules for every direction", () => {
	// [local, remote, baseline] → expected per direction
	const cases = [
		{
			name: "new local",
			args: [["A"], [], []],
			both: ["upload:A"],
			push: ["upload:A"],
			pull: [],
		},
		{
			name: "deleted remotely",
			args: [["A"], [], ["A"]],
			both: ["delete-local:A"],
			push: ["upload:A"],
			pull: ["delete-local:A"],
		},
		{
			name: "new remote",
			args: [[], ["A"], []],
			both: ["download:A"],
			push: [],
			pull: ["download:A"],
		},
		{
			name: "deleted locally",
			args: [[], ["A"], ["A"]],
			both: ["delete-remote:A"],
			push: ["delete-remote:A"],
			pull: ["download:A"],
		},
		{ name: "both sides", args: [["A"], ["A"], ["A"]], both: [], push: [], pull: [] },
		{ name: "neither side", args: [[], [], ["A"]], both: [], push: [], pull: [] },
	];
	for (const c of cases)
		for (const direction of ["both", "push", "pull"])
			assert.deepEqual(plan(...c.args, direction), c[direction], `${c.name} (${direction})`);
	// A null baseline treats every one-sided folder as new.
	assert.deepEqual(plan(["A"], ["B"], null), ["upload:A", "download:B"]);
	assert.deepEqual(plan(["A"], ["B"], []), ["upload:A", "download:B"]);
});

test("folder planner orders creates parents first and deletes children first", () => {
	assert.deepEqual(plan(["A/B", "A"], [], []), ["upload:A", "upload:A/B"]);
	assert.deepEqual(plan([], ["A", "A/B"], ["A", "A/B"]), [
		"delete-remote:A/B",
		"delete-remote:A",
	]);
});

test("cached remote leaves local folders untouched but still plans remote changes", () => {
	assert.deepEqual(plan(["A"], [], ["A"], "both", true), []);
	assert.deepEqual(plan([], ["A"], [], "both", true), []);
	assert.deepEqual(plan([], ["A"], ["A"], "both", true), ["delete-remote:A"]);
	assert.deepEqual(plan(["A"], [], [], "both", true), ["upload:A"]);
});

test("folder baseline retains unfinished deletions and drops finished ones", () => {
	const actions = planDirectories({
		local: new Set(["kept", "both"]),
		remote: new Set(["gone", "promoted", "both"]),
		baseline: new Set(["kept", "gone", "promoted", "both", "vanished"]),
		direction: "both",
		remoteFromCache: false,
	});
	const outcomes = new Map([
		["gone", "applied"],
		["promoted", "both-present"],
	]);
	const next = nextDirectoryBaseline(
		new Set(["kept", "gone", "promoted", "both", "vanished"]),
		new Set(["kept", "both"]),
		new Set(["gone", "promoted", "both"]),
		actions,
		outcomes,
	);
	assert.deepEqual([...next].sort(), ["both", "kept", "promoted"]);
});

// --- Engine ---------------------------------------------------------------

test("deleting an empty local folder deletes it in Filen instead of restoring it", async () => {
	const s = await synced(["A"]);
	s.vault.delete("A");
	await s.run();
	assert.deepEqual(s.calls.rmdir, ["A"]);
	assert.equal(s.vault.has("A"), false, "local folder not recreated");
	assert.deepEqual(s.storedDirs, []);
	await s.run();
	assert.equal(s.vault.has("A"), false, "still gone on the next sync");
	assert.equal(s.cloudDirs.has("A"), false);
});

test("deleting a folder in Filen trashes the empty local folder after confirmation", async () => {
	const s = await synced(["A"]);
	s.cloudDirs.delete("A");
	await s.run();
	assert.deepEqual(s.calls.confirms, [["A/"]]);
	assert.deepEqual(s.calls.trashed, ["A"]);
	assert.deepEqual(s.calls.mkdir, [], "folder not re-uploaded");
	assert.deepEqual(s.storedDirs, []);
});

test("nested folder deletions prune children before parents on both sides", async () => {
	const s = await synced(["A", "A/B"]);
	s.vault.delete("A/B");
	s.vault.delete("A");
	await s.run();
	assert.deepEqual(s.calls.rmdir, ["A/B", "A"]);

	const r = await synced(["C", "C/D"]);
	r.cloudDirs.delete("C/D");
	r.cloudDirs.delete("C");
	await r.run();
	assert.deepEqual(r.calls.trashed, ["C/D", "C"]);
});

test("a survivor whose new child uploads is kept and promoted", async () => {
	const s = await synced(["A"]);
	s.cloudDirs.delete("A");
	s.addFile("A/new.md", "new");
	await s.run();
	assert.ok(s.cloudFiles.has("A/new.md"));
	assert.deepEqual(s.calls.trashed, []);
	assert.ok(s.vault.has("A"));
	assert.deepEqual(s.storedDirs, ["A"]);
});

test("a survivor holding only ignored content keeps its pending deletion", async () => {
	const s = await synced(["A"]);
	s.cloudDirs.delete("A");
	s.hiddenLocal.set("A", ["A/.DS_Store"]);
	await s.run();
	assert.deepEqual(s.calls.trashed, []);
	assert.deepEqual(s.storedDirs, ["A"], "baseline retained");
	s.resetCalls();
	await s.run();
	assert.deepEqual(s.calls.mkdir, [], "survivor is not resurrected in Filen");
	assert.deepEqual(s.calls.confirms, [["A/"]], "deletion is planned again");
});

test("a cached remote skips local pruning until a fresh sync", async () => {
	const s = await synced(["A"]);
	await s.run({ autoSync: true }); // warm the remote tree cache
	s.cloudDirs.delete("A"); // not reported by the event probe
	s.resetCalls();
	await s.run({ autoSync: true });
	assert.deepEqual(s.calls.trashed, []);
	assert.deepEqual(s.storedDirs, ["A"], "baseline retained while cached");
	await s.run();
	assert.deepEqual(s.calls.trashed, ["A"]);
	assert.deepEqual(s.storedDirs, []);
});

test("remotes without folder deletion keep the pending deletion", async () => {
	const s = await synced(["A"], { folderApi: false });
	s.vault.delete("A");
	await s.run();
	assert.ok(s.cloudDirs.has("A"));
	assert.equal(s.vault.has("A"), false, "not restored locally");
	assert.deepEqual(s.storedDirs, ["A"]);
	await s.run();
	assert.equal(s.vault.has("A"), false, "still not restored");
});

test("a remote folder recreated after scanning prevents local pruning", async () => {
	const s = await synced(["A"]);
	s.cloudDirs.delete("A");
	s.statDirOverride = () => ({ uuid: "recreated" });
	await s.run();
	assert.deepEqual(s.calls.trashed, []);
	assert.ok(s.vault.has("A"));
	assert.deepEqual(s.storedDirs, ["A"]);
});

test("cancelling local folder deletions leaves folders and baseline untouched", async () => {
	const s = await synced(["A"]);
	s.cloudDirs.delete("A");
	s.confirmAnswer = false;
	const result = await s.run();
	assert.equal(result.cancelled, true);
	assert.ok(s.vault.has("A"));
	assert.equal(s.calls.setDirs, 0);
	assert.deepEqual(s.storedDirs, ["A"]);
});

test("push and pull restore deleted folders on the missing side", async () => {
	const push = await synced(["A"]);
	push.cloudDirs.delete("A");
	await push.run({ isManual: true }, "push");
	assert.deepEqual(push.calls.mkdir, ["A"]);
	assert.deepEqual(push.calls.trashed, []);
	assert.deepEqual(push.storedDirs, ["A"]);

	const pull = await synced(["A"]);
	pull.vault.delete("A");
	await pull.run({ isManual: true }, "pull");
	assert.deepEqual(pull.calls.localMkdir, ["A"]);
	assert.deepEqual(pull.calls.rmdir, []);
	assert.deepEqual(pull.storedDirs, ["A"]);
});

test("first sync without a folder baseline keeps union behavior and records it", async () => {
	const s = fixture({ localDirs: ["L"], remoteDirs: ["R"] });
	await s.run();
	assert.deepEqual(s.calls.mkdir, ["L"]);
	assert.deepEqual(s.calls.localMkdir, ["R"]);
	assert.deepEqual(s.storedDirs, ["L", "R"]);
});

test("preview lists folder actions and folder deletes skip the bulk guard", async () => {
	const dirs = Array.from({ length: 30 }, (_, i) => `F${i}`);
	const s = await synced(dirs);
	for (const dir of dirs) s.vault.delete(dir);
	const preview = await s.engine.previewPlan("both", {});
	assert.equal(preview.counts.deleteRemote, 30);
	assert.ok(preview.actions.every((a) => a.isDir && a.operation === "delete-remote"));
	assert.equal(preview.safetyReport.blocked, false);
	assert.equal(s.calls.setDirs, 0, "preview is read-only");
});
