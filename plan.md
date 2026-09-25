# UX, activity log, and auto-sync improvements

## Context

The current sync experience has three related problems:

- Background sync can create a second native Obsidian notice such as “1 file uploaded/updated” after progress/status UI has already communicated completion.
- Activity logs are persisted (up to 500 entries) but shown as undifferentiated text lines, even though entries already carry a `kind` and the stylesheet already contains unused row, badge, filter, search, and summary styles.
- Save-triggered auto-sync defaults to a 2-second trailing debounce and can start another full reconciliation immediately after a successful run. Every pass still enumerates the full loaded vault, hashes uncached/invalidated files, and plans against all baseline paths; `pendingPaths` is currently used only for pending counts and clearing revisions, not to scope scan work.

The intended outcome is quieter feedback, a useful diagnostic log, and auto-sync that batches edits and avoids unnecessary repeat work without weakening conflict/delete safety.

## Approach & Architecture

### Notifications

Keep one progress/status surface as the normal success feedback. Remove the background-change completion notice and its setting entirely, while retaining actionable notices for conflicts, confirmation, authentication, offline/manual actions, and failures.

### Activity log

Build on the existing persisted `ActivityLogEntry` model and its `kind` classification. Make the modal scannable with structured rows, local timestamps precise to seconds, category badges, case-insensitive search, three filters (**All**, **Activity**, and **Issues**), visible-result summary, and a useful empty state. Reduce event noise at the source by omitting raw local-edit events, routine connection/cache chatter, and successful automatic no-op runs. Manual runs retain a start/result trail; runs with changes record one concise completed result per operation plus an aggregate result instead of planned + started + completed + accepted duplicates.

### Auto-sync and scanning

Treat the existing save delay as edit debounce and add a separate minimum interval between every automatic sync start (save, interval, startup, focus/visibility, and reconnect). Manual commands bypass it. The coordinator will calculate the next eligible run from both the most recent edit and most recent sync start; manual sync commands bypass the wait but reset the cooldown for the next automatic run, coalescing all events into one queued run.

Use `pendingPaths` as a local scan hint for save-triggered runs and maintain session-only complete scan snapshots after a full pass. A narrow pass is allowed only when the local snapshot is less than five minutes old, every hint is a file path (including both sides of a file rename), the remote tree cache is fresh, and Filen’s event probe reports no remote changes. It refreshes only candidate local entries/hashes, loads candidate baselines, plans only those candidates, and patches the snapshots after each successful operation. Manual, initial, interval, startup, focus/online recovery, folder-event, replan, stale-cache, and remote-change paths use the existing full reconciliation. If any scoped assumption is not provably safe, fall back to a full scan. Preserve executor revalidation, bulk guards, and remote polling safety rails.

## Files to Modify / Create

- `src/settings.ts` — persist/validate the new minimum auto-sync interval, update Auto-sync controls, and remove the background-change notice preference.
- `src/main.ts` — mark force-upload starts for the shared auto-sync cooldown; show a neutral idle status label while edits are queued; hide queued-change indicators outside the opened sync menu.
- `src/sync/coordinator.ts` — enforce the minimum interval, coalesce pending changes, pass scan hints, and emit less repetitive structured activity.
- `src/sync-engine.ts` — maintain session scan snapshots, accept safe local scan hints, choose narrow versus full reconciliation, and preserve full-scan fallbacks.
- `src/sync/executor.ts` — return the successful post-operation metadata needed to patch scan snapshots without rescanning the vault/tree.
- `src/sync/types.ts` — add the minimal sync-run/scan-hint and post-operation contracts, and simplify activity events to the entries that remain useful.
- `src/activity-logs.ts` — add structured rows, category/search filters, result count, and improved empty states; remove log copying.
- `styles.css` — finish/adapt the existing activity-log row/filter/search/badge styles; ensure mobile layout and theme compatibility.
- `README.md` — document the revised auto-sync timing, scanning behavior, notification behavior, and activity-log controls.
- `test/coordinator-ux.test.mjs` — cover cooldown/debounce coalescing, queued runs, and notice behavior.
- `test/sync-ux.test.mjs` — cover scoped scan correctness, fallback rules, deletion/rename handling, and unchanged-file work.
- `test/activity-logs.test.mjs` — cover log filtering, ordering, formatting, and legacy entries through exported pure helpers.
- `test/run-tests.mjs` — update settings assertions and remove obsolete background-notice formatter expectations.
- `package.json` — include the focused activity-log test in the repository test command.

