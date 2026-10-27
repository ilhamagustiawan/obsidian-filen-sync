# Security and infrastructure upgrade (draft)

## Context

Preserve this plugin's existing user experience while strengthening security, sync safety, and maintainability. Compare the two supplied repositories as references, not as automatically trustworthy implementations.

## Initial findings

- Existing UX includes direct folder mirroring, manual sync/push/pull, auto-sync, activity, conflict copies, and file versions.
- `src/secrets.ts` already wraps Obsidian SecretStorage, including password storage. README instead says passwords remain in memory and auth is in plugin data. Trace actual callers before concluding how secrets are persisted; reconcile implementation and disclosures.
- `src/db.ts` namespaces the baseline using vault name. Investigate isolation across vaults, accounts, and remote roots before proposing migrations.
- `src/main.ts` (1,209 lines) and `src/sync-engine.ts` (715 lines) warrant focused boundary review, not a wholesale rewrite.
- Dependencies include `@filen/sdk` with a caret range and localforage. Existing tests run through `test/run-tests.mjs`.
- SDK follow-up: [npm registry latest metadata](https://registry.npmjs.org/@filen%2fsdk/latest) currently reports `@filen/sdk` **0.4.2**, Node >=20. Explicitly recheck and adopt the latest stable release during implementation, pin it exactly, and test integration compatibility; do not assume a newer version exists.
- Reference README claims: real-fruit-snacks emphasizes secret storage, memory-only mode, mass-change guards, trash, and plan preview; neddy3z emphasizes SDK cloud APIs, a pure decision table, exact SDK pinning, and release provenance. These claims still need source verification. The latter explicitly reports no real-account testing and plaintext derived credentials: do not copy that security model.

## Confirmed scope

The user selected a comprehensive, phased foundation upgrade: security, sync reliability, architecture, performance, testing, and release infrastructure, preserving existing UX.

Further source findings:

- `src/main.ts:809–815` actually persists the entered password through `PluginSecrets.setPassword`; the README's memory-only password claim is incorrect. Remove unnecessary raw-password persistence and safely clear legacy stored passwords as a priority.
- `loadSettings` already migrates legacy `data.json` auth into SecretStorage. Reuse and harden this migration rather than inventing another.
- Manifest currently targets Obsidian 1.11.4 and supports mobile; README still states 0.15.0. Verify SecretStorage support and align requirements.

## Confirmed source-level risks

- `FilenRemoteFs.rm` passes `permanent: true`: ordinary remote deletes are irreversible. Change ordinary sync deletion to trash, verified against installed SDK behavior.
- `SyncEngine.applySyncEntry` deletes the local baseline before local trash succeeds. Reverse ordering and cover failure/restart recovery.
- `detectLocalChange` writes baseline metadata during planning; make planning read-only and commit only validated outcomes.
- Plans capture metadata/hash before execution, while `pushLocal` rereads bytes later. Bind the hash and metadata to transferred bytes and revalidate before destructive writes.
- `normalizeRemotePath` only strips slashes; introduce explicit containment validation before remote-derived paths reach vault writes or remote operations.
- Existing sync already separates planning/application and confirms local deletions. Extend these seams instead of replacing the UX.

Scope excludes unrelated feature additions. No specific production issue reported; prioritize demonstrated audit findings.

## Approach

Keep current workflows and command semantics. Audit actual trust boundaries and failure paths first, then implement small, regression-tested hardening slices. Retain the official SDK unless evidence supports changing it; do not introduce custom cryptography merely to match a reference.

## Files to modify

Existing integration points:

- `src/secrets.ts`, `src/settings.ts`, `src/main.ts`: credential lifecycle and integration.
- `src/db.ts`, `src/sync-engine.ts`, `src/fs-remote.ts`, `src/path-filters.ts`: baseline isolation and sync safety.
- `src/obsidian-axios-adapter.ts`: transport boundary review.
- `test/`, `package.json`, `.github/`, `manifest.json`, `README.md`: regression coverage, dependency/build controls, API compatibility, accurate security disclosures.

New focused modules: `src/sync/planner.ts`, `src/sync/executor.ts`, `src/sync/coordinator.ts`, `src/sync/path-validation.ts`; tests under `test/`; `.github/workflows/release.yml`; `SECURITY.md`. Also inspect `esbuild.config.mjs`, `src/shims/fs-extra.ts`, and `src/file-version-modal.ts` for bundle and restore integration. Avoid restyling existing UI; only extend safety/auth controls.

## Reference assessment

- [neddy3z planner source](https://github.com/NeDDy3z/filen-obsidian/blob/main/src/sync.ts): confirms a pure planner/executor seam and explicit type-clash handling. Do not copy its delete branches blindly: local code already handles delete-versus-modify conflicts more conservatively.
- [real-fruit-snacks remote scan](https://github.com/Real-Fruit-Snacks/obsidian-filen-cloud-sync/blob/03829a23f887255121970a6aed83502410c4598d/src/sync/remoteScan.ts): explicitly aborts on metadata-decryption failures. Adopt that safety invariant, not its first-wins collision behavior or skipped unresolved parents.
- Reference README feature/security claims are inspiration, not a security audit or proof of correctness. Keep official SDK encryption; no custom protocol/crypto rewrite.

## Reuse

- Existing `PluginSecrets` in `src/secrets.ts` rather than another credential mechanism without cause.
- Existing `SyncDb` and migration mechanism in `src/db.ts`.
- Existing sync, ignore, activity, and version features; inspect reusable functions next.

## Steps

Land each phase independently with regression tests; security fixes need not wait for the entire refactor.

### 1. Behavioral test foundation and urgent safety fixes

- [ ] Extend `test/run-tests.mjs` using the existing Node test runner and esbuild for TypeScript fixtures; add in-memory vault/remote/DB fakes. Current tests only validate manifest/version metadata.
- [ ] Characterize current sync, push, pull, conflict-copy, ignore, auto-sync, and version workflows. Preserve command IDs and current one-way semantics rather than importing reference mirror semantics.
- [ ] Remove password persistence; clear the legacy password secret on migration; validate stored auth using `readFilenAuth`. Never fall back to plaintext persistence when SecretStorage is unavailable.
- [ ] Switch ordinary remote deletes to recoverable trash. Keep local trash behavior; commit baseline deletion only after successful deletion.

### 2. Authentication and storage isolation

- [ ] Add optional session-only derived credentials; switching modes clears persisted credentials safely. Clear password/2FA references after login and on disconnect/unload; do not claim guaranteed JavaScript memory erasure.
- [ ] Harden existing plaintext-auth migration with validation, write/read verification, serialized settings writes, and recoverable failure reporting. Do not destroy the only usable credentials before successful migration.
- [ ] Namespace baselines with a persistent local vault identity, Filen account ID, and resolved remote-root UUID. Target/account switches cancel the old run before opening another namespace.
- [ ] Copy and validate legacy records before marking migration complete; retain the old namespace for recovery. Legacy records cannot prove account/root identity: require explicit confirmation of the old binding, or preserve them quarantined and reconcile non-destructively. Never infer deletions from ambiguous history.
- [ ] Reject corrupt/unsupported schema versions rather than quietly opening an empty baseline. Keep metadata separate from file keys to avoid reserved-key collisions.

### 3. Validated scans and safe execution

- [ ] Add `src/sync/path-validation.ts`: reject absolute/traversal paths, dot segments, NUL/control characters, drive/UNC paths, and separator ambiguity before normalization. Validate remote roots separately; preserve Unicode names. Block affected runs on duplicate paths, case/Unicode collisions, or file/folder clashes rather than silently choosing a winner.
- [ ] Require complete validated scans before planning deletions; surface SDK tree/decryption errors. Narrow the catch-all recursive fallback to known supported fallback cases. A missing root must not be silently recreated and interpreted as an empty remote during an established sync.
- [ ] Extract `src/sync/planner.ts` from the existing two-pass engine. Supply content fingerprints as inputs; no network, vault, or DB mutation inside the planner. Defer hash-backfill writes until successful validation.
- [ ] Extract `src/sync/executor.ts`; revalidate local metadata/content and remote identity/version before overwrite/delete. Hash the exact bytes uploaded. If either side changed, skip/replan rather than apply a stale decision; do not promise cross-device atomicity unsupported by Filen.
- [ ] Preserve conflict copies before overwriting, allocate collision-free names, and abort if preservation fails. Stage local downloads in an ignored vault-local location with recoverable promotion; retain originals when promotion fails.
- [ ] Record pending destructive operations before execution and reconcile their outcome on restart before retrying. Commit successful per-file baselines, not a speculative whole-run snapshot. A timeout is an unknown mutation outcome, not permission to blindly retry.
- [ ] Extend existing delete confirmation with a bulk guard: require approval when destructive operations reach 20 files, or at least 5 files and 20% of existing destination files. Count deletes and overwrites per destination, exclude new files, and always guard an unexpectedly empty source. Keep existing local-delete confirmation. Automatic runs report blocked status; manual review confirms only the current plan and revalidates before apply.

### 4. Transport and lifecycle infrastructure

- [ ] Test and harden `createObsidianAxiosLike`: absent GET body, JSON/binary responses, non-JSON errors, status handling compatible with the installed SDK, and safe HTTPS endpoint handling. Never disable TLS validation or log auth headers/bodies.
- [ ] Implement bounded request deadlines and logical cancellation; document that `requestUrl` may not physically abort requests. Suppress late callbacks/baseline commits after cancellation and reconcile ambiguous writes before retry.
- [ ] Extract `src/sync/coordinator.ts` from `main.ts`: one run at a time, generation-bound target/auth state, queued edits during sync, lifecycle cleanup, and bounded backoff. Reuse existing debounce, pending-run, cooldown, and activity machinery.
- [ ] Keep `RemoteFs` as the SDK boundary; test current `fs()` cache behavior before selectively replacing fragile operations with UUID-based `cloud()` calls. Preserve version browsing/restoring and verify restore preconditions.
- [ ] Make connection test upload, download, compare bytes, then trash its uniquely named probe; report cleanup failure without hiding the primary error.

### 5. Measured performance and diagnostics

- [ ] Measure cold/warm scans, unchanged runs, attachment transfer memory, and API counts on synthetic 1k/10k-file vaults before optimizing. Avoid new parallel transfers until correctness is covered.
- [ ] Reuse validated per-run remote indexes and hash the upload buffer once. Keep bounded concurrency and a byte-budget for buffered transfers; do not evict safety checks for speed. Detect oversized transfers before allocation and report skipped files without treating them as deleted.
- [ ] Reuse activity logs for phase timing, counts, and sanitized error categories; redact credential material and response payloads. Keep logs bounded and disclose that filenames may be sensitive. No telemetry.

### 6. Release and migration gates

- [ ] Check npm's `@filen/sdk` latest stable dist-tag again at implementation time, review official release changes, and update to that version (not beta or Git main). The registry currently reports **0.4.2**, matching the existing `^0.4.2` declaration; if still latest, replace the caret with exact `0.4.2` rather than claiming a version upgrade. Update `package.json` and `package-lock.json` together and verify the resolved version/integrity.
- [ ] Treat the SDK update as a separately testable change after characterization tests and before SDK-dependent refactors. Verify saved-auth compatibility, login/2FA, request adapter behavior, listing/cache behavior, upload/download, trash, and version restore on desktop/mobile. If latest breaks compatibility, fix the integration before shipping; report blockers rather than silently staying on an older version.
- [ ] Align development/CI Node requirements with the chosen SDK (`0.4.2` declares Node >=20; README currently says 18+). Review transitive dependency/security changes and audit esbuild polyfills/browser bundle for accidental Node-only runtime requirements.
- [ ] Expand `.github/workflows/lint.yml` or replace it with CI covering `npm ci`, tests, typecheck/build, lint, and format checks; use least-privilege permissions and pinned actions.
- [ ] Add `.github/workflows/release.yml`: tag/version consistency, CI-built release artifacts, checksums and provenance attestations. Keep AGPL licensing and required source availability; do not copy reference licensing claims.
- [ ] Align README, manifest, versions mapping, and `SECURITY.md` with verified SecretStorage API compatibility, threat model, network use, recoverable deletes, and migration procedure. Keep desktop/mobile supported; use the lowest documented version supporting every chosen API.
- [ ] Roll out on scratch vaults first, then backed-up existing installations. Document rollback: preserve baseline migration copies, stop sync before downgrade, and never restore deprecated password persistence.

## Migration requirement

Preserve existing installations, settings, and sync history. Plan explicit, failure-safe credential and baseline migrations; never silently discard a baseline or reinterpret its absence as permission to delete. Vault files must remain safe throughout upgrades.

## Verification

- Automated: credential migration failures/malformed secrets/session-only reload; malicious paths and collisions; same-name vault and account/root isolation; incomplete scans; metadata drift; exact upload hashes; delete-vs-edit and edit-vs-edit; first sync; failures before/after each transfer and DB write; restart reconciliation; stale confirmations; retries/cancellation/unload; HTTP response matrix; version restore and conflict-copy failures.
- Required invariants: no ordinary permanent deletion; no password/auth in settings or logs; no write outside the selected roots; no deletion inferred from incomplete or untrusted state; no baseline advancement before verified success; subsequent unchanged sync converges without repeated transfers.
- Run `npm run test`, `npm run build`, `npm run lint`, and `npm run fmt:check` during implementation. CI must run the behavioral suite, not only metadata checks.
- End-to-end on desktop plus iOS/Android scratch vaults: login/restart/disconnect, session-only mode, all existing commands, activity/status, auto-sync, offline/reconnect, large files, versions, trash recovery, and two-device concurrent edits. Verify migration with an existing-install fixture and failure injection before using real notes.
- Measure performance before/after using identical fixtures; accept optimizations only if they improve measured cost without weakening safety or increasing peak memory beyond the explicit transfer budget.
- API/SDK capabilities (SecretStorage version, trash behavior, remote revision checks, cancellation limitations) are implementation gate checks against official declarations/docs and the pinned SDK. Fail closed or document limits rather than invent guarantees.
- No builds, installs, live account operations, or code changes were performed during planning.

## Open decisions

- Confirmed: comprehensive phased upgrade, with exceptional safety confirmations for unusually large destructive changes; normal sync UX remains unchanged. Define guard thresholds and overwrite/delete counting during sync-engine review.
- Confirmed: keep desktop and mobile support; raising the minimum Obsidian version for supported secure APIs is acceptable. Determine the exact minimum from official API documentation.
- Confirmed: remember derived credentials in Obsidian SecretStorage by default; never persist raw passwords; offer optional session-only authentication. Disclose that stored derived credentials grant account access and do not protect against malicious plugins or compromised devices.
