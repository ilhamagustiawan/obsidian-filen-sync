import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

class Element {
	constructor(tag = "div") {
		this.tag = tag;
		this.children = [];
		this.attributes = new Map();
		this.parentElement = null;
		this.textContent = "";
		this.className = "";
		this.style = { setProperty: (key, value) => this.attributes.set(key, value) };
	}
	createEl(tag, options = {}) {
		const child = new Element(tag);
		child.className = options.cls ?? "";
		this.insertBefore(child, null);
		return child;
	}
	createSpan(options) {
		return this.createEl("span", options);
	}
	insertBefore(child, before) {
		child.remove();
		child.parentElement = this;
		const index = before ? this.children.indexOf(before) : this.children.length;
		this.children.splice(index, 0, child);
	}
	remove() {
		if (this.parentElement) {
			const siblings = this.parentElement.children;
			siblings.splice(siblings.indexOf(this), 1);
			this.parentElement = null;
		}
	}
	setAttr(key, value) {
		this.attributes.set(key, String(value));
	}
	removeAttribute(key) {
		this.attributes.delete(key);
	}
	setText(value) {
		this.textContent = value;
	}
	toggleClass(key, enabled) {
		this.attributes.set(`class:${key}`, enabled);
	}
}

test("mobile chip lifecycle, progress, routing, and cleanup", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "filen-mobile-chip-"));
	const originalWindow = globalThis.window;
	const originalDocument = globalThis.document;
	const originalNow = Date.now;
	try {
		const stub = join(dir, "obsidian.mjs");
		await writeFile(
			stub,
			`export class ItemView {} export class Plugin {}
			export const Platform = {isMobile:true};
			export const setIcon = (el, icon) => el.setAttr('data-icon', icon);`,
		);
		const outfile = join(dir, "chip.mjs");
		await build({
			stdin: {
				contents:
					'export {MobileSyncIndicator} from "./src/ui/mobile-sync-indicator.ts"; export {Platform} from "obsidian";',
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
		const { MobileSyncIndicator, Platform } = await import(pathToFileURL(outfile).href);
		const makeView = () => {
			const containerEl = new Element();
			const header = containerEl.createEl("header");
			const contentEl = containerEl.createEl("article");
			return { containerEl, contentEl, header };
		};
		const syncing = (manual = false, progress = undefined) => ({
			kind: "syncing",
			text: "Connecting…",
			detail: "Connecting to Filen",
			updatedAt: 1,
			isManual: manual,
			progress,
		});
		const success = {
			kind: "success",
			text: "up to date",
			detail: "No changes",
			updatedAt: 2,
			syncCompleted: true,
		};
		const fixture = () => {
			let now = 1000,
				next = 1,
				enabled = true,
				view = makeView(),
				details = 0,
				menu = 0;
			const timers = new Map(),
				events = new Map(),
				cleanup = [];
			Date.now = () => now;
			Platform.isMobile = true;
			globalThis.window = {
				setTimeout(fn, delay) {
					const id = next++;
					timers.set(id, { fn, at: now + delay });
					return id;
				},
				clearTimeout(id) {
					timers.delete(id);
				},
			};
			globalThis.document = { createElement: (tag) => new Element(tag) };
			const plugin = {
				app: {
					workspace: {
						on: (name, fn) => {
							events.set(name, fn);
							return name;
						},
						getActiveViewOfType: () => view,
					},
				},
				registerEvent: (name) => cleanup.push(() => events.delete(name)),
				register: (fn) => cleanup.push(fn),
				registerDomEvent: (el, name, fn) => {
					el[name] = fn;
					cleanup.push(() => delete el[name]);
				},
			};
			const chip = new MobileSyncIndicator(
				plugin,
				() => enabled,
				() => details++,
				() => menu++,
			);
			return {
				chip,
				timers,
				events,
				get view() {
					return view;
				},
				get row() {
					return view?.containerEl.children.find(
						(el) => el.className === "filen-mobile-sync-row",
					);
				},
				get label() {
					return this.row?.children[0].children[1].textContent;
				},
				get actions() {
					return { details, menu };
				},
				setEnabled(value) {
					enabled = value;
					chip.refreshVisibility();
				},
				switchView(value) {
					view = value;
					events.get("active-leaf-change")();
				},
				tick(ms) {
					const target = now + ms;
					for (;;) {
						const job = [...timers]
							.filter(([, job]) => job.at <= target)
							.sort((a, b) => a[1].at - b[1].at)[0];
						if (!job) break;
						timers.delete(job[0]);
						now = job[1].at;
						job[1].fn();
					}
					now = target;
				},
				close() {
					cleanup.forEach((fn) => fn());
				},
			};
		};

		await t.test("opening feedback is immediate, no-op result lasts two seconds", () => {
			const f = fixture();
			f.chip.onOpeningCheckChange({ kind: "scheduled", scheduledAt: 2000 });
			assert.equal(f.label, "Checking shortly…");
			assert.deepEqual(f.view.containerEl.children, [f.view.header, f.row, f.view.contentEl]);
			f.chip.onStatusChange(syncing());
			f.chip.onOpeningCheckChange({ kind: "cleared" });
			f.tick(100);
			assert.equal(f.label, "Connecting…");
			f.chip.onStatusChange(success);
			assert.equal(f.label, "Up to date");
			f.tick(1999);
			assert.ok(f.row);
			f.tick(1);
			assert.equal(f.row, undefined);
			f.close();
		});

		await t.test("routine quick checks stay quiet; slow runs show progress", () => {
			const f = fixture();
			f.chip.onStatusChange(syncing());
			f.tick(299);
			assert.equal(f.row, undefined);
			f.chip.onStatusChange(success);
			f.tick(1000);
			assert.equal(f.row, undefined);
			f.chip.onStatusChange(syncing());
			f.tick(300);
			assert.equal(f.label, "Connecting…");
			f.chip.onStatusChange(success);
			assert.equal(f.label, "Up to date");
			f.close();
		});

		await t.test(
			"manual progress uses bytes, limits rendering, and never implies early completion",
			() => {
				const f = fixture();
				f.chip.onStatusChange(syncing(true));
				assert.equal(f.label, "Connecting…");
				const progress = {
					phase: "transferring",
					current: 0,
					total: 2,
					path: "large.bin",
					completedBytes: 50,
					totalBytes: 100,
				};
				for (let i = 0; i < 20; i++) f.chip.onStatusChange(syncing(true, progress));
				assert.equal(f.timers.size, 1);
				f.tick(100);
				const bar = f.row.children[0].children[2];
				assert.equal(bar.attributes.get("aria-valuenow"), "50");
				assert.equal(f.label, "Syncing · 0 of 2 changes");
				f.chip.onStatusChange(syncing(true, { ...progress, completedBytes: 100 }));
				f.tick(100);
				assert.equal(f.label, "Finishing…");
				f.chip.onStatusChange({ ...success, kind: "idle", detail: "Edits queued" });
				assert.equal(f.label, "Changes queued");
				f.close();
			},
		);

		await t.test(
			"issues remain and dismiss without clearing underlying state; new runs reappear",
			() => {
				const f = fixture();
				const error = {
					kind: "error",
					text: "Sync failed",
					detail: "Network error",
					updatedAt: 1,
				};
				f.chip.onStatusChange(error);
				f.tick(10000);
				assert.equal(f.label, "Sync failed");
				f.row.children[0].click({});
				assert.deepEqual(f.actions, { menu: 1, details: 0 });
				f.row.children[2].click();
				assert.equal(f.row, undefined);
				f.chip.onStatusChange({ ...error, detail: "Retry in 10s" });
				assert.equal(f.row, undefined);
				f.chip.onStatusChange(syncing(true));
				assert.ok(f.row);
				f.row.children[0].click({});
				assert.equal(f.actions.details, 1);
				f.chip.onStatusChange(error);
				assert.ok(f.row);
				f.close();
			},
		);

		await t.test("one row follows views and retains state when no suitable view exists", () => {
			const f = fixture();
			f.switchView(null);
			f.chip.onStatusChange(syncing(true));
			const view = makeView();
			f.switchView(view);
			assert.equal(f.label, "Connecting…");
			const row = f.row;
			const second = makeView();
			f.switchView(second);
			assert.equal(f.row, row);
			assert.deepEqual(view.containerEl.children, [view.header, view.contentEl]);
			f.setEnabled(false);
			assert.equal(f.row, undefined);
			f.setEnabled(true);
			assert.equal(f.row, row);
			Platform.isMobile = false;
			f.chip.refreshVisibility();
			assert.equal(f.row, undefined);
			f.close();
			assert.equal(f.timers.size, 0);
			assert.equal(f.events.size, 0);
		});

		await t.test(
			"old completion timers cannot hide another run; closed chips never remount",
			() => {
				const f = fixture();
				f.chip.onStatusChange(syncing(true));
				f.chip.onStatusChange(success);
				f.tick(1500);
				f.chip.onStatusChange(syncing(true));
				f.tick(1000);
				assert.ok(f.row);
				f.close();
				assert.equal(f.row, undefined);
				f.chip.onStatusChange(syncing(true));
				f.tick(5000);
				assert.equal(f.row, undefined);
				assert.equal(f.timers.size, 0);
			},
		);
	} finally {
		globalThis.window = originalWindow;
		globalThis.document = originalDocument;
		Date.now = originalNow;
		await rm(dir, { recursive: true, force: true });
	}
});
