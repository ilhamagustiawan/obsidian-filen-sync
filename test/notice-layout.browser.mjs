// Standalone layout regression (requires Playwright with Chromium installed):
// node test/notice-layout.browser.mjs [absolute/path/to/playwright/index.mjs]
// Pass the optional module path when Playwright is installed outside this repo.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { chromium } = await import(process.argv[2] || "playwright");
const browser = await chromium.launch({ channel: "chromium" });
try {
	const page = await browser.newPage();
	const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
	for (const width of [320, 360, 390, 430, 768, 1280]) {
		await page.setViewportSize({ width, height: 800 });
		for (const compact of [false, true]) {
			// Obsidian's notice is a flex host. Mirror SyncNoticeController's DOM,
			// including a long terminal summary and an unbroken transfer filename.
			await page.setContent(`<style>
				body { margin: 16px; font: 14px sans-serif; }
				.notice { display: flex; }
				${css}
			</style><div class="${width < 768 ? "is-phone" : ""}">
				<div class="notice filen-sync-progress-notice ${compact ? "filen-notice-compact" : ""}">
					<div class="notice-content"><div class="filen-notice-container">
						<div class="filen-notice-header">
							<div class="filen-notice-icon-wrapper"><span class="filen-notice-icon">✓</span><span class="filen-notice-title">Filen Sync</span></div>
							<span class="filen-notice-badge">100%</span>
						</div>
						<div class="filen-notice-bar-track"><div class="filen-notice-bar-fill" style="width:100%"></div></div>
						<div class="filen-notice-details"><span class="filen-notice-count">Vault is up to date</span><span class="filen-notice-file"></span></div>
						<div class="filen-notice-summary">Last synced 04/10/2026, 13.27.06 · No changes</div>
					</div></div>
				</div>
			</div>`);
			for (const filename of ["", "very-long-unbroken-filename-".repeat(10) + ".md"]) {
				await page.locator(".filen-notice-file").evaluate((el, text) => {
					el.textContent = text;
				}, filename);
				await page.locator(".notice").evaluate((el, syncing) => {
					el.classList.toggle("is-syncing", syncing);
				}, Boolean(filename));
				assert.equal(
					await page.locator(".filen-notice-bar-track").isVisible(),
					Boolean(filename),
				);
				const summaryFits = await page
					.locator(".filen-notice-summary")
					.evaluate(
						(el) =>
							el.scrollWidth <= el.clientWidth &&
							el.scrollHeight <= el.clientHeight + 1,
					);
				assert.ok(summaryFits, "Last-sync history is fully readable");
				const overflow = await page.evaluate(() => {
					const notice = document.querySelector(".notice");
					const bounds = notice.getBoundingClientRect();
					return [...notice.querySelectorAll("*")]
						.filter((el) => {
							const rect = el.getBoundingClientRect();
							return (
								rect.width &&
								(rect.right > bounds.right + 1 || rect.left < bounds.left - 1)
							);
						})
						.map((el) => el.className);
				});
				assert.deepEqual(overflow, [], `Overflow at ${width}px, compact=${compact}`);
			}
		}
	}
	console.log("Notice layout: PASS (6 viewport widths, detailed/compact, summary/filename)");
} finally {
	await browser.close();
}