## Reuse Opportunities

- Reuse `pendingPaths`, `changeRevision`, `lastEditAt`, `nextAutoSyncAllowedAt`, and the existing single debounce timer in `SyncCoordinator`; add a session-only last-sync-start timestamp (reset on plugin reload), a full-scan-required flag, and a pending-count surface for the opened sync menu rather than introducing a second scheduler or visible pending indicator.
- Reuse `LocalHashCache` and its five-minute integrity TTL, `SyncEngine.invalidateLocal()`, `planSync()`, `filterPrevRecords()`, and executor revalidation.
- Reuse Filen `checkEvents()` and `REMOTE_TREE_CACHE_TTL_MS`; manual and initial sync continue to force full verification.
- Reuse `ActivityLogEntry.kind`, `inferActivityLogKind()`, `formatActivityLogTimestamp()`, `trimActivityLogs()`, and the existing activity-log CSS class family.
- Reuse existing actionable notice throttling and progress/status/floating-indicator surfaces.

## Steps

- [x] Step 0: Create and switch to isolated git worktree (use worktrees skill) — reuse the already-created worktree at `/Users/agustiawan/.worktrees/obsidian-filen-sync/feat-ux-activity-log-auto-sync-improvements` on branch `feat/ux-activity-log-auto-sync-improvements`; open it with `herdr worktree open --cwd /Users/agustiawan/Developer/personal/obsidian-filen-sync --path /Users/agustiawan/.worktrees/obsidian-filen-sync/feat-ux-activity-log-auto-sync-improvements --no-focus`, then `cd /Users/agustiawan/.worktrees/obsidian-filen-sync/feat-ux-activity-log-auto-sync-improvements`. Preserve its current changes in `src/activity-logs.ts`, `src/settings.ts`, and `src/sync/coordinator.ts`, and run every subsequent implementation command there.
- [x] Add settings and coordinator tests for a `minimumAutoSyncIntervalSeconds` default of 10, clamped to 5–120 seconds, plus trailing save debounce and failure backoff. Prove that manual sync bypasses the limit and edits during a run remain queued for the next eligible pass.
- [x] Persist and render the minimum interval as a numeric input clamped to 5–120 seconds (default 10) under Auto-sync. Include both debounce and minimum-gap behavior in auto-sync descriptions without adding a second timer/scheduler. Record all coordinator sync starts plus force-upload starts; manual operations bypass the wait but move the next automatic eligibility time.
- [x] Remove `notifyOnBackgroundChange`, `formatBackgroundChangeNotice()`, and the successful background-change `Notice`; keep conflict, confirmation, authentication, manual-action, and failure notices.
- [x] Track whether a queued automatic run requires full reconciliation. Snapshot pending path revisions at run start and pass file-only hints only for save-triggered work; interval/startup/focus/online/folder/manual/initial/recovery triggers mark the run full.
- [x] Add a session local-scan snapshot alongside the existing remote-tree cache. On a safe narrow pass, refresh candidate files directly from the vault, read only candidate DB records, validate collisions against the complete cached snapshot, plan only candidate paths, skip directory reconciliation, and patch local/remote snapshots from successful executor results.
- [x] Preserve explicit full-scan fallbacks for absent/stale snapshots, remote events or probe failure, folders, expired integrity TTL, replan, and uncertain state; keep full collision checks, bulk safety calculations, and executor revalidation on the applicable complete data.
- [x] Add engine correctness tests for file create/modify/delete/rename, edits during sync, stale/missing caches, remote change/probe failure, folders, and forced full scans; prove unrelated unchanged files are not read or planned in an eligible narrow pass and that narrow/full outcomes agree.
- [x] Stop logging raw local edit events and stop emitting/logging planned, started, and accepted duplicates for each transfer. Keep manual run starts, exceptional fallback/recovery diagnostics and connection state/test/failure messages (but not routine connection success on every run), one concise past-tense entry per completed operation, one aggregate completion entry, and every failure/conflict. Omit successful automatic no-op runs entirely; pending edits remain visible in status UI.
- [x] Add pure activity-log filtering helpers and render newest-first categorized rows with `YYYY-MM-DD HH:mm:ss` local timestamp, badge, case-insensitive search, **All**/**Activity**/**Issues** filter, “showing N of M” summary, accessible labels, responsive layout, and filtered-empty state. Remove **Copy logs**, keep **Clear logs** clearing immediately, and keep the existing persisted schema.
- [x] Update README settings, notification, scan-safety, and activity-log documentation.
- [x] Run `npm test`, `npm run lint`, `npm run fmt:check`, and `npm run build`; manually verify desktop/mobile activity logs and an end-to-end burst-edit auto-sync.

