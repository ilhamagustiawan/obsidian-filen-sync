# Improve mobile sync experience and performance

## Context

- The supplied Android screenshot shows the automatic sync pill underneath the system status icons and Obsidian title area. The pill is a raw `position: fixed` element mounted in `workspace.containerEl`; `styles.css` relies on `env(safe-area-inset-top)`, which resolves to an insufficient/zero value in the Android WebView.
- Mobile hides the native status-bar item, automatic Obsidian progress notices are disabled, and `main.ts` routes status changes to `FloatingSyncIndicator`; therefore this covered pill is the only automatic mobile progress surface.
- The screenshot is already in transfer phase at `0/294`. The current pill reports only completed files, even while chunks of the first file are moving, so both real throughput and perceived responsiveness must be measured.
- Existing performance foundations should remain: path-hinted narrow auto-sync, five-minute local snapshot/hash caches, 30-minute remote tree cache, Filen event polling, two concurrent small-file transfers, three chunk workers, replan-on-change, per-file baselines, and mutation-uncertainty recovery.
- Confirmed hotspots in current code:
    - first sync may download matching remote files serially only to calculate a local-comparable hash, despite Filen metadata often carrying the file's SHA-512;
    - fresh target identity is resolved in `prepareSyncTarget()`, then `SyncEngine.sync()` ensures the same root again;
    - folder preparation and each file operation can repeatedly traverse Filen paths; `client.init(client.config)` after every write/delete discards the SDK virtual filesystem cache;
    - transfer progress is published and rendered for every file/chunk tick without coalescing;
    - manual/initial local scans hash files serially, but repeated manual no-change sync is not a selected primary workload.
- An unmerged WIP commit, `9426d1c`, already contains instrumented tests and a candidate one-shot root/per-scan folder UUID optimization. It is evidence and reusable work, not something to cherry-pick blindly.

## Approach & Architecture

### 1. Native, inset-safe mobile progress

- Replace the custom viewport-fixed mobile pill with a compact mode owned by `SyncNoticeController` and created through Obsidian's core `Notice`. Obsidian's notice container—not plugin pixel math—will own Android/iOS inset and orientation placement.
- Keep one overlay controller and one notice element. Automatic mobile mode remains delayed by about 300 ms, compact, tappable, and persistent for actionable warning/error states; explicit **Show sync progress** expands/opens the existing detailed mode. Desktop keeps its status-bar/ribbon behavior and does not gain automatic notices.
- Show truthful live work while a file is in flight: phase, completed/total files, abbreviated path, and current-file transferred/total bytes when known. Coalesce syncing updates to at most 10 Hz; terminal states flush immediately. Preserve reduced motion, accessibility labels, teardown, and stale-timer protection.
- Remove `FloatingSyncIndicator` after equivalent mobile behavior is covered. Retain the existing `showFloatingSyncIndicator` saved setting for compatibility, but present it as **Mobile sync indicator**.

### 2. Measure before changing transfer behavior

- Extend deterministic fixtures to record target preparation, local scan, remote scan, folder preparation, first completed transfer, and total time; also count local reads/hashes, remote tree/list/exists/get calls, SDK resets, uploads/downloads, and peak file/chunk concurrency.
- Gate on three user-selected workloads: (a) 294 real small transfers (primary), (b) first sync of mostly identical files, and (c) automatic sync after one/few edits (no-regression).
- Add a single local activity-log timing summary for real-device diagnosis; do not add telemetry or transmit filenames/timings.

### 3. Low-risk I/O and round-trip reductions

- Add explicit SHA-256/SHA-512 content-fingerprint helpers. Validate Filen metadata hashes as 128-character hexadecimal SHA-512 values at the remote adapter edge.
- For a no-baseline path with equal size/mtime and a valid Filen SHA-512, calculate the local SHA-512 with bounded concurrency and compare it directly. Equal content establishes the same trusted baseline as today; mismatch follows existing first-sync conflict/direction policy. If the Filen hash is absent/invalid, retain the current remote-download-and-SHA-256 fallback. This must make zero remote content downloads for eligible identical files.
- Adapt the proven parts of `9426d1c`: consume a freshly verified root exactly once for the immediately following root ensure, and build a per-scan path-to-directory-UUID index for parent-first folder creation. Never cache target identity across runs; clear the index/token on target change, failed scan/create, uncertainty, SDK reset, or close.

### 4. Measurement-gated safe transfer session

