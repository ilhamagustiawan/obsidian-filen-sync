# 04: Handle unavailable targets and incomplete previews safely

**What to build:** Users receive an explicit unavailable or failed preview when setup or inspection cannot establish a trustworthy plan. Inspection never creates missing folders, silently repairs history, or interprets incomplete listings as deletion evidence.

**Blocked by:** 03 — Preview bidirectional sync on an existing target.

**Status:** completed

- [x] Missing target and unavailable authentication are reported clearly without target creation or execution controls for an invalid plan.
- [x] An existing target without a baseline can be inspected as a first-sync plan through read-only empty history, without initializing persistent baseline state.
- [x] Invalid or mismatched history bindings are reported without resetting, migrating, or repairing stored history during preview; direct users to normal setup/apply workflows as appropriate.
- [x] Collisions, incomplete listings, failed reads, and connectivity failures produce an explicit failed/unavailable state rather than a clean empty plan.
- [x] Cleanup releases preview coordination on failure or dismissal without discarding pending edits.
- [x] Manually exercise missing targets, absent and corrupt history, binding mismatch, collisions, authentication failure, and interrupted scans; verify files, folders, baseline, and success timestamps remain unchanged. Automated test additions are out of scope.
