# Remotely Save compared with Filen Sync

## Scope and evidence

This report compares implementation, optimization, UI, safety, security, and maintainability. It replaces the earlier adapter-design note with a comparison against the actual implementation now in this repository.

- **Upstream snapshot:** `remotely-save/remotely-save` commit [`34db181af002f8d71ea0a87e7965abc57b294914`](https://github.com/remotely-save/remotely-save/tree/34db181af002f8d71ea0a87e7965abc57b294914), fetched from the default branch for this investigation.
- **Local snapshot:** Filen Sync commit `995787f9a2bb0876c657fed0b7ea1efceab58d60`. Local citations below refer to files at that snapshot. [Local package metadata][f-package]
- **Method:** direct inspection of first-party source and repository documentation. Search was used for discovery, not as evidence for implementation claims. Neither plugin was run inside Obsidian, and no live Filen/provider benchmarks were performed. UI observations describe implemented behavior, not a visual usability test. Recommendations are explicitly proposals, not existing features.

### Executive conclusion

**Keep Filen Sync's engine; borrow selected product and diagnostic ideas rather than replacing it with Remotely Save.** Both reconcile local files, remote files, and a last-successful baseline. Filen Sync already adds content fingerprints, remote identity tracking, edit-path hints, conservative conflict preservation, and target-bound history. Remotely Save contributes particularly useful examples of dry runs, persistent sync plans, stage profiling, explicit direction modes, and localized settings. These are complementary, not evidence that one plugin is universally faster or safer. [R-sync][R-types][R-main][R-profiler][F-engine][F-planner][F-db]

## 1. How Remotely Save works

### 1.1 Architecture and filesystem interface

`FakeFs` is the shared abstraction for local storage, remote providers, and the encryption decorator. Its contract includes `walk`, `walkPartial`, `stat`, `mkdir`, binary reads/writes, rename, removal, connectivity checking, and authentication-related methods. `FakeFsLocal` adapts the vault; `fsGetter.ts` selects a provider; `FakeFsEncrypt` wraps that provider. This lets the engine work with common file entities rather than provider-specific calls. [R-fs][R-local][R-getter][R-encrypt]

The public README lists S3-compatible services, Dropbox, OneDrive App Folder, WebDAV, and Webdis, plus paid integrations including Google Drive, Box, pCloud, Yandex Disk, Koofr, Azure Blob Storage, and full OneDrive access. **It does not list a native Filen backend.** Multi-provider compatibility is the upstream product's main architectural difference from this Filen-specific plugin. [R-readme]

### 1.2 Current V3 execution pipeline

The implemented `syncer` does the following:

1. Checks availability of configured paid features, then validates the encryption password/method against the remote.
2. Lists the remote through the encryption wrapper.
3. Lists local entities and loads previous successful records for the vault/profile.
4. Combines those inputs, applies filters, and assigns per-path decisions.
5. Saves the generated plan locally, including on a dry run.
6. For a non-dry run, checks mass-change protection and executes ordered operations.
7. Saves optional profiling data and updates notification, ribbon, and status callbacks. [R-sync]

The algorithm distinguishes creation, modification, deletion, conflicts, and already-equal entries. The ordinary equality branches primarily compare client/server timestamps and effective encrypted sizes; they are **not equivalent to Filen Sync's local SHA-256 and remote UUID/hash checks**. Provider timestamp normalization includes rounding S3/Dropbox timestamps to seconds. Do not turn this into an unsupported claim that every provider uses a content hash to decide equality. [R-sync][F-planner]

The main execution phases are: record equal entries, create folders shallowest-first, delete deepest-first, then transfer files. Each level uses `p-queue`; configured concurrency defaults to **5**. Successful operations update previous-sync records, and three accumulated operation errors pause/clear the remaining queue. This is per-file progress, not an atomic transaction across the vault. [R-sync][R-main]

### 1.3 Baseline and deletion model

V3 relies on a **local previous-successful baseline**, not a continuously uploaded tombstone/manifest sidecar. The official minimal-intrusion document says remote metadata files were needed in older versions but are no longer required from 0.4.1. The source still contains legacy metadata names/migration handling; their presence does not mean the normal V3 pass uploads a remote manifest. [R-minimal][R-design][R-sync]

`localdb.ts` stores previous-sync records under vault/profile/path keys, plus sync plans, success/failure timestamps, and profiler results. Plan cleanup includes age/count limits (one day/20 records). Local state enables deletion detection: missing on one side plus unchanged on the other propagates the deletion; a modified survivor is preserved by pushing or pulling it. A new device without history cannot infer every historical deletion. The last point is an implication of the three-state model, not a verified upstream defect. [R-db][R-design]

### 1.4 Conflicts and directions

The actual conflict type is `keep_newer`, `keep_larger`, or `smart_conflict`. The free options select a winner; the paid smart option merges eligible Markdown or duplicates other content. There are not general `keep_local`, `keep_remote`, and `skip` strategies in this type. [R-types][R-readme]

Smart merge is more specific than “fall back to newer on failure”: eligible `.md`/`.markdown` files have a size limit of **1,000,000 bytes**. It can use stored original content for a three-way merge, or construct an LCS-based ancestor for a two-way merge when there is no original. Conflict markers are Markdown-escaped. Larger/non-Markdown files take duplication paths. This can preserve changes but also creates semantic risk when no trustworthy ancestor exists. The semantic-risk assessment is this report's inference. [R-conflict][R-pro-types][R-sync]

Upstream exposes five directions: bidirectional, incremental pull, incremental push, and pull/push variants that propagate deletions. Their exact decision tables matter: “push” is not merely “ignore remote changes,” and non-delete incremental modes deliberately avoid some destructive operations. [R-types][R-design][R-sync]

### 1.5 Scheduling and UI

Remotely Save supports manual sync, a dry-run command, periodic sync, delayed startup sync, and sync-on-save. Its save-event handler is throttled at three seconds and checks the **active file's modification time** against last success; it also tracks a pending save-triggered sync. Do not infer that every create/delete/rename event is independently planned from that event's path. [R-main]

UI includes provider/basic/advanced settings, password and encryption-method confirmation dialogs, ribbon/status updates, exported sync plans, a profiler, and QR/URI settings transfer. Text is routed through an i18n layer with language dictionaries. These are useful examples for discoverability and support, not a mandate to reproduce the large provider-specific settings page. [R-main][R-settings][R-import][R-i18n]

### 1.6 Mobile syncing progress: what the UI actually shows

**Remotely Save uses a ribbon state icon, manual-run notices, and an optional text status bar—not a dedicated mobile percentage/byte-progress overlay in the inspected implementation.** The mobile status-bar workaround is disabled by default (`enableMobileStatusBar: false`); status information itself defaults to enabled. On mobile, the status item is created only when both options permit it. [R-main][R-settings]

To enable the extra surface, open **Settings → Remotely Save**, find the advanced setting **Mobile Status Bar (experimental)**, and select **Enable**. Also ensure **Show Last Successful Sync In Status Bar** is enabled; changes to that setting can require reloading the plugin. These are the literal English labels from upstream. [R-settings][R-en]

**Illustration reconstructed from source—not an actual device screenshot.** Other Obsidian status-bar items and exact layout vary by device/theme:

```text
Default mobile behavior (extra status bar disabled)
┌──────────────────────────────────────┐
│ Obsidian note                        │
│                                      │
│   Manual sync: transient notice      │
│   “1/2 Remotely Save starts running   │
│    (s3)”                             │
│                                      │
│ Ribbon: idle icon → running icon     │
│ No persistent file-count status text │
└──────────────────────────────────────┘

With experimental mobile status bar enabled
┌──────────────────────────────────────┐
│ Obsidian note                        │
│                                      │
│                                      │
├──────────────────────────────────────┤
│ Manual: Syncing 03/12                 │ ← text status item
├──────────────────────────────────────┤
│ Obsidian mobile navigation / toolbar │
└──────────────────────────────────────┘

After successful completion:
  Successfully synced just now

Automatic save-triggered run:
  Auto (save): Syncing 03/12
```

The illustrated notice's `1/2` is a **coarse workflow step**, not half of the bytes/files transferred. In the default info log mode, manual runs show start/finish notices; more verbose mode also shows intermediate stages. Notices are gated to `manual`/`dry`, so normal automatic sync does not continuously produce progress popups. The ribbon changes icon at sync start and resets at finish; this is an icon-state change, not evidence of an animated spinner. [R-main][R-en]

**Text progress implementation:** execution calls `callbackSyncProcess`, which delegates to `setCurrSyncMsg`. That method zero-pads the current operation counter to the total's digit width and writes a trigger prefix plus `Syncing current/total` using `setText`. It places the decision, file path, and trigger in `aria-label` and `currSyncMsg`, not in the compact visible text. Do not assume the desktop-style tooltip is easily discoverable by touch. [R-main][R-sync]

```text
syncer → doActualSync → callbackSyncProcess
       → setCurrSyncMsg
           visible:    Manual: Syncing 03/12
           aria-label: Manual: Syncing progress=03/12,
                       decision=…,path=notes/today.md,source=manual
```

**Counter caveat:** the queue invokes the progress callback before incrementing its counter and before awaiting the actual operation. Thus this is operation-dispatch progress, not a verified count of completed transfers, and it is not a byte-weighted percentage. When the pass ends, the UI replaces it with relative success/failure time instead of maintaining a `12/12` completion display. [R-sync][R-main]

**How it makes the mobile status bar visible:** `changeMobileStatusBar` queries `.is-mobile .app-container .status-bar`, sets inline `display: flex`, and offsets it using `margin-bottom` equal to the mobile navigation bar's computed height. A `MutationObserver` watches direct child additions to the app container for mobile navigation/toolbar elements; it waits 300 ms before recalculating height. Disabling the option disconnects the observer and removes those inline styles. This changes Obsidian's normally hidden status bar rather than mounting an independent plugin panel. [R-mobile]

**Trade-offs for Filen Sync:** the compact persistent count is a useful optional UX pattern, but copying this DOM workaround would couple the plugin to Obsidian's internal classes and affect the shared status bar. Filen Sync already has actual completed-action counts and chunk-byte progress, plus on-demand mobile notices. Prefer its existing ribbon/menu and an optional plugin-owned compact surface if persistent progress is desired; label scanning separately from transferring, and keep automatic updates quiet. These are recommendations, not implemented changes. [F-engine][F-coordinator][F-notice][F-presentation]

## 2. How this Filen Sync plugin works

### 2.1 Lifecycle, target, and transport

`main.ts` wires settings, commands, credentials, target preparation, coordinator, status/ribbon UI, logs, and version history. `SyncCoordinator` serializes runs and schedules automatic work. `SyncEngine` builds a plan; `planSync` is a pure function; `SyncExecutor` applies it; `FilenRemoteFs` owns Filen operations. The separation already exists even though several modules remain large. [F-main][F-coordinator][F-engine][F-planner][F-executor][F-remote]

The remote target is a folder mirror, with authenticated user/root UUID resolved before opening history. `SyncDb` binds its database name and metadata to **vault ID + user ID + remote-root UUID**, rejects mismatched/corrupt bindings, and validates stored paths. This is a meaningful safeguard against applying one account/root's deletion history to another. [F-db][F-remote]

The plugin pins `@filen/sdk` to `0.4.2`. It injects an Obsidian `requestUrl`-based HTTP adapter, requires HTTPS, and tracks uncertain mutation outcomes after deadline/abort. A timed-out operation is not assumed to be cancelled remotely; reconciliation state is persisted through lifecycle wiring. This is worth preserving. The adapter's certificate-store explanation is a source comment, not independently verified platform behavior in this investigation. [f-package][F-http][F-main]

### 2.2 Plan and safe apply

The engine scans and filters local/remote entries, checks path collisions, loads baseline records, and calls the pure planner. Local records include SHA-256 content hashes; remote identity/content evidence includes UUID and optional validated SHA-512. On first sync, matching time/size is not sufficient: content equality must be established, using Filen's hash when available or a downloaded remote digest otherwise. [F-engine][F-planner][F-hash]

Before apply, mass-delete/overwrite guards can require confirmation. The defaults are **20 destructive files**, or **20% with at least five destructive files**, plus unexpected-empty-side checks when baseline count is at least five. Local deletions also receive a separate confirmation path. Silent auto-sync refuses required confirmations and waits for manual intervention rather than opening a destructive prompt unattended. [F-bulk][F-engine][F-coordinator]

Execution revalidates local content/metadata and remote identity where implemented, writes a baseline after completed work, and retries one fresh engine pass for recognized replan errors. The coordinator provides additional bounded auto-retries/hold behavior. These checks narrow race windows; they do not prove that all writes are server-side compare-and-swap or that vault sync is atomic. [F-executor][F-remote][F-engine][F-coordinator]

### 2.3 Conflicts and directional caveats

For normal bidirectional conflicts where both copies exist, the planner selects the newer timestamp (local wins ties), and the executor saves the losing content as a local conflict file before applying the winner. There is no automatic text merge. Delete-versus-modify cases restore the modified survivor and can report a conflict **without creating another copy**. [F-planner][F-executor]

Local `push`/`pull` commands are not interchangeable with upstream's incremental directions:

- A local-only unchanged baseline file in `push` mode is re-uploaded after remote deletion.
- An unchanged remote survivor after local deletion is deleted remotely in `push` mode; `pull` restores it locally.
- If both files changed, `push`/`pull` overwrite the destination, rather than taking the bidirectional conflict-copy path.
- Delete-versus-modify handling may still upload in `pull` or download in `push` to preserve the survivor. [F-planner][F-executor]

**Recommendation:** make those semantics explicit in command descriptions/confirmation UI. “Push changed local files” can otherwise be read as “only uploads, never remote deletions or local downloads.” This is a UX inference from the implemented branches, not a reproduced user report. [F-main][F-planner]

### 2.4 Existing optimizations

The engine has five-minute remote-tree and local-snapshot TTLs. Automatic passes can probe Filen user events; unchanged remote state can reuse a cached tree. If both snapshots are valid, no remote changes are reported, and hints are file-level, a narrow pass plans the queued candidate paths. Manual, initial, and explicitly full-scan passes force scans; folder changes invalidate eligibility for the narrow path; probe failures fall back conservatively. [F-engine][F-remote]

The coordinator tracks path revisions, including old/new rename paths, so edits arriving during a run are not blindly cleared. It invalidates local hash cache entries on vault events, debounces saves, enforces a minimum gap, retries transient failures with bounded backoff, and reacts to focus/visibility/online events. This is more directly path-aware than upstream's active-file save handler. [F-coordinator][R-main]

Transfer behavior has two levels:

- Up to **two small-file** upload/download actions in parallel by default.
- Files at least **8 MiB**, deletes, conflicts, and other actions remain serial.
- Each file uses **1 MiB chunks with three chunk workers**.
- A mutation session reuses directory UUID information and postpones SDK cache reset until the session ends. [F-engine][F-chunks][F-remote]

The local benchmark tests measure mocked reads/tree calls/SDK resets and concurrency. They are regression evidence for workload behavior, **not real-cloud throughput results or proof that Filen Sync outperforms Remotely Save**. [F-bench]

### 2.5 UI already implemented

This plugin includes account setup, desktop status/ribbon interaction, a mobile sync menu, manual on-demand progress, activity logs, pause/resume, initial sync, directional commands, conflict review, and a file-version modal with grouped revisions, preview/diff, and restore. Its Filen-native recovery UX is a strength to retain. [F-main][F-settings][F-version][F-logs]

Important implementation detail: floating/mobile indicator and automatic progress-notice helpers currently return `false`; the notice controller says automatic compact notices are retired and only renders on demand. A stored setting/name for a floating indicator is therefore **not evidence that an automatic overlay is active**. Progress-notice updates are coalesced at 100 ms. [F-presentation][F-notice]

## 3. Comparison matrix

| Area                       | Remotely Save                                                          | Filen Sync                                                     | Assessment                                                                                 |
| -------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Backend scope              | Multiple providers; some paid                                          | Native Filen only                                              | Keep focused unless multi-provider support is a product goal. [R-readme][F-remote]         |
| Core reconciliation        | Local + remote + previous success                                      | Same model with content/identity evidence                      | No engine replacement needed. [R-sync][F-planner]                                          |
| Ordinary equality          | Time and effective encrypted size                                      | Local digest, baseline, remote UUID/hash, metadata             | Different correctness/cost trade-offs. [R-sync][F-planner]                                 |
| Normal conflicts           | Newer/larger; paid smart merge/duplicate                               | Newer winner with losing copy retained locally                 | Preserve copies; consider optional merge preview later. [R-readme][R-conflict][F-executor] |
| Directions                 | Five explicit modes                                                    | Three modes with their own preservation/deletion branches      | Document differences before adding parity. [R-design][F-planner]                           |
| Dry run / plan history     | Command and persisted plan export                                      | Planner exists, no registered preview/dry-run command          | High-value gap. [R-main][R-sync][F-main][F-planner]                                        |
| Mass-change guard          | Percentage setting, default 50                                         | Absolute + percentage + empty-side checks                      | Retain local conservative guards. [R-main][R-sync][F-bulk]                                 |
| Save-triggered work        | Throttled active-file check                                            | Revisioned changed-path queue and narrow planning              | Retain Filen approach. [R-main][F-coordinator][F-engine]                                   |
| Transfers                  | Configurable file-operation queue, default five                        | Default two small files; serial large files; three chunks/file | Tune by memory and request load, not concurrency alone. [R-sync][F-engine][F-chunks]       |
| Diagnostics                | Saved plans + optional stage profiler                                  | Activity logs + aggregate scan/plan/transfer/first-file timing | Add structured plan diagnostics. [R-profiler][R-db][F-engine][F-logs]                      |
| Config transfer / language | QR/URI settings transfer and i18n                                      | No equivalent observed in settings/commands                    | Useful optional conveniences after safety work. [R-import][R-i18n][F-settings][F-main]     |
| Recovery UI                | No comparable version-history command found in inspected main/settings | Filen revision preview/diff/restore                            | Keep native recovery as a differentiator. [R-main][R-settings][F-version]                  |
| Credentials at rest        | Obfuscated settings plus warning/gitignore                             | Derived auth in Obsidian SecretStorage                         | Do not copy obfuscation as a security mechanism. [R-config][R-readme][F-secrets]           |

## 4. Optimization opportunities, ranked

These are **proposals based on source inspection**, not verified performance regressions.

### P0 — Preserve safety while making it structurally explicit

1. **Replace copy-dependent guard logic with structured planner fields.** `checkBulkGuard` infers overwrite risk from strings such as `detail.includes("Remote changed")`. A wording/localization change can change protection behavior. Add explicit fields such as `destinationExists`, `destructive`, and a stable reason code; compute safety from those fields. Add planner-to-guard tests for every direction and conflict branch. [F-bulk][F-planner]
2. **Specify direction contracts.** Decide whether push/pull mean strict one-way incremental transfer, one-way mirroring with deletions, or the present preserve-survivor behavior. Maintain stable command IDs; explain or introduce modes deliberately rather than silently changing existing semantics. Upstream's explicit direction tables are a useful specification format. [F-main][F-planner][R-design]
3. **Keep revalidation and uncertain-write reconciliation.** Do not remove extra reads or replay timed-out mutations merely to improve a benchmark. Test remote replacement, edits during upload, and interrupted finalization before optimizing these checks. [F-executor][F-http][F-remote]

### P1 — Dry-run preview and diagnostic history

4. **Expose a preview-only engine API.** Return actions, counts, safety report, timings, and snapshot provenance without mkdir, transfers, deletions, or baseline writes. Calling the current `sync()` and stopping before executor is not a strict read-only solution: `sync()` begins with remote `mkdir("")`, and target preparation can resolve/create folders. Introduce a no-create target-resolution mode for a genuinely read-only preview. Replan on Apply rather than trusting an old preview. [F-engine][F-remote][R-sync]
5. **Persist bounded, structured plans locally.** Retain action/reason, trigger, direction, full/narrow/cache state, scan timing, result, and safety outcome. Provide opt-in export with filename redaction and no credentials. Upstream demonstrates useful saved plans/profiling; Filen's existing logs supply a UI entry point. [R-db][R-profiler][F-logs][F-engine]
6. **Instrument before raising concurrency.** Count tree/stat/events requests, local bytes read, hashes, SDK resets, retries, and peak active transfers. Benchmark cold initial sync, warm no-op, one changed note in a large vault, deep folders, and large attachments on actual desktop/mobile devices. Use the existing mocked workloads as regression checks, not production latency forecasts. [F-bench][F-engine][R-profiler]

### P2 — Memory and scan costs

7. **Reduce download reassembly duplication.** `downloadFileChunks` retains all decrypted parts, then allocates another full buffer; `toArrayBuffer` creates another copy before writing to Obsidian. Three workers bound concurrent requests, not total file memory. Consider a preallocated validated target buffer first; investigate streaming only if the SDK/vault contracts support it. Measure peak memory at 10/50/100 MiB before claiming mobile improvement. [F-chunks][F-executor]
8. **Optimize full-scan hashing only with a trust model.** Manual/initial/full scans force local hash reads; uploads also re-read/hash for race protection. A large vault with a few edits can therefore spend time before the first transfer. Reusing stable cached hashes on automatic work already exists. Any broader reuse must preserve detection of same-size/same-mtime content changes and missed file events. [F-engine][F-executor][F-cache]
9. **Use a global resource budget if adding adaptive concurrency.** Two simultaneous small files can each have three chunk workers, plus metadata calls. Expose a conservative mobile preset or byte/request semaphore before increasing the file pool to upstream's five. Neither plugin's default is a measured universal optimum. [F-engine][F-chunks][R-main]
10. **Treat the events endpoint as an invalidation hint, not an authoritative delta feed.** Current code requests account-wide `filter: "all"`; any returned event marks the remote dirty. Verify ordering, retention, pagination, watermark boundaries, and root-scoping against the pinned Filen API before refining this cache. TTL expiry, manual/full scans, and probe-error fallback remain necessary. Those endpoint guarantees were not researched here. [F-remote][F-engine]

## 5. UI proposals

These recommendations extend existing interfaces rather than copying upstream's entire settings page.

- **Preview changes:** show uploads, downloads, overwrites, deletes, conflicts, skipped files, reasons, and the verified remote target before Apply. Clearly distinguish preview from a finished sync. Upstream's dry command is the precedent; Filen's pure planner is the starting point. [R-main][F-planner][F-main]
- **Explain directional actions:** for example, “Push may delete remote files that were deleted locally”; show when conflict preservation permits a reverse transfer. Use the implemented branch table as the source of truth. [F-planner][F-main]
- **Dedicated conflict review:** expand the current command/menu into a list with original/copy locations, side-by-side diff, and explicit keep-local/keep-remote/keep-both actions. Preserve originals before any optional automatic merge. The present command opens a conflict file; upstream merge behavior shows why blind merges need caution. [F-main][F-executor][R-conflict]
- **Diagnostics drawer:** surface actual full/narrow/cache mode, last successful sync, pending local changes, required confirmation, retry deadline, and logs/export. The coordinator already exposes many of these states. [F-coordinator][F-main]
- **Settings cleanup:** remove or clearly retire settings whose floating-indicator behavior is disabled. Keep quiet automatic mobile behavior and on-demand progress as the current default unless usability testing supports a change. [F-presentation][F-notice][F-settings]
- **Optional safe setup sharing:** initially export only nonsecret folder/filter/schedule options. Do not export Filen derived auth/master keys in a QR code by default. Upstream's URI mechanism is convenience, not a security boundary. [R-import][F-secrets]
- **Localization later:** centralize UI strings and stable reason codes, especially before translating settings. Never make business logic depend on translated message text. [R-i18n][F-bulk][F-main]

## 6. Security, licensing, and maintenance

### Encryption is not the same feature in both plugins

Remotely Save's optional password-based wrapper encrypts **both names and content**, supporting OpenSSL and rclone formats; the README warns that the vault base name remains visible for relevant providers. Without a password it does not provide that extra encryption layer. Filen Sync uses the SDK's encryption for chunk payloads and metadata/file names as part of the Filen-native format. This investigation verifies calls and representation in plugin code, not the SDK's cryptographic correctness or a security audit of either scheme. [R-encrypt][R-encryption][R-readme][F-chunks]

Upstream settings obfuscation reverses/base64-encodes serialized configuration; it is not authenticated encryption or an OS secret store. Filen Sync places derived auth in Obsidian SecretStorage and keeps password/2FA in session fields. SecretStorage use alone does not justify claiming stronger OS-level encryption on every platform. [R-config][F-secrets][F-main]

### Licensing constrains reuse

**Publicly readable does not mean freely reusable.** `pro/src/sync.ts` and smart-conflict implementation are present in the public tree, but `pro/LICENSE` is PolyForm Strict 1.0.0: its grant excludes distribution and changes/new works based on the software. `src/LICENSE` is Apache-2.0, which has notice/license obligations. Do not copy the upstream engine or paid conflict code into this plugin without separate permission/legal review. Independently specify required behavior and implement within this project's own modules. This is a practical license caution, not legal advice. [R-pro-license][R-src-license]

### Module size and test strategy

At the reviewed local snapshot, `main.ts` is 1,535 lines, `coordinator.ts` 954, `sync-engine.ts` 789, `fs-remote.ts` 706, and `settings.ts` 613. These sizes exceed the repository's guidance to keep lifecycle minimal and consider splitting files around 200–300 lines. Upstream's large lifecycle/settings files should not be copied as a maintainability model. Suggested boundaries: command registration; target/auth lifecycle; status/ribbon presentation; scan/cache preparation; scheduling/retry policy; and transfer SDK internals. This is a maintainability recommendation, not a need to rewrite the planner. [F-main][F-coordinator][F-engine][F-remote][F-settings][F-guidelines]

The local test suite already includes planner/sync behavior, initial sync, coordinator UX, progress/indicators, logs, benchmark workloads, and remote filesystem tests. Prioritize new tests for strict read-only preview, structured guard classification, one-way mode contracts, stale event hints, large-file buffer bounds, and interruption/recovery. Neither test-file presence nor this inspection proves all current tests pass; no test run was performed for this documentation-only change. [f-package][F-bench]

Both depend on Obsidian's plugin runtime; timers and focus/visibility handling do not create a reliable OS background service. Upstream explicitly documents that automatic sync cannot be relied upon while the application is closed/backgrounded. Mobile foreground/resume tests remain necessary for Filen Sync. [R-background][F-coordinator]

## 7. Corrections to the previous note

1. The current sync engine is **publicly readable** at `pro/src/sync.ts`; its restrictive license, not missing source, is the reuse constraint. [R-sync][R-pro-license]
2. V3 normally does **not require remote metadata sidecars**. [R-minimal][R-sync]
3. Free conflict strategies are **newer/larger**, not generic keep-local/keep-remote/skip. Smart conflict means eligible Markdown merge or duplication, not simply a newer-file fallback. [R-types][R-readme][R-conflict]
4. Filen UUID is **object identity**, not a content hash. This plugin treats UUID and content hashes separately. [F-planner][F-remote]
5. Filen Sync has already implemented the remote adapter, planner, executor, baseline DB, caching, safety guards, and version UI. The next work is targeted improvement, not creating `fsFilen.ts` from scratch. [F-remote][F-engine][F-db][F-version]

## 8. Suggested implementation order

1. Write a direction/safety specification and replace string-inferred destructive flags.
2. Add strictly read-only preview plus a bounded, redacted plan history/export.
3. Measure real scan/transfer/memory costs, then reduce download buffer copies.
4. Expand conflict review and recovery UI.
5. Extract lifecycle/UI/scheduling modules, then consider localization and safe settings transfer.

Keep remote identity binding, conflict preservation, manual confirmation, full-scan escape paths, and uncertain-write reconciliation throughout. These priorities are this report's synthesis of the evidence above, not an upstream roadmap. [F-db][F-executor][F-engine][F-http]

## Sources

Upstream links are pinned to the researched commit. Local links are relative to this document.

[R-readme]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/README.md
[R-sync]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/pro/src/sync.ts
[R-types]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/baseTypes.ts
[R-main]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/main.ts
[R-fs]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/fsAll.ts
[R-local]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/fsLocal.ts
[R-getter]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/fsGetter.ts
[R-encrypt]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/fsEncrypt.ts
[R-db]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/localdb.ts
[R-design]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/docs/sync_algorithm/v3/design.md
[R-minimal]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/docs/minimal_intrusive_design.md
[R-conflict]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/pro/src/conflictLogic.ts
[R-pro-types]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/pro/src/baseTypesPro.ts
[R-settings]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/settings.ts
[R-import]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/importExport.ts
[R-i18n]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/i18n.ts
[R-profiler]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/profiler.ts
[R-mobile]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/misc.ts#L540-L619
[R-en]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/langs/en.json
[R-config]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/configPersist.ts
[R-encryption]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/docs/encryption/README.md
[R-background]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/docs/browser_env_no_background_after_closing.md
[R-pro-license]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/pro/LICENSE
[R-src-license]: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/LICENSE
[F-main]: ../src/main.ts
[F-settings]: ../src/settings.ts
[F-engine]: ../src/sync-engine.ts
[F-planner]: ../src/sync/planner.ts
[F-executor]: ../src/sync/executor.ts
[F-coordinator]: ../src/sync/coordinator.ts
[F-remote]: ../src/fs-remote.ts
[F-db]: ../src/db.ts
[F-bulk]: ../src/sync/bulk-guard.ts
[F-chunks]: ../src/sync/chunk-transfers.ts
[F-cache]: ../src/sync/local-hash-cache.ts
[F-hash]: ../src/sync/content-hash.ts
[F-http]: ../src/obsidian-axios-adapter.ts
[F-secrets]: ../src/secrets.ts
[F-version]: ../src/file-version-modal.ts
[F-logs]: ../src/activity-logs.ts
[F-notice]: ../src/ui/sync-notice.ts
[F-presentation]: ../src/ui/sync-presentation.ts
[F-bench]: ../test/benchmark-workloads.test.mjs
[F-guidelines]: ../AGENTS.md
[f-package]: ../package.json
