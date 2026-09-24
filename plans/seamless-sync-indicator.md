# Seamless sync progress

## Context

- Two automatic progress surfaces currently compete: a top-right Obsidian Notice (`src/ui/sync-notice.ts`) and a bottom-center floating pill (`src/ui/floating-sync-indicator.ts`). Both render counts, percentages, filenames, and terminal states.
- A native status-bar item and ribbon state also already exist in `src/main.ts`.
- Goal: quiet, coherent sync feedback resembling native Obsidian behavior rather than duplicate notifications.
- Planning only; implementation must take place in a dedicated git worktree after approval.

## Approach

- Confirmed: use the existing native status-bar item in the screenshot on desktop and a compact bottom fallback on mobile. Neither overlay is the best desktop default: the status bar avoids covering notes and matches the requested native feel.
- Stop automatic top-right progress banners and desktop floating pills, including for existing installations. Keep the detailed Notice renderer only for explicit “Show sync progress” requests; retain existing command IDs.
- Default desktop presentation: compact themed icon, gentle syncing motion, neutral up-to-date state, distinct pending/paused/offline/error/conflict states. Preserve the existing optional icon-and-text setting. Hover exposes phase, completed/total changes, active file, and last successful sync; selecting opens the existing actions menu with an explicit details action.
- Add a last-sync summary to the status tooltip, actions menu, and on-demand details (also reachable on mobile): e.g. “Last synced 2 minutes ago” plus the existing result summary when available. Show the exact local timestamp in details and “Not synced yet” before the first success. Reuse `lastSyncTimestamp` and `formatRelativeTime`; compute relative time when opening/refreshing the surface so it does not go stale. Failed or skipped attempts must not replace the last successful sync time; preserve the existing persisted timestamp across reloads. Keep the desktop icon-only default uncluttered.
- Mobile: compact single-line, keyboard-accessible/tappable fallback; do not show the full multi-row progress card automatically. Delay transient syncing display by about 300 ms to avoid flashing on fast/no-op runs; briefly show completion, but retain actionable error/conflict information until state changes. Respect safe areas and reduced motion.
- Use phase labels for scanning/planning/finalizing; only show determinate transfer progress with a valid total. Never imply the entire sync is finished merely because transfer counts reach 100%.
- Keep actionable failure/conflict notices and the existing opt-in background-change notice. Remove routine successful-sync toast duplication; manual success remains visible through the indicator and details.
- Simplify settings: retire automatic progress-notice choices (ignore legacy saved values safely), relabel the floating toggle as mobile-only while honoring its saved boolean, preserve status-bar style and background notification preferences. No changes to sync algorithms or remote filesystem behavior.
- User supplied a screenshot of the bottom status-bar area (word/character counts, pin, and red sync icon) and asked to add/change feedback there. Target the existing Filen status-bar item in this area rather than adding another competing indicator.
- User confirmed desktop status bar plus mobile fallback. If a desktop theme hides the status bar, existing ribbon/commands remain the access path; do not introduce fragile theme-visibility detection.

## Files to modify

- `src/main.ts`: platform routing, status-bar feedback, existing menu/details entry points.
- `src/ui/floating-sync-indicator.ts`, `styles.css`: compact mobile presentation, timing, accessibility and motion.
- `src/ui/sync-notice.ts`: on-demand detail lifecycle; avoid stale dismiss timers/manual state across runs.
- `src/settings.ts`: simplified settings and legacy compatibility.
- `src/sync/coordinator.ts`: eliminate routine success toast duplication, preserving actionable notices.
- New `src/ui/sync-presentation.ts` only for shared phase/count formatting and surface policy, keeping lifecycle work out of `main.ts`.
- New `test/sync-indicator.test.mjs`, existing `test/coordinator-ux.test.mjs`, `package.json` test script, and `README.md`.

## Reuse

- Existing `StatusBarState` events from `src/sync/coordinator.ts`.
- Existing `buildStatusBarMenu`, `showSyncProgress`, status-bar/ribbon rendering, and activity-log entry points in `src/main.ts` (verify exact details command wiring during implementation).
- `SyncNoticeController.showOnDemand` / `closeNotice` for explicit details; existing floating controller teardown/timers for mobile.
- Node test + esbuild Obsidian-stub pattern in `test/sync-ux.test.mjs` and coordinator tests; existing `SyncProgress` phase, counts, bytes, path instead of new engine events.

## Steps

- [ ] After approval, create branch `feat/seamless-sync-indicator` from current HEAD in `~/.codex/worktrees/seamless-sync-indicator/obsidian-filen-sync`, using the same global `.codex/worktrees` location and directory layout as the existing Codex workspace. Keep the existing `~/.codex/worktrees/sync-ux/obsidian-filen-sync` worktree untouched. Leave current uncommitted `package.json`, `src/fs-remote.ts`, `test/remote-fs.test.mjs`, and performance-plan work untouched; copy only this approved plan to the new worktree. Install dependencies there with npm after approval.
- [ ] Add failing presentation/routing tests, then consolidate automatic surface selection and settings compatibility. Acceptance: desktop shows no automatic progress overlays; mobile shows at most one compact indicator; old saved settings cannot resurrect duplicate banners.
- [ ] Refine status-bar and on-demand progress using existing state. Acceptance: truthful phase/count feedback, a last-successful-sync time and available result summary in tooltip/menu/details, explicit never-synced state, unchanged menu actions and command IDs, no success-toast duplication, errors/conflicts still discoverable. Run tests/build checkpoint.
- [ ] Compact the mobile controller and style it with Obsidian variables. Acceptance: no fast-sync flashing, no stale completion timer hiding a new run, keyboard/touch access, reduced motion, clean unload.
- [ ] Extend regression tests and README, run full verification, review the worktree diff. No automatic merge, release, or deployment to a real vault.

## Verification

- Run `npm test`, `npm run lint`, `npm run build`; check formatting of touched files. Record unrelated baseline failures separately.
- Automated tests: desktop/mobile routing, legacy settings, unknown/zero totals, phase transitions, completed counts, consecutive syncs and dismiss timers, terminal errors without previous visible progress, and teardown. Assert no automatic progress Notice is created and actionable coordinator notices remain. Test last-sync summary before first success, after success/reload, relative-time refresh, and after failed/skipped attempts (successful timestamp unchanged).
- Manual Obsidian desktop: confirm the indicator occupies the screenshot’s status-bar area; exercise hover, click, Enter/Space, menus, on-demand details, icon/full mode, light/dark themes, manual/background/no-op sync, pending, pause, offline, errors, conflicts, and unload/reload.
- Manual mobile: narrow layout, safe-area/keyboard overlap, long filenames, tap details, reduced motion, quick completion and back-to-back runs. Use a disposable test vault; request permission before deployment. If a real mobile/Obsidian runtime is unavailable, report that limitation rather than claiming runtime verification.
