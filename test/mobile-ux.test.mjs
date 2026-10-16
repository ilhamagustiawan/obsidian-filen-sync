import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Element } from "./helpers/obsidian-ui.mjs";

const dir = await mkdtemp(resolve("tmp/mobile-ux-"));
const stub = join(dir, "obsidian.mjs");
await writeFile(
	stub,
	`
export { Modal, Platform } from ${JSON.stringify(resolve("test/helpers/obsidian-ui.mjs"))};
export class Setting {
	constructor(section) { this.el = section.createDiv(); }
	setName(name) { this.name = name; return this; }
	setDesc() { return this; }
	addText(fn) {
		const inputEl = this.el.createEl('input');
		inputEl.setAttribute = inputEl.setAttr;
		const text = {inputEl, setPlaceholder(v){inputEl.placeholder=v;return this;}, setValue(v){inputEl.value=v;return this;}, onChange(fn){inputEl.change=fn;return this;}};
		fn(text); return this;
	}
	addButton(fn) {
		const buttonEl = this.el.createEl('button');
		buttonEl.setAttribute = buttonEl.setAttr;
		const button = {buttonEl, setButtonText(v){buttonEl.textContent=v;return this;}, setCta(){return this;}, setDisabled(v){buttonEl.disabled=v;return this;}, onClick(fn){buttonEl.click=fn;return this;}};
		fn(button); return this;
	}
}
`,
);
const outfile = join(dir, "mobile.mjs");
await build({
	stdin: {
		contents: `export * from './src/ui/account-login.ts'; export * from './src/ui/mobile-dialog.ts'; export * from './src/ui/visible-viewport.ts'; export * from './src/ui/sync-presentation.ts'; export {Platform} from 'obsidian';`,
		resolveDir: process.cwd(),
	},
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
const m = await import(pathToFileURL(outfile).href);
test.after(() => rm(dir, { recursive: true, force: true }));

function viewportFixture(withVisualViewport = true) {
	const win = new EventTarget();
	Object.assign(win, { innerHeight: 800, innerWidth: 390 });
	if (withVisualViewport) {
		win.visualViewport = Object.assign(new EventTarget(), {
			height: 800,
			width: 390,
			offsetTop: 0,
			offsetLeft: 0,
		});
	}
	const properties = new Map();
	const el = {
		ownerDocument: { defaultView: win },
		style: {
			setProperty: (k, v) => properties.set(k, v),
			removeProperty: (k) => properties.delete(k),
		},
	};
	return { win, el, properties };
}

test("keyboard viewport resize and pan update dialog bounds and release listeners", () => {
	const { win, el, properties } = viewportFixture();
	const cleanup = m.trackVisibleViewport(el);
	assert.equal(properties.get("--filen-viewport-height"), "800px");
	Object.assign(win.visualViewport, { height: 340, offsetTop: 24 });
	win.visualViewport.dispatchEvent(new Event("resize"));
	assert.equal(properties.get("--filen-viewport-height"), "340px");
	assert.equal(properties.get("--filen-viewport-top"), "24px");
	win.visualViewport.offsetTop = 48;
	win.visualViewport.dispatchEvent(new Event("scroll"));
	assert.equal(properties.get("--filen-viewport-top"), "48px");
	cleanup();
	win.visualViewport.dispatchEvent(new Event("resize"));
	win.visualViewport.dispatchEvent(new Event("scroll"));
	win.dispatchEvent(new Event("resize"));
	assert.equal(properties.size, 0, "closed dialogs no longer receive viewport updates");
});

test("viewport tracking falls back to window dimensions", () => {
	const { win, el, properties } = viewportFixture(false);
	const cleanup = m.trackVisibleViewport(el);
	win.innerHeight = 300;
	win.dispatchEvent(new Event("resize"));
	assert.equal(properties.get("--filen-viewport-height"), "300px");
	assert.equal(properties.get("--filen-viewport-top"), "0px");
	cleanup();
});

test("mobile dialogs clean up on close and bind again on reopen; desktop stays untouched", () => {
	const { el, properties } = viewportFixture();
	const dialog = new m.MobileDialog({});
	Object.assign(dialog.modalEl, el);
	m.Platform.isMobile = true;
	try {
		dialog.open();
		assert.equal(properties.size, 4);
		dialog.close();
		assert.equal(properties.size, 0);
		dialog.open();
		assert.equal(properties.size, 4);
		dialog.close();
		m.Platform.isMobile = false;
		dialog.open();
		assert.equal(properties.size, 0);
		dialog.close();
	} finally {
		m.Platform.isMobile = false;
	}
});

function loginFixture(connect) {
	const section = new Element();
	section.setAttribute = section.setAttr;
	// The small shared DOM mock doesn't implement native setAttribute on children.
	const createEl = Element.prototype.createEl;
	section.createEl = function (tag, options) {
		const child = createEl.call(this, tag, options);
		child.setAttribute = child.setAttr;
		return child;
	};
	let connected = 0;
	const plugin = {
		settings: { email: "user@example.com" },
		hasSessionPassword: () => false,
		saveSettings: async () => {},
		refreshSyncTarget: async () => {},
		setSessionPassword(value) {
			this.password = value;
		},
		setSessionTwoFactorCode(value) {
			this.code = value;
		},
		testConnection: connect,
	};
	m.renderAccountLogin(section, plugin, () => connected++);
	const inputs = section.children.flatMap((c) => c.children).filter((c) => c.tag === "input");
	const buttons = section.children.flatMap((c) => c.children).filter((c) => c.tag === "button");
	return { section, plugin, inputs, buttons, connected: () => connected };
}

test("login inputs support email, password-manager and OTP keyboards without persisting secrets", () => {
	const {
		inputs: [email, password, code],
		buttons: [show],
		plugin,
	} = loginFixture(async () => true);
	assert.equal(email.type, "email");
	assert.equal(email.inputMode, "email");
	assert.equal(email.autocomplete, "username");
	assert.equal(email.attrs.autocapitalize, "none");
	assert.equal(password.type, "password");
	assert.equal(password.autocomplete, "current-password");
	assert.equal(code.type, "text", "leading zeros in codes must be retained");
	assert.equal(code.inputMode, "numeric");
	assert.equal(code.autocomplete, "one-time-code");
	code.change(" 012345 ");
	password.change("secret");
	assert.equal(plugin.code, "012345");
	assert.equal(plugin.password, "secret");
	assert.deepEqual(plugin.settings, { email: "user@example.com" });
	show.click();
	assert.equal(password.type, "text");
	assert.equal(show.attrs["aria-pressed"], "true");
	show.click();
	assert.equal(password.type, "password");
	assert.equal(show.textContent, "Show password");
});

test("login shows busy and inline failure states, prevents duplicate requests, and supports retry", async () => {
	let finish,
		calls = 0;
	const fixture = loginFixture(() => {
		calls++;
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	const login = fixture.buttons[1];
	const pending = login.click();
	assert.equal(login.disabled, true);
	assert.equal(login.textContent, "Connecting…");
	await login.click();
	assert.equal(calls, 1);
	finish(false);
	await pending;
	assert.equal(login.disabled, false);
	assert.match(fixture.section.children.at(-1).textContent, /Could not connect/);
	assert.equal(fixture.connected(), 0);
	const retry = login.click();
	finish(true);
	await retry;
	assert.equal(fixture.connected(), 1);
});

test("closed settings do not reopen themselves when a pending login completes", async () => {
	let finish;
	const fixture = loginFixture(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const pending = fixture.buttons[1].click();
	fixture.section.children.at(-1).isConnected = false;
	finish(true);
	await pending;
	assert.equal(fixture.connected(), 0);
});

test("status labels distinguish connectivity, pause, pending work and checks", () => {
	assert.equal(m.syncIconPresentation(null, { offline: true }).label, "Offline");
	assert.equal(m.syncIconPresentation(null, { connected: false }).label, "Not connected");
	assert.equal(m.syncIconPresentation(null, { paused: true }).label, "Auto-sync paused");
	assert.equal(m.syncIconPresentation(null, { pending: 1 }).label, "1 pending change");
	assert.equal(m.syncIconPresentation(null, { pending: 3 }).label, "3 pending changes");
	assert.equal(m.syncIconPresentation({ kind: "pending" }).label, "Checking changes");
	assert.equal(m.syncIconPresentation(null).label, "Ready to sync");
});
