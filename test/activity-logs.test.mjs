import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadActivityLogsModule() {
	await mkdir(resolve("tmp"), { recursive: true });
	const dir = await mkdtemp(resolve("tmp/activity-logs-"));
	try {
		const stub = join(dir, "obsidian.mjs");
		await writeFile(
			stub,
			`
			function createMockNode(tag, options = {}) {
				const node = {
					tag,
					options,
					text: options.text ?? "",
					children: [],
					attrs: options.attr ?? {},
					classes: new Set(),
					empty() { node.children = []; },
					setText(t) { node.text = t; },
					addClass(c) { node.classes.add(c); },
					setAttr(k, v) { node.attrs[k] = v; },
					addEventListener(evt, fn) { node.listeners = { ...(node.listeners ?? {}), [evt]: fn }; },
					createEl(childTag, childOpts = {}) {
						const child = createMockNode(childTag, childOpts);
						node.children.push(child);
						return child;
					},
					createDiv(childOpts = {}) {
						const child = createMockNode("div", childOpts);
						node.children.push(child);
						return child;
					},
					createSpan(childOpts = {}) {
						const child = createMockNode("span", childOpts);
						node.children.push(child);
						return child;
					},
				};
				return node;
			}
			export class Modal {
				constructor(app) {
					this.app = app;
					this.modalEl = createMockNode("div");
					this.contentEl = createMockNode("div");
				}
			}
			export class Notice {}
			`,
		);

		const outfile = join(dir, "activity-logs.mjs");
		await build({
			entryPoints: ["src/activity-logs.ts"],
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
		return await import(pathToFileURL(outfile).href);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("formatActivityLogTimestamp formats local time with seconds", async () => {
	const { formatActivityLogTimestamp } = await loadActivityLogsModule();
	const d = new Date(2026, 2, 24, 14, 5, 9); // March 24, 2026 14:05:09
	const formatted = formatActivityLogTimestamp(d.getTime());
	assert.equal(formatted, "2026-03-24 14:05:09");
});

test("inferActivityLogKind classifies message categories accurately", async () => {
	const { inferActivityLogKind } = await loadActivityLogsModule();
	assert.equal(inferActivityLogKind("Conflict detected note.md"), "conflict");
	assert.equal(inferActivityLogKind("Skipped note.md: ignored pattern"), "skipped");
	assert.equal(inferActivityLogKind("Need deletion confirmation"), "skipped");
	assert.equal(inferActivityLogKind("Not logged in to Filen"), "account");
	assert.equal(inferActivityLogKind("Network timeout occurred"), "network");
	assert.equal(inferActivityLogKind("Upload failed: 500 error"), "error");
	assert.equal(inferActivityLogKind("Uploaded note.md"), "general");
	assert.equal(inferActivityLogKind("Sync complete: up to date"), "general");
});

test("readActivityLogs parses legacy strings, raw objects, and enforces 500 entry limit", async () => {
	const { readActivityLogs, MAX_ACTIVITY_LOG_ENTRIES } = await loadActivityLogsModule();
	assert.equal(MAX_ACTIVITY_LOG_ENTRIES, 500);

	// Legacy string entry
	const fromStrings = readActivityLogs(["Uploaded note.md", "Conflict detected other.md"]);
	assert.equal(fromStrings.length, 2);
	assert.equal(fromStrings[0].message, "Uploaded note.md");
	assert.equal(fromStrings[0].kind, "general");
	assert.equal(fromStrings[1].kind, "conflict");

	// Legacy objects without kind
	const now = Date.now();
	const fromObjects = readActivityLogs([
		{ at: now - 1000, message: "Network disconnected from server" },
		{ at: now, message: "Downloaded file.md" },
		"not an object",
		null,
		{ at: "invalid", message: "skip" },
	]);
	assert.equal(fromObjects.length, 3);
	assert.equal(fromObjects[0].kind, "network");
	assert.equal(fromObjects[1].kind, "general");

	// Bounded persistence (500 max)
	const many = Array.from({ length: 600 }, (_, i) => ({
		at: now + i,
		message: `Log entry ${i}`,
		kind: "general",
	}));
	const trimmed = readActivityLogs(many);
	assert.equal(trimmed.length, 500);
	assert.equal(trimmed[0].message, "Log entry 100");
	assert.equal(trimmed[499].message, "Log entry 599");
});

test("filterActivityLogs filters by All, Activity, and Issues (with skipped as issue) and sorts newest-first", async () => {
	const { filterActivityLogs } = await loadActivityLogsModule();
	const entries = [
		{ at: 1000, message: "Uploaded a.md", kind: "general" },
		{ at: 3000, message: "Conflict detected b.md", kind: "conflict" },
		{ at: 2000, message: "Skipped large file c.bin", kind: "skipped" },
		{ at: 4000, message: "Sync failed: offline", kind: "error" },
		{ at: 2500, message: "Downloaded d.md", kind: "general" },
	];

	// All: returns all 5 sorted newest-first
	const all = filterActivityLogs(entries, "all");
	assert.equal(all.length, 5);
	assert.deepEqual(
		all.map((e) => e.at),
		[4000, 3000, 2500, 2000, 1000],
	);

	// Activity: only general events
	const activity = filterActivityLogs(entries, "activity");
	assert.equal(activity.length, 2);
	assert.deepEqual(
		activity.map((e) => e.message),
		["Downloaded d.md", "Uploaded a.md"],
	);

	// Issues: error, conflict, AND skipped are grouped under Issues
	const issues = filterActivityLogs(entries, "issues");
	assert.equal(issues.length, 3);
	assert.deepEqual(
		issues.map((e) => e.kind),
		["error", "conflict", "skipped"],
	);
});

test("filterActivityLogs supports case-insensitive search by message and timestamp", async () => {
	const { filterActivityLogs } = await loadActivityLogsModule();
	const baseTime = new Date(2026, 2, 24, 10, 0, 0).getTime();
	const entries = [
		{ at: baseTime, message: "Uploaded Recipe.MD", kind: "general" },
		{ at: baseTime + 60_000, message: "Downloaded Meeting-Notes.md", kind: "general" },
		{ at: baseTime + 120_000, message: "Conflict on Recipe.md", kind: "conflict" },
	];

	// Case-insensitive query "recipe"
	const recipeMatches = filterActivityLogs(entries, "all", "recipe");
	assert.equal(recipeMatches.length, 2);
	assert.equal(recipeMatches[0].message, "Conflict on Recipe.md");
	assert.equal(recipeMatches[1].message, "Uploaded Recipe.MD");

	// Search matching formatted timestamp (e.g. "10:01")
	const timeMatches = filterActivityLogs(entries, "all", "10:01");
	assert.equal(timeMatches.length, 1);
	assert.equal(timeMatches[0].message, "Downloaded Meeting-Notes.md");

	// Combined filter (issues only) + query
	const issueRecipe = filterActivityLogs(entries, "issues", "recipe");
	assert.equal(issueRecipe.length, 1);
	assert.equal(issueRecipe[0].kind, "conflict");
});

test("summarizeActivityLogs produces accurate status copy", async () => {
	const { summarizeActivityLogs } = await loadActivityLogsModule();
	assert.equal(summarizeActivityLogs(3, 10), "Showing 3 of 10");
	assert.equal(summarizeActivityLogs(0, 0), "Showing 0 of 0");
	assert.equal(summarizeActivityLogs(5, 5), "Showing 5 of 5");
});

test("ActivityLogModal renders without Copy logs button and clears immediately", async () => {
	const { ActivityLogModal } = await loadActivityLogsModule();
	let cleared = false;
	const host = {
		getActivityLogs: () => [{ at: Date.now(), message: "Uploaded test.md", kind: "general" }],
		clearActivityLogs: async () => {
			cleared = true;
		},
		onActivityLogsChanged: () => () => {},
	};

	const modal = new ActivityLogModal({}, host);
	modal.onOpen();

	// Verify no copy button exists
	const buttons = [];
	const findButtons = (node) => {
		if (!node) return;
		if (node.tag === "button") buttons.push(node);
		if (node.children) {
			for (const child of node.children) findButtons(child);
		}
	};
	findButtons(modal.contentEl);

	const buttonTexts = buttons.map((b) => b.text || b.options?.text);
	assert.ok(!buttonTexts.includes("Copy logs"), "Copy logs button must not be present");
	assert.ok(buttonTexts.includes("Clear logs"), "Clear logs button must be present");

	// Verify clicking Clear logs calls host.clearActivityLogs directly
	const clearBtn = buttons.find((b) => (b.text || b.options?.text) === "Clear logs");
	assert.ok(clearBtn?.listeners?.click, "Clear button has click handler");
	clearBtn.listeners.click();
	assert.equal(cleared, true, "Clear logs should immediately invoke host.clearActivityLogs()");
});
