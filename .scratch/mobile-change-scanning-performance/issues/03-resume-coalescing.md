# 03: Freshness-aware resume coalescing

**What to build:** Focus and visibility events for the same app transition share one pending reconciliation; ordinary resume runs stop forcing fresh content verification. A resume trigger arriving shortly after a successful reconciliation with no queued edits and still-valid verification is coalesced away; reconnect, overdue verification, pending edits, and recovery never get suppressed by the cooldown. Interval and edit-triggered runs behave as before.

**Blocked by:** 02 (engine must make routine runs cheap first).

**Status:** ready-for-agent

- [ ] Focus and visibility notifications for one transition produce one reconciliation, never two forced passes.
- [ ] Resume triggers no longer force fresh hashing or remote refresh; they use the routine reconcile policy.
- [ ] Coalescing is skipped when pending edits exist, confirmation is pending, verification is overdue (hash TTL elapsed), or the run is a reconnect/online recovery.
- [ ] Successful-verification timestamps advance only on successful, complete runs; failed/skipped/cancelled runs never advance them.
- [ ] Automatic-sync spacing, debounce, backoff, and bounded replan retries keep their existing behavior.