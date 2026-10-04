# Faster mobile change scanning without weaker sync safety

## Problem Statement

Mobile users repeatedly wait for Filen Sync to check their vault when returning to Obsidian, reconnecting, or running periodic automatic sync, even when little or nothing has changed. Routine foreground and interval runs currently force every included local file to be read and hashed again and fetch fresh remote metadata. The existing edit-path hints and session hash cache therefore provide less benefit for common mobile workflows than they do for individual save-triggered runs.

Large vaults and attachments amplify redundant I/O, hashing, and memory pressure. Existing diagnostics combine several scanning stages and can report narrow provenance merely because hints were supplied, making it difficult to identify the work actually performed or assess an optimization reliably.

Users need faster routine checks without missing deletions, remote changes, or same-stat local edits, and without weakening conflict preservation, target binding, confirmation guards, or mutation revalidation.

## Solution

Make automatic change checking proportional to the work required. Separate full inventory reconciliation from forced content verification and remote metadata refresh, coalesce duplicate foreground triggers, and retain trusted session hashes until they are invalidated or expire.

Manual sync, initial sync, read-only preview, and conservative recovery continue to verify fresh state. Periodic reconciliation still discovers files and folders that were added or removed, and content verification remains bounded by the existing freshness deadline. Benchmark memory-bounded hashing and eliminate duplicate local reads during first-sync equality verification where correctness can be preserved.

Record the actual scan decisions and stage costs in bounded local diagnostics so improvements can be demonstrated rather than assumed. Do not introduce telemetry, new performance settings, or weaker safety modes.

## User Stories

1. As a mobile user, I want returning to Obsidian to avoid rereading unchanged files with valid hashes, so that routine sync checks finish sooner.
2. As a mobile user, I want focus and visibility notifications for the same return to the app to share one pending reconciliation, so that duplicate events do not cause redundant scans.
3. As a mobile user, I want periodic sync to reuse valid content evidence, so that automatic checks avoid unnecessary file reads.
4. As a vault owner, I want periodic sync to inspect the complete included inventory, so that additions and deletions are found even without queued edit hints.
5. As a vault owner, I want folder additions, deletions, and renames reconciled, so that faster scanning does not leave the mirror structure incorrect.
6. As an editing user, I want a small number of edits to use the existing narrow pass when eligible, so that unrelated files do not require content reads.
7. As an editing user, I want a rename to include both old and new paths, so that synchronization handles the original path correctly.
8. As an editing user, I want changes arriving during a run to remain queued, so that a completed run cannot discard newer edits.
9. As a vault owner, I want observed edits to invalidate cached hashes even when file metadata is unchanged, so that same-stat content replacement is detected.
10. As a vault owner, I want missed-event edits discovered when content verification becomes due, so that event-driven performance does not create indefinite blind spots.
11. As a vault owner, I want an inventory refresh not to extend content verification deadlines, so that cached hashes cannot remain trusted forever without rereading bytes.
12. As a user returning after a long absence, I want overdue content verified, so that resume optimizations do not conceal stale evidence.
13. As a user reconnecting to Filen, I want recovery reconciliation preserved, so that offline changes are checked rather than suppressed by a cooldown.
14. As a manual-sync user, I want Sync now to retain fresh verification, so that explicit verification remains trustworthy.
15. As a new user, I want initial sync to verify local content, so that missing session history is not mistaken for proof of unchanged files.
16. As a preview user, I want fresh read-only planning, so that performance changes do not make the proposed actions stale or mutate my files.
17. As a user with multiple devices, I want remote changes to trigger fresh reconciliation, so that a local fast path does not hide edits elsewhere.
18. As a vault owner, I want failed remote event probes to fall back conservatively, so that network errors are not interpreted as evidence of no change.
19. As a vault owner, I want expired or missing snapshots to prevent an unsafe narrow pass, so that incremental planning always has adequate inventory context.
20. As a user changing sync targets, I want target identity freshly verified, so that cached state from another account or mirror cannot affect my vault.
21. As a vault owner, I want files changing during scanning to invalidate the affected planning evidence, so that stale content does not become a trusted fresh snapshot.
22. As a vault owner, I want uploads, downloads, and deletions to retain immediate revalidation, so that faster planning does not authorize stale mutations.
23. As a vault owner, I want conflicts and delete-versus-modify survivors preserved as before, so that performance work cannot silently change recovery behavior.
24. As a vault owner, I want collision checks and destructive-operation confirmations unchanged, so that less scanning work does not reduce protection against data loss.
25. As a user with large attachments, I want hashing concurrency constrained by bytes as well as workers, so that scanning cannot launch unbounded whole-file reads.
26. As a mobile user, I want scanning to remain responsive, so that faster throughput does not make editing or navigation unusable.
27. As a first-sync user, I want eligible identical files to reuse one local read for both fingerprints, so that equality verification avoids redundant I/O.
28. As a first-sync user, I want both fingerprints derived from the same stable bytes, so that equality cannot establish an inconsistent previous-successful baseline.
29. As a first-sync user, I want absent or invalid remote hashes to retain the existing equality fallback, so that optimization does not incorrectly declare files identical.
30. As a user encountering a scanning failure, I want partial snapshots rejected, so that incomplete listings cannot become deletion evidence.
31. As a user encountering concurrent changes, I want bounded replanning and existing recovery behavior preserved, so that automatic retries remain safe and predictable.
32. As a support requester, I want diagnostics to show the actual scan mode and fallback reason, so that supplied hints are not confused with a completed narrow pass.
33. As a support requester, I want local reads, hash reuse, remote refresh, and stage timings distinguished, so that troubleshooting identifies the dominant cost.
34. As a privacy-conscious user, I want diagnostics to remain local and exclude contents and credentials, so that performance measurement does not expose my notes or authentication.
35. As an existing user, I want stable commands, settings, filters, and direction semantics, so that performance improvements do not require relearning sync behavior.
36. As a desktop user, I want the shared engine to retain correctness and performance, so that mobile improvements do not regress desktop synchronization.

