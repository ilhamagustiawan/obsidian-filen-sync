# Improving mobile change-scanning performance

## Scope and conclusion

Investigated local snapshot `7573e52ebd969f1af4b43e88f199a55a3540f142`, the installed Obsidian API **1.13.1**, and Filen SDK **0.4.2**. This is source-based research, not an Android/iOS performance measurement. Recommendations below are proposals; no runtime code was changed. Installed dependency implementation was inspected directly because upstream default-branch behavior can differ from the version bundled here. [F-engine][O-api][S-package]

**Highest-priority improvement: separate inventory reconciliation from forced content verification.** Today foreground/focus, reconnect, and the default three-minute interval request a full scan. In the engine, `fullScan` both disables incremental reconciliation and forces a fresh binary read plus SHA-256 for every included local file; it also bypasses the remote event/cache shortcut. This makes routine mobile wakeups much more expensive than ordinary edit-triggered sync. [F-coordinator][F-engine][F-cache][F-settings]

Retain manual/initial/preview verification, periodic missed-event detection, and immediate per-file mutation checks. Optimize how often the expensive path runs, not the safety checks just before writes/deletes. [F-engine][F-executor][F-tests]

## 1. What is already implemented

| Existing mechanism      | Actual behavior and limit                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault inventory         | `walkLocal()` uses `getAllLoadedFiles()` rather than recursively listing disk directories. Obsidian documents this method as returning files and folders. Replacing it with an adapter traversal would not remove the current hashing bottleneck. [F-engine][O-api] |
| Hash reuse              | `LocalHashCache` reuses SHA-256 only for the same `TFile` object, mtime, ctime, size, and an age under **five minutes**. Vault events invalidate paths, including same-stat edits. Forced scans bypass reuse. [F-cache][F-coordinator]                              |
| Edit hints              | Create/modify/delete/rename events populate a revisioned pending-path map; rename includes old and new paths. Eligible automatic runs read hinted files and their baselines only. [F-coordinator][F-engine]                                                         |
| Narrow-pass safety      | Narrow mode requires fresh local/remote snapshots, a successful no-change remote probe, file-only hints, no force flag, and no replan. Folder changes, stale caches, remote changes, and probe errors fall back to full reconciliation. [F-engine][F-tests]         |
| Remote tree cache       | Current source uses **five minutes**, not the 30-minute value mentioned in an older plan. `checkEvents()` uses account events with `filter: "all"`; any nonempty result is treated as change. [F-engine][F-remote][F-old-plan]                                      |
| First-sync equality     | Eligible no-baseline files with equal size/mtime compare local SHA-512 to validated Filen metadata; missing/invalid hashes fall back to downloading remote bytes. This optimization already exists. [F-engine][F-hash]                                              |
| Remote setup reductions | One-shot verified-root reuse, a scanned directory UUID index, and callback-scoped mutation sessions are already present. Do not propose these as new scan improvements. [F-remote]                                                                                  |

### Why mobile wakeups are expensive

The current path is:

```text
visible / focus / online / periodic interval
  → request or schedule auto-sync with fullScan = true
  → forceScan = isManual || initialSync || fullScan
  → walkLocal(..., forceScan = true): read and hash every included file
  → fresh remote tree (fast polling disabled)
  → equality resolution → planner → execution
```

Visibility and focus events already share a debounced queue, but a completed foreground sync does not establish a dedicated resume-reconciliation cooldown. A later foreground event can request another forced pass, subject to the existing minimum sync interval. [F-coordinator][F-engine]

The default interval is **three minutes**, whereas the content-hash cache TTL is **five minutes**. Because interval runs force hashes anyway, the longer hash TTL does not make these routine interval scans cheap. [F-settings][F-cache][F-coordinator]

## 2. Prioritized changes

### P0 — Measure the actual scan mode and its components