- If the 294-file benchmark still shows repeated Filen setup/cache reset as dominant, add one optional deep seam to `RemoteFs`: a callback-scoped mutation session. The callback guarantees `finally` cleanup and keeps existing `readFile`/`writeFile`/`rm` calls unchanged for callers and test adapters.
- `FilenRemoteFs` will use the freshly scanned/cached directory UUID index during the session and Filen's `cloud.fileExists({name,parent})` for lightweight **per-file immediate path/UUID revalidation**. It must not replace revalidation with a single stale batch snapshot. Downloads/deletes still verify the expected UUID/hash; absent-path uploads still confirm absence immediately before mutation.
- While all session lookups avoid stale SDK path entries, defer `client.init(client.config)` until the session exits, then reset exactly once on success or failure. If those invariants cannot be proven in tests, retain per-operation resets and do not land this optimization.
- Only after the above, if controlled latency still shows worker under-utilization, benchmark a bounded tiny-file tier: at most three concurrent files below a conservative threshold, two for current small-file range, and serial large files/conflicts/deletes. Keep existing three-chunk concurrency and enforce a tested in-flight memory bound; add no user-facing “fast mode.”

## Decisions & Rationale (from Grilling)

- **Automatic mobile surface:** user selected an Obsidian-managed compact notice. Rejected view-header anchoring, bottom-toolbar offsets, and hard-coded Android insets because they couple to internal DOM/device geometry.
- **Performance workloads:** user selected hundreds of real transfers, first sync of mostly identical files, and automatic sync after a few edits. Repeated manual no-change sync is not a primary target, so full manual verification may remain deliberately expensive.
- **Optimization depth:** user selected a measurement-gated safe transfer session. Low-risk changes land first; the deeper seam is allowed only when measurements show per-file Filen setup is dominant and all safety invariants remain explicit.
- **Acceptance gate:** in an identical controlled-latency 294-small-file fixture, require at least 30% lower time to first completed transfer and 25% lower total time, with fewer remote setup calls. Eligible identical first-sync files must require zero remote downloads. One/few-file auto-sync may not regress by more than 10%. Record Android results separately; a fixed network SLA would be misleading. Any threshold revision requires documented baseline evidence.
- **Real-device diagnostics:** user selected one compact timing/count summary per sync in the existing local activity log. It follows existing retention and contains no file contents, credentials, or telemetry; rejected opt-in-only and synthetic-only diagnostics because they make the reported Android slowdown harder to verify.
- **Shared understanding:** user confirmed the complete scope and all above constraints; the design frontier is empty.
- **Safety:** do not weaken fresh target binding, collision/bulk guards, conflict rules, same-stat edit detection, per-file remote identity checks, replan behavior, or uncertain-mutation recovery. Rejected conservative-only scope because it may miss the reported workload; rejected aggressive fast mode because weaker checks/settings/memory pressure are not justified.

## Files to Modify / Create

- `src/main.ts` — route automatic mobile status to the notice controller; keep desktop lifecycle small; pass timing/session context where needed.
- `src/ui/sync-notice.ts` — compact automatic mobile and detailed on-demand modes, coalesced progress, tap/accessibility/timer lifecycle.
- `src/ui/sync-presentation.ts` — shared compact phase/file/byte formatting and surface policy.
- `src/ui/floating-sync-indicator.ts` — remove after notice parity is verified.
- `styles.css` — compact notice styling; remove fixed pill positioning/styles.
- `src/settings.ts`, `README.md` — retain compatible toggle, describe native mobile placement/behavior and local timing diagnostics.
- `src/sync/content-hash.ts` (new) — explicit SHA-256/SHA-512 helpers and Filen hash validation; replace duplicated hash implementations.
- `src/sync/types.ts`, `src/sync/planner.ts`, `src/sync/local-hash-cache.ts`, `src/sync-engine.ts` — comparable Filen fingerprint, bounded equality proof, phase metrics, directory UUID context, and measured transfer scheduling.
- `src/fs-remote.ts` — root/folder reuse and, only if gated in, callback-scoped mutation session with `fileExists` revalidation and one final SDK reset.
- `src/sync/executor.ts`, `src/sync/chunk-transfers.ts` — consume shared hashing and session behavior without removing local before/after mutation checks.
- `test/sync-indicator.test.mjs`, `test/sync-ux.test.mjs`, `test/transfer-progress.test.mjs`, `test/run-tests.mjs` — UI, fingerprint, correctness, timing, concurrency, and no-regression coverage.
- `test/remote-fs.test.mjs` (new/adapted from `9426d1c`) and `package.json` — focused SDK-call/session tests and test-script registration.

