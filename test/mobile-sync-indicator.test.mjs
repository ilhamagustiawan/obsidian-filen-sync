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
	appendChild(child) {
		this.insertBefore(child, null);
	}
	querySelector(selector) {
		return this.children.find((child) => `.${child.className}` === selector) ?? null;
	}
	setAttribute(key, value) {
		this.setAttr(key, value);
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

test("persistent mobile sidebar status shares the menu and survives remounts", async () => {
	const dir = await mkdtemp(join(tmpdir(), "filen-mobile-status-"));
	const originalWindow = globalThis.window,
		originalDocument = globalThis.document;
	try {
		const stub = join(dir, "obsidian.mjs");
		await writeFile(
			stub,
			`export class MarkdownView {} export const Platform = {isMobile:true}; export const setIcon = (el, icon) => el.setAttr('data-icon', icon);`,
		);
		const outfile = join(dir, "indicator.mjs");
		await build({
			entryPoints: ["src/ui/mobile-sync-indicator.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
			plugins: [
				{
					name: "obsidian",
					setup(b) {
						b.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
					},
				},
			],
		});
		const { MobileSyncIndicator } = await import(pathToFileURL(outfile).href);
		const events = new Map(),
			cleanups = [],
			timers = new Map();
		const delays = [];
		let enabled = true,
			menus = 0,
			next = 0;
		let sidebar = new Element();
		const note = new Element();
		const header = note.createEl("div", { cls: "view-header" });
		let activeView = { containerEl: note };
		const workspace = {
			rightSplit: { containerEl: sidebar },
			getActiveViewOfType() {
				return activeView;
			},
			on(name, fn) {
				events.set(name, fn);
				return name;
			},
		};
		const plugin = {
			app: { workspace },
			registerEvent() {},
			register(fn) {
				cleanups.push(fn);
			},
			registerDomEvent(el, name, fn) {
				el[name] = fn;
				cleanups.push(() => delete el[name]);
			},
		};
		globalThis.document = { createElement: (tag) => new Element(tag) };
		globalThis.window = {
			setTimeout(fn, ms) {
				delays.push(ms);
				const id = ++next;
				timers.set(id, fn);
				return id;
			},
			clearTimeout(id) {
				timers.delete(id);
			},
		};
		const indicator = new MobileSyncIndicator(
			plugin,
			() => enabled,
			() => assert.fail("all taps open menu"),
			() => menus++,
		);
		indicator.refreshVisibility();
		const button = sidebar.children[0];
		assert.ok(button);
		assert.equal(button.attributes.get("data-sync-state"), "pending");
		button.click({});
		assert.equal(menus, 1);
		indicator.onStatusChange({
			kind: "success",
			syncCompleted: true,
			text: "up to date",
			detail: "",
			updatedAt: 1,
		});
		assert.equal(button.attributes.get("data-sync-state"), "synced");
		assert.equal(button.children[0].attributes.get("data-icon"), "circle-check");
		assert.equal(button.children.length, 1, "mobile status is icon-only");
		assert.match(button.attributes.get("aria-label"), /Synced/);
		const line = note.children[0];
		assert.notEqual(line, header);
		assert.equal(note.children[1], header, "line sits above the note title header");
		assert.equal(line.attributes.get("data-sync-state"), "synced");
		assert.equal(line.click, undefined, "progress line is not clickable");
		assert.equal(timers.size, 1, "success hides after its completion timeout");
		assert.equal(delays.at(-1), 2000);
		for (const fn of [...timers.values()]) fn();
		timers.clear();
		assert.deepEqual(note.children, [header]);
		events.get("layout-change")();
		assert.deepEqual(note.children, [header], "layout changes do not resurrect success");
		indicator.onStatusChange({ kind: "syncing", text: "Syncing", detail: "", updatedAt: 1 });
		assert.equal(timers.size, 1);
		for (const fn of timers.values()) fn();
		timers.clear();
		assert.equal(button.attributes.get("data-sync-state"), "syncing");
		assert.equal(note.children[0], line);
		assert.equal(line.attributes.get("class:is-indeterminate"), true);
		indicator.onStatusChange({
			kind: "syncing",
			text: "Downloading",
			detail: "",
			updatedAt: 1,
			progress: { phase: "transferring", current: 4, total: 5 },
		});
		for (const fn of [...timers.values()]) fn();
		timers.clear();
		assert.equal(line.attributes.get("aria-valuenow"), "80");
		assert.equal(line.children[0].attributes.get("width"), "80%");
		assert.equal(line.attributes.get("class:is-indeterminate"), false);
		activeView = null;
		events.get("active-leaf-change")();
		assert.deepEqual(note.children, [header], "no line outside note views");
		activeView = { containerEl: note };
		events.get("active-leaf-change")();
		assert.equal(note.children[0], line);
		sidebar = new Element();
		workspace.rightSplit.containerEl = sidebar;
		events.get("layout-change")();
		assert.equal(sidebar.children[0], button, "same button remounts in rebuilt sidebar");
		indicator.onStatusChange({ kind: "error", text: "Error", detail: "", updatedAt: 1 });
		assert.equal(line.attributes.get("data-sync-state"), "error");
		assert.equal(timers.size, 0, "errors stay visible until resolved");
		indicator.onStatusChange({ kind: "warning", text: "Conflict", detail: "", updatedAt: 1 });
		assert.equal(line.attributes.get("data-sync-state"), "conflict");
		assert.equal(timers.size, 0, "conflicts stay visible until resolved");
		button.click({});
		assert.equal(menus, 2);
		enabled = false;
		indicator.refreshVisibility();
		assert.equal(sidebar.children.length, 0);
		assert.deepEqual(note.children, [header], "disabling removes the line too");
		enabled = true;
		indicator.refreshVisibility();
		assert.equal(sidebar.children.length, 1);
		for (const fn of cleanups) fn();
		assert.equal(sidebar.children.length, 0);
		assert.equal(timers.size, 0);
		assert.deepEqual(note.children, [header], "unload removes the progress line");
		events.get("layout-change")();
		assert.equal(sidebar.children.length, 0, "unloaded indicator never remounts");
	} finally {
		globalThis.window = originalWindow;
		globalThis.document = originalDocument;
		await rm(dir, { recursive: true, force: true });
	}
});
