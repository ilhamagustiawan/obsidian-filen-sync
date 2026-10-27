import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

test("initial command requests verified two-way sync and preserves warning state", async () => {
	await mkdir(resolve("tmp"), { recursive: true });
	const dir = await mkdtemp(resolve("tmp/initial-command-"));
	try {
		const stub = join(dir, "obsidian.mjs");
		await writeFile(
			stub,
			`export class Plugin {constructor(app,manifest){this.app=app;this.manifest=manifest;this.commands=[];}register(){} registerEvent(){} addSettingTab(){} addStatusBarItem(){return null;} addRibbonIcon(){return {addClass(){},setAttr(){}};} addCommand(command){this.commands.push(command);}}
  export class Component {load(){} unload(){}} export const MarkdownRenderer={render:async()=>{}}; export class ItemView {} export class Modal {} export class Notice {} export class PluginSettingTab {} export class Setting {} export class Menu {constructor(){this.items=[];} addItem(fn){const item={setTitle(v){this.title=v;return this;},setIcon(){return this;},setDisabled(v){this.disabled=v;return this;},onClick(fn){this.action=fn;return this;},setSubmenu(){return this.submenu=new Menu();}};fn(item);this.items.push(item);return this;}addSeparator(){}} export class TFile {} export class TFolder {}
  export class MarkdownView {} export const Platform={isMobile:true}; export const setIcon=()=>{}; export const setTooltip=()=>{}; export const normalizePath=p=>p; export const requestUrl=()=>{throw Error('No network');};`,
		);
		const sdk = join(dir, "sdk.mjs");
		await writeFile(sdk, "export class FilenSDK {}");
		const outfile = join(dir, "plugin.mjs");
		await build({
			stdin: {
				contents:
					'export {default as Plugin} from "./src/main.ts"; export {DEFAULT_SETTINGS} from "./src/settings.ts";',
				resolveDir: process.cwd(),
			},
			outfile,
			bundle: true,
			platform: "node",
			format: "esm",
			plugins: [
				{
					name: "stubs",
					setup(b) {
						b.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
						b.onResolve({ filter: /^@filen\/sdk$/ }, () => ({ path: sdk }));
					},
				},
			],
		});
		const { Plugin, DEFAULT_SETTINGS } = await import(pathToFileURL(outfile).href);
		const plugin = new Plugin(
			{
				vault: { getFiles: () => [] },
				workspace: {
					on: () => ({}),
					onLayoutReady: () => {},
					getActiveViewOfType: () => null,
				},
			},
			{ id: "filen-sync" },
		);
		plugin.hasSavedAuth = () => false;
		plugin.loadSettings = async () => {
			plugin.settings = { ...DEFAULT_SETTINGS };
		};
		await plugin.onload();
		const command = plugin.commands.find((c) => c.id === "initial-sync");
		assert.equal(command.name, "Initial sync");
		const calls = [];
		let cleared = false;
		plugin.coordinator.runSync = async (...args) => {
			calls.push(args);
			plugin.statusBarState = {
				kind: "warning",
				text: "Conflict to review",
				detail: "Copy saved",
				updatedAt: 1,
			};
			return { kind: "applied", applied: 1, conflicts: 1 };
		};
		plugin.clearReconciliationNeeded = async () => {
			cleared = true;
		};
		command.callback();
		await new Promise((r) => setImmediate(r));
		assert.deepEqual(calls, [["Initial sync", "both", { isManual: true, initialSync: true }]]);
		assert.equal(cleared, true);
		assert.equal(plugin.statusBarState.kind, "warning");
		cleared = false;
		plugin.coordinator.runSync = async () => ({ kind: "failed", message: "Unavailable" });
		await plugin.initialSync();
		assert.equal(cleared, false);
		plugin.app.vault = { getFiles: () => [] };
		plugin.app.workspace.getActiveFile = () => null;
		const menu = plugin.statusBar.buildMenu();
		assert.equal(menu.items[0].title, "Not connected");
		assert.equal(menu.items[0].disabled, true);
		assert.equal(menu.items[1].title, "Not synced yet");
		assert.equal(menu.items[1].disabled, true);
		assert.deepEqual(
			menu.items.slice(2, 7).map((item) => item.title),
			["Pause", "Version history", "Open Sync log", "Deleted files", "Sync settings"],
		);
		assert.equal(menu.items.find((item) => item.title === "Version history").disabled, true);
		assert.ok(
			menu.items
				.find((item) => item.title === "Advanced")
				.submenu.items.some((item) => item.title === "Push local files"),
		);
		const originalDocument = globalThis.document,
			originalWindow = globalThis.window;
		try {
			const timers = new Map();
			let next = 0,
				reviews = 0,
				otherModal = null;
			globalThis.document = { visibilityState: "hidden", querySelector: () => otherModal };
			globalThis.window = {
				setTimeout(fn) {
					const id = ++next;
					timers.set(id, fn);
					return id;
				},
				clearTimeout(id) {
					timers.delete(id);
				},
			};
			plugin.openConflictResolver = async () => reviews++;
			const fire = () => {
				const [id, fn] = [...timers][0];
				timers.delete(id);
				fn();
			};
			plugin.scheduleConflictReview();
			plugin.scheduleConflictReview();
			assert.equal(timers.size, 1);
			fire();
			assert.equal(reviews, 0);
			assert.equal(timers.size, 1);
			globalThis.document.visibilityState = "visible";
			otherModal = {};
			fire();
			assert.equal(reviews, 0);
			otherModal = null;
			fire();
			assert.equal(reviews, 1);
			assert.equal(timers.size, 0);
			assert.equal(plugin.reviewPending, false);
		} finally {
			globalThis.document = originalDocument;
			globalThis.window = originalWindow;
		}
		// Settings needs an explicit result; connection errors are otherwise handled
		// by notices rather than propagated to the login UI.
		plugin.setStatus = () => {};
		plugin.logActivity = () => {};
		plugin.getOrCreateRemoteFs = () => ({ checkConnect: async () => {} });
		assert.equal(await plugin.testConnection(), true);
		plugin.getOrCreateRemoteFs = () => ({
			checkConnect: async () => {
				throw new Error("Offline");
			},
		});
		assert.equal(await plugin.testConnection(), false);

		// Auto-sync stays quiet while a force upload owns the target.
		plugin.hasSavedAuth = () => true;
		assert.equal(plugin.canAutoSync(), true);
		plugin.forceSyncInProgress = true;
		assert.equal(plugin.canAutoSync(), false);
		plugin.forceSyncInProgress = false;

		// Offline force upload stops before touching the sync target.
		let prepared = 0;
		plugin.prepareSyncTarget = async () => {
			prepared++;
		};
		const file = { path: "a.md", name: "a.md", stat: { mtime: 5, ctime: 1, size: 3 } };
		plugin.isOffline = () => true;
		await plugin.forceSyncFile(file);
		assert.equal(prepared, 0);
		assert.equal(plugin.forceSyncInProgress, false);

		// Online force upload reads local content once and records the baseline.
		plugin.isOffline = () => false;
		let reads = 0;
		const records = [];
		plugin.app.vault.readBinary = async () => {
			reads++;
			return new Uint8Array([1, 2, 3]).buffer;
		};
		plugin.db = {
			getConflict: async () => undefined,
			getFile: async () => undefined,
			setFile: async (_path, record) => records.push(record),
		};
		plugin.getOrCreateRemoteFs = () => ({
			stat: async () => null,
			writeFile: async () => ({ uuid: "remote-1" }),
		});
		plugin.saveSettings = async () => {};
		await plugin.forceSyncFile(file);
		assert.equal(prepared, 1);
		assert.equal(reads, 1);
		assert.equal(records.length, 1);
		assert.equal(records[0].remoteUuid, "remote-1");
		assert.equal(records[0].size, 3);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