## Reuse Opportunities

- Existing `SyncNoticeController` already uses `new Notice(frag, 0)` and has detailed phase/count/byte rendering.
- Existing `StatusBarState`, `formatSyncProgress`, delayed/persistent terminal behavior, mobile toggle, and status actions.
- `mapPool()` for bounded fingerprint work and existing transfer fixtures for fixed-latency comparisons.
- `LocalHashCache`, local snapshots, `scanHints`, remote tree/event caches, `patchSnapshots()`, and current fallback-to-full-scan rails.
- `FilenRemoteFs.walkTree()` already exposes file/directory UUIDs and SHA-512 metadata; Filen SDK 0.4.2 exposes `cloud.fileExists({name,parent})`.
- `9426d1c` tests/measurements for one-shot verified-root reuse and per-scan directory UUIDs.

## Steps

- [x] Step 0: Create and switch to isolated git worktree (use worktrees skill): `WORKTREE_PATH=$(/Users/agustiawan/.agents/skills/worktrees/scripts/new-worktree.sh --herdr mobile-sync-experience) && cd "$WORKTREE_PATH"` (standard fallback: `git worktree add .worktrees/mobile-sync-experience --detach HEAD && cd .worktrees/mobile-sync-experience`). Perform every edit, install, benchmark, test, and commit only inside it.
- [x] Step 1: Add failing mobile surface/lifecycle tests; consolidate automatic mobile progress into compact `SyncNoticeController` mode; remove the fixed pill and update CSS/copy. Verify Android-zero-inset behavior is delegated to Obsidian, not plugin offsets.
- [x] Step 2: Add benchmark instrumentation and establish checked-in before numbers/call counts for 294 tiny uploads, mostly-identical first sync, and one-file auto-sync. Capture time to first completion, total, remote calls/resets, reads/hashes, progress updates, and peak concurrency.
- [x] Step 3: Add validated Filen SHA-512 comparison with fallback behavior; prove eligible identical files make no remote content downloads and all mismatch/conflict/direction outcomes remain unchanged. Run the first measurement checkpoint.
- [x] Step 4: Review/adapt only the safe root/folder optimizations from `9426d1c`; cover one-shot consumption, standalone engine use, replaced roots, failed preparation/scans/creates, nested folders, uncertainty, and close/reset. Run the second checkpoint.
- [x] Step 5: If the accepted performance gate is still unmet and call traces identify per-file setup/reset, implement the callback-scoped remote mutation session with `fileExists` per-file revalidation and one final SDK reset. Otherwise document the measured reason and skip this complexity. Run full safety and timing checkpoints.
- [x] Step 6: If the gate remains unmet and traces identify idle transfer capacity—not crypto/network saturation—benchmark and optionally land the bounded three-worker tiny-file tier. Reject it if memory, failure draining, rate limits, or one-file auto-sync regress.
- [x] Step 7: Add/verify local phase timing summary, update README/settings copy, run final quality gates, compare production bundle size, and conduct a safety/performance review of the worktree diff. Do not merge, release, or deploy to a real vault automatically.

## Verification

- Quality gates: `npm test`, `npm run lint`, `npm run fmt:check`, `npm run build`.
- UI: mobile-only automatic compact notice; desktop has no automatic notice; zero/nonzero safe-area environments; portrait/landscape; long paths; current-file bytes while count remains `0/294`; delayed quick sync; back-to-back runs; on-demand expansion; warning/error persistence; tap/keyboard/accessibility; reduced motion; unload/timer cleanup.
- Performance: identical controlled latency/data before and after; enforce the accepted relative thresholds and request/read counts; zero eligible remote equality downloads; ≤10% one-file auto-sync regression; bounded peak file/chunk concurrency and progress render rate.
- Safety: same-stat local edits, edits during upload/download, remote UUID/hash replacement, absent-path race, target root replacement, stale/failed event probe, stale caches, replan, partial parallel failure draining, SDK reset on every session exit, mutation uncertainty, nested/failed folder creation, path collisions, conflicts, local-delete confirmation, and bulk guard.
- Manual Android test in a disposable/backup vault: reproduce the ~294-change run and record device/network, per-phase time, first completion, total time, indicator placement, orientation/background/foreground, offline/reconnect, long filename, and large attachment. Report limitations instead of claiming unperformed real-device verification.
