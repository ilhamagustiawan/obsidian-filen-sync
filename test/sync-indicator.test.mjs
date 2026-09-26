import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let presentation;
test("sync presentation routes overlays only to enabled mobile fallback", async () => {
	const dir = await mkdtemp(resolve("tmp/sync-indicator-"));
	try {
		const outfile = join(dir, "sync-presentation.mjs");
		await build({
			entryPoints: ["src/ui/sync-presentation.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
		});
		presentation = await import(pathToFileURL(outfile).href);
		assert.equal(presentation.shouldShowMobileSyncIndicator(false, true), false);
		assert.equal(presentation.shouldShowMobileSyncIndicator(true, true), true);
		assert.equal(presentation.shouldShowMobileSyncIndicator(true, false), false);
		assert.equal(presentation.shouldShowAutomaticProgressNotice(false, true), false);
		assert.equal(presentation.shouldShowAutomaticProgressNotice(true, true), true);
		assert.equal(presentation.shouldShowAutomaticProgressNotice(true, false), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("sync presentation labels phases and only reports valid transfer totals", () => {
	assert.equal(
		presentation.formatSyncProgress({ phase: "scanning-local", current: 0, total: 0 }),
		"Scanning local files",
	);
	assert.equal(
		presentation.formatSyncProgress({ phase: "planning", current: 0, total: 0 }),
		"Comparing changes",
	);
	assert.equal(
		presentation.formatSyncProgress({ phase: "transferring", current: 4, total: 0 }),
		"Transferring changes",
	);
	assert.equal(
		presentation.formatSyncProgress({ phase: "transferring", current: 4, total: 8 }),
		"4 of 8 changes",
	);
	assert.equal(
		presentation.formatSyncProgress({ phase: "transferring", current: 9, total: 8 }),
		"8 of 8 changes",
	);
});

test("formatByteProgress and formatTransferDetails handle in-flight work truthfully", () => {
	assert.equal(presentation.formatBytes(500), "500 B");
	assert.equal(presentation.formatBytes(2048), "2.0 KB");
	assert.equal(presentation.formatBytes(5242880), "5.0 MB");
	assert.equal(presentation.formatFilename("folder/sub/note.md"), "…/note.md");
	assert.equal(presentation.formatFilename("root.md"), "root.md");

	const inFlight = presentation.formatTransferDetails({
		phase: "transferring",
		current: 0,
		total: 294,
		path: "notes/work.md",
		completedBytes: 40960,
		totalBytes: 204800,
	});
	assert.equal(inFlight.countText, "0 of 294 changes · 40.0 KB/200.0 KB");
	assert.equal(inFlight.fileText, "…/work.md");
});

test("last sync summary distinguishes never synced from a prior success", () => {
	assert.equal(
		presentation.formatLastSyncSummary(null, () => ""),
		"Not synced yet",
	);
	assert.equal(
		presentation.formatLastSyncSummary(123, (at) => `relative:${at}`),
		"Last synced relative:123",
	);
});

test("SyncNoticeController supports compact mobile mode with anti-flash delay and 10 Hz coalescing", async () => {
	const dir = await mkdtemp(resolve("tmp/sync-notice-test-"));
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	try {
		const stub = join(dir, "obsidian-stub.mjs");
		const outfile = join(dir, "sync-notice.mjs");

		await writeFile(
			stub,
			`
			export class Notice {
				constructor(frag, duration) {
					this.frag = frag;
					this.duration = duration;
					this.hidden = false;
					this.noticeEl = globalThis.__createMockElement("div", "notice");
					if (frag && frag.children) {
						this.noticeEl.children.push(...frag.children);
					}
					globalThis.__testActiveNotices.push(this);
				}
				hide() {
					this.hidden = true;
					this.noticeEl.isConnected = false;
				}
			}
			export const setIcon = (el, icon) => {
				if (el) el.setAttr("data-icon", icon);
			};
			`,
		);

		await build({
			entryPoints: ["src/ui/sync-notice.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
			plugins: [
				{
					name: "obsidian-test-stub",
					setup(build) {
						build.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
					},
				},
			],
		});

		class MockElement {
			constructor(tag, cls = "") {
				this.tag = tag;
				this.classList = new Set(cls.split(" ").filter(Boolean));
				this.children = [];
				this.attributes = new Map();
				this.textContent = "";
				this.style = {};
				this.isConnected = true;
			}
			addClass(...classes) {
				for (const c of classes) this.classList.add(c);
			}
			removeClass(...classes) {
				for (const c of classes) this.classList.delete(c);
			}
			hasClass(cls) {
				return this.classList.has(cls);
			}
			setText(t) {
				this.textContent = String(t);
			}
			setAttr(name, val) {
				this.attributes.set(name, String(val));
			}
			getAttr(name) {
				return this.attributes.get(name);
			}
			removeAttribute(name) {
				this.attributes.delete(name);
			}
			createDiv(opts = {}) {
				const el = new MockElement("div", opts.cls || "");
				if (opts.text) el.setText(opts.text);
				this.children.push(el);
				return el;
			}
			createSpan(opts = {}) {
				const el = new MockElement("span", opts.cls || "");
				if (opts.text) el.setText(opts.text);
				this.children.push(el);
				return el;
			}
			createEl(tag, opts = {}) {
				const el = new MockElement(tag, opts.cls || "");
				if (opts.text) el.setText(opts.text);
				this.children.push(el);
				return el;
			}
			addEventListener(evt, handler) {
				if (!this._listeners) this._listeners = new Map();
				this._listeners.set(evt, handler);
			}
			trigger(evt, eventData = {}) {
				const handler = this._listeners?.get(evt);
				if (handler) handler({ preventDefault() {}, stopPropagation() {}, ...eventData });
			}
			empty() {
				this.children = [];
				this.textContent = "";
			}
			remove() {
				this.isConnected = false;
			}
		}

		globalThis.__createMockElement = (tag, cls) => new MockElement(tag, cls);
		globalThis.__testActiveNotices = [];
		const activeTimers = new Map();
		let nextTimerId = 1;
		globalThis.setTimeout = (fn, ms) => {
			const id = nextTimerId++;
			activeTimers.set(id, { fn, ms });
			return id;
		};
		globalThis.clearTimeout = (id) => activeTimers.delete(id);
		globalThis.window = globalThis;
		globalThis.document = {
			createDocumentFragment: () => new MockElement("fragment"),
			body: new MockElement("body"),
		};

		const { SyncNoticeController } = await import(pathToFileURL(outfile).href);

		let mobileEnabled = false;
		let menuOpened = false;
		let logsOpened = false;
		const controller = new SyncNoticeController(
			() => {
				logsOpened = true;
			},
			() => "Last synced 1m ago",
			(e) => {
				menuOpened = true;
			},
			() => true, // isMobile = true
			() => mobileEnabled,
		);

		// When mobile sync indicator is disabled, automatic syncing shows no notice.
		controller.onStatusChange({
			kind: "syncing",
			text: "Syncing…",
			detail: "Scanning…",
			updatedAt: Date.now(),
			progress: { current: 0, total: 10, path: "a.md", phase: "transferring" },
		});
		assert.equal(globalThis.__testActiveNotices.length, 0);

		// Enable mobile sync indicator
		mobileEnabled = true;

		// 1. Anti-flash delay: initial syncing queues a 300 ms timer without immediately mounting a Notice
		controller.onStatusChange({
			kind: "syncing",
			text: "Syncing…",
			detail: "Scanning…",
			updatedAt: Date.now(),
			progress: {
				current: 0,
				total: 294,
				path: "file1.md",
				phase: "transferring",
				completedBytes: 1024,
				totalBytes: 8192,
			},
		});
		assert.equal(
			globalThis.__testActiveNotices.length,
			0,
			"No notice immediately due to anti-flash delay",
		);
		const antiFlashTimerEntry = [...activeTimers.entries()].find(([, t]) => t.ms === 300);
		assert.ok(antiFlashTimerEntry, "300ms anti-flash timer exists");

		// Fire 300ms timer
		activeTimers.delete(antiFlashTimerEntry[0]);
		antiFlashTimerEntry[1].fn();

		assert.equal(globalThis.__testActiveNotices.length, 1, "Notice mounted after 300ms");
		const notice = globalThis.__testActiveNotices[0];
		assert.ok(notice.noticeEl.hasClass("filen-notice-compact"), "Has compact class for mobile");
		assert.equal(notice.noticeEl.getAttr("role"), "button", "Accessible button role");

		// Click calls onOpenMenu
		notice.noticeEl.trigger("click");
		assert.equal(menuOpened, true, "Tapping compact notice opens menu");

		// 2. Truthful live work while file is in flight at 0/294
		const countEl = notice.noticeEl.children[0].children[2].children[0];
		assert.match(countEl.textContent, /0 of 294/);
		assert.match(countEl.textContent, /1\.0 KB\/8\.0 KB/);

		// 3. Coalescing to 10 Hz (100 ms)
		// Send 10 rapid progress updates
		const renderCountBefore = notice.noticeEl.children[0].children[2].children[0].textContent;
		for (let i = 1; i <= 5; i++) {
			controller.onStatusChange({
				kind: "syncing",
				text: "Syncing…",
				detail: `Transferring ${i}...`,
				updatedAt: Date.now(),
				progress: {
					current: 0,
					total: 294,
					path: `file${i}.md`,
					phase: "transferring",
					completedBytes: i * 1024,
					totalBytes: 8192,
				},
			});
		}
		// A 100ms coalesce timer must be active
		const coalesceEntry = [...activeTimers.entries()].find(([, t]) => t.ms <= 100);
		assert.ok(coalesceEntry, "100ms coalesce timer active");

		// Terminal state flushes immediately, canceling any pending coalesce timer
		controller.onStatusChange({
			kind: "success",
			text: "Sync complete",
			detail: "294 files synced",
			updatedAt: Date.now(),
		});
		assert.ok(notice.noticeEl.hasClass("is-success"), "Terminal state rendered immediately");

		// On-demand expansion to detailed mode
		controller.showOnDemand({
			kind: "syncing",
			text: "Syncing…",
			detail: "Scanning…",
			updatedAt: Date.now(),
			progress: { current: 5, total: 10, path: "test.md", phase: "transferring" },
		});
		assert.ok(
			!globalThis.__testActiveNotices.at(-1).noticeEl.hasClass("filen-notice-compact"),
			"Detailed mode does not have compact class",
		);

		// Scanning phase: title is "Filen Sync", count shows phase label, file is empty (no duplicate text)
		controller.showOnDemand({
			kind: "syncing",
			text: "Checking local files…",
			detail: "Checking local files…",
			updatedAt: Date.now(),
			progress: { current: 0, total: 0, path: "", phase: "scanning-local" },
		});
		const scanNotice = globalThis.__testActiveNotices.at(-1);
		const scanTitle = scanNotice.noticeEl.children[0].children[0].children[0].children[1];
		const scanBadge = scanNotice.noticeEl.children[0].children[0].children[1];
		const scanCount = scanNotice.noticeEl.children[0].children[2].children[0];
		const scanFile = scanNotice.noticeEl.children[0].children[2].children[1];
		assert.equal(scanTitle.textContent, "Filen Sync");
		assert.equal(scanBadge.textContent, "Syncing");
		assert.equal(scanCount.textContent, "Scanning local files · Last synced 1m ago");
		assert.equal(scanFile.textContent, "");

		controller.closeNotice();
		assert.equal(globalThis.__testActiveNotices.at(-1).hidden, true);
	} finally {
		delete globalThis.__createMockElement;
		delete globalThis.__testActiveNotices;
		delete globalThis.document;
		delete globalThis.window;
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
		await rm(dir, { recursive: true, force: true });
	}
});
