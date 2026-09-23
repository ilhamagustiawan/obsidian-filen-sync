import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

test("initial command requests verified two-way sync and preserves warning state", async () => {
	const dir = await mkdtemp(resolve("tmp/initial-command-"));
	try {
		const stub = join(dir, "obsidian.mjs");
		await writeFile(
			stub,
			`export class Plugin {constructor(app,manifest){this.app=app;this.manifest=manifest;this.commands=[];}register(){} registerEvent(){} addSettingTab(){} addStatusBarItem(){return null;} addRibbonIcon(){return {addClass(){},setAttr(){}};} addCommand(command){this.commands.push(command);}}
  export class Modal {} export class Notice {} export class PluginSettingTab {} export class Setting {} export class Menu {} export class TFile {} export class TFolder {}
  export const Platform={isMobile:true}; export const setIcon=()=>{}; export const setTooltip=()=>{}; export const normalizePath=p=>p; export const requestUrl=()=>{throw Error('No network');};`,
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
			{ workspace: { on: () => ({}), onLayoutReady: () => {} } },
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
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
