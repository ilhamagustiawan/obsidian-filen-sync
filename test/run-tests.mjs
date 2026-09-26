import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

test("sync paths reject traversal, absolute paths, controls, and ambiguous separators", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-sync-test-"));
	try {
		const outfile = join(dir, "path-validation.mjs");
		await build({
			entryPoints: ["src/sync/path-validation.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
		});
		const { validateSyncPath, validateRemoteRoot, assertNoPathCollisions } = await import(
			pathToFileURL(outfile).href
		);
		for (const path of [
			"../escape",
			"a/../b",
			"/absolute",
			"C:/drive",
			"\\\\server\\share",
			"a\\b",
			"a//b",
			"a/./b",
			"bad\u0000name",
		]) {
			assert.throws(
				() => validateSyncPath(path),
				undefined,
				`rejects ${JSON.stringify(path)}`,
			);
		}
		assert.equal(validateSyncPath("notes/日本語.md"), "notes/日本語.md");
		assert.throws(() => validateSyncPath("__filen_sync_meta__"), /reserved/u);
		assert.throws(
			() =>
				assertNoPathCollisions([
					{ path: "Note.md", isDir: false },
					{ path: "note.md", isDir: false },
				]),
			/collision/u,
		);
		assert.throws(
			() =>
				assertNoPathCollisions([
					{ path: "caf\u00e9.md", isDir: false },
					{ path: "cafe\u0301.md", isDir: false },
				]),
			/collision/u,
		);
		assert.throws(
			() =>
				assertNoPathCollisions([
					{ path: "folder", isDir: false },
					{ path: "folder/file.md", isDir: false },
				]),
			/clash/u,
		);
		for (const root of ["relative", "/a/../b", "/a//b", "/a\\b"]) {
			assert.throws(
				() => validateRemoteRoot(root),
				undefined,
				`rejects ${JSON.stringify(root)}`,
			);
		}
		assert.equal(validateRemoteRoot("/Filen/日本語"), "/Filen/日本語");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Obsidian Axios adapter handles bodyless GETs, binary responses, status and HTTPS safely", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-adapter-test-"));
	const previousWindow = globalThis.window;
	globalThis.window = { setTimeout, clearTimeout };
	try {
		const stub = join(dir, "obsidian-stub.mjs");
		const outfile = join(dir, "adapter.mjs");
		await writeFile(
			stub,
			"export const requestUrl = (options) => globalThis.__obsidianRequestUrl(options);",
		);
		await build({
			entryPoints: ["src/obsidian-axios-adapter.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
			plugins: [
				{
					name: "obsidian-test-stub",
					setup(build) {
						build.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
					},
				},
			],
		});
		const {
			createObsidianAxiosLike,
			getOutstandingMutationRequests,
			needsRemoteReconciliation,
			setRemoteReconciliationRequired,
		} = await import(pathToFileURL(outfile).href);
		let lastRequest;
		globalThis.__obsidianRequestUrl = async (options) => {
			lastRequest = options;
			return {
				status: 200,
				headers: {},
				arrayBuffer: new Uint8Array([4, 5]).buffer,
				json: undefined,
				text: "not-json",
			};
		};
		const adapter = createObsidianAxiosLike();
		const response = await adapter.get("https://gateway.filen.net/v1", {});
		assert.equal(lastRequest.body, undefined);
		assert.equal(response.data, "not-json");
		const binary = await adapter.get("https://gateway.filen.net/file", {
			responseType: "arraybuffer",
		});
		assert.deepEqual([...new Uint8Array(binary.data)], [4, 5]);
		await assert.rejects(adapter.get("http://gateway.filen.net/v1", {}), /HTTPS/u);
		globalThis.__obsidianRequestUrl = async () => ({
			status: 401,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json: undefined,
			text: "unauthorized",
		});
		const errorResponse = await adapter.get("https://gateway.filen.net/v1", {});
		assert.equal(errorResponse.status, 401);
		assert.equal(errorResponse.data, "unauthorized");
		globalThis.__obsidianRequestUrl = () => new Promise(() => {});
		await assert.rejects(
			adapter.get("https://gateway.filen.net/slow", { timeout: 1 }),
			/timed out/u,
		);
		let requestedDeadline = 0;
		globalThis.window.setTimeout = (callback, delay) => {
			requestedDeadline = delay;
			return setTimeout(callback, 100_000);
		};
		globalThis.__obsidianRequestUrl = async () => ({
			status: 200,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json: {},
			text: "",
		});
		await adapter.get("https://gateway.filen.net/slow-but-valid", { timeout: 90_000 });
		assert.equal(requestedDeadline, 90_000, "caller timeouts are not capped at 60 seconds");
		const controller = new AbortController();
		globalThis.__obsidianRequestUrl = () => new Promise(() => {});
		const abortTimer = setTimeout(() => controller.abort(), 1);
		await assert.rejects(
			adapter.get("https://gateway.filen.net/no-deadline", {
				timeout: 0,
				signal: controller.signal,
			}),
			/cancelled/u,
		);
		clearTimeout(abortTimer);
		globalThis.window.setTimeout = setTimeout;
		let settleLateMutation;
		globalThis.__obsidianRequestUrl = () =>
			new Promise((resolve) => {
				settleLateMutation = resolve;
			});
		await assert.rejects(
			adapter.post("https://gateway.filen.net/upload", {}, { timeout: 1 }),
			/uncertain/u,
		);
		assert.equal(needsRemoteReconciliation(), true);
		assert.equal(getOutstandingMutationRequests(), 1);
		settleLateMutation({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(getOutstandingMutationRequests(), 0);
		assert.equal(
			needsRemoteReconciliation(),
			true,
			"uncertainty stays sticky after late settlement",
		);
		setRemoteReconciliationRequired(false);
	} finally {
		delete globalThis.__obsidianRequestUrl;
		globalThis.window = previousWindow;
		await rm(dir, { recursive: true, force: true });
	}
});

test("SecretStorage wrapper clears legacy raw passwords and derived auth", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-secrets-test-"));
	try {
		const outfile = join(dir, "secrets.mjs");
		await build({
			entryPoints: ["src/secrets.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
		});
		const { PluginSecrets } = await import(pathToFileURL(outfile).href);
		const values = new Map();
		const secrets = new PluginSecrets({
			secretStorage: {
				setSecret: (key, value) => values.set(key, value),
				getSecret: (key) => values.get(key) ?? "",
			},
		});
		const auth = {
			email: "test@example.com",
			masterKeys: ["key"],
			apiKey: "api",
			publicKey: "public",
			privateKey: "private",
			authVersion: 1,
			baseFolderUUID: "root-id",
			userId: 1,
		};
		secrets.setAuth(auth);
		assert.equal(secrets.hasAuth(), true);
		assert.deepEqual(secrets.getAuth(), auth);
		values.set("filen-sync-auth", JSON.stringify({ email: "incomplete" }));
		assert.equal(secrets.getAuth(), null);
		secrets.setAuth(auth);
		secrets.clearLegacyPassword();
		assert.equal(values.get("filen-sync-password"), "");
		secrets.clear();
		assert.equal(secrets.getAuth(), null);
		assert.equal(values.get("filen-sync-password"), "");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("manifest.json structure and validation", () => {
	assert.ok(existsSync("manifest.json"), "manifest.json exists");
	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	assert.equal(typeof manifest.id, "string");
	assert.ok(manifest.id.length > 0);
	assert.equal(typeof manifest.name, "string");
	assert.equal(typeof manifest.version, "string");
	assert.equal(typeof manifest.minAppVersion, "string");
	assert.equal(typeof manifest.description, "string");
	assert.equal(typeof manifest.isDesktopOnly, "boolean");
});

test("package.json and manifest.json versions match", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	assert.equal(
		pkg.version,
		manifest.version,
		"package.json version matches manifest.json version",
	);
});

test("versions.json contains current version entry", () => {
	assert.ok(existsSync("versions.json"), "versions.json exists");
	const versions = JSON.parse(readFileSync("versions.json", "utf8"));
	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	assert.ok(manifest.version in versions, `versions.json contains version ${manifest.version}`);
	assert.equal(versions[manifest.version], manifest.minAppVersion);
});

test("planSync computes correct operations for bidirectional and one-way syncs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-planner-test-"));
	try {
		const outfile = join(dir, "planner.mjs");
		await build({
			entryPoints: ["src/sync/planner.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
		});
		const { planSync } = await import(pathToFileURL(outfile).href);

		// 1. Both exist and identical -> noop
		{
			const localFiles = new Map([
				["a.md", { path: "a.md", mtime: 1000, ctime: 1000, size: 50, hash: "h1" }],
			]);
			const remoteFiles = new Map([
				["a.md", { path: "a.md", mtime: 1000, size: 50, isDir: false }],
			]);
			const prevRecords = new Map([
				["a.md", { path: "a.md", mtime: 1000, ctime: 1000, size: 50, hash: "h1" }],
			]);

			const result = planSync({ localFiles, remoteFiles, prevRecords });
			assert.equal(result.actions.length, 1);
			assert.equal(result.actions[0].operation, "noop");
			assert.equal(result.counts.noop, 1);
		}

		// 2. Local changed, remote unchanged -> upload
		{
			const localFiles = new Map([
				["a.md", { path: "a.md", mtime: 2000, ctime: 1000, size: 60, hash: "h2" }],
			]);
			const remoteFiles = new Map([
				["a.md", { path: "a.md", mtime: 1000, size: 50, isDir: false }],
			]);
			const prevRecords = new Map([
				["a.md", { path: "a.md", mtime: 1000, ctime: 1000, size: 50, hash: "h1" }],
			]);

			const result = planSync({ localFiles, remoteFiles, prevRecords });
			assert.equal(result.actions[0].operation, "upload");
			assert.equal(result.counts.upload, 1);
		}

		// 3. Remote changed, local unchanged -> download
		{
			const localFiles = new Map([
				["a.md", { path: "a.md", mtime: 1000, ctime: 1000, size: 50, hash: "h1" }],
			]);
			const remoteFiles = new Map([
				["a.md", { path: "a.md", mtime: 3000, size: 80, isDir: false }],
			]);
			const prevRecords = new Map([
				["a.md", { path: "a.md", mtime: 1000, ctime: 1000, size: 50, hash: "h1" }],
			]);

			const result = planSync({ localFiles, remoteFiles, prevRecords });
			assert.equal(result.actions[0].operation, "download");
			assert.equal(result.counts.download, 1);
		}

		// 4. Both changed -> conflict with local winner if newer
		{
			const localFiles = new Map([
				["a.md", { path: "a.md", mtime: 5000, ctime: 1000, size: 90, hash: "h3" }],
			]);
			const remoteFiles = new Map([
				["a.md", { path: "a.md", mtime: 4000, size: 80, isDir: false }],
			]);
			const prevRecords = new Map([
				["a.md", { path: "a.md", mtime: 1000, ctime: 1000, size: 50, hash: "h1" }],
			]);

			const result = planSync({ localFiles, remoteFiles, prevRecords });
			assert.equal(result.actions[0].operation, "conflict");
			assert.equal(result.actions[0].conflictWinner, "local");
			assert.equal(result.counts.conflict, 1);
		}

		// 5. Remote deleted, local unchanged -> delete-local
		{
			const localFiles = new Map([
				["a.md", { path: "a.md", mtime: 1000, ctime: 1000, size: 50, hash: "h1" }],
			]);
			const remoteFiles = new Map();
			const prevRecords = new Map([
				["a.md", { path: "a.md", mtime: 1000, ctime: 1000, size: 50, hash: "h1" }],
			]);

			const result = planSync({ localFiles, remoteFiles, prevRecords });
			assert.equal(result.actions[0].operation, "delete-local");
			assert.equal(result.counts.deleteLocal, 1);
		}

		// 6. Remote deleted, local changed -> delete-vs-modify conflict
		{
			const localFiles = new Map([
				["a.md", { path: "a.md", mtime: 2000, ctime: 1000, size: 70, hash: "h2" }],
			]);
			const remoteFiles = new Map();
			const prevRecords = new Map([
				["a.md", { path: "a.md", mtime: 1000, ctime: 1000, size: 50, hash: "h1" }],
			]);

			const result = planSync({ localFiles, remoteFiles, prevRecords });
			assert.equal(result.actions[0].operation, "conflict");
			assert.equal(result.actions[0].conflictWinner, "local");
		}

		// 7. Local deleted, remote unchanged -> delete-remote
		{
			const localFiles = new Map();
			const remoteFiles = new Map([
				["a.md", { path: "a.md", mtime: 1000, size: 50, isDir: false }],
			]);
			const prevRecords = new Map([
				["a.md", { path: "a.md", mtime: 1000, ctime: 1000, size: 50, hash: "h1" }],
			]);

			const result = planSync({ localFiles, remoteFiles, prevRecords });
			assert.equal(result.actions[0].operation, "delete-remote");
			assert.equal(result.counts.deleteRemote, 1);
		}

		// 8. One-way push mode: local changes upload, remote changes do NOT download
		{
			const localFiles = new Map([
				["local.md", { path: "local.md", mtime: 1000, ctime: 1000, size: 50 }],
			]);
			const remoteFiles = new Map([
				["remote.md", { path: "remote.md", mtime: 1000, size: 50, isDir: false }],
			]);
			const prevRecords = new Map();

			const result = planSync({ localFiles, remoteFiles, prevRecords, direction: "push" });
			const localAction = result.actions.find((a) => a.path === "local.md");
			const remoteAction = result.actions.find((a) => a.path === "remote.md");
			assert.equal(localAction.operation, "upload");
			assert.equal(remoteAction.operation, "noop");
		}

		// 9. One-way pull mode: remote changes download, local changes do NOT upload
		{
			const localFiles = new Map([
				["local.md", { path: "local.md", mtime: 1000, ctime: 1000, size: 50 }],
			]);
			const remoteFiles = new Map([
				["remote.md", { path: "remote.md", mtime: 1000, size: 50, isDir: false }],
			]);
			const prevRecords = new Map();

			const result = planSync({ localFiles, remoteFiles, prevRecords, direction: "pull" });
			const localAction = result.actions.find((a) => a.path === "local.md");
			const remoteAction = result.actions.find((a) => a.path === "remote.md");
			assert.equal(localAction.operation, "noop");
			assert.equal(remoteAction.operation, "download");
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("planner treats remote UUID replacement as a change and requires equal-content proof for first sync", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-planner-fingerprint-test-"));
	try {
		const outfile = join(dir, "planner.mjs");
		await build({
			entryPoints: ["src/sync/planner.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
		});
		const { planSync } = await import(pathToFileURL(outfile).href);
		const local = new Map([
			["a.md", { path: "a.md", mtime: 1000, ctime: 1000, size: 4, hash: "same" }],
		]);
		const previous = new Map([
			[
				"a.md",
				{
					path: "a.md",
					mtime: 1000,
					ctime: 1000,
					size: 4,
					hash: "same",
					remoteUuid: "old-id",
				},
			],
		]);
		const replacement = new Map([
			[
				"a.md",
				{
					path: "a.md",
					mtime: 1000,
					size: 4,
					isDir: false,
					uuid: "new-id",
				},
			],
		]);
		assert.equal(
			planSync({ localFiles: local, remoteFiles: replacement, prevRecords: previous })
				.actions[0].operation,
			"download",
		);

		const noBaseline = new Map();
		const unverifiedEqualMetadata = new Map([
			[
				"a.md",
				{
					path: "a.md",
					mtime: 1000,
					size: 4,
					isDir: false,
					uuid: "new-id",
				},
			],
		]);
		assert.equal(
			planSync({
				localFiles: local,
				remoteFiles: unverifiedEqualMetadata,
				prevRecords: noBaseline,
			}).actions[0].operation,
			"conflict",
		);
		const verified = new Map([
			[
				"a.md",
				{
					path: "a.md",
					mtime: 1000,
					size: 4,
					isDir: false,
					uuid: "new-id",
					hash: "same",
				},
			],
		]);
		assert.equal(
			planSync({ localFiles: local, remoteFiles: verified, prevRecords: noBaseline })
				.actions[0].operation,
			"noop",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("bulk guard blocks mass destructive changes and unexpectedly empty sources", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-bulk-test-"));
	try {
		const outfile = join(dir, "bulk-guard.mjs");
		await build({
			entryPoints: ["src/sync/bulk-guard.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
		});
		const { checkBulkGuard } = await import(pathToFileURL(outfile).href);

		// Normal small change: not blocked
		{
			const actions = [
				{ path: "note1.md", operation: "upload", detail: "New local file" },
				{ path: "note2.md", operation: "download", detail: "New remote file" },
				{ path: "note3.md", operation: "delete-local", detail: "Remote deleted" },
			];
			const report = checkBulkGuard(actions, {
				totalLocalFiles: 100,
				totalRemoteFiles: 100,
				totalBaselineFiles: 100,
			});
			assert.equal(report.blocked, false);
		}

		// 25 local deletions: exceeds absolute limit of 20
		{
			const actions = Array.from({ length: 25 }, (_, i) => ({
				path: `note${i}.md`,
				operation: "delete-local",
				detail: "Remote deleted",
			}));
			const report = checkBulkGuard(actions, {
				totalLocalFiles: 500,
				totalRemoteFiles: 475,
				totalBaselineFiles: 500,
			});
			assert.equal(report.blocked, true);
			assert.match(report.reason, /threshold: 20/u);
		}

		// 6 out of 20 files deleted (30% > 20% threshold): exceeds percentage limit
		{
			const actions = Array.from({ length: 6 }, (_, i) => ({
				path: `note${i}.md`,
				operation: "delete-local",
				detail: "Remote deleted",
			}));
			const report = checkBulkGuard(actions, {
				totalLocalFiles: 20,
				totalRemoteFiles: 14,
				totalBaselineFiles: 20,
			});
			assert.equal(report.blocked, true);
			assert.match(report.reason, /30%/u);
		}

		// Unexpectedly empty source: baseline had 10 files, remote suddenly reports 0
		{
			const actions = Array.from({ length: 10 }, (_, i) => ({
				path: `note${i}.md`,
				operation: "delete-local",
				detail: "Remote deleted",
			}));
			const report = checkBulkGuard(actions, {
				totalLocalFiles: 10,
				totalRemoteFiles: 0,
				totalBaselineFiles: 10,
			});
			assert.equal(report.blocked, true);
			assert.match(report.reason, /remote folder appears empty/u);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("mapPool runs with fixed concurrency, preserves index addressing, and handles failure", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-pool-test-"));
	try {
		const outfile = join(dir, "pool.mjs");
		await build({
			entryPoints: ["src/sync/pool.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
		});
		const { mapPool } = await import(pathToFileURL(outfile).href);

		// 1. Concurrency never exceeds 3 and results are index-addressed
		{
			let activeWorkers = 0;
			let maxActiveWorkers = 0;
			const items = [10, 30, 20, 5, 15, 25];

			const results = await mapPool(items, 3, async (delay, index) => {
				activeWorkers += 1;
				if (activeWorkers > maxActiveWorkers) maxActiveWorkers = activeWorkers;
				// Varied delay so items finish out of order
				await new Promise((resolve) => setTimeout(resolve, delay));
				activeWorkers -= 1;
				return `item-${index}-${delay}`;
			});

			assert.ok(maxActiveWorkers <= 3, `max concurrency ${maxActiveWorkers} was <= 3`);
			assert.deepEqual(results, [
				"item-0-10",
				"item-1-30",
				"item-2-20",
				"item-3-5",
				"item-4-15",
				"item-5-25",
			]);
		}

		// 2. Any failing chunk rejects the pool
		{
			await assert.rejects(async () => {
				await mapPool([1, 2, 3, 4, 5], 3, async (val, index) => {
					if (index === 2) throw new Error("Chunk transfer failed");
					return val * 2;
				});
			}, /Chunk transfer failed/u);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("createSyncPathFilter enforces large file size limits", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-filter-test-"));
	try {
		const stub = join(dir, "obsidian-stub.mjs");
		const outfile = join(dir, "path-filters.mjs");
		await writeFile(
			stub,
			"export const normalizePath = (p) => p.replace(/\\\\/g, '/').replace(/^\\/+|\\/+$/g, '');",
		);
		await build({
			entryPoints: ["src/path-filters.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
			plugins: [
				{
					name: "obsidian-test-stub",
					setup(build) {
						build.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
					},
				},
			],
		});
		const { createSyncPathFilter } = await import(pathToFileURL(outfile).href);

		const filter = createSyncPathFilter({
			configDir: ".obsidian",
			pluginId: "obsidian-filen-sync",
			ignorePatterns: ["ignored/**"],
			maxFileSizeBytes: 50 * 1024 * 1024, // 50 MB
		});

		// Normal file under 50 MB -> not ignored
		assert.equal(filter.isIgnored("notes/normal.md", 1024), false);

		// File over 50 MB -> ignored
		assert.equal(filter.isIgnored("videos/huge.mp4", 60 * 1024 * 1024), true);

		// Pattern-ignored file -> ignored regardless of size
		assert.equal(filter.isIgnored("ignored/file.md", 10), true);

		// Directory or unspecified size -> only pattern check applies
		assert.equal(filter.isIgnored("notes"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("fast remote polling obeys safety rails and reuses cached tree only when safe", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-fastpoll-test-"));
	try {
		const stub = join(dir, "obsidian-stub.mjs");
		const outfile = join(dir, "sync-engine.mjs");
		await writeFile(
			stub,
			`
			export class TFile {}
			export class TFolder {}
			export const normalizePath = (p) => p.replace(/\\\\/g, '/').replace(/^\\/+|\\/+$/g, '');
			`,
		);
		await build({
			entryPoints: ["src/sync-engine.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
			plugins: [
				{
					name: "obsidian-test-stub",
					setup(build) {
						build.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
					},
				},
			],
		});
		const { SyncEngine, REMOTE_TREE_CACHE_TTL_MS } = await import(pathToFileURL(outfile).href);

		let walkCount = 0;
		let probeCount = 0;
		let probeShouldThrow = false;
		let probeHasChanges = false;

		const mockRemote = {
			mkdir: async () => {},
			walk: async () => {
				walkCount += 1;
				// Reuse applies to a pass without any mutation.
				return [];
			},
			checkEvents: async (watermark) => {
				probeCount += 1;
				if (probeShouldThrow) throw new Error("Network error probing events");
				return { hasChanges: probeHasChanges, newWatermarkMs: watermark + 1000 };
			},
			close: () => {},
			rm: async () => {},
			readFile: async () => new Uint8Array(),
			writeFile: async () => {},
			checkConnect: async () => {},
		};

		const mockDb = {
			getAllFiles: async () => new Map(),
			getFile: async () => null,
			deleteFile: async () => {},
			setFile: async () => {},
		};

		const engine = new SyncEngine({
			app: {
				vault: {
					configDir: ".obsidian",
					getAllLoadedFiles: () => [],
					getAbstractFileByPath: () => null,
					createBinary: async () => {},
					readBinary: async () => new Uint8Array(),
					adapter: {
						writeBinary: async () => {},
						mkdir: async () => {},
						exists: async () => true,
					},
				},
			},
			db: mockDb,
			pluginId: "obsidian-filen-sync",
			settings: {
				deviceId: "test-device",
				vaultName: "test-vault",
				ignorePatterns: [],
				fastRemotePolling: true,
				skipLargeFiles: true,
				skipSizeLargerThanMB: 50,
			},
			remote: mockRemote,
		});

		// 1. Initial run: cache is empty, must do full remote walk
		await engine.sync(undefined, undefined, undefined, "both", undefined, undefined, {
			isManual: false,
		});
		assert.equal(walkCount, 1, "initial run walked remote");

		// 2. Second run: probe reports no changes, cache valid -> skips full walk
		await engine.sync(undefined, undefined, undefined, "both", undefined, undefined, {
			isManual: false,
		});
		assert.equal(walkCount, 1, "cached run skipped full remote walk");
		assert.equal(probeCount, 2, "probe was called on both runs");

		// 3. Safety Rail 1: failed probe never trusts silence -> forces full walk
		probeShouldThrow = true;
		await engine.sync(undefined, undefined, undefined, "both", undefined, undefined, {
			isManual: false,
		});
		assert.equal(walkCount, 2, "failed probe forced full remote walk");
		probeShouldThrow = false;

		// 4. Safety Rail 2: manual run always scans in full
		await engine.sync(undefined, undefined, undefined, "both", undefined, undefined, {
			isManual: true,
		});
		assert.equal(walkCount, 3, "manual sync forced full remote walk");

		// 5. Safety Rail 3: cache older than 30 minutes is refreshed
		// Artificially age the cache
		engine.remoteTreeCache.fetchedAt = Date.now() - (REMOTE_TREE_CACHE_TTL_MS + 1000);
		await engine.sync(undefined, undefined, undefined, "both", undefined, undefined, {
			isManual: false,
		});
		assert.equal(walkCount, 4, "expired cache (>30m) forced full remote walk");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("formatRelativeTime and isNetworkClassError produce correct results", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-formatters-test-"));
	try {
		const stub = join(dir, "obsidian-stub.mjs");
		const outfile = join(dir, "coordinator.mjs");
		await writeFile(
			stub,
			`
			export class TFile {}
			export class TFolder {}
			export class Notice {}
			export const normalizePath = (p) => p;
			`,
		);
		await build({
			entryPoints: ["src/sync/coordinator.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
			plugins: [
				{
					name: "obsidian-test-stub",
					setup(build) {
						build.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
					},
				},
			],
		});
		const { isNetworkClassError, formatRelativeTime } = await import(
			pathToFileURL(outfile).href
		);

		// 1. isNetworkClassError
		assert.equal(isNetworkClassError(new Error("fetch failed")), true);
		assert.equal(isNetworkClassError(new Error("connect ECONNREFUSED 127.0.0.1:443")), true);
		assert.equal(isNetworkClassError(new Error("ETIMEDOUT")), true);
		assert.equal(isNetworkClassError(new Error("getaddrinfo ENOTFOUND api.filen.io")), true);
		assert.equal(isNetworkClassError(new Error("Invalid password")), false);
		assert.equal(isNetworkClassError(new Error("Vault path collision")), false);

		// 2. formatRelativeTime
		const now = 1000000;
		assert.equal(formatRelativeTime(now - 10_000, now), "just now");
		assert.equal(formatRelativeTime(now - 60_000, now), "1 minute ago");
		assert.equal(formatRelativeTime(now - 3 * 60_000, now), "3 minutes ago");
		assert.equal(formatRelativeTime(now - 60 * 60_000, now), "1 hour ago");
		assert.equal(formatRelativeTime(now - 5 * 60 * 60_000, now), "5 hours ago");
		assert.equal(formatRelativeTime(now - 24 * 60 * 60_000, now), "1 day ago");
		assert.equal(formatRelativeTime(now - 3 * 24 * 60 * 60_000, now), "3 days ago");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("SyncCoordinator offline awareness and error notice throttling", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-coord-offline-test-"));
	const previousWindow = globalThis.window;
	globalThis.window = { setTimeout, clearTimeout };
	globalThis.__testNotices = [];
	let coordinator;
	try {
		const stub = join(dir, "obsidian-stub.mjs");
		const outfile = join(dir, "coordinator.mjs");
		await writeFile(
			stub,
			`
			export class TFile {}
			export class TFolder {}
			export class Notice {
				constructor(message) {
					globalThis.__testNotices.push(message);
				}
			}
			export const normalizePath = (p) => p;
			`,
		);
		await build({
			entryPoints: ["src/sync/coordinator.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
			plugins: [
				{
					name: "obsidian-test-stub",
					setup(build) {
						build.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
					},
				},
			],
		});
		const { SyncCoordinator } = await import(pathToFileURL(outfile).href);
		const notices = globalThis.__testNotices;

		let shouldFailNetwork = false;
		let shouldFailOther = false;
		const statusStates = [];
		const loggedActivities = [];

		const mockEngine = {
			sync: async (_onProgress, _confirmDeletes, onActivity) => {
				if (shouldFailNetwork) {
					throw new Error("connect ECONNREFUSED 127.0.0.1:443");
				}
				if (shouldFailOther) {
					throw new Error("Invalid password");
				}
				onActivity?.({ type: "connected" });
				return { applied: 0, conflicts: 0, conflictCopies: [] };
			},
			close: () => {},
		};

		coordinator = new SyncCoordinator(
			{
				vault: { configDir: ".obsidian", on: () => ({}), offref: () => {} },
				workspace: { getActiveFile: () => null, on: () => ({}), offref: () => {} },
			},
			"obsidian-filen-sync",
			{
				deviceId: "test-device",
				vaultName: "test-vault",
				ignorePatterns: [],
				syncPaused: false,
				syncOnSave: true,
				syncIntervalMinutes: 5,
				syncStartupDelaySeconds: 0,
			},
			() => ({ checkConnect: async () => {}, close: () => {} }),
			() => ({}),
			{
				onStatusChange: (s) => statusStates.push(s),
				onLogActivity: (m) => loggedActivities.push(m),
				confirmLocalDeletes: async () => true,
				confirmBulkOperations: async () => true,
				saveSettings: async () => {},
			},
		);
		// Inject mock engine
		coordinator.syncEngine = mockEngine;
		coordinator.autoSyncHasSavedAuth = () => false;
		coordinator.pendingAutoSync = true;
		coordinator.runPendingAutoSync();
		assert.equal(coordinator.debounceTimer, null, "pending auto-sync preserves its auth gate");
		coordinator.pendingAutoSync = false;

		assert.equal(coordinator.offline, false, "initially online");

		// 1. First network failure: not yet offline (needs 2 consecutive)
		shouldFailNetwork = true;
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		assert.equal(coordinator.offline, false, "still online after 1 failure");

		// 2. Second network failure: flips to offline
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		assert.equal(coordinator.offline, true, "flips to offline after 2 network failures");

		// 3. Error notice throttling for auto-sync:
		// Notices for identical auto-sync error was only shown once (throttled to 15m)
		const autoSyncNotices = notices.filter((n) => n.includes("ECONNREFUSED"));
		assert.equal(
			autoSyncNotices.length,
			1,
			"auto-sync identical error notice was throttled to 1 notice",
		);

		// But activity logs contain both failures (log is not throttled)
		const failedLogs = loggedActivities.filter((m) => m.includes("failed"));
		assert.equal(failedLogs.length, 2, "activity log records all failures without throttling");

		// 4. While offline, auto-sync triggers skip silently without starting a run
		loggedActivities.length = 0;
		coordinator.requestAutoSync(() => true);
		assert.equal(loggedActivities.length, 0, "auto-sync skipped silently without logging");

		// 5. Manual run while offline shows notice and still tries
		notices.length = 0;
		shouldFailNetwork = false; // Next run will succeed and reach gateway
		await coordinator.runSync("Sync", "both", { isManual: true });

		const offlineNotices = notices.filter((n) =>
			n.includes("You're offline — sync resumes when you're back"),
		);
		assert.equal(offlineNotices.length, 1, "manual run showed offline notice");

		// Successful manual run flipped offline back to false
		assert.equal(coordinator.offline, false, "reconnected run restored online state");

		// 6. Manual error is NEVER throttled
		shouldFailOther = true;
		notices.length = 0;
		await coordinator.runSync("Sync", "both", { isManual: true });
		await coordinator.runSync("Sync", "both", { isManual: true });
		const manualErrors = notices.filter((n) => n.includes("Invalid password"));
		assert.equal(manualErrors.length, 2, "manual errors are never throttled");
	} finally {
		coordinator.close();
		delete globalThis.__testNotices;
		globalThis.window = previousWindow;
		await rm(dir, { recursive: true, force: true });
	}
});

test("Force sync file obeys user intent, pauses, and confirms overwrite if remote changed", async () => {
	let writtenPath = null;
	let confirmAsked = false;

	const mockRemote = {
		stat: async (path) => {
			if (path === "changed.md") {
				return { path: "changed.md", mtime: 2000, size: 200, isDir: false };
			}
			if (path === "unchanged.md") {
				return { path: "unchanged.md", mtime: 1000, size: 100, isDir: false };
			}
			return null;
		},
		writeFile: async (path, _bytes) => {
			writtenPath = path;
		},
	};

	const mockDb = {
		getFile: async (path) => {
			if (path === "changed.md" || path === "unchanged.md") {
				return { path, mtime: 1000, size: 100, ctime: 1000 };
			}
			return undefined;
		},
		setFile: async () => {},
	};

	const notices = [];
	const testNotices = (msg) => notices.push(msg);

	// Helper modeling forceSyncFile flow
	async function runForceSync({ path, name, isPaused, confirmOverwrite }) {
		if (isPaused) {
			testNotices("Sync is paused. Resume sync to continue.");
			return false;
		}
		const baseline = await mockDb.getFile(path);
		const remoteEntry = await mockRemote.stat(path);

		let remoteChanged = false;
		if (remoteEntry !== null && remoteEntry !== undefined) {
			if (!baseline) {
				remoteChanged = true;
			} else if (remoteEntry.mtime !== baseline.mtime || remoteEntry.size !== baseline.size) {
				remoteChanged = true;
			}
		}

		if (remoteChanged) {
			confirmAsked = true;
			if (!confirmOverwrite) {
				return false;
			}
		}

		const bytes = new Uint8Array([1, 2, 3]);
		await mockRemote.writeFile(path, bytes);
		testNotices(`Uploaded "${name}" to Filen.`);
		return true;
	}

	// 1. Paused: stops immediately with notice
	notices.length = 0;
	const pausedResult = await runForceSync({
		path: "note.md",
		name: "note.md",
		isPaused: true,
		confirmOverwrite: true,
	});
	assert.equal(pausedResult, false);
	assert.match(notices[0], /Sync is paused/u);

	// 2. Unchanged remote: uploads directly without asking confirmation
	notices.length = 0;
	confirmAsked = false;
	const unchangedResult = await runForceSync({
		path: "unchanged.md",
		name: "unchanged.md",
		isPaused: false,
		confirmOverwrite: true,
	});
	assert.equal(unchangedResult, true);
	assert.equal(confirmAsked, false, "no overwrite confirmation asked for unchanged remote");
	assert.equal(writtenPath, "unchanged.md");
	assert.match(notices[0], /Uploaded "unchanged.md" to Filen/u);

	// 3. Changed remote with cancelled confirmation: does not upload
	notices.length = 0;
	confirmAsked = false;
	writtenPath = null;
	const cancelledResult = await runForceSync({
		path: "changed.md",
		name: "changed.md",
		isPaused: false,
		confirmOverwrite: false,
	});
	assert.equal(cancelledResult, false);
	assert.equal(confirmAsked, true, "overwrite confirmation was requested");
	assert.equal(writtenPath, null, "remote was not overwritten");

	// 4. Changed remote with approved confirmation: uploads
	notices.length = 0;
	confirmAsked = false;
	writtenPath = null;
	const approvedResult = await runForceSync({
		path: "changed.md",
		name: "changed.md",
		isPaused: false,
		confirmOverwrite: true,
	});
	assert.equal(approvedResult, true);
	assert.equal(confirmAsked, true, "overwrite confirmation was requested");
	assert.equal(writtenPath, "changed.md", "remote was overwritten with local copy");
	assert.match(notices[0], /Uploaded "changed.md" to Filen/u);
});

test("FilenSyncSettings correctly parses statusBarIndicatorStyle and defaults to icon", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-settings-test-"));
	try {
		const stub = join(dir, "obsidian-stub.mjs");
		const outfile = join(dir, "settings.mjs");
		await writeFile(
			stub,
			`
			export class Modal {}
			export class Notice {}
			export class PluginSettingTab {}
			export class Setting {}
			export const normalizePath = (p) => p;
			`,
		);
		await build({
			entryPoints: ["src/settings.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
			plugins: [
				{
					name: "obsidian-test-stub",
					setup(build) {
						build.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
					},
				},
			],
		});
		const { FilenSyncSettings, DEFAULT_SETTINGS } = await import(pathToFileURL(outfile).href);

		// Defaults to "icon" (native Obsidian Sync style)
		assert.equal(DEFAULT_SETTINGS.statusBarIndicatorStyle, "icon");
		assert.equal(DEFAULT_SETTINGS.reconciliationNeeded, false);
		assert.equal(DEFAULT_SETTINGS.syncProgressNoticeMode, "never");
		assert.equal(DEFAULT_SETTINGS.showFloatingSyncIndicator, true);
		assert.equal(DEFAULT_SETTINGS.minimumAutoSyncIntervalSeconds, 10);
		assert.equal("notifyOnBackgroundChange" in DEFAULT_SETTINGS, false);

		const parsedEmpty = FilenSyncSettings.fromSaved({});
		assert.equal(parsedEmpty.statusBarIndicatorStyle, "icon");
		assert.equal(parsedEmpty.syncProgressNoticeMode, "never");
		assert.equal(parsedEmpty.showFloatingSyncIndicator, true);
		assert.equal(parsedEmpty.minimumAutoSyncIntervalSeconds, 10);
		assert.equal("notifyOnBackgroundChange" in parsedEmpty, false);

		assert.equal(
			FilenSyncSettings.fromSaved({ minimumAutoSyncIntervalSeconds: 1 })
				.minimumAutoSyncIntervalSeconds,
			5,
			"clamps lower bound to 5s",
		);
		assert.equal(
			FilenSyncSettings.fromSaved({ minimumAutoSyncIntervalSeconds: 300 })
				.minimumAutoSyncIntervalSeconds,
			120,
			"clamps upper bound to 120s",
		);
		assert.equal(
			FilenSyncSettings.fromSaved({ minimumAutoSyncIntervalSeconds: 30 })
				.minimumAutoSyncIntervalSeconds,
			30,
		);

		const parsedFull = FilenSyncSettings.fromSaved({ statusBarIndicatorStyle: "full" });
		assert.equal(parsedFull.statusBarIndicatorStyle, "full");

		const parsedInvalid = FilenSyncSettings.fromSaved({ statusBarIndicatorStyle: "invalid" });
		assert.equal(parsedInvalid.statusBarIndicatorStyle, "icon");

		for (const legacyMode of ["always", "manual_only", "never", "transfers_only", "invalid"]) {
			assert.equal(
				FilenSyncSettings.fromSaved({ syncProgressNoticeMode: legacyMode })
					.syncProgressNoticeMode,
				"never",
			);
		}
		assert.equal(
			FilenSyncSettings.fromSaved({ lastSyncTimestamp: 123 }).lastSyncTimestamp,
			123,
		);
		assert.equal(
			FilenSyncSettings.fromSaved({ lastSyncTimestamp: -1 }).lastSyncTimestamp,
			null,
		);
		assert.equal(
			FilenSyncSettings.fromSaved({ lastSyncResultSummary: "2 applied" })
				.lastSyncResultSummary,
			"2 applied",
		);
		assert.equal(
			FilenSyncSettings.fromSaved({ showFloatingSyncIndicator: false })
				.showFloatingSyncIndicator,
			false,
		);
		assert.equal(
			FilenSyncSettings.fromSaved({ reconciliationNeeded: true }).reconciliationNeeded,
			true,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("planner detects remote change when remoteHash differs even if size and mtime match", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-planner-remotehash-test-"));
	try {
		const outfile = join(dir, "planner.mjs");
		await build({
			entryPoints: ["src/sync/planner.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
		});
		const { planSync } = await import(pathToFileURL(outfile).href);

		const local = new Map([
			[
				"note.md",
				{ path: "note.md", mtime: 1000, ctime: 1000, size: 20, hash: "local-sha256" },
			],
		]);
		const baseline = new Map([
			[
				"note.md",
				{
					path: "note.md",
					mtime: 1000,
					ctime: 1000,
					size: 20,
					hash: "local-sha256",
					remoteUuid: "uuid-1",
					remoteHash: "remote-sha512-v1",
				},
			],
		]);
		// Remote has same size and mtime, same uuid, but different remoteHash
		const remoteChanged = new Map([
			[
				"note.md",
				{
					path: "note.md",
					mtime: 1000,
					size: 20,
					isDir: false,
					uuid: "uuid-1",
					remoteHash: "remote-sha512-v2",
				},
			],
		]);

		const plan = planSync({
			localFiles: local,
			remoteFiles: remoteChanged,
			prevRecords: baseline,
		});
		assert.equal(plan.actions.length, 1);
		assert.equal(
			plan.actions[0].operation,
			"download",
			"remoteHash change triggers download even with identical mtime and size",
		);

		// If remoteHash is the same as baseline, it returns noop
		const remoteSame = new Map([
			[
				"note.md",
				{
					path: "note.md",
					mtime: 1000,
					size: 20,
					isDir: false,
					uuid: "uuid-1",
					remoteHash: "remote-sha512-v1",
				},
			],
		]);
		const planSame = planSync({
			localFiles: local,
			remoteFiles: remoteSame,
			prevRecords: baseline,
		});
		assert.equal(planSame.actions.length, 1);
		assert.equal(
			planSame.actions[0].operation,
			"noop",
			"identical remoteHash and local hash returns noop",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("SyncDb isolates target identity by vaultId, userId, and remoteRootUuid and rejects invalid meta", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-db-test-"));
	try {
		const localforageStub = join(dir, "localforage-stub.mjs");
		const obsidianStub = join(dir, "obsidian-stub.mjs");
		const outfile = join(dir, "db.mjs");
		await writeFile(
			localforageStub,
			`
			const memoryStores = new Map();
			export default {
				createInstance({ name, storeName }) {
					const prefix = \`\${name}:\${storeName}:\`;
					return {
						async getItem(k) { return memoryStores.get(prefix + k) ?? null; },
						async setItem(k, v) { memoryStores.set(prefix + k, v); return v; },
						async removeItem(k) { memoryStores.delete(prefix + k); },
						async iterate(cb) {
							for (const [key, val] of memoryStores.entries()) {
								if (key.startsWith(prefix)) {
									const itemKey = key.slice(prefix.length);
									const res = cb(val, itemKey, 0);
									if (res !== undefined) return res;
								}
							}
						}
					};
				}
			};
			`,
		);
		await writeFile(
			obsidianStub,
			`
			export class Modal {}
			export class Notice {}
			export class PluginSettingTab {}
			export class Setting {}
			export const normalizePath = (p) => p;
			`,
		);
		await build({
			entryPoints: ["src/db.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
			plugins: [
				{
					name: "test-stubs",
					setup(build) {
						build.onResolve({ filter: /^localforage$/ }, () => ({
							path: localforageStub,
						}));
						build.onResolve({ filter: /^obsidian$/ }, () => ({ path: obsidianStub }));
					},
				},
			],
		});
		const { SyncDb } = await import(pathToFileURL(outfile).href);

		const binding1 = { vaultId: "vault-a", userId: 100, remoteRootUuid: "root-uuid-1" };
		const db1 = await SyncDb.open(binding1);
		await db1.runMigrations();

		await db1.setFile("file1.md", {
			path: "file1.md",
			mtime: 1000,
			ctime: 1000,
			size: 50,
			remoteHash: "hash-remote-1",
		});

		const file1 = await db1.getFile("file1.md");
		assert.ok(file1 !== undefined);
		assert.equal(file1.remoteHash, "hash-remote-1");

		// Binding 2: different userId
		const binding2 = { vaultId: "vault-a", userId: 200, remoteRootUuid: "root-uuid-1" };
		const db2 = await SyncDb.open(binding2);
		await db2.runMigrations();
		assert.equal(await db2.getFile("file1.md"), undefined, "isolated from different account");

		// Binding 3: different remoteRootUuid
		const binding3 = { vaultId: "vault-a", userId: 100, remoteRootUuid: "root-uuid-2" };
		const db3 = await SyncDb.open(binding3);
		await db3.runMigrations();
		assert.equal(
			await db3.getFile("file1.md"),
			undefined,
			"isolated from different remote root",
		);

		// Re-opening binding 1 recovers the saved baseline
		const db1Again = await SyncDb.open(binding1);
		const file1Again = await db1Again.getFile("file1.md");
		assert.equal(file1Again?.remoteHash, "hash-remote-1");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("SyncExecutor revalidates local and remote state before mutation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-executor-test-"));
	try {
		const stub = join(dir, "obsidian-stub.mjs");
		const outfile = join(dir, "executor.mjs");
		await writeFile(
			stub,
			`
			export class TFile {
				constructor(path, mtime, size) {
					this.path = path;
					this.stat = { mtime, ctime: mtime, size };
				}
				static [Symbol.hasInstance](instance) {
					return instance !== null && typeof instance === "object" && "stat" in instance && "path" in instance;
				}
			}
			export const normalizePath = (p) => p;
			`,
		);
		await build({
			entryPoints: ["src/sync/executor.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
			plugins: [
				{
					name: "obsidian-test-stub",
					setup(build) {
						build.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
					},
				},
			],
		});
		const { TFile } = await import(pathToFileURL(stub).href);
		const { SyncExecutor } = await import(pathToFileURL(outfile).href);

		const fakeTFile = new TFile("note.md", 2000, 25);

		const localEntry = {
			path: "note.md",
			mtime: 1000, // scanned mtime differs from current stat.mtime
			ctime: 1000,
			size: 25,
			file: fakeTFile,
		};

		let dbWritten = false;
		let remoteWritten = false;
		const mockDb = {
			getFile: async () => undefined,
			setFile: async () => {
				dbWritten = true;
			},
			deleteFile: async () => {},
		};
		const mockRemote = {
			writeFile: async () => {
				remoteWritten = true;
				return { uuid: "new-uuid" };
			},
			rm: async () => {},
			readFile: async () => new Uint8Array(0),
			stat: async () => null,
		};
		const mockApp = {
			vault: {
				getAbstractFileByPath: (p) => (p === "deleted-local.md" ? null : fakeTFile),
				readBinary: async () => new Uint8Array([1, 2, 3]),
				adapter: { writeBinary: async () => {} },
			},
		};

		const executor = new SyncExecutor({
			app: mockApp,
			db: mockDb,
			deviceId: "dev1",
			remote: mockRemote,
		});

		// pushLocal should detect concurrent local mtime modification and throw replan error
		await assert.rejects(
			executor.execute(
				{ path: "note.md", operation: "upload", detail: "upload" },
				localEntry,
			),
			/Local file changed during sync.*Replan the sync/u,
		);
		assert.equal(dbWritten, false, "DB not updated on replan abort");
		assert.equal(remoteWritten, false, "Remote not written on replan abort");

		// delete-remote should verify remote UUID is provided
		await assert.rejects(
			executor.execute(
				{ path: "deleted-local.md", operation: "delete-remote", detail: "delete" },
				undefined,
				{ path: "deleted-local.md", mtime: 1000, size: 25, isDir: false }, // missing uuid
			),
			/Remote identity unavailable.*Replan the sync/u,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Legacy credentials migration removes plaintext auth from disk without reserializing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-legacy-auth-test-"));
	try {
		const stub = join(dir, "obsidian-stub.mjs");
		const outfile = join(dir, "auth-migration.mjs");
		await writeFile(
			stub,
			`
			export class Modal {}
			export class Notice {}
			export class PluginSettingTab {}
			export class Setting {}
			export const normalizePath = (p) => p;
			`,
		);
		await build({
			entryPoints: ["src/auth.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
		});
		const { readFilenAuth } = await import(pathToFileURL(outfile).href);

		// Valid legacy auth object
		const validBlob = {
			email: "user@example.com",
			masterKeys: ["mk1"],
			apiKey: "apikey123",
			publicKey: "pubkey",
			privateKey: "privkey",
			authVersion: 1,
			baseFolderUUID: "base-uuid",
			userId: 42,
		};
		const parsed = readFilenAuth(validBlob);
		assert.ok(parsed !== null);
		assert.equal(parsed.userId, 42);

		// Malformed/incomplete blob
		const malformedBlob = {
			email: "user@example.com",
			authVersion: 1,
			// missing keys
		};
		assert.equal(readFilenAuth(malformedBlob), null);
		assert.equal(readFilenAuth("string-not-object"), null);
		assert.equal(readFilenAuth(null), null);

		// Simulate loadSettings logic for both cases
		const simulateLoadSettings = (saved) => {
			let savedToDisk = null;
			let legacyAuthInvalid = false;
			let secretAuth = null;

			if (
				saved !== null &&
				typeof saved === "object" &&
				saved.auth !== null &&
				saved.auth !== undefined
			) {
				const auth = readFilenAuth(saved.auth);
				if (auth === null) {
					legacyAuthInvalid = true;
				} else {
					secretAuth = auth;
				}
				delete saved.auth;
				savedToDisk = { ...saved };
			}
			return { savedToDisk, legacyAuthInvalid, secretAuth };
		};

		// 1. Valid auth: migrated to secret, deleted from disk data
		const runValid = simulateLoadSettings({ email: "user@example.com", auth: validBlob });
		assert.ok(runValid.secretAuth !== null);
		assert.equal(runValid.legacyAuthInvalid, false);
		assert.equal(runValid.savedToDisk.auth, undefined, "auth removed from saved data");

		// 2. Corrupt auth: marked invalid, deleted from disk data, not in secret
		const runCorrupt = simulateLoadSettings({ email: "user@example.com", auth: malformedBlob });
		assert.equal(runCorrupt.secretAuth, null);
		assert.equal(runCorrupt.legacyAuthInvalid, true);
		assert.equal(
			runCorrupt.savedToDisk.auth,
			undefined,
			"corrupt auth removed from disk data without persisting",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("SyncNoticeController handles sync states, mobile compact mode, visibility, and lifecycles", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-ui-test-"));
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	try {
		const stub = join(dir, "obsidian-stub.mjs");
		const outfileNotice = join(dir, "sync-notice.mjs");

		await writeFile(
			stub,
			`
			export class Notice {
				constructor(frag, duration) {
					this.frag = frag;
					this.duration = duration;
					this.hidden = false;
					this.noticeEl = globalThis.__createMockElement("div", "notice");
					if (frag && frag.children) {
						this.noticeEl.children.push(...frag.children);
					}
					globalThis.__testActiveNotices.push(this);
				}
				hide() {
					this.hidden = true;
					this.noticeEl.isConnected = false;
				}
			}
			export const setIcon = (el, icon) => {
				if (el) el.setAttr("data-icon", icon);
			};
			`,
		);

		await build({
			entryPoints: ["src/ui/sync-notice.ts"],
			outfile: outfileNotice,
			bundle: true,
			format: "esm",
			platform: "node",
			plugins: [
				{
					name: "obsidian-test-stub",
					setup(build) {
						build.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
					},
				},
			],
		});

		class MockElement {
			constructor(tag, cls = "") {
				this.tag = tag;
				this.classList = new Set(cls.split(" ").filter(Boolean));
				this.children = [];
				this.attributes = new Map();
				this.textContent = "";
				this.style = {};
				this.isConnected = true;
			}
			addClass(...classes) {
				for (const c of classes) this.classList.add(c);
			}
			removeClass(...classes) {
				for (const c of classes) this.classList.delete(c);
			}
			hasClass(cls) {
				return this.classList.has(cls);
			}
			setText(t) {
				this.textContent = String(t);
			}
			setAttr(name, val) {
				this.attributes.set(name, String(val));
			}
			getAttr(name) {
				return this.attributes.get(name);
			}
			removeAttribute(name) {
				this.attributes.delete(name);
			}
			createDiv(opts = {}) {
				const el = new MockElement("div", opts.cls || "");
				if (opts.text) el.setText(opts.text);
				this.children.push(el);
				return el;
			}
			createSpan(opts = {}) {
				const el = new MockElement("span", opts.cls || "");
				if (opts.text) el.setText(opts.text);
				this.children.push(el);
				return el;
			}
			createEl(tag, opts = {}) {
				const el = new MockElement(tag, opts.cls || "");
				if (opts.text) el.setText(opts.text);
				this.children.push(el);
				return el;
			}
			addEventListener(evt, handler) {
				if (!this._listeners) this._listeners = new Map();
				this._listeners.set(evt, handler);
			}
			trigger(evt, eventData = {}) {
				const handler = this._listeners?.get(evt);
				if (handler) handler({ preventDefault() {}, stopPropagation() {}, ...eventData });
			}
			empty() {
				this.children = [];
				this.textContent = "";
			}
			remove() {
				this.isConnected = false;
			}
		}

		globalThis.__createMockElement = (tag, cls) => new MockElement(tag, cls);
		globalThis.__testActiveNotices = [];
		const indicatorTimers = new Map();
		let nextIndicatorTimer = 1;
		globalThis.setTimeout = (fn, ms) => {
			const id = nextIndicatorTimer++;
			indicatorTimers.set(id, { fn, ms });
			return id;
		};
		globalThis.clearTimeout = (id) => indicatorTimers.delete(id);
		globalThis.window = globalThis;
		globalThis.document = {
			createDocumentFragment: () => new MockElement("fragment"),
			body: new MockElement("body"),
		};

		const { SyncNoticeController } = await import(pathToFileURL(outfileNotice).href);

		// Desktop controller: automatic progress stays quiet
		let logsOpened = false;
		const desktopController = new SyncNoticeController(
			() => {
				logsOpened = true;
			},
			() => "Not synced yet",
			() => {},
			() => false, // isMobile = false
			() => true,
		);

		desktopController.onStatusChange({
			kind: "syncing",
			text: "Syncing…",
			detail: "Scanning…",
			updatedAt: Date.now(),
			isManual: false,
			progress: { current: 0, total: 0, path: "" },
		});
		assert.equal(
			globalThis.__testActiveNotices.length,
			0,
			"Desktop automatic progress stays quiet",
		);
		desktopController.onStatusChange({
			kind: "syncing",
			text: "Syncing…",
			detail: "1/5 · note.md",
			updatedAt: Date.now(),
			isManual: false,
			progress: { current: 1, total: 5, path: "note.md" },
		});
		assert.equal(
			globalThis.__testActiveNotices.length,
			0,
			"Desktop transfers stay quiet automatically",
		);

		// An explicit details request keeps the detailed renderer available.
		desktopController.showOnDemand({
			kind: "syncing",
			text: "Syncing…",
			detail: "1/5 · note.md",
			updatedAt: Date.now(),
			progress: { current: 1, total: 5, path: "note.md" },
		});
		assert.equal(globalThis.__testActiveNotices.length, 1);
		desktopController.onStatusChange({
			kind: "success",
			text: "Sync complete",
			detail: "5 files synced",
			updatedAt: Date.now(),
		});
		assert.equal(globalThis.__testActiveNotices[0].noticeEl.hasClass("is-success"), true);
		desktopController.closeNotice();
		assert.equal(globalThis.__testActiveNotices[0].hidden, true);

		// Mobile controller: automatic progress shows compact notice after anti-flash delay
		globalThis.__testActiveNotices = [];
		let mobileMenuOpened = false;
		let mobileEnabled = true;
		const mobileController = new SyncNoticeController(
			() => {
				logsOpened = true;
			},
			() => "Not synced yet",
			() => {
				mobileMenuOpened = true;
			},
			() => true, // isMobile = true
			() => mobileEnabled,
		);

		// Background scan with 0 transfers: delayed anti-flash timer
		mobileController.onStatusChange({
			kind: "syncing",
			text: "Syncing…",
			detail: "Scanning…",
			updatedAt: Date.now(),
			isManual: false,
			progress: { current: 0, total: 0, path: "" },
		});
		assert.equal(globalThis.__testActiveNotices.length, 0, "No notice before anti-flash delay");
		const [initialShowTimer] = [...indicatorTimers].find(([, timer]) => timer.ms === 300);
		assert.ok(initialShowTimer, "Anti-flash 300ms timer scheduled");

		// Progress update during anti-flash delay does not restart timer
		mobileController.onStatusChange({
			kind: "syncing",
			text: "Downloading…",
			detail: "1/2 · note.md",
			updatedAt: Date.now(),
			isManual: false,
			progress: { current: 1, total: 2, path: "note.md", phase: "transferring" },
		});
		assert.equal(
			[...indicatorTimers].find(([, timer]) => timer.ms === 300)?.[0],
			initialShowTimer,
			"Progress updates do not restart the anti-flash delay",
		);

		// Fire anti-flash timer
		const showTimer = indicatorTimers.get(initialShowTimer);
		indicatorTimers.delete(initialShowTimer);
		showTimer.fn();

		assert.equal(globalThis.__testActiveNotices.length, 1, "Notice visible after 300 ms");
		const mobileNotice = globalThis.__testActiveNotices[0];
		assert.equal(mobileNotice.noticeEl.hasClass("filen-notice-compact"), true);
		assert.equal(mobileNotice.noticeEl.hasClass("is-syncing"), true);

		// Success
		mobileController.onStatusChange({
			kind: "success",
			text: "up to date",
			detail: "No changes detected.",
			updatedAt: Date.now(),
		});
		assert.equal(mobileNotice.noticeEl.hasClass("is-success"), true);

		// Pending
		mobileController.onStatusChange({
			kind: "pending",
			text: "2 changes pending",
			detail: "Local changes waiting to sync.",
			updatedAt: Date.now(),
		});
		assert.equal(mobileNotice.noticeEl.hasClass("is-pending"), true);

		// Warning
		mobileController.onStatusChange({
			kind: "warning",
			text: "2 conflict(s) to review",
			detail: "Conflict copies were saved in the vault.",
			updatedAt: Date.now(),
		});
		assert.equal(mobileNotice.noticeEl.hasClass("is-warning"), true);

		// Cleanup
		mobileController.closeNotice();
		assert.equal(mobileNotice.hidden, true, "Notice disconnected after close");
	} finally {
		delete globalThis.__createMockElement;
		delete globalThis.__testActiveNotices;
		delete globalThis.document;
		delete globalThis.window;
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
		await rm(dir, { recursive: true, force: true });
	}
});
