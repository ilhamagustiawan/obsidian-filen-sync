# 02: Independent inventory, verification, and remote refresh decisions

**What to build:** Replace the overloaded forced full-scan boolean with independent decisions: reconcile inventory, verify local contents (fresh hashes), and refresh remote metadata. Manual sync, initial sync, preview, replan, and uncertain recovery retain their existing fresh/verified contracts; routine runs get a reconcile mode that still discovers deletions, renames, and folder changes even with an empty pending set.

**Blocked by:** None (can start immediately; overlaps 01 in engine internals).

**Status:** ready-for-agent

- [ ] Engine accepts explicit verify/refresh/reconcile signals instead of relying only on `fullScan`.
- [ ] Conservative callers (manual, initial, preview, replan, recovery, cold session) keep fresh local content and remote metadata.
- [ ] Routine auto-sync enumerates the complete included inventory (adds/deletes/renames/folders found) while reusing still-valid session hashes.
- [ ] Inventory refresh never extends a hash's verification deadline; expired/invalidated paths still force fresh content evidence on the next eligible run.
- [ ] Empty pending hints never prove an unchanged vault; collision checks and empty-side guards still run over the full inventory.