**Proposal:** record the trigger, actual selected mode, fallback reason, target-preparation time, event-probe time, local inventory/read/hash time, remote fetch/decrypt time, equality-resolution time, DB time, bytes read, and hash hits/misses. These are necessary to distinguish I/O, crypto, network, and scheduling costs; no speedup percentage can be inferred from source alone. [F-engine][F-coordinator][F-bench]

Current `scanMs` aggregates local scanning, remote scanning, baseline loading, and equality work. Engine `totalMs` starts after root ensure and event probing, and excludes coordinator target preparation; directory preparation is also outside `transferMs`. Diagnostic provenance is currently inferred from the presence of `scanHints`, not whether the engine actually selected narrow mode. Consequently, the existing summary is useful but insufficient for diagnosing wakeup latency or comparing scan modes accurately. [F-engine][F-coordinator]

Keep measurements local, bounded by existing diagnostic retention, without contents or credentials. Extend the existing deterministic benchmark rather than add telemetry. [F-bench][F-coordinator]

### P1 — Split scan policy into separate decisions

**Proposal:** replace the overloaded boolean internally with independent decisions such as:

- **Reconcile inventory:** enumerate all current paths and detect additions/deletions.
- **Refresh remote metadata:** probe/reuse the tree when allowed, otherwise fetch fresh metadata.
- **Verify contents:** bypass hash cache for explicit verification, expired entries, invalidated paths, or recovery.

A routine foreground/interval run can reconcile the complete local inventory while using still-valid hashes for unchanged files. Startup with an empty session cache will still hash files; manual, initial, preview, replan, and uncertain recovery should retain their existing conservative behavior until equivalent guarantees are tested. Events and TTL expiry must continue to discover same-stat changes. [F-engine][F-cache][F-tests]

**Important:** refreshing inventory must still find deletions and folder changes. Do not turn an interval run with no pending hints into “nothing to do”; an empty dirty set is not proof of an unchanged vault. [F-engine][F-planner][F-tests]

The narrow-mode decision currently also depends on local and remote snapshot TTLs. Hash freshness and snapshot freshness must remain separate: refreshing a snapshot must not extend every content hash's `checkedAt` without reading it. [F-engine][F-cache]

### P1 — Coalesce resume triggers without losing reconciliation

**Proposal:** retain the existing debounce and minimum-gap behavior, and introduce a single pending resume reconciliation with a freshness/cooldown decision. Merge focus plus visibility for the same foreground transition; do not suppress reconnect recovery or overdue content verification. [F-coordinator]

This is a policy change, not a request to simply disable foreground or periodic sync. Use recent successful inventory verification and cache age to select work, preserving revisioned pending paths when edits arrive during a run. Test event orderings before changing defaults. [F-coordinator][F-tests]

### P2 — Use bounded, byte-aware local hashing

`walkLocal()` currently awaits each binary read and SHA-256 serially. **Proposal:** benchmark a two-worker small-file pool using the existing draining `mapPool()`, with large attachments serial and a total in-flight byte budget. Avoid `Promise.all()` across an entire vault. Whole-file reads return `ArrayBuffer`s, and the hash helper copies a `Uint8Array` view with `slice()`, so worker count alone does not bound memory. [F-engine][F-pool][F-hash][O-api]

Preserve per-read stat/path checks and generation invalidation. Add a scan-level revision barrier so an edit to an earlier-completed file while a later file is being scanned prevents a stale snapshot from being treated as fresh. After workers drain successfully, prune hashes and validate collisions; do not publish a partial snapshot on failure. This barrier is a proposed additional defense, not an existing API guarantee. [F-cache][F-engine][F-pool]

Potential benefit is overlapping I/O and digest work, not a guaranteed twofold speedup. If mobile storage/crypto is already saturated, serial hashing may remain preferable. Measure wall time, responsiveness, and peak bytes on actual Android/iOS devices. [F-engine][F-hash]

### P2 — Avoid rereading first-sync equality candidates

