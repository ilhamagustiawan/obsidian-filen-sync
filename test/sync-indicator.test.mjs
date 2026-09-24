import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
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
		assert.equal(presentation.shouldShowFloatingIndicator(false, true), false);
		assert.equal(presentation.shouldShowFloatingIndicator(true, true), true);
		assert.equal(presentation.shouldShowFloatingIndicator(true, false), false);
		assert.equal(presentation.shouldShowAutomaticProgressNotice(), false);
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
