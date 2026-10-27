# Mobile icon and resync reliability

## Context

- In the supplied mobile screenshots, the automatic full-width Filen `Notice` obscures Obsidian content, and the activity log repeatedly shows “Changes detected during sync; running fresh pass...” followed by “Remote file changed before upload: 2026-09-26.md. Replan the sync.”
- `src/ui/sync-notice.ts` automatically mounts the wide card on mobile. Meanwhile `src/main.ts` already has a persistent top-right mobile ribbon icon, a sync actions menu, on-demand details, and an activity log.
- **Confirmed root cause of the reported upload loop:** `@filen/sdk@0.4.2` `cloud.fileExists()` returns `{ exists: false } | { exists: true, uuid }` (see installed `node_modules/@filen/sdk/dist/types/api/v3/file/exists.d.ts`). In `src/fs-remote.ts`, mutation-session `writeFile()` checks `existing` as a boolean. The `{ exists: false }` object is truthy, so every new remote file erroneously throws “Remote file changed before upload”; the engine repeats the same mistake on its single immediate replan, and future interval runs repeat it again. Adapter tests currently exercise folder/root resolution, not this real upload contract.
- Actual local or remote concurrent changes can still request a replan after that fix. Current engine retries once immediately; coordinator does not classify a replan as retryable and later interval triggers can create repeating failures. Preserve safe, fresh revalidation while recovering gracefully.
- **Review feedback:** include a small HTML-in-Markdown mobile before/after example in this plan; also extend scope to reliable file-removal detection without weakening deletion safeguards. Existing `planSync()` already distinguishes local/remote deletions using the per-file baseline, but a path-hinted auto-sync can plan against a 30-minute cached remote tree when the Filen event probe reports no changes. `SyncExecutor.deleteLocal()` verifies local state but does not recheck remote absence immediately before moving a local file to trash. These are targeted coverage/fix points; the user selected bidirectional detection with bounded fresh scans and strict pre-delete validation.

## Approach & Architecture

### 1. Quiet, discoverable mobile status

- Reuse the **existing** mobile ribbon control as the _only automatic mobile status surface_. Remove automatic compact `Notice` creation entirely; do not create a second floating control or apply brittle viewport offsets. The desktop status-bar path stays unchanged.
- Mobile tap **always opens the existing sync actions menu**, including while syncing or after failure; it must never accidentally start a sync. Menu retains **Show sync progress**, **Open activity log**, **Retry now / Sync now**, pause, and settings; show a clear “Sync needs review — select Sync now” menu/tooltip message when retries are exhausted.
- Update ribbon icon/color/motion/accessibility labels for syncing, idle, completion, warning/offline, and error/held-retry states. Preserve minimum touch area and reduced-motion styling. Keep detailed `SyncNoticeController` only for _explicit_ progress requests; no automatic success/error/pending card on mobile.
- Suppress routine automatic-sync failure toasts **on mobile**; keep warning/confirmation and other urgent safety prompts, and explicit/manual-sync failure notices. Existing desktop notification policy stays unchanged. Remove the obsolete mobile-indicator toggle from settings, ignore its saved value safely (do not migrate destructively), and document the icon-only behavior.

### Mobile example (readable planning preview)

| Now: automatic card                                                        | Proposed: quiet sync                                                                                        | Proposed: tap error icon                                                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A full-width **Filen Sync** notice covers the first lines of a daily note. | The daily note stays fully visible. A single **⟳** icon in Obsidian's top-right ribbon shows sync activity. | A red **!** icon opens the existing sync menu: **Sync needs review → Sync now**, **Show sync progress**, **Open activity log**. |

**HTML source sketch** for the proposed states (illustrative only; the real icon/menu will use Obsidian components, not this static markup):

