# Safe sync planning, read-only preview, and diagnostic history

## Problem Statement

Filen Sync users cannot inspect a complete proposed sync before allowing it to change their vault or remote folder. Directional command names can suggest stricter one-way behavior than the implemented push/pull rules provide, including deletions, overwrites, and reverse transfers that preserve a modified survivor.

Destructive-change protection currently infers some overwrite risks from human-readable action descriptions. Changing that copy can unintentionally change safety behavior. Activity logs help troubleshooting, but do not provide bounded, structured plan history with explicit snapshot provenance and safe export.

## Solution

Keep the existing Filen-specific reconciliation engine and recovery protections. Make action reasons and destructive effects explicit, explain the current direction contracts, and provide a read-only **Preview changes** command. Show the verified target, proposed actions, reasons, and safety warnings before the user chooses **Apply**.

Apply always prepares a fresh plan and requires any applicable confirmations; a preview is not authorization to execute stale actions. Store bounded diagnostic history locally and offer explicitly requested, redacted exports without credentials or file contents.

## User Stories

1. As a vault owner, I want to preview sync changes, so that I can understand their impact before applying them.
2. As a vault owner, I want preview to leave local files and remote objects unchanged, so that inspection cannot cause data loss.
3. As a vault owner, I want preview to leave my previous-successful baseline unchanged, so that inspection does not alter future deletion detection.
4. As a vault owner, I want to see the verified remote folder, so that I can confirm I am inspecting the intended target.
5. As a new user, I want a missing target reported without creating it, so that preview remains read-only during setup.
6. As a vault owner, I want to select bidirectional, push, or pull preview, so that I can inspect the mode I intend to use.
7. As a vault owner, I want uploads and downloads distinguished from overwrites, so that I can identify replaced content.
8. As a vault owner, I want local and remote deletions listed separately, so that I understand where files will disappear.
9. As a vault owner, I want conflicts and the proposed winner explained, so that I understand how my changes will be preserved.
10. As a vault owner, I want delete-versus-modify recovery distinguished from conflict-copy creation, so that I am not promised a copy that will not exist.
11. As a vault owner, I want skipped files and unchanged files distinguished, so that I understand why files are absent from transfers.
12. As a vault owner, I want concise reasons for each action, so that I can judge whether the plan matches my expectations.
13. As a vault owner, I want bulk-change warnings before Apply, so that I can investigate unusual deletion or overwrite counts.
14. As a vault owner, I want unexpectedly empty local or remote sides flagged, so that a listing failure is not mistaken for intentional deletion.
15. As a push user, I want remote deletion and overwrite behavior explained, so that I do not assume push only adds files.
16. As a pull user, I want local deletion and overwrite behavior explained, so that I do not assume pull only adds files.
17. As a directional-sync user, I want reverse survivor-preservation transfers identified, so that I understand why push can download or pull can upload.
18. As a vault owner, I want Apply to inspect current state again, so that edits after preview are not overwritten using an old plan.
19. As a vault owner, I want changed actions presented for review, so that fresh planning does not authorize changes I have not seen.
20. As a vault owner, I want to dismiss a preview without syncing, so that inspecting a plan never commits me to execution.
21. As a vault owner, I want preview and sync serialized, so that concurrent runs do not produce misleading state.
22. As a mobile user, I want the preview available through the existing sync menu, so that I can inspect changes without a desktop status bar.
23. As a user of automatic sync, I want required destructive confirmations deferred to manual interaction, so that unattended runs remain conservative.
24. As a vault owner, I want recent plan history retained locally with bounded storage, so that I can investigate behavior without unbounded growth.
25. As a support requester, I want to export diagnostics explicitly, so that no diagnostic data is shared without my action.
26. As a privacy-conscious user, I want paths and target identifiers redacted by default in exports, so that diagnostics do not reveal my vault organization or account identity.
27. As a support requester, I want exports to exclude credentials and file contents, so that troubleshooting does not expose secrets or notes.
28. As a vault owner, I want plan provenance, timing, and outcomes recorded, so that I can distinguish preview from completed or interrupted work.
29. As a vault owner, I want to clear diagnostic history, so that I can remove locally retained filenames and operational metadata.
30. As an existing user, I want stable commands and unchanged direction semantics, so that this feature does not silently change my workflow.