A full local scan calculates SHA-256, then `resolveRemoteFileHashes()` rereads eligible no-baseline files to calculate SHA-512. **Proposal:** after baseline/remote metadata is available, identify candidates and calculate both digests from one binary read, returning only the hashes rather than retaining vault-wide buffers. Keep the existing SHA-256 baseline format and remote-download fallback. [F-engine][F-hash][F-db]

The optimized equality result must refer to the same stable bytes used for the local SHA-256, with post-read stat checks and event-revision validation. Do not simply compare a newly read SHA-512 and attach an older cached SHA-256; this would weaken equality proof under concurrent edits. Test edits between the two digest operations and failed metadata resolution. [F-engine][F-cache][F-tests]

A smaller benchmark candidate is avoiding the explicit typed-array copy when a view spans its entire backing `ArrayBuffer`; verify Web Crypto input handling and memory effects before changing it. Do not introduce a new incremental-hashing dependency unless large-file measurements justify it. [F-hash]

### P3 — Deepen incremental scanning only after the above

Narrow mode still traverses the complete cached local path set to rebuild collision validation, and hash invalidation loops over all cache keys even for ordinary file edits. **Proposal:** distinguish exact-file invalidation from subtree invalidation and consider a maintained collision index only if profiling shows this CPU work matters. Path case/normalization and file-versus-folder collisions must stay equivalent to full validation. [F-cache][F-engine][F-validation]

Remote account events also trigger conservative full rescans even when unrelated to this mirror. The SDK exposes typed event payloads, but the current adapter keeps only id/type/timestamp. **Proposal:** first collect event-type counts and establish completeness, ordering, pagination, boundary timestamps, move/delete ancestry, and unknown-event handling before considering mirror-scoped invalidation. The inspected API wrapper does not establish those server guarantees. Unknown events, gaps, failures, or ambiguous ancestry must require a refresh. [F-remote][S-events][S-user]

**Do not implement a remote delta cache from timestamp alone.** The current full refresh plus finite cache TTL is a safety fallback; retaining that fallback is essential if event handling is optimized. [F-engine][F-remote]

## 3. Primary-source constraints and rejected shortcuts

- **Do not replace binary hashes with `cachedRead()` strings.** Obsidian recommends cached text reads for displaying content and documents an external-write stale-cache window. Binary content fingerprints and transfer checks need byte-oriented semantics. The public API offers `readBinary()`, not `cachedReadBinary()`. [O-vault][O-api][F-executor]
- **Do not rely only on size/mtime or a last-sync timestamp.** Existing tests explicitly cover same-stat replacements, missed events, rename/delete, and changes during mutations. The planner prefers available content hashes over timestamp differences. [F-planner][F-tests]
- **Do not replace the remote tree fetch with per-folder recursion by assumption.** Installed Filen SDK `getDirectoryTree()` calls the directory-download API and builds a tree from its folder/file response, decrypting metadata. The current plugin already uses this method with `skipCache: true`; it is not a plugin-level request per directory. SDK file decryption promises are eagerly created, so remote decrypt scheduling is a separate possible hotspot requiring measurement. [F-remote][S-cloud][S-download]
- **Do not promise persisted hashes make cold-start scans trustworthy.** A saved baseline is not proof that bytes stayed unchanged while the plugin was unloaded. Persistent-cache trust would need a separate design for missed events and mandatory verification. Keep session caching first. [F-db][F-cache][F-tests]
- **Do not assume hidden configuration files are covered.** Obsidian states the Vault API only accesses app-visible files; hidden-folder files require the adapter. This investigation concerns the current Vault-based scan, not adding hidden-file sync. [O-vault][F-engine]

## 4. Verification plan

Extend the existing benchmark and safety fixtures with these workloads. Existing fixtures use mocked Obsidian/Filen objects and are not device throughput evidence. [F-bench][F-tests]

