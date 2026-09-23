# Audit safety fixes

## Context

Verify the seven reviewer findings and address credential exposure and sync data-integrity risks. Planning only; no implementation changes yet.

Initial inspection confirms plaintext legacy-auth reserialization, settings-based rather than authenticated target DB binding, unverified legacy baseline copying, and missing upload/remote-delete revalidation. Remote walk omits even the UUID supported by its entry type.

## Approach

Fail closed on ambiguous credentials, target identity, and concurrent mutations. Keep untrusted old history out of the active baseline. Preserve existing conflict-copy and trash protections.

## Files to modify

- `src/main.ts`, `src/db.ts`, `src/settings.ts`
- `src/fs-remote.ts`, `src/sync/executor.ts`, planner/types/engine
- Request adapter, onboarding copy, related tests and documentation (details pending inspection)

## Reuse

- `readFilenAuth`, SecretStorage write/readback verification in `src/main.ts`
- `getVaultRemoteRoot`, coordinator engine invalidation
- `validateSyncPath`, executor hashing and conflict-copy helpers

## Steps

- [x] **Credential migration:** Remove `legacyAuthPending` serialization entirely. Valid legacy auth may move to SecretStorage with existing readback verification; invalid auth or storage failure requires reconnection. Strip auth from persisted plugin data in all migration branches, without logging its contents. If sanitizing persistence fails, surface the failure and disable sync rather than claiming migration succeeded. Keep password/2FA session-only.
- [x] **Verified target binding:** Persist a random local vault ID independent of vault name/device ID. Resolve authenticated `userId` and effective remote directory UUID before opening the baseline or constructing an engine. Use a collision-resistant encoding/digest of the complete identity tuple, not lossy/truncated sanitization. Record and validate binding metadata. Fail closed with no old DB fallback. Keep startup offline/light; bind lazily when connecting/syncing.
- [x] **Target lifecycle:** Serialize preparation and gate new mutations while settings/auth change. Use generation checks so stale asynchronous target preparation cannot install an old DB. Drain in-flight work before disposing old resources; prevent further old-plan operations. Rebind for login, logout, credential replacement, remote-root/vault-name changes, and resolved directory replacement. Route manual force-sync through the same binding gate. Keep each run's settings/remote/DB binding immutable.
- [x] **Legacy history:** New bound namespaces must never automatically copy unbound legacy or v2 history. Preserve old stores untouched and explain the conservative first sync to users. Only migrate schema within an exactly verified binding. With no trusted baseline, absence alone must not imply deletion; differing same-path content must preserve a conflict copy in normal two-way sync. Establish a baseline for verified equal content as well as transfers.
- [x] **Fingerprints and planner:** Extend remote entries, planner inputs and baseline records with UUID and optional remote content hash. Populate walk/stat consistently with normalized timestamps and uncached metadata; inspect SDK 0.4.2 APIs to select supported cache bypasses. Propagate fields through the engine (currently discarded). Compare remote fingerprints before unchanged fast paths. Remove copied baseline-as-current local hashes; compute current hashes where equality is required, including ambiguous equal-size/mtime first sync. Missing fingerprints must not be fabricated or trusted as equality.
- [x] **Mutation safety:** Carry expected presence/absence and fingerprints to remote mutation helpers. Re-read/re-stat local content around upload reads and before committing; upload the validated bytes and persist their actual metadata. Revalidate remote destination before upload and remote source before trash deletion; delete the verified UUID rather than resolve the path again. Recheck local absence before remote deletion. Guard conflict, download and force-upload paths consistently so concurrent newly created files are not silently overwritten. Commit fresh remote identity after successful transfers, not the previous UUID. Drift returns an explicit replan-needed outcome, leaves the baseline unchanged, invalidates cached scans, and requests a bounded fresh pass; persistent churn produces a visible retry-needed result. Client revalidation narrows races but is not server-side compare-and-swap; document remaining limitations if the SDK lacks conditional mutations.
- [x] **Transport uncertainty:** Respect positive caller timeouts without capping them; honor explicit zero as no deadline and use a documented configurable adapter default when omitted. Thread upload timeout policy through chunk transfers. Distinguish pre-dispatch cancellation from timeout/abort after dispatch. Track outstanding requests, block overlapping mutation retries while they can still complete, and require fresh reconciliation before further mutations; never advance a baseline on an uncertain result. Inspect and neutralize SDK automatic retries for uncertain mutations, preserving safe read retries. Ensure late settlements cannot produce unhandled rejections or misleading success. Persist a non-secret reconciliation-needed marker so reload cannot silently resume an old plan; unresolved late-write risk must block mutations rather than rely on one immediate scan.
- [x] **Disclosure and review:** State that remembered derived session tokens/keys are stored in Obsidian SecretStorage, while password/2FA stay in memory. Document inactive legacy history, reconnect behavior, target binding and uncertain-transfer recovery. Review the complete diff for credential leakage and destructive fallback paths.