## Implementation Decisions

- Extend the existing planner, bulk guard, target preparation, engine, coordinator, activity-log presentation, and command/menu registration rather than replacing the engine or adding a provider abstraction.
- Keep feature logic in focused modules; lifecycle code only wires the feature and registers stable commands.
- Planned actions carry stable reason codes and explicit effects: destination side, destination existence, replacement/deletion classification, conflict winner, and preservation behavior where applicable. Human-readable detail is presentation only and never controls guards or execution.
- Classify replacement of an existing destination as an overwrite regardless of wording or direction. Include conflict winner application in destructive accounting even when a losing copy is preserved. Creation of a conflict copy itself is not an overwrite of the original. Directory-only work and no-ops do not inflate destructive-file counts.
- Preserve existing guard defaults: confirmation at 20 destructive files on either side; at least five destructive files and 20% of that side; unexpectedly empty-side protection when the baseline contains at least five files. Preserve separate local-delete confirmation and unattended refusal of required confirmations.
- Document the current direction contract from the planner's complete branch table. Do not introduce strict one-way or incremental variants in this feature. Push may propagate local deletions, re-upload an unchanged local survivor after remote deletion, and overwrite remote content. Pull may propagate remote deletions, restore an unchanged remote survivor after local deletion, and overwrite local content. Modified survivors can be restored in either direction, including reverse transfers. When both copies change, directional modes overwrite the destination rather than using the normal bidirectional conflict-copy path.
- Normal bidirectional conflicts retain the existing newer-winner behavior, including local wins on equal timestamps and local preservation of losing content. Delete-versus-modify recovery must not claim a duplicate was created when the executor only restores the survivor.
- Introduce a preview-only engine operation that shares scan, filtering, equality verification, collision checking, planning, and safety evaluation with sync. Return actions, aggregate counts, exclusions summary, safety report, timing, direction, target identity, and snapshot provenance. Distinguish filtered exclusions from planner no-ops; avoid inventing per-path actions for entries that were never enumerated.
- Manual preview uses fresh full local and remote scans. Preserve existing automatic narrow/cache behavior and record actual full/narrow/cache provenance for diagnostic plans; never imply that every plan was a full scan.
- Resolve the remote target without creating folders. Missing target, unavailable authentication, invalid history binding, collision, or incomplete listing produces an explicit unavailable/failed preview, not a successful empty plan. Do not represent failed scans as deletion evidence.
- Strict preview prohibits local content writes, conflict copies, remote mkdir/upload/delete/rename, baseline updates, and sync-success updates. Reads, content downloads needed to establish equality, ephemeral caches, and explicitly described local diagnostic-history writes are allowed. No downloaded content is retained in history.
- Read existing target-bound history without silently resetting or migrating it during preview. Resolve any history initialization or repair through normal setup/apply, not through inspection.
- Present counts, per-action reasons, target, direction explanation, freshness time, safety warnings, and exclusions summary in a plugin-owned desktop/mobile surface. A preview is labelled as proposed work, never as successful sync. Large action lists should remain navigable without mounting every row at once.
- Apply does not hand stored preview actions directly to the executor. It invokes fresh target preparation and planning through the normal coordinator and engine, followed by existing execution revalidation. Recheck target binding, direction, and filters. If the target, action set, or safety effects differ from what was reviewed, require review of the updated plan before execution. Preserve final revalidation because review cannot eliminate race windows.
- Serialize preview and apply with existing sync coordination. Prevent automatic work from mutating the target during active preview generation or fresh-plan review; after review closes, resume scheduling without dropping queued path revisions. A displayed historical preview is still advisory, not a lock on external devices.
- Retain existing remote identity checks, content evidence, target-bound baseline, bounded replanning, and uncertain-write reconciliation. Do not replay an uncertain mutation solely because a preview or old plan exists.
- Add versioned, bounded local diagnostic plan storage separate from the previous-successful baseline. Initial retention is the latest 20 entries no older than 24 hours, enforced on load and insertion. Keep action/reason metadata, trigger, direction, target binding, scan provenance, timings, safety outcome, and run outcome. No credentials, file contents, or raw provider payloads are stored.
- Record preview, success, failure, cancellation, and partial application distinctly. Do not label planned operations as completed. Link preview and apply records without treating the preview as execution evidence.
- Scope history to the verified vault/account/root binding; do not display another target's plans as current-target history. Bound each record as well as record count: cap retained action details at 5,000 entries, preserve full aggregate counts, and mark truncation explicitly. An open preview may show its full in-memory plan; persisted history is diagnostic, not an executable plan.
- Provide a clear-history action and explicit export. Default exports replace paths with stable per-export opaque aliases, preserving relationships without exposing original names. Redact folder names, account/vault/root identifiers, and free-form messages that could contain them. Never export credentials, derived auth, master keys, content hashes, or file contents. Do not offer an unredacted export in this scope.
- Explain in the UI and documentation that local history contains paths until cleared or expired, and preview can contact Filen and download content for equality checking. No telemetry or automatic diagnostic upload is introduced.
- Implement independently within this project's modules. Do not copy upstream paid engine or smart-conflict code.

