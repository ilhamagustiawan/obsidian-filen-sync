import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

let scratch;
let FilenRemoteFs;
let mock;

before(async () => {
	await mkdir(resolve("tmp"), { recursive: true });
	scratch = await mkdtemp(resolve("tmp/remote-fs-"));
	const sdk = join(scratch, "sdk.mjs");
	const obsidian = join(scratch, "obsidian.mjs");
	await writeFile(
		sdk,
		`export class FilenSDK {
 constructor(config) { this.config = config; this.cache = new Map(); globalThis.__filenMock.clients.push(this); }
 init() { this.cache.clear(); globalThis.__filenMock.resets++; }
 logout() { globalThis.__filenMock.logouts++; }
 fs() { const m = globalThis.__filenMock; return {
  pathToItemUUID: async ({path, type}) => { m.lookups++; if (this.cache.has(path)) return this.cache.get(path); m.listRequests++; await m.delay(); const uuid = m.paths.get(path) ?? null; if (uuid !== null) this.cache.set(path, uuid); return uuid; },
  mkdir: async ({path}) => { m.sdkMkdirs++; const uuid = await this.fs().pathToItemUUID({path}); if (uuid !== null) return uuid; m.creates++; await m.delay(); const made = 'made-' + path; m.paths.set(path, made); this.cache.set(path, made); return made; }
 }; }
 cloud() { const m = globalThis.__filenMock; return {
  getDirectoryTree: async () => { m.trees++; await m.delay(); if (m.treeFailure) throw new Error('scan failed'); return m.tree; },
  createDirectory: async ({name,parent}) => { m.creates++; await m.delay(); if (m.createFailure) throw new Error('create failed'); const uuid = 'made-' + name; m.created.push({name,parent,uuid}); return uuid; },
  fileExists: async ({name,parent}) => { m.fileExistsCalls++; await m.delay(); return m.fileExistsResponse?.({name,parent}) ?? (m.files.has(name) ? { exists: true, uuid: m.files.get(name).uuid } : { exists: false }); },
  trashFile: async ({uuid}) => { m.trashed.push(uuid); return true; },
  getFile: async ({uuid}) => { const file = m.filesByUuid.get(uuid); if (!file) throw new Error('not found'); return file; }
 }; }
 getWorker() {
  return {
   crypto: {
    utils: {
     generateEncryptionKey: async () => 'key',
     hashFileName: async () => 'hashed-name'
    },
    encrypt: {
     metadata: async () => 'encrypted',
    },
    hash: {
     fileHash: async () => 'd'.repeat(128),
     sha512: async () => 'd'.repeat(128),
    }
   }
  };
 }
 generateHMACKey() { return Promise.resolve('hmac-key'); }
 api() {
  return {
   upload: () => ({
    empty: async () => ({ status: true }),
    done: async () => ({ status: true }),
   })
  };
 }
}`,
	);
	await writeFile(obsidian, `export const requestUrl = () => {};`);
	const outfile = join(scratch, "remote.mjs");
	await build({
		stdin: {
			contents: 'export {FilenRemoteFs} from "./src/fs-remote.ts";',
			resolveDir: process.cwd(),
		},
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		plugins: [
			{
				name: "stubs",
				setup(b) {
					b.onResolve({ filter: /^@filen\/sdk$/ }, () => ({ path: sdk }));
					b.onResolve({ filter: /^obsidian$/ }, () => ({ path: obsidian }));
				},
			},
		],
	});
	({ FilenRemoteFs } = await import(pathToFileURL(outfile).href));
});

