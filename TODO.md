# TODO

Live roadmap. Current implementation: direct Filen folder mirror with a planner/executor
pipeline, safety guards, conflict review, and mobile-aware auto-sync. Completed plans and specs
live in `docs/archive/`.

## Done

- [x] Filen auth through `@filen/sdk`; saved auth in SecretStorage, password/2FA session-only
- [x] Direct remote FS adapter: `src/fs-remote.ts`
- [x] 3-way local/remote/baseline planning: `src/sync/planner.ts`, `src/sync/executor.ts`
- [x] Baselines in IndexedDB via `localforage`, namespaced per vault/account/root: `src/db.ts`
- [x] Content hash fallback for local mtime/ctime drift; session hash cache
- [x] Initial sync, Sync now, Push, Pull, Force sync current file commands
- [x] Delete propagation with structured destructive and bulk guards: `src/sync/bulk-guard.ts`
- [x] Path validation and collision blocking: `src/sync/path-validation.ts`
- [x] Transfer recovery and reconciliation of uncertain mutations: `src/sync/recovery.ts`
- [x] Single status bar item, mobile sync indicator, and progress notice
- [x] Activity log with categories and filtering: `src/activity-logs.ts`
- [x] Read-only sync preview, diagnostic history, and redacted export
- [x] Conflict handling: automatic merge or review (`src/ui/conflict-resolver-modal.ts`,
      `src/ui/managed-conflict-review.ts`), local recovery copies
- [x] File version modal: list, restore, delete Filen versions
- [x] Ignore rules, auto-sync on save/interval/startup/foreground, debounced triggers
- [x] Mobile change-scanning performance and byte-bounded transfers
- [x] Onboarding prompt when not connected
- [x] CI: build, tests, lint, format; tagged release workflow

## Open

- [ ] Keep `src/main.ts` lifecycle-only; split `src/sync/coordinator.ts` and
      `src/sync-engine.ts` into smaller modules
- [ ] Reduce `main.js` bundle size (audit `@filen/sdk` polyfills with an esbuild metafile)
- [ ] Rename detection across directories (currently delete + create)
- [ ] Merge snapshot limits: expiry for local recovery copies
- [ ] Optional plugin-level E2EE if data must stay portable outside Filen account encryption