## Implementation Decisions

- Extend the existing coordinator, sync engine, session hash cache, content-fingerprint helpers, equality resolution, and diagnostic summary. Keep lifecycle wiring minimal. Do not replace the planner, executor, remote adapter, or target-bound previous-successful baseline.
- Replace the overloaded internal full-scan decision with independent inventory reconciliation, remote metadata freshness, and content verification decisions. Preserve existing callers' conservative behavior until they are explicitly mapped to the new policy.
- Routine foreground and interval checks reconcile the complete included local inventory while reusing still-valid session hashes. They may probe and reuse a fresh remote tree under the existing safety conditions; remote changes, failed probes, expiry, or unavailable event support require fresh metadata.
- Explicit manual sync, initial sync, preview, cold session state, replan, and uncertain recovery retain fresh verification appropriate to their existing contracts. Do not optimize recovery by replaying cached or previously authorized actions.
- Keep the existing five-minute content-hash verification deadline and five-minute snapshot/tree TTLs initially. Hash validity remains conditional on file identity, mtime, ctime, size, event invalidation, and age. Refreshing inventory does not reset a hash's verification time.
- A missed same-stat event may remain undetected until content verification becomes due, as with the existing session cache. Discover it on the next eligible verification run; do not promise verification while the mobile app is suspended or offline.
- Maintain file and folder inventory independently from content hash freshness. Empty pending hints do not prove an unchanged vault. Local deletions, renames, excluded paths, and folder changes continue through complete reconciliation when narrow planning is ineligible.
- Preserve revisioned pending paths, old-path rename hints, debounce behavior, minimum automatic-sync spacing, backoff, confirmation holds, and bounded replan retries. A resume reconciliation can merge focus and visibility triggers but cannot clear pending recovery or newer edits.
- Add a freshness-aware resume coalescing decision based on pending/running work and the last successful relevant reconciliation. Never advance successful-verification timestamps for failed, skipped, or incomplete runs. Reconnect and overdue verification must remain pending when immediate work is throttled.
- Preserve narrow-pass eligibility and full-inventory collision checks. Existing directory changes, stale snapshots, probe errors, and replans remain conservative fallback reasons.
- Protect snapshot publication against edits arriving during scanning, including changes to a file whose hash worker already finished. Use scan-level revision evidence in addition to per-read path/stat checks; discard affected evidence and replan conservatively rather than labeling it fresh.
- Benchmark a two-worker small-file hashing pool through the existing draining worker pool. Keep large attachments serial. Enforce both a worker limit and an explicit accounted in-flight byte budget before launching additional reads, allowing a single oversized file only in isolation. Account for known hashing copies, not just file lengths, and record measured device-memory limitations separately.
- The final small-file threshold and byte budget must be justified by checked-in measurements before enabling concurrent hashing by default. Keep serial hashing if concurrency fails correctness, memory, responsiveness, or performance gates. Do not expose a user-facing fast mode.
- Publish snapshots, prune hash entries, and validate complete collision state only after successful scanning. Worker failure stops new work and drains in-flight operations; incomplete results never become an empty-side or deletion signal.
- Identify eligible no-baseline equality candidates using the existing size/mtime and validated Filen SHA-512 conditions. Calculate local SHA-256 and SHA-512 from one stable binary read where feasible. Retain hashes rather than vault-wide byte buffers.
- Both equality fingerprints must refer to the same verified bytes. A new SHA-512 match cannot be paired with an older cached SHA-256 without fresh consistency proof. Preserve the SHA-256 baseline format, SHA-512 validation, mismatch policy, and remote-download fallback when metadata is absent or invalid.
- Retain immediate local and remote mutation checks, remote UUID/hash evidence, fresh target binding, direction semantics, conflict preservation, local-delete confirmation, bulk guards, and uncertain-mutation recovery. No guard may depend on the optimization being successful.
- Instrument the selected inventory/content/remote policies, actual narrow/full reconciliation provenance, fallback reason, trigger, local read count and bytes, hash hits/misses, equality work, and remote probe/refresh counts. Measure target preparation, event probing, local scanning, baseline loading, remote metadata work, equality resolution, planning, directory preparation, and execution with clear stage boundaries.
- End-to-end timing includes coordinator target preparation and engine setup/probing. Distinguish overlapping stage durations from elapsed total; do not sum concurrent durations as though they were sequential. Preserve existing diagnostic records by treating additional timing and counter fields as optional.
- Do not infer narrow provenance from supplied hints. Return the engine's actual decision to diagnostic consumers, including the conservative fallback reason. Replans must not be misreported as a successful hinted-only pass.
- Keep diagnostics within existing local retention and explicit-export privacy rules. Add no contents, credentials, raw event payloads, telemetry, or automatic uploads. Scanning measurements need aggregate counts rather than additional retained filenames.
- Keep binary reads for byte fingerprints. Cached text reads and metadata-only comparisons are not substitutes for content evidence. Do not introduce persistent hash trust or baseline-schema migration in this feature.
- Deliver in stages: observable diagnostics, independent scan policy, resume coalescing, then measurement-gated concurrent hashing and single-read equality. Each optimization must independently retain the conservative fallback.