## Files to modify (expanded)

- `src/main.ts`, `src/auth.ts`/existing SecretStorage helper as needed, `src/db.ts`, `src/settings.ts`
- `src/fs-remote.ts`, `src/sync/types.ts`, `src/sync/planner.ts`, `src/sync/executor.ts`, `src/sync-engine.ts`, `src/sync/coordinator.ts`
- `src/obsidian-axios-adapter.ts`, `src/sync/chunk-transfers.ts`, `src/onboarding-modal.ts`, `README.md`
- `test/run-tests.mjs`; add focused test modules if needed using the existing harness. Extract target-binding/uncertainty helpers into focused modules rather than enlarging `main.ts`.

## Reuse (expanded)

- Existing coordinator single-run gate, auto-sync scheduling, status callbacks, cache invalidation and bulk/local-delete confirmation flows.
- `FilenRemoteFs.getClient`, `getParentUuid`, `stat`, and safe trash behavior; expose verified target identity without duplicating authentication.
- Existing executor `sha256Hex`, conflict-copy helpers and path validation; chunk-transfer SHA-512 metadata remains a separate remote digest.

## Verification

- Regression tests first for malformed legacy auth, SecretStorage failure, repeated saves and sanitization failure: no auth payload ever passed to `saveData`.
- DB/target tests: same-name vaults, long/sanitization-colliding roots, different authenticated users with unchanged email, effective vault subfolders, recreated root UUID, switching during sync, racing preparation and failed reopening. Verify no foreign baseline is read or mutated.
- Migration tests: unbound old history stays untouched/inactive, bound schema upgrades remain supported, fresh baseline never infers deletes from absence, equal-content first sync records a baseline.
- Planner/executor tests: equal-size/mtime remote hash or UUID changes, real local edits previously masked by baseline hashes, digest-algorithm separation, missing hash fallback, local mutation during read/upload, remote replacement before delete/upload, concurrent local recreation, stale plans and bounded replan behavior. Assert no baseline commit for skipped/uncertain items.
- Adapter/chunk/coordinator tests with controlled promises/timers: timeout over 60 seconds, explicit zero, configured default, pre/post-dispatch abort, late success/failure, SDK retry behavior, blocked overlapping mutations, full reconciliation and reload recovery markers.
- Run `npm test`, `npm run lint`, `npm run fmt:check`, and `npm run build` after implementation; no installs or artifact commits.
- Manual checks in a disposable Obsidian vault: migration/reconnect disclosure, account and root switches, conflict copies/trash, concurrent edits from another client, slow transfer uncertainty, and unload/reload. Inspect plugin data for credentials without printing secrets. Real Filen/Obsidian checks require an authorized test account; report any unavailable checks explicitly.

## Decisions and verified details

- User approved safety-first migration: require reconnection when credentials cannot be validated; leave unverified legacy history inactive rather than importing it.
- All seven findings are supported by current code. Qualification for #2: remote-root/vault-name settings already call `refreshSyncTarget`, but the DB still uses email/raw root and failed reopening retains the previous DB. Fix binding and failure behavior, not merely add another refresh call.
- Additional directly related bug: `src/sync-engine.ts` labels the previous baseline hash as the current local hash. Planner fast paths can therefore suppress real edits. Remove this shortcut; only freshly computed hashes count as current content evidence.
- Uploader metadata uses SHA-512 while executor baseline hashes use SHA-256. Keep remote and local digest fields distinct; never compare them as if they used the same algorithm.
- SDK `version` is typed as `FileEncryptionVersion`, not a mutation revision. Do not use it as a change token. Use actual file UUID and available content hash, with conservative fallback when hash is absent.
- Adapter confirms a 60-second cap and non-cancelling Promise.race. Both timeout and abort after dispatch can leave an uncertain server result.
