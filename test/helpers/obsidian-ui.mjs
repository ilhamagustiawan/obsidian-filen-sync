export class Element {
	constructor(tag = "div") {
		this.tag = tag;
		this.children = [];
		this.attrs = {};
		this.className = "";
		this.textContent = "";
		this.isConnected = true;
		this.ownerDocument = {
			defaultView: { innerWidth: 1024, addEventListener() {}, removeEventListener() {} },
		};
	}
	createEl(tag, options = {}) {
		const el = new Element(tag);
		el.className = options.cls ?? "";
		el.textContent = options.text ?? "";
		this.children.push(el);
		el.parentElement = this;
		return el;
	}
	createDiv(o) {
		return this.createEl("div", typeof o === "string" ? { cls: o } : o);
	}
	createSpan(o) {
		return this.createEl("span", o);
	}
	setText(t) {
		this.textContent = t;
	}
	empty() {
		for (const c of this.children) c.isConnected = false;
		this.children = [];
	}
	addClass(...c) {
		this.className += " " + c.join(" ");
	}
	removeClass() {}
	toggleClass() {}
	setAttr(k, v) {
		this.attrs[k] = v;
	}
	getAttr(k) {
		return this.attrs[k];
	}
	querySelectorAll(selector) {
		const cls = selector.slice(1);
		return this.children.flatMap((c) => [
			...(c.className.split(" ").includes(cls) ? [c] : []),
			...c.querySelectorAll(selector),
		]);
	}
	querySelector(s) {
		return this.querySelectorAll(s)[0] ?? null;
	}
	addEventListener(name, fn) {
		this[name] = fn;
	}
}
export class TFile {}
export class TFolder {}
export class Component {
	load() {
		globalThis.__renderLoads = (globalThis.__renderLoads ?? 0) + 1;
	}
	unload() {
		globalThis.__renderUnloads = (globalThis.__renderUnloads ?? 0) + 1;
	}
}
export const MarkdownRenderer = {
	async render(app, text, el) {
		globalThis.__markdown?.(text, el);
		el.setText(text);
	},
};
export class Modal {
	constructor(app) {
		this.app = app;
		this.modalEl = new Element();
		this.titleEl = new Element();
		this.contentEl = new Element();
	}
	open() {
		const result = this.onOpen?.();
		if (globalThis.__autoConfirm && this.constructor.name === "Confirmation")
			this.contentEl.children.at(-1).children.at(-1).onclick();
		return result;
	}
	close() {
		this.onClose?.();
	}
}
export class Notice {
	constructor(text) {
		globalThis.__notices?.push(text);
	}
}
export const Platform = { isMobile: false };
export const normalizePath = (p) => p;
export class Setting {}
export class PluginSettingTab {}