| Workload                                                     | Proposed acceptance evidence                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Foreground after 30 seconds, unchanged vault                 | One coalesced reconciliation; zero local content reads while hashes are valid; explicit remote-cache/probe decision.              |
| Three-minute interval, unchanged vault                       | Full path inventory without forced content reads for valid entries; overdue entries still verified.                               |
| One-file edit in a large vault                               | Read/hash the changed file only in eligible narrow mode; compare actual mode, baseline calls, and unrelated reads.                |
| Same-stat edit with event                                    | Event invalidation forces verification even when metadata matches.                                                                |
| Same-stat edit without event                                 | Finite verification deadline discovers it; foreground does not refresh the deadline without reading bytes.                        |
| Cold start / expired hashes / manual / preview               | Content verification remains fresh; compare serial versus bounded hashing and peak bytes.                                         |
| First sync with mostly identical content                     | Eligible candidates read local bytes once for both hashes, make no remote-content downloads, and establish a consistent baseline. |
| Remote change / event failure / folder rename / cache expiry | Conservative fallback; plans match a full fresh reconciliation.                                                                   |
| Edit during scan or failed worker                            | Drain in-flight work, reject/replan as required, and do not publish a partial or stale snapshot.                                  |
| Large attachments plus many notes                            | Enforced memory budget; no unbounded read/decrypt launch added by plugin changes.                                                 |

Record device, OS, Obsidian version, vault file count/bytes, included attachment distribution, network conditions, trigger, actual mode, per-stage wall time, read/hash counts, UI responsiveness, and peak in-flight bytes. Compare identical workloads before/after. Do not claim a device speedup until measured.

**Suggested delivery order:** diagnostics → independent scan policy → resume coalescing → bounded hashing → single-read equality → optional deeper incremental indexing. Start with policy changes because the source shows avoidable forced work on common mobile triggers; parallel hashing alone cannot eliminate that work. [F-coordinator][F-engine]

## Sources

Local links refer to the snapshot named above. SDK package files are authoritative for installed 0.4.2 behavior; upstream links are provided for navigation, not assertions of identical default-branch code.

[F-engine]: ../src/sync-engine.ts
[F-coordinator]: ../src/sync/coordinator.ts
[F-cache]: ../src/sync/local-hash-cache.ts
[F-executor]: ../src/sync/executor.ts
[F-planner]: ../src/sync/planner.ts
[F-remote]: ../src/fs-remote.ts
[F-hash]: ../src/sync/content-hash.ts
[F-db]: ../src/db.ts
[F-pool]: ../src/sync/pool.ts
[F-settings]: ../src/settings.ts
[F-validation]: ../src/sync/path-validation.ts
[F-tests]: ../test/sync-ux.test.mjs
[F-bench]: ../test/benchmark-workloads.test.mjs
[F-old-plan]: ../plans/mobile-experience-performance.md
[O-api]: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
[O-vault]: https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Vault.md
[S-package]: https://www.npmjs.com/package/@filen/sdk/v/0.4.2
[S-cloud]: ../node_modules/@filen/sdk/dist/browser/cloud/index.js
[S-download]: ../node_modules/@filen/sdk/dist/browser/api/v3/dir/download.js
[S-events]: ../node_modules/@filen/sdk/dist/types/api/v3/user/events.d.ts
[S-user]: ../node_modules/@filen/sdk/dist/browser/user/index.js

Installed sources inspected: `node_modules/obsidian/obsidian.d.ts` (Vault read APIs, inventory methods, and events); `node_modules/@filen/sdk/dist/browser/cloud/index.js` (`getDirectoryTree` and upload SHA-512); `node_modules/@filen/sdk/dist/browser/api/v3/user/events.js` (request/response wrapper); `node_modules/@filen/sdk/dist/browser/api/v3/dir/download.js`; SDK event type declarations and `user/index.js`. For upstream navigation: [Filen cloud source](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/master/src/cloud/index.ts), [events API source](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/master/src/api/v3/user/events.ts), [directory download source](https://github.com/FilenCloudDienste/filen-sdk-ts/blob/master/src/api/v3/dir/download.ts).
