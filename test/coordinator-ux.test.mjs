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
			"export class TFile {} export class TFolder {} export const Platform = { isMobile: false }; export class Notice { constructor(message) { (globalThis.__coordinatorNotices ??= []).push(message); } } export const normalizePath=p=>p;",
		);
		globalThis.__coordinatorNotices = [];
		const outfile = join(dir, "coordinator.mjs");
		await build({
			stdin: {
				contents:
					'export {SyncCoordinator} from "./src/sync/coordinator.ts";export {TFile, Platform} from "obsidian";',
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
		const { SyncCoordinator, TFile, Platform } = await import(pathToFileURL(outfile).href);
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
		const vaultFiles = [];
		coordinator = new SyncCoordinator(
			{
				vault: {
					configDir: ".obsidian",
					getFiles: () => vaultFiles,
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
			Platform,
			vaultFiles,
			TFile,
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

test("bounded replan recovery retries up to 3 times with non-terminal status then holds until manual sync", () =>
	fixture(async ({ coordinator, events, states, file, notices, activities }) => {
		coordinator.syncEngine.sync = async () => {
			throw new Error("Remote file changed before upload: note.md. Replan the sync.");
		};

		// Attempt 1: Replan error on auto-sync -> retry 1/3 scheduled with non-terminal pending status
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		assert.equal(coordinator.isReplanHeld, false);
		assert.equal(states.at(-1).kind, "pending");
		assert.match(states.at(-1).detail, /1\/3/);
		assert.equal(notices.length, 0, "No error notice on scheduled replan retry");

		// Attempt 2: retry 2/3
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		assert.equal(coordinator.isReplanHeld, false);
		assert.equal(states.at(-1).kind, "pending");
		assert.match(states.at(-1).detail, /2\/3/);
		assert.equal(notices.length, 0);

		// Attempt 3: retry 3/3
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		assert.equal(coordinator.isReplanHeld, false);
		assert.equal(states.at(-1).kind, "pending");
		assert.match(states.at(-1).detail, /3\/3/);

		// Attempt 4: Exhaustion -> held!
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		assert.equal(coordinator.isReplanHeld, true);
		assert.equal(states.at(-1).kind, "error");
		assert.equal(states.at(-1).text, "Sync needs review — select Sync now");
		assert.ok(
			activities.some((a) => a.includes("Sync held: concurrent changes detected repeatedly")),
			"Hold logged to activity log",
		);

		// Modifying file queues changes but does not clear hold or publish idle
		events.get("modify")(file);
		assert.equal(coordinator.pendingCount, 1);
		assert.equal(states.at(-1).kind, "error");
		assert.equal(states.at(-1).text, "Sync needs review — select Sync now");

		// Auto sync triggers while held are ignored
		const stateCountBefore = states.length;
		coordinator.requestAutoSync(() => true);
		assert.equal(states.length, stateCountBefore, "Auto-sync request ignored while held");

		// Failed manual sync does NOT clear the hold
		await coordinator.runSync("Sync now", "both", { isManual: true });
		assert.equal(coordinator.isReplanHeld, true, "Failed manual sync does not lift hold");
		assert.equal(states.at(-1).kind, "error");
		assert.equal(states.at(-1).text, "Sync needs review — select Sync now");

		// Successful manual sync clears the hold
		coordinator.syncEngine.sync = async () => ({ applied: 1, conflicts: 0 });
		const manualSuccess = await coordinator.runSync("Sync now", "both", { isManual: true });
		assert.equal(manualSuccess.kind, "applied");
		assert.equal(coordinator.isReplanHeld, false, "Successful manual sync lifts hold");
		assert.equal(coordinator.pendingCount, 0, "Pending changes cleared on success");
		assert.equal(states.at(-1).kind, "success");
	}));

test("routine auto-sync failure toast is suppressed on mobile while manual failure toast is preserved", () =>
	fixture(async ({ coordinator, notices, Platform }) => {
		coordinator.syncEngine.sync = async () => {
			throw new Error("network connection failed");
		};

		// 1. Desktop: routine auto-sync shows throttled notice
		Platform.isMobile = false;
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		assert.equal(notices.length, 1);
		assert.match(notices[0], /Filen auto-sync failed/);

		// 2. Mobile: routine auto-sync suppresses notice toast
		notices.length = 0;
		Platform.isMobile = true;
		coordinator.lastErrorNoticeTime.clear();
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		assert.equal(notices.length, 0, "Routine auto-sync failure toast suppressed on mobile");

		// 3. Mobile: manual sync failure still shows notice toast
		coordinator.resetOffline();
		await coordinator.runSync("Sync now", "both", { isManual: true, silent: false });
		assert.equal(notices.length, 1, "Manual sync failure toast preserved on mobile");
		assert.match(notices[0], /Sync now failed/);

		Platform.isMobile = false;
	}));

test("conflicts in vault produce persistent warning, informative notice, and clear upon resolution", () =>
	fixture(async ({ coordinator, events, states, notices, activities, vaultFiles, TFile }) => {
		// 1. Conflict generated during sync
		coordinator.syncEngine.sync = async () => ({
			applied: 1,
			conflicts: 1,
			conflictCopies: [
				{
					originalPath: "Daily/2026/09/2026-09-26.md",
					copyPath:
						"Daily/2026/09/2026-09-26.sync-conflict-remote-2dc80003-d5b9-47d3-8a26-78e15a005f73-1790437810707.md",
				},
			],
		});

		// Add conflict copy to mock vault files
		const conflictFile = Object.assign(new TFile(), {
			path: "Daily/2026/09/2026-09-26.sync-conflict-remote-2dc80003-d5b9-47d3-8a26-78e15a005f73-1790437810707.md",
			name: "2026-09-26.sync-conflict-remote-2dc80003-d5b9-47d3-8a26-78e15a005f73-1790437810707.md",
			stat: { size: 100 },
		});
		vaultFiles.push(conflictFile);

		await coordinator.runSync("Auto-sync", "both", { isManual: false });

		assert.equal(coordinator.conflictCount, 1);
		assert.equal(states.at(-1).kind, "warning");
		assert.match(states.at(-1).text, /1 conflict\(s\) to review/);

		// Notice specifies conflicted file and informs about review in sync menu
		assert.equal(notices.length, 1);
		assert.match(notices[0], /Daily\/2026\/09\/2026-09-26\.md/);
		assert.match(notices[0], /Review in sync menu/);

		// Activity log records conflict detected, not misleading "resolved"
		assert.ok(
			activities.some((a) => a.includes("Conflict detected: Daily/2026/09/2026-09-26.md")),
			"Activity log records conflict detected",
		);

		// 2. Next auto-sync succeeds with 0 conflicts (e.g. uploaded conflict file)
		// Crucial: status must NOT revert to "up to date" while conflict copy is still in vault!
		coordinator.syncEngine.sync = async () => ({ applied: 1, conflicts: 0 });
		await coordinator.runSync("Auto-sync", "both", { isManual: false });

		assert.equal(states.at(-1).kind, "warning", "Warning persists despite 0-conflict sync");
		assert.match(states.at(-1).text, /1 conflict\(s\) to review/);

		// 3. Modifying another file triggers publishPending -> still keeps warning
		events.get("modify")({ path: "other.md" });
		assert.equal(states.at(-1).kind, "warning", "publishPending keeps conflict warning");

		// 4. Deleting the conflict file clears the warning back to idle
		vaultFiles.length = 0;
		events.get("delete")(conflictFile);
		assert.equal(coordinator.conflictCount, 0);
		assert.equal(states.at(-1).kind, "idle");
		assert.equal(states.at(-1).text, "Ready");

		// 5. Subsequent sync without conflicts reaches success
		coordinator.syncEngine.sync = async () => ({ applied: 1, conflicts: 0 });
		await coordinator.runSync("Auto-sync", "both", { isManual: false });
		assert.equal(states.at(-1).kind, "success");
		assert.equal(states.at(-1).text, "1 applied");
	}));