## Testing Decisions

Automated test work is explicitly excluded at the user's request. The user will validate the feature manually. Existing automated tests need not be removed, and this decision is not a claim that the feature has been validated.

Manual acceptance checklist:

- Use a disposable vault and remote folder; compare files, folders, previous-successful records, and success timestamps before and after preview. Verify only diagnostic history changes.
- Preview a missing remote target and verify it remains missing. Check initial setup, absent history, and invalid history binding without silent repair.
- Exercise new, unchanged, modified, deleted, both-modified, and delete-versus-modify cases in all three directions. Compare displayed effects with actual apply behavior, including reverse preservation transfers and whether a conflict copy actually exists.
- Confirm overwrite/deletion warnings survive changes to human-readable reason text and classify winner application correctly.
- Exercise absolute, percentage, local-delete, and unexpectedly empty-side guards. Verify automatic sync waits for manual confirmation.
- Edit local and remote files after preview; change the target or filters; verify Apply replans and requires renewed review when its proposed effects change.
- Exercise failed listings, remote object replacement, connectivity loss, interrupted mutation finalization, cancellation, and partial success. Verify failures never appear as a clean empty plan or completed work.
- Start preview during sync and trigger automatic work during preview/review. Verify serialization and that pending edits are retained.
- Check preview and history on desktop and mobile, including large action lists, dismissing without Apply, and foreground/resume behavior.
- Confirm history retention, truncation, target isolation, clear-history behavior, and explicit export. Inspect exported data for paths, identifiers, credentials, hashes, note contents, and leaks through free-form errors.

## Out of Scope

- New direction modes or changes to existing push/pull reconciliation semantics.
- Automatic text merging, expanded conflict-resolution actions, or redesigned version recovery.
- Transfer concurrency changes, streaming downloads, buffer optimizations, event-feed refinements, or broader hash-cache reuse.
- New benchmark infrastructure or claims of real-cloud/mobile performance improvements.
- Automated test additions or a new testing framework.
- Multi-provider support, replacing the sync engine, or remote manifest/tombstone storage.
- Localization, QR/settings transfer, and a persistent floating mobile indicator.
- Broad lifecycle/scheduling refactors beyond focused extraction required for this feature.
- Executing saved plans, remote diagnostic upload, telemetry, and unredacted exports.

## Further Notes

- Source: the repository's Remotely Save comparison and ranked recommendations. This spec deliberately covers the first two implementation priorities; later optimization and recovery work remains separate.
- Current code confirms that sync begins with remote root creation and that some overwrite guards inspect action detail strings. Preview cannot simply call sync and stop before transfers.
- No project glossary or ADR collection was found during repository exploration; terminology follows the current planner, engine, coordinator, and target-bound baseline model.
- Tracker publication is pending configuration. Run `/setup-matt-pocock-skills` to provide the issue tracker and triage-label vocabulary. Publish this spec with `ready-for-agent` once configured; no additional triage is required.