## Verification

### Automated

- Scheduler tests prove repeated saves reset the edit debounce, automatic runs cannot start more frequently than the configured 10-second default (or selected 5–120-second value), and manual runs remain immediate.
- Queue tests prove changes made during a sync are retained and run later, not dropped or immediately looped; failure backoff wins when it is longer than the normal minimum gap.
- Notice tests prove ordinary successful file updates emit no standalone completion notice; conflict/error/confirmation notices remain; no visible pending indicator appears while queued.
- Status tests prove queued edits leave the status bar in a neutral idle state and the opened sync menu can still report the pending count.
- Engine tests compare scoped and full reconciliation outcomes for local create/modify/delete/rename and prove unsafe states select a full scan.
- Activity tests cover legacy log parsing, **Activity** versus **Issues** grouping (skipped belongs to Issues), case-insensitive text search, result counts, and bounded persistence; the modal no longer renders a copy action.
- Full test, lint, format-check, typecheck/build suites pass.

### Manual

1. Set the minimum gap to 10 seconds, make several rapid saves, and verify one pending batch runs only after both the save debounce and run-rate limit.
2. Edit again during transfer and verify a second run waits for eligibility and includes the new revision.
3. Confirm progress/status updates remain visible but no “1 file updated/uploaded” completion notice appears.
4. Open activity logs on desktop and mobile; search, filter, clear immediately, and inspect error/conflict emphasis; verify there is no copy action.
5. Exercise manual sync, interval sync, local deletion/rename, remote-only change, and conflict flows to confirm full-scan safety and actionable notices.

## Decisions & Rationale (from Grilling)

- Remove the successful background-change notice feature and its setting entirely; retain only actionable notices and the existing progress/status surfaces.
- Improve the existing activity-log presentation and reduce duplicate noise without migrating to a new persisted event schema; omit unsynced local edit events, successful automatic no-op runs, routine per-run connection-success entries, and normal cache/scan optimization details; log only useful sync lifecycle/actions/results, exceptional fallback/recovery diagnostics, and connection changes/failures, remove the **Copy logs** action, keep **Clear logs** clearing immediately, and provide **All**, **Activity**, and **Issues** filters (with skipped entries treated as issues).
- Keep the existing trailing save debounce and add a separate session-only minimum gap between all automatic sync starts, defaulting to 10 seconds and configurable from 5–120 seconds; all manual transfer/sync operations bypass it but reset the cooldown for the next automatic run; the gap resets after plugin/app restart.
- Use conservative, session-only pending-path optimization with a five-minute local integrity TTL and full reconciliation whenever caches, trigger type, folder scope, or remote state make a narrow pass uncertain; do not introduce durable incremental indexes.
