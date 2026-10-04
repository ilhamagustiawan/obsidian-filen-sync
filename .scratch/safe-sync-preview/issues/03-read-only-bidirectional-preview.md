# 03: Preview bidirectional sync on an existing target

**What to build:** Users can select a desktop Preview changes command to inspect a fresh bidirectional plan for an existing, verified target without syncing. Share planning with normal sync rather than stopping an ordinary sync before execution.

**Blocked by:** 01 — Make destructive guards independent of wording.

**Status:** ready-for-agent

- [ ] Extract only the focused shared read-only scan/planning behavior needed for this slice before wiring the command; keep lifecycle wiring minimal and ordinary sync behavior intact.
- [ ] Resolve an existing target without creation and use fresh full local/remote scans, existing filtering, equality verification, collision checks, and structured guard evaluation.
- [ ] Show verified target, direction, freshness time, actions, reasons, counts, safety warnings, and explicit proposed-work labeling.
- [ ] Preview performs no remote mkdir/upload/delete/rename, local content writes, conflict-copy creation, baseline updates, or sync-success updates. Read-only equality downloads and ephemeral caches are permitted.
- [ ] Serialize preview generation with sync and retain pending local path revisions. Dismissing preview performs no sync.
- [ ] Record timing and actual snapshot provenance in the preview result for later diagnostics; do not persist history in this slice.
- [ ] Explain that preview contacts Filen and may download content for equality checks. Fail closed on errors; never display a failed scan as a successful empty plan.
- [ ] Manually compare local files, remote objects, baseline records, and success timestamps before and after preview on an existing target. Automated test additions are out of scope.