```html
<section class="phone" aria-label="Mobile Filen sync preview">
	<header class="phone-header">
		<span>Daily note</span>
		<button type="button" aria-label="Filen syncing. Open sync menu">⟳</button>
	</header>
	<article>My note remains fully readable. No automatic card appears.</article>
</section>
<section class="phone" aria-label="Mobile Filen sync error preview">
	<header class="phone-header">
		<span>Daily note</span>
		<button type="button" aria-label="Sync needs review. Open sync menu">!</button>
	</header>
	<nav aria-label="Sync actions">
		<strong>Sync needs review — select Sync now</strong>
		<div>Sync now · Show sync progress · Open activity log</div>
	</nav>
</section>
```

**Review gate:** Planning cannot create `.html` files. After approval and worktree creation, first build a _standalone browser-viewable HTML mockup_ of before/after/tap states and ask the user to review it before changing the plugin. The preview is not the shipped UI.

### 2. Correct the remote upload precondition

- In `FilenRemoteFs.writeFile()` mutation session, use `existing.exists` rather than object truthiness: `{ exists: false }` allows creation when no UUID was expected; `{ exists: true, uuid: expected }` allows replacing the planned remote object; other combinations reject and request a fresh plan. Keep the existing standalone `stat()` path and SDK session `finally` cleanup/reset.
- Add SDK-shaped adapter tests with a mocked upload completion (including empty files) and precondition responses; prove no upload/DB baseline mutation on UUID mismatch. Do **not** remove remote revalidation to make the failure disappear.

### 3. Reliable, safe file-removal detection in both directions

- Keep the existing three-way planner: an absent file is a deletion **only if a trusted prior baseline exists**. Preserve the existing delete-vs-modify conflict rule, remote trash, local Obsidian trash, user confirmation for local deletes, and bulk guard. Never interpret an empty/failed remote scan or an ignored path as blanket deletion.
- **Obsidian → Filen:** retain delete/rename vault-event path hints (both old and new path), and verify the local file is still absent before moving its _expected remote UUID and version/hash_ to Filen trash. If the remote object has changed, replan to resolve a deletion-vs-modify conflict instead of deleting it. Retain baseline until successful operation and keep edits during the run queued.
- **Filen → Obsidian:** bound remote-tree staleness to about **five minutes** for automatic checks even when the events feed says no changes (while retaining fast event polling on ordinary save-triggered runs). Before moving a local file to trash, explicitly verify remote absence via a fresh server-backed adapter lookup; if it reappeared or the check fails, abort/replan rather than deleting local data. Continue to request user confirmation for automatic local deletions; never interpret a rejected confirmation as a successful sync.
- Cover both directions for manual, interval, foreground, hinted save, concurrent edit, missed-event, stale-cache, rename, and partial-failure cases. Limit extra remote requests to paths with planned destructive operations; do not do a full remote scan for every save.

### 4. Bounded recovery for genuine races

- Keep the engine’s one immediate fresh pass and its scan/hash invalidation. Identify replan requests narrowly from existing error messages; do not treat generic failures, auth errors, or uncertain transfer outcomes as safe-to-retry replans.
- For **automatic** sync only, after the engine's immediate replan also races: schedule up to **three** delayed full-scan attempts using existing `pendingAutoSync`, edit debounce, minimum gap and a short exponential retry backoff (e.g. 2/4/8 s, with the normal 10 s minimum gap still enforced). Do not schedule while another run is active; clear timers on teardown. During a scheduled retry show non-terminal syncing/pending feedback in the icon rather than a noisy failure toast/log for every attempt.
- On success reset the replan retry budget and clear only pending-path revisions captured by that successful run. On exhaustion, hold _all_ automatic triggers (interval, save, foreground, startup) until a manual **Sync now** successfully reconciles; keep new edits queued, show a clear manual-action-required error in icon/menu/log. A failed manual attempt does not lift the hold. Manual runs bypass automatic cooldown; unrelated network-backoff and bulk/confirmation/uncertain-mutation safeguards remain intact.
- Ensure a terminal error does not get silently hidden by later file-change status events; never loop indefinitely or overwrite concurrent remote edits.

## Decisions & Rationale (from Grilling)

- **Mobile surface:** user chose persistent top-right ribbon icon only, with tap always opening the sync menu. Rejected direct-to-details tap, syncing-only icon, and a second floating icon: actions/errors must stay reachable without covering content.
- **Background notices:** user chose icon/log for routine mobile auto-sync failures; preserve urgent safety/confirmation and explicit manual failure messages. Rejected all-toasts (still blocks notes) and no-toasts (hides urgent issues).
- **Retry policy:** user chose bounded automatic recovery after the root-cause fix, rather than stopping after one race or retrying forever; reuse quiescence/backoff and keep strict preconditions.
- **After exhaustion:** user chose hold until manual sync and **ask the user to sync**. New local edits do not reset the hold; only a successful manual full two-way sync does.
- **Legacy toggle:** user chose remove the now-misleading mobile-indicator setting; the existing top-right icon remains available to all users regardless of old saved value. Do not rename stable command IDs.
- **File removal:** in response to review feedback, user chose detection in **both directions**, keeping baseline-based delete-vs-modify conflict handling, explicit local-delete confirmation, bulk limits, and both trash destinations. Rejected one-direction-only coverage and unsafe interpretation of absent entries after failed scans.
- **Missed remote events:** user chose a short (~five-minute) fresh remote scan fallback plus fresh pre-delete checks, rather than a scan on every save (battery/network cost) or keeping the 30-minute detection delay.
- **HTML review example:** user requested a real browser-viewable HTML example; the previous raw-HTML-in-Markdown block rendered as flattened text. Replaced it with a readable Markdown comparison and fenced HTML source sketch. After approval, create a standalone HTML mockup in the worktree and **pause for user visual review before plugin implementation**. A `.html` file cannot be written during planning.
- **Safety alternatives rejected:** bypassing UUID/hash checks or blindly retrying possibly uncertain mutations could lose remote edits; changing auto retry policy for unrelated errors is out of scope.

## Files to Modify / Create

- `plans/mobile-sync-mockup.html` (new, **only after approval inside the worktree**) — standalone static, responsive before/after/icon-menu HTML preview for user review; not shipped with plugin.
- `src/main.ts` — mobile ribbon tap/menu routing, held-retry messaging, removal of automatic notice routing/obsolete toggle refresh, state/accessibility styling.
- `src/ui/sync-notice.ts`, `src/ui/sync-presentation.ts` — on-demand-only details and removal of unused mobile automatic surface policy.
- `src/sync/coordinator.ts` — bounded replan scheduling/hold, status and notice policy, timer/pending revision lifecycle.
- `src/fs-remote.ts` — parse SDK `FileExistsResponse` correctly; add fresh remote-absence and expected remote-version checks for destructive operations without weakening session cleanup.
- `src/sync-engine.ts`, `src/sync/executor.ts` — shorten remote-cache staleness for automatic checks and verify planned deletions again before applying/trashing (including same-UUID remote changes).
- `src/settings.ts`, `styles.css`, `README.md` — hide obsolete setting, trim automatic-card CSS, adjust ribbon visuals/copy; retain safe handling of old saved settings.
- `test/remote-fs.test.mjs` — realistic SDK response and upload/session tests plus fresh absence and version checks for deletes.
- `test/coordinator-ux.test.mjs`, `test/sync-indicator.test.mjs`, `test/run-tests.mjs` — bounded recovery/hold, icon-only mobile routing, and local/remote removal with stale/missed events, confirmation, conflict, and race coverage.

## Reuse Opportunities

- `syncRibbonIconEl`, `updateRibbonIcon()`, `buildStatusBarMenu()`, `openStatusBarMenu()`, `SyncNoticeController.showOnDemand()` in `src/main.ts`/`src/ui/sync-notice.ts`.
- Engine `replanAttempts` and cache/hash invalidation; `mapPool()` drain-on-failure and `withMutationSession()` guaranteed cleanup.
- `planSync()` baseline-aware `delete-local` / `delete-remote` / delete-vs-modify conflict outcomes; `checkBulkGuard()`, `SyncExecutor.deleteLocal()`, `SyncExecutor` UUID checks, and existing local delete confirmation callbacks.
- Coordinator `lastEditAt`, `pendingPaths` revisions (including rename old path), `pendingAutoSyncRequiresFullScan`, `nextAutoSyncAllowedAt`, `scheduleQueuedAutoSync()`, `teardownAutoSync()`, and existing network retry/backoff paths.

## Steps

- [ ] Step 0: Create and switch to isolated git worktree (use worktrees skill): `WORKTREE_PATH=$(/Users/agustiawan/.agents/skills/worktrees/scripts/new-worktree.sh --herdr mobile-icon-resync) && cd "$WORKTREE_PATH"` (fallback: `git worktree add .worktrees/mobile-icon-resync --detach HEAD && cd .worktrees/mobile-icon-resync`). Copy this approved plan there before implementation; **all** subsequent edits, installs, tests, and commits occur inside that worktree.
- [ ] Step 1: Create a self-contained, responsive `plans/mobile-sync-mockup.html` inside the worktree with actual styled phone previews (current blocked note, proposed unobstructed icon, tapped error menu). Open it for user visual review and **wait for feedback/approval before modifying plugin sources**; revise mockup if needed.
- [ ] Step 2: Write failing regression tests reproducing real SDK `{ exists: false }` / UUID responses, mobile icon-only routing, bounded replan retries/hold, and file-removal detection in both directions.
- [ ] Step 3: Correct mutation-session upload preconditions; cover new file, matching/missing/replaced expected file, partial upload/session exit, and reconciliation safety.
- [ ] Step 4: Route mobile icon taps to menu, retire automatic cards/toggle, keep explicit details, update accessibility, CSS and README; suppress only routine mobile background-failure toasts. Match the **approved** HTML mockup's non-obstructive mobile states.
- [ ] Step 5: Bound remote-tree cache staleness to ~five minutes for automatic checks; add fresh server-backed remote-absence validation before local trash and remote identity/version validation before Filen trash. Test hinted/interval/foreground/missed-event scans, deletion races, confirmation/guard behavior, and no regression for ordinary save scans.
- [ ] Step 6: Implement bounded, quiescence-aware coordinator recovery for replan-only auto-sync failures; preserve queued revisions and hold until successful manual reconciliation. Add fake-timer tests for later triggers, teardown, edits during a run, and offline/reconnect.
- [ ] Step 7: Run focused tests and full quality gates; review worktree diff for data safety and UX. Do not merge, deploy to a real vault, release, or commit generated artifacts automatically.

## Verification

- `npm test`, `npm run lint`, `npm run fmt:check`, `npm run build` in the worktree.
- Adapter/integration: real SDK-shaped `fileExists` responses; successful new-file upload even with the session; UUID mismatch never overwrites or records success; fresh-pass revalidation, root binding, and uncertain-mutation guards retained; session resets once on success/failure.
- Deletions: local removal/rename propagates only when expected remote UUID _and content version_ still match; remote removal is detected after missed events by bounded scan and verified server-side immediately before local trash; fresh remote reappearance and failed probes replan instead of deleting; never delete without prior baseline; preserve confirmation, bulk guard, delete-vs-modify conflict copies, and trash destinations. Verify no unneeded fresh tree request on every ordinary save.
- Coordinator: delayed full scan only for genuine auto replans, max 3 delayed retries with debounce/min-gap, successful reset, manual bypass and successful-unlock, exhausted hold across all automatic triggers and fresh edits, no duplicate timers/overlapping runs, no repeated toast spam.
- UI: obtain user approval of the standalone worktree HTML mockup before plugin edits; compare the implemented mobile UI with that approved example. Only existing top-right icon appears automatically; tapping it always opens menu, including while syncing/failed; manual **Show sync progress** remains available; error icon/menu explains required **Sync now**; desktop status bar and manual/safety notices unchanged; unload removes timers/details.
- Manual Android/iOS test in disposable/backup vault: ensure no overlay blocks content, top-right target is accessible, rapid edits settle, previously failing new daily note uploads, remove notes on both sides, confirm/decline local trash, preserve concurrent remote edits, and ensure offline/background/foreground transitions do not restart an exhausted loop. Report if real-device verification is not available.
