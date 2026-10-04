# 07: Safety regression guard across the new scan policies

**What to build:** Verify that faster scanning does not weaken the existing protections: collision checks, bulk guards, local-delete confirmation, executor revalidation, conflict/survivor preservation, target binding, directional outcomes, mutation uncertainty recovery, and bounded replanning all behave as before under the new reconcile/verify/refresh decisions.

**Blocked by:** 02, 03, 04, 05, 06.

**Status:** completed

- [x] No safety check depends on the optimization succeeding; guards run identically in reconcile, narrow, and full modes.
- [x] Periodic reconciliation still discovers creation, deletion, file rename, folder rename, and exclusion changes with an empty pending-path set, with final effects equivalent to a full fresh reconciliation.
- [x] Manual, initial, preview, cold-cache, expired-cache, replan, and uncertain-recovery runs retain their fresh evidence contracts. Preview stays read-only.
- [x] Remote change, failed probe, missing event capability, expired remote metadata, target replacement, ambiguous folder hints, and failed listings fall back safely; no failed scan is represented as a clean empty inventory.
- [x] Existing test suite passes unchanged, extended by coordinator-to-engine integration coverage of the new policies.