## Testing Decisions

- **Proposed primary seam, awaiting user confirmation:** exercise automatic triggers and explicit runs through the existing coordinator-to-engine integration with mocked vault, remote filesystem, database, clock, and callbacks. Assert observable reads, remote calls, plans' effects, outcomes, diagnostic provenance, and retained queued work. No new production test interface is proposed.
- Reuse the existing engine integration fixtures for exhaustive reconciliation and race cases when going through the coordinator would obscure the scenario. These are supporting tests at an existing boundary, not a new abstraction. Prefer the highest existing boundary that exposes the behavior under test.
- Prior art includes the repository's coordinator scheduling fixtures, narrow/full outcome-equivalence tests, session hash expiry and same-stat tests, mutation-race tests, and deterministic benchmark workloads. Extend them rather than introduce a framework or rewrite them.
- Good tests check external behavior and resource bounds: bytes read, transfers performed or refused, final local/remote state, previous-successful baseline consistency, pending edit preservation, confirmation requirements, actual provenance, and elapsed logical scheduling. Avoid assertions on private maps, internal method names, worker ordering, or arbitrary timer implementation details.
- Use fake time for TTL, debounce, cooldown, suspension/resume, and backoff cases. Use explicit read/probe barriers for concurrent-change tests; avoid timing-sensitive sleeps as the correctness oracle.
- With valid hashes and fresh remote evidence, an unchanged foreground reconciliation performs zero local content reads. Focus and visibility for the same transition produce one reconciliation. An unchanged three-minute interval enumerates inventory without forcing valid hashes to be reread.
- Verify that a complete inventory refresh still discovers creation, deletion, file rename, folder rename, and exclusion changes when the pending-path set is empty. Compare final effects with a full fresh reconciliation.
- Eligible one-file auto-sync reads/hashes only the changed file during planning and preserves newer edits queued while the run is active. Report narrow provenance only when narrow mode was actually selected.
- Test observed and missed same-stat edits separately. Event invalidation forces content verification immediately when the next run occurs; missed events are discovered after the finite hash deadline. Repeated inventory refreshes must not extend that deadline without reads.
- Manual, initial, preview, cold-cache, expired-cache, replan, and uncertain-recovery runs retain their intended fresh evidence. Preview remains read-only except for allowed local diagnostics.
- Remote change, failed probe, missing event capability, expired remote metadata, target replacement, ambiguous folder hints, and failed listings fall back safely. No failed scan is represented as a clean empty inventory.
- Test edits before reads, during reads, between digest calculations, after a worker completes, and before snapshot publication. Drain workers, reject stale evidence, preserve queued revisions, and retain bounded replanning.
- First-sync equality candidates with valid metadata require one local planning read for both fingerprints and zero remote content downloads. Invalid/missing metadata and mismatches retain existing fallback/conflict behavior. Executor revalidation reads remain allowed and must not be counted as redundant planning reads.
- Assert hashing worker and accounted byte limits for mixed notes and large attachments. Failed workers stop further scheduling, drain safely, and do not publish partial snapshots. Do not equate an accounted buffer budget with a guaranteed total process-memory limit.
- Verify collision checks, delete-versus-modify survivor preservation, directional outcomes, bulk guards, local-delete confirmation, remote identity changes, and mutation uncertainty against existing behavior.
- Diagnostics must describe the actual mode and fallback, include preparation/probing in end-to-end elapsed time, and avoid credentials, contents, and raw provider payloads. Older diagnostic entries remain readable.
- Use deterministic workload comparisons for unchanged warm foreground, unchanged interval, one-file edit, expired/full verification, first sync with mostly identical files, and large-attachment mixtures. Gate policy changes on eliminated unnecessary read/refresh counts rather than an invented device speedup percentage.
- Benchmark optional concurrent hashing against serial hashing under identical inputs and controlled latency. Enable it only with documented improvement and no correctness, responsiveness, memory-bound, or one-file auto-sync regression. Record enough workload detail to make comparisons repeatable.
- Validate Android and iOS separately in disposable or backed-up vaults. Record device, OS, Obsidian version, included file count/bytes, attachment distribution, network conditions, actual scan mode, per-stage time, read/hash counts, and responsiveness. Mark unperformed real-device verification explicitly; mocked benchmarks are not device throughput evidence.

