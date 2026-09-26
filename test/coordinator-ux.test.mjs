import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

async function fixture(run) {
	await mkdir(resolve("tmp"), { recursive: true });
	const dir = await mkdtemp(resolve("tmp/coordinator-ux-"));
	const oldWindow = globalThis.window;
	const oldDocument = globalThis.document;
	const timers = new Map();
	let next = 1;
	globalThis.window = {
		setTimeout: (fn, ms) => {
			const id = next++;
			timers.set(id, { fn, ms });
			return id;
		},
		clearTimeout: (id) => timers.delete(id),
		setInterval: () => 99,
		clearInterval: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	globalThis.document = {
		visibilityState: "visible",
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	let coordinator;
	try {
		const stub = join(dir, "obsidian.mjs");
		await writeFile(
			stub,
			"export class TFile {} export class TFolder {} export class Notice { constructor(message) { (globalThis.__coordinatorNotices ??= []).push(message); } } export const normalizePath=p=>p;",
		);
		globalThis.__coordinatorNotices = [];
		const outfile = join(dir, "coordinator.mjs");
		await build({
			stdin: {
				contents:
					'export {SyncCoordinator} from "./src/sync/coordinator.ts";export {TFile} from "obsidian";',
				resolveDir: process.cwd(),
			},
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
			plugins: [
				{
					name: "stub",
					setup(b) {
						b.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
					},
				},
			],
		});
		const { SyncCoordinator, TFile } = await import(pathToFileURL(outfile).href);
		const events = new Map();
		const states = [];
		const file = Object.assign(new TFile(), { path: "note.md", stat: { size: 3 } });
		const settings = {
			syncOnSave: true,
			syncOnSaveDelaySeconds: 2,
			minimumAutoSyncIntervalSeconds: 10,
			syncPaused: false,
			syncIntervalMinutes: 3,
			syncStartupDelaySeconds: 0,
			ignorePatterns: [],
			skipLargeFiles: false,
			skipSizeLargerThanMB: 50,
		};
		const activities = [];
		coordinator = new SyncCoordinator(
			{
				vault: {
					configDir: ".obsidian",
					on: (event, fn) => {
						events.set(event, fn);
						return {};
					},
					offref: () => {},
				},
				workspace: { getActiveFile: () => null, on: () => ({}), offref: () => {} },
			},
			"filen-sync",
			settings,
			() => ({}),
			() => ({}),
			{
				onStatusChange: (s) => states.push(s),
				onLogActivity: (msg) => activities.push(msg),
				confirmLocalDeletes: async () => true,
				confirmBulkOperations: async () => true,
				saveSettings: async () => {},
			},
		);
		coordinator.syncEngine = {
			sync: async () => ({ applied: 0, conflicts: 0 }),
			invalidateLocal: () => {},
			close: () => {},
		};
		coordinator.setupAutoSync(() => true);
		await run({
			coordinator,
			events,
			states,
			file,
			timers,
			notices: globalThis.__coordinatorNotices,
			activities,
		});
	} finally {
		coordinator?.close();
		delete globalThis.__coordinatorNotices;
		globalThis.window = oldWindow;
		globalThis.document = oldDocument;
		await rm(dir, { recursive: true, force: true });
	}
}
test("pending changes deduplicate, keep status neutral idle, and clear after success", () =>
	fixture(async ({ coordinator, events, states, file }) => {
		events.get("modify")(file);
		events.get("modify")(file);
		assert.equal(coordinator.pendingCount, 1);
		assert.equal(states.at(-1).kind, "idle");
		assert.equal(states.at(-1).text, "Ready");
		await coordinator.runSync("Sync", "both", { isManual: true });
		assert.equal(coordinator.pendingCount, 0);
		assert.equal(states.at(-1).kind, "success");
	}));
test("edit during sync stays queued and leaves status in neutral idle", () =>
	fixture(async ({ coordinator, events, states, file }) => {
		events.get("modify")(file);
		coordinator.syncEngine.sync = async () => {
			events.get("modify")(file);
			return { applied: 1, conflicts: 0 };
		};
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		assert.equal(coordinator.pendingCount, 1);
		assert.equal(states.at(-1).kind, "idle");
	}));
test("confirmation warning survives edits and stops automatic retries", () =>
	fixture(async ({ coordinator, events, states, file }) => {
		coordinator.syncEngine.sync = async () => ({
			applied: 0,
			conflicts: 0,
			cancelled: true,
			cancelReason: "Confirm delete",
		});
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		events.get("modify")(file);
		assert.equal(states.at(-1).kind, "warning");
		assert.equal(states.at(-1).text, "Confirmation needed");
		const n = states.length;
		coordinator.requestAutoSync(() => true);
		assert.equal(states.length, n);
		coordinator.syncEngine.sync = async () => ({ applied: 1, conflicts: 0 });
		await coordinator.runSync("Sync", "both", { isManual: true });
		assert.equal(states.at(-1).kind, "success");
	}));
test("minimumAutoSyncIntervalSeconds enforces minimum gap, while manual sync bypasses it", () =>
	fixture(async ({ coordinator, events, file, timers }) => {
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		events.get("modify")(file);
		// Cooldown is 10s default; edit immediately after sync should wait ~10s, not just 2s debounce
		const scheduledMs = [...timers.values()].map((t) => t.ms);
		assert.ok(
			scheduledMs.some((ms) => ms >= 8000 && ms <= 10000),
			`expected ~10s cooldown, got: ${scheduledMs.join(", ")}`,
		);

		// Manual sync bypasses the cooldown immediately
		const manualResult = await coordinator.runSync("Sync", "both", { isManual: true });
		assert.equal(manualResult.kind, "up-to-date");
	}));
test("repeated saves reset edit debounce when cooldown has expired", () =>
	fixture(async ({ coordinator, events, file, timers }) => {
		// Simulate last sync being long in the past (cooldown expired)
		coordinator.lastSyncStartAt = Date.now() - 30_000;
		coordinator.nextAutoSyncAllowedAt = 0;
		events.get("modify")(file);
		assert.ok([...timers.values()].some((t) => t.ms === 2000));
		timers.clear();
		events.get("modify")(file);
		assert.ok([...timers.values()].some((t) => t.ms === 2000));
	}));
test("failure backoff wins when longer than normal minimum gap", () =>
	fixture(async ({ coordinator, events, file, timers }) => {
		coordinator.syncEngine.sync = async () => {
			throw new Error("network connection failed");
		};
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		assert.ok(coordinator.retryAt !== null, "retryAt should be set after failure");
		events.get("modify")(file);
		const scheduledMs = [...timers.values()].map((t) => t.ms);
		assert.ok(
			scheduledMs.some((ms) => ms >= 25000),
			`expected backoff wait >= 25s, got: ${scheduledMs.join(", ")}`,
		);
	}));
test("successful syncs are timestampable without success-toast duplication", () =>
	fixture(async ({ coordinator, states, notices }) => {
		const result = await coordinator.runSync("Sync", "both", { isManual: true });
		assert.equal(result.kind, "up-to-date");
		assert.equal(states.at(-1).syncCompleted, true);
		assert.deepEqual(notices, []);

		coordinator.syncEngine.sync = async () => ({ applied: 1, conflicts: 1 });
		await coordinator.runSync("Sync", "both", { isManual: true });
		assert.equal(states.at(-1).syncCompleted, true);
		assert.equal(notices.length, 1, "conflicts remain actionable");
	}));
test("failed and skipped attempts do not mark a successful completion", () =>
	fixture(async ({ coordinator, states }) => {
		coordinator.syncEngine.sync = async () => {
			throw new Error("offline");
		};
		await coordinator.runSync("Sync", "both", { isManual: true });
		assert.equal(states.at(-1).kind, "error");
		assert.notEqual(states.at(-1).syncCompleted, true);

		coordinator.isSyncing = true;
		const stateCount = states.length;
		const result = await coordinator.runSync("Sync", "both", { isManual: true });
		assert.equal(result.kind, "skipped");
		assert.equal(states.length, stateCount);
	}));
test("activity logs record concise phase timing summary without sensitive information", () =>
	fixture(async ({ coordinator, activities }) => {
		coordinator.syncEngine.sync = async () => ({
			applied: 5,
			conflicts: 0,
			conflictCopies: [],
			timing: {
				totalMs: 1250,
				scanMs: 150,
				planMs: 25,
				transferMs: 1075,
				firstTransferMs: 220,
			},
		});
		await coordinator.runSync("Sync", "both", { isManual: true });
		const completionLog = activities.find((a) => a.startsWith("Sync complete:"));
		assert.ok(completionLog, "Found completion log");
		assert.match(completionLog, /5 applied/);
		assert.match(completionLog, /total 1\.3s/);
		assert.match(completionLog, /scan 150ms/);
		assert.match(completionLog, /plan 25ms/);
		assert.match(completionLog, /transfer 1075ms/);
		assert.match(completionLog, /first file in 220ms/);
	}));