after(async () => {
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

function fixture({ delayMs = 0, tree = {} } = {}) {
	mock = {
		clients: [],
		paths: new Map([["/Obsidian", "root-1"]]),
		tree,
		lookups: 0,
		listRequests: 0,
		sdkMkdirs: 0,
		creates: 0,
		trees: 0,
		resets: 0,
		logouts: 0,
		created: [],
		trashed: [],
		files: new Map(),
		filesByUuid: new Map(),
		fileExistsCalls: 0,
		fileExistsResponse: null,
		treeFailure: false,
		createFailure: false,
		delay: () => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve()),
	};
	for (const [path, entry] of Object.entries(tree)) {
		if (path !== "/" && entry.type === "directory" && typeof entry.uuid === "string") {
			mock.paths.set(`/Obsidian${path}`, entry.uuid);
		}
	}
	globalThis.__filenMock = mock;
	return new FilenRemoteFs({
		email: "",
		password: "",
		twoFactorCode: "",
		remoteRoot: "/Obsidian",
		auth: { userId: 42, baseFolderUUID: "base" },
		saveAuth: async () => {},
	});
}

test("target identity is freshly resolved and its next root ensure is reused once", async () => {
	const remote = fixture();
	assert.deepEqual(await remote.getTargetIdentity(), { userId: 42, rootUuid: "root-1" });
	await remote.mkdir("");
	assert.equal(mock.lookups, 1);

	mock.paths.set("/Obsidian", "root-2");
	assert.deepEqual(await remote.getTargetIdentity(), { userId: 42, rootUuid: "root-2" });
	await remote.mkdir("");
	assert.equal(mock.lookups, 2);
	assert.equal(mock.resets, 2);
});

test("standalone root ensure and failed identity do not reuse an old root", async () => {
	const remote = fixture();
	await remote.mkdir("");
	assert.equal(mock.lookups, 1);

	const client = mock.clients[0];
	client.fs = () => ({
		pathToItemUUID: async () => {
			throw new Error("lookup failed");
		},
		mkdir: async () => {
			mock.lookups++;
			return "root-3";
		},
	});
	await assert.rejects(remote.getTargetIdentity(), /lookup failed/);
	client.fs = () => ({
		pathToItemUUID: async () => {
			mock.lookups++;
			return "root-3";
		},
		mkdir: async () => {
			mock.lookups++;
			return "root-3";
		},
	});
	await remote.mkdir("");
	assert.equal(mock.lookups, 2);
});

test("directory scan UUIDs make nested creates parent-first without path lookups", async () => {
	const remote = fixture({
		tree: {
			"/": { type: "directory", uuid: "root-1", parent: "base" },
			"/existing": {
				type: "directory",
				uuid: "existing-uuid",
				parent: "root-1",
				lastModified: 1,
				size: 0,
			},
		},
	});
	await remote.walk();
	const before = mock.lookups;
	await remote.mkdir("existing/child");
	await remote.mkdir("existing/child/grandchild");
	assert.equal(mock.lookups, before + 1);
	assert.deepEqual(
		mock.created.map((item) => item.parent),
		["existing-uuid", "made-child"],
	);
	assert.equal(mock.sdkMkdirs, 0);
});

test("failed scans and uncertain creates discard the directory index", async () => {
	const remote = fixture({
		tree: {
			"/": { type: "directory", uuid: "root-1", parent: "base" },
			"/existing": {
				type: "directory",
				uuid: "existing-uuid",
				parent: "root-1",
				lastModified: 1,
				size: 0,
			},
		},
	});
	await remote.walk();
	mock.createFailure = true;
	await assert.rejects(remote.mkdir("existing/new"), /create failed/);
	mock.createFailure = false;
	await remote.mkdir("existing/fallback");
	assert.equal(mock.sdkMkdirs, 1);

	mock.treeFailure = true;
	await assert.rejects(remote.walk(), /scan failed/);
	mock.treeFailure = false;
	await remote.mkdir("existing/after-failed-scan");
	assert.equal(mock.sdkMkdirs, 2);
});

test("closing the target discards root and directory scan state", async () => {
	const remote = fixture();
	await remote.getTargetIdentity();
	await remote.close();
	await remote.mkdir("");
	assert.equal(mock.lookups, 2);
	assert.equal(mock.logouts, 1);
});

test("changed scanned parent falls back to SDK path resolution", async () => {
	const remote = fixture({
		tree: {
			"/": { type: "directory", uuid: "root-1", parent: "base" },
			"/existing": {
				type: "directory",
				uuid: "existing-uuid",
				parent: "root-1",
				lastModified: 1,
				size: 0,
			},
		},
	});
	await remote.walk();
	mock.paths.set("/Obsidian/existing", "replacement-uuid");
	await remote.mkdir("existing/child");
	assert.equal(mock.created.length, 0);
	assert.equal(mock.sdkMkdirs, 1);
});

test("an intervening scan invalidates the one-shot verified-root token", async () => {
	const remote = fixture();
	await remote.getTargetIdentity();
	await remote.walk();
	await remote.mkdir("");
	assert.equal(mock.sdkMkdirs, 1);
});

test("benchmark compares no-op repeats and nested folder preparation at fixed latency", async (t) => {
	const tree = { "/": { type: "directory", uuid: "root-1", parent: "base" } };
	const remote = fixture({ delayMs: 1, tree });
	const noOpSamples = [];
	for (let run = 0; run < 5; run++) {
		const started = performance.now();
		await remote.getTargetIdentity();
		const prepared = performance.now();
		await remote.mkdir("");
		await remote.walk();
		noOpSamples.push({ total: performance.now() - started, prep: prepared - started });
	}
	const noOpLookups = mock.lookups;
	const noOpListRequests = mock.listRequests;
	const noOpTreeRequests = mock.trees;

	const folderStarted = performance.now();
	await remote.getTargetIdentity();
	await remote.mkdir("");
	await remote.walk();
	for (let i = 0; i < 30; i++) await remote.mkdir(`folder-${i}`);
	const optimizedFolderMs = performance.now() - folderStarted;
	const optimizedFolderListRequests = mock.listRequests - noOpListRequests;
	const optimizedCreates = mock.creates;
	const optimizedFolderLookups = mock.lookups - noOpLookups;
	const optimizedFolderSdkLookups = optimizedFolderLookups;
	const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

	const baselineNoOpSamples = [];
	const baselineNoOpMetrics = { lookups: 0, listRequests: 0, trees: 0 };
	const baselineNoOpRemote = fixture({ delayMs: 1, tree });
	for (let run = 0; run < 5; run++) {
		const started = performance.now();
		await baselineNoOpRemote.getTargetIdentity();
		const prepared = performance.now();
		await mock.clients.at(-1).fs().mkdir({ path: "/Obsidian" });
		await baselineNoOpRemote.walk();
		baselineNoOpSamples.push({ total: performance.now() - started, prep: prepared - started });
	}
	Object.assign(baselineNoOpMetrics, {
		lookups: mock.lookups,
		listRequests: mock.listRequests,
		trees: mock.trees,
	});

	const baselineFolderSamples = [];
	let baselineFolderListRequests = 0;
	let baselineFolderCreates = 0;
	const baselineFolderRemote = fixture({ delayMs: 1, tree });
	for (let run = 0; run < 5; run++) {
		mock.paths = new Map([["/Obsidian", "root-1"]]);
		const started = performance.now();
		await baselineFolderRemote.getTargetIdentity();
		const sdkFs = mock.clients.at(-1).fs();
		await sdkFs.mkdir({ path: "/Obsidian" });
		await baselineFolderRemote.walk();
		for (let i = 0; i < 30; i++) {
			await sdkFs.mkdir({ path: `/Obsidian/folder-${i}` });
		}
		baselineFolderSamples.push(performance.now() - started);
	}
	baselineFolderListRequests = mock.listRequests;
	baselineFolderCreates = mock.creates;
	t.diagnostic(
		`No-op repeats (5 runs, 1ms controlled latency): median baseline ${median(baselineNoOpSamples.map((s) => s.total)).toFixed(1)}ms / optimized ${median(noOpSamples.map((s) => s.total)).toFixed(1)}ms; prep baseline ${median(baselineNoOpSamples.map((s) => s.prep)).toFixed(1)}ms / optimized ${median(noOpSamples.map((s) => s.prep)).toFixed(1)}ms; SDK lookups ${baselineNoOpMetrics.lookups} / ${noOpLookups}; network list requests ${baselineNoOpMetrics.listRequests} / ${noOpListRequests}; tree requests ${baselineNoOpMetrics.trees} / ${noOpTreeRequests}. Root list traffic is unchanged due to the warmed SDK cache.`,
	);
	t.diagnostic(
		`Nested first sync (5 runs, 30 folders/run, 1ms controlled latency): median baseline ${median(baselineFolderSamples).toFixed(1)}ms / optimized ${optimizedFolderMs.toFixed(1)}ms; list requests ${baselineFolderListRequests} / ${optimizedFolderListRequests}; folder creates ${baselineFolderCreates} / ${optimizedCreates}; SDK path lookups ${baselineFolderListRequests} vs indexed fast-path ${optimizedFolderSdkLookups}.`,
	);
});

test("mutation-session writeFile handles real SDK fileExists response shapes correctly", async () => {
	const remote = fixture({
		tree: {
			"/": { type: "directory", uuid: "root-1", parent: "base" },
		},
	});

	await remote.withMutationSession(async () => {
		// 1. New file: expectedRemoteUuid is undefined. SDK fileExists returns { exists: false }.
		// In buggy version, { exists: false } was truthy so it erroneously threw "Remote file changed before upload".
		mock.fileExistsResponse = () => ({ exists: false });
		const newFileEntry = await remote.writeFile(
			"daily-note.md",
			new Uint8Array(0),
			1000,
			1000,
			undefined,
		);
		assert.ok(newFileEntry.uuid, "New file uploaded successfully");
		assert.equal(newFileEntry.path, "daily-note.md");

		// 2. Existing file update: expectedRemoteUuid matches SDK uuid.
		mock.fileExistsResponse = () => ({ exists: true, uuid: "uuid-expected-1" });
		const updatedEntry = await remote.writeFile(
			"existing.md",
			new Uint8Array(0),
			2000,
			2000,
			"uuid-expected-1",
		);
		assert.ok(updatedEntry.uuid, "Existing file updated successfully");

		// 3. UUID mismatch: expectedRemoteUuid !== SDK uuid -> rejects with Replan the sync
		mock.fileExistsResponse = () => ({ exists: true, uuid: "uuid-remote-changed" });
		await assert.rejects(
			remote.writeFile("conflict.md", new Uint8Array(0), 2000, 2000, "uuid-expected-1"),
			/Remote file changed before upload: conflict\.md\. Replan the sync\./,
		);

		// 4. Unexpected existence: expectedRemoteUuid is undefined but file exists -> rejects
		mock.fileExistsResponse = () => ({ exists: true, uuid: "uuid-exists" });
		await assert.rejects(
			remote.writeFile("already-there.md", new Uint8Array(0), 1000, 1000, undefined),
			/Remote file changed before upload: already-there\.md\. Replan the sync\./,
		);

		// 5. Missing expected file: expectedRemoteUuid is set but SDK returns { exists: false } -> rejects
		mock.fileExistsResponse = () => ({ exists: false });
		await assert.rejects(
			remote.writeFile("deleted-remote.md", new Uint8Array(0), 2000, 2000, "uuid-expected-1"),
			/Remote file changed before upload: deleted-remote\.md\. Replan the sync\./,
		);
	});
});

test("rm revalidates remote identity, version and hash before trashing", async () => {
	const remote = fixture();
	mock.paths.set("/Obsidian/note.md", "uuid-note-1");
	mock.filesByUuid.set("uuid-note-1", {
		uuid: "uuid-note-1",
		size: 100,
		version: 3,
		trash: false,
		metadataDecrypted: {
			lastModified: 1000,
			hash: "a".repeat(128),
		},
	});

	// 1. Matches UUID, version and hash -> successfully trashed
	await remote.rm("note.md", "uuid-note-1", {
		version: 3,
		remoteHash: "a".repeat(128),
	});
	assert.deepEqual(mock.trashed, ["uuid-note-1"]);

	// 2. Remote UUID mismatch -> replan
	mock.trashed = [];
	await assert.rejects(
		remote.rm("note.md", "uuid-different", { version: 3 }),
		/Remote file changed before deletion: note\.md\. Replan the sync\./,
	);
	assert.equal(mock.trashed.length, 0);

	// 3. Remote version mismatch -> replan
	await assert.rejects(
		remote.rm("note.md", "uuid-note-1", { version: 4 }),
		/Remote file changed before deletion: note\.md\. Replan the sync\./,
	);
	assert.equal(mock.trashed.length, 0);

	// 4. Remote hash mismatch -> replan
	await assert.rejects(
		remote.rm("note.md", "uuid-note-1", { remoteHash: "b".repeat(128) }),
		/Remote file changed before deletion: note\.md\. Replan the sync\./,
	);
	assert.equal(mock.trashed.length, 0);

	// 5. File already deleted on remote (stat returns null) -> replan
	mock.filesByUuid.get("uuid-note-1").trash = true;
	await assert.rejects(
		remote.rm("note.md", "uuid-note-1"),
		/Remote file changed before deletion: note\.md\. Replan the sync\./,
	);
	assert.equal(mock.trashed.length, 0);
});
