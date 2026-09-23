import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

async function fixture(run) {
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
			"export class TFile {} export class TFolder {} export class Notice {} export const normalizePath=p=>p;",
		);
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
			syncPaused: false,
			syncIntervalMinutes: 3,
			syncStartupDelaySeconds: 0,
			ignorePatterns: [],
			skipLargeFiles: false,
			skipSizeLargerThanMB: 50,
		};
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
				onLogActivity: () => {},
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
		await run({ coordinator, events, states, file, timers });
	} finally {
		coordinator?.close();
		globalThis.window = oldWindow;
		globalThis.document = oldDocument;
		await rm(dir, { recursive: true, force: true });
	}
}
test("pending changes deduplicate, show immediately, and clear after success", () =>
	fixture(async ({ coordinator, events, states, file }) => {
		events.get("modify")(file);
		events.get("modify")(file);
		assert.equal(coordinator.pendingCount, 1);
		assert.equal(states.at(-1).kind, "pending");
		await coordinator.runSync("Sync", "both", { isManual: true });
		assert.equal(coordinator.pendingCount, 0);
		assert.equal(states.at(-1).kind, "success");
	}));
test("edit during sync stays queued and cannot announce success", () =>
	fixture(async ({ coordinator, events, states, file }) => {
		events.get("modify")(file);
		coordinator.syncEngine.sync = async () => {
			events.get("modify")(file);
			return { applied: 1, conflicts: 0 };
		};
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		assert.equal(coordinator.pendingCount, 1);
		assert.equal(states.at(-1).kind, "pending");
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
test("success adds no cooldown; later edit waits only for debounce", () =>
	fixture(async ({ coordinator, events, file, timers }) => {
		await coordinator.runSync("Auto-sync", "both", { silent: true, autoSync: true });
		events.get("modify")(file);
		assert.ok([...timers.values()].some((t) => t.ms === 2000));
		assert.ok([...timers.values()].every((t) => t.ms < 30000));
	}));