## Out of Scope

- Changes to direction semantics, conflict winners, survivor preservation, delete confirmations, or destructive-operation thresholds.
- Persisted content-hash caches, new baseline schemas, remote manifests, or timestamp-only change detection.
- Mirror-scoped remote event delta application, event-feed pagination redesign, or relaxed assumptions about provider event completeness.
- Maintained collision indexes and exact-file versus subtree invalidation optimizations unless addressed in a separate measured follow-up.
- Changes to Filen SDK metadata-decryption scheduling or replacement of its directory-tree API.
- Transfer concurrency changes, remote mutation-session redesign, streaming transfer, new hashing dependencies, or incremental large-file hashing.
- Hidden configuration-file synchronization, new providers, sync settings redesign, new performance toggles, or a progress-surface redesign.
- Telemetry, automatic diagnostic upload, raw provider payload retention, or expanded filename collection.
- Background synchronization guarantees while Obsidian is suspended or closed.
- A guaranteed percentage improvement or claims of Android/iOS validation without device measurements.

## Further Notes

- This spec synthesizes the mobile change-scanning research and inspected implementation. The research distinguishes existing optimizations from proposed work; root reuse, directory UUID reuse, SHA-512 equality comparison, and remote mutation sessions already exist and are not new deliverables here.
- Current source uses five-minute local snapshot, remote tree, and hash freshness windows. Older planning text mentioning a 30-minute remote tree must not be treated as the current contract.
- No project glossary or ADR collection was found. Terminology follows the existing coordinator, engine, narrow pass, inventory, session hash cache, verified target, and previous-successful baseline model.
- Test-seam confirmation is pending. The proposed coordinator-to-engine integration boundary reuses existing test doubles and adds no production interface.
- Issue tracker configuration and triage vocabulary were not provided. Run `/setup-matt-pocock-skills`, then publish this spec to the configured project tracker with `ready-for-agent` and no additional triage. This local draft has not been published or labelled.
