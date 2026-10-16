// Standalone browser regression. Like notice-layout.browser.mjs, accepts an
// external Playwright module path; set FILEN_BROWSER_CHANNEL=chrome for Chrome.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { chromium } = await import(process.argv[2] || "playwright");
const browser = await chromium.launch({ channel: process.env.FILEN_BROWSER_CHANNEL || "chromium" });
const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
try {
	const page = await browser.newPage();
	for (const width of [320, 390, 768]) {
		await page.setViewportSize({ width, height: 800 });
		for (const height of [800, 320]) {
			for (const kind of ["review", "history", "confirmation", "progress"]) {
				const top = height === 320 ? 40 : 0;
				const paragraphs = `<p>${"Long preview text ".repeat(40)}</p>`.repeat(8);
				const content =
					kind === "history"
						? `<div class="filen-sync-version-main"><div class="filen-sync-version-header"><button>← Back</button><span class="filen-sync-version-title">A very long note name.md</span><label class="filen-sync-version-toggle-label">Show changes <input type="checkbox"></label><button>Copy</button><button>Restore</button></div><div class="filen-sync-version-content">${paragraphs}</div></div>`
						: kind === "confirmation"
							? `<p>Restore this revision? The current content stays in local recovery.</p><div class="modal-button-container"><button>Cancel</button><button>Restore</button></div>`
							: `<input type="search" placeholder="Search files"><div class="filen-review-layout"><div class="filen-review-list"><button>folder/long-note-name.md</button></div><div class="filen-review-preview">${paragraphs}<textarea class="filen-conflict-editor"></textarea><div class="modal-button-container"><button>Apply and sync</button></div></div></div>`;
				await page.setContent(`<style>
					* { box-sizing: border-box; }
					body { margin: 0; font: 16px sans-serif; --background-primary: white; --background-secondary: #eee; }
					.modal-container { position: fixed; inset: 0; display: flex; justify-content: center; align-items: center; }
					.modal { padding: 16px; background: white; }
					.modal-content { flex: 1 1 auto; overflow: auto; }
					.modal-title { flex: 0 0 auto; min-height: 32px; }
					.modal-button-container { display: flex; }
					button { font: inherit; }
					.notice { display: flex; }
					${css}
				</style><body class="is-mobile ${width < 768 ? "is-phone" : ""}">
				${
					kind === "progress"
						? `<div class="notice filen-sync-progress-notice filen-mobile-progress"><div class="notice-content"><div class="filen-notice-container"><div class="filen-notice-header"><span class="filen-notice-title">Filen Sync</span><button class="filen-progress-close">×</button></div><div class="filen-notice-count">Waiting for confirmation</div><div class="filen-notice-summary">Last synced 2 minutes ago</div><a class="filen-notice-log-link">View logs</a></div></div></div>`
						: `<div class="modal-container"><div class="modal filen-mobile-dialog ${kind === "history" ? "filen-sync-version-modal" : kind === "confirmation" ? "filen-confirm-dialog" : "filen-conflict-resolver"}"><div class="modal-title">${kind}</div><div class="modal-content">${content}</div></div></div>`
				}
				</body>`);
				const root = kind === "progress" ? ".notice" : ".modal";
				await page.locator(root).evaluate(
					(el, { height, top, width }) => {
						el.style.setProperty("--filen-viewport-height", `${height}px`);
						el.style.setProperty("--filen-viewport-width", `${width}px`);
						el.style.setProperty("--filen-viewport-top", `${top}px`);
					},
					{ height, top, width },
				);
				const bounds = await page.locator(root).boundingBox();
				const label = `${kind}, width=${width}, visible height=${height}`;
				assert.ok(
					bounds.y >= top && bounds.y + bounds.height <= top + height + 1,
					`Vertical bounds: ${label}`,
				);
				assert.ok(
					bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
					`Horizontal bounds: ${label}`,
				);
				assert.equal(
					await page.locator(root).evaluate((el) => el.scrollWidth > el.clientWidth + 1),
					false,
					`No horizontal overflow: ${label}`,
				);
				for (const control of await page
					.locator(
						`${root} button, ${root} input[type="search"], ${root} label, ${root} .filen-notice-log-link`,
					)
					.all()) {
					const box = await control.boundingBox();
					assert.ok(box.height >= 44, `Touch target: ${label}`);
				}
				if (kind === "review") {
					await page
						.getByRole("button", { name: "Apply and sync" })
						.scrollIntoViewIfNeeded();
					const box = await page
						.getByRole("button", { name: "Apply and sync" })
						.boundingBox();
					assert.ok(
						box.y >= top && box.y + box.height <= top + height + 1,
						`Primary action is reachable: ${label}`,
					);
				}
				if (kind === "history") {
					const preview = page.locator(".filen-sync-version-content");
					assert.ok(
						await preview.evaluate(
							(el) => el.scrollHeight > el.clientHeight && el.clientHeight > 0,
						),
						`History preview can scroll: ${label}`,
					);
				}
			}
		}
	}
	console.log("Mobile layout: PASS (3 widths, 2 visible heights, 4 dialog types)");
} finally {
	await browser.close();
}
