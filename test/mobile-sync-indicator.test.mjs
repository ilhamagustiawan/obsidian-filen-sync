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
			`export const Platform = {isMobile:true}; export const setIcon = (el, icon) => el.setAttr('data-icon', icon);`,
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
		let enabled = true,
			menus = 0,
			next = 0;
		let sidebar = new Element();
		const workspace = {
			rightSplit: { containerEl: sidebar },
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
			setTimeout(fn) {
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
		assert.equal(timers.size, 0, "completion remains visible");
		indicator.onStatusChange({ kind: "syncing", text: "Syncing", detail: "", updatedAt: 1 });
		assert.equal(timers.size, 1);
		for (const fn of timers.values()) fn();
		timers.clear();
		assert.equal(button.attributes.get("data-sync-state"), "syncing");
		sidebar = new Element();
		workspace.rightSplit.containerEl = sidebar;
		events.get("layout-change")();
		assert.equal(sidebar.children[0], button, "same button remounts in rebuilt sidebar");
		indicator.onStatusChange({ kind: "error", text: "Error", detail: "", updatedAt: 1 });
		button.click({});
		assert.equal(menus, 2);
		enabled = false;
		indicator.refreshVisibility();
		assert.equal(sidebar.children.length, 0);
		enabled = true;
		indicator.refreshVisibility();
		assert.equal(sidebar.children.length, 1);
		for (const fn of cleanups) fn();
		assert.equal(sidebar.children.length, 0);
		assert.equal(timers.size, 0);
		events.get("layout-change")();
		assert.equal(sidebar.children.length, 0, "unloaded indicator never remounts");
	} finally {
		globalThis.window = originalWindow;
		globalThis.document = originalDocument;
		await rm(dir, { recursive: true, force: true });
	}
});
