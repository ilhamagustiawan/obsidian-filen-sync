# 08: Browse recent preview history

**What to build:** Users inspect and clear recent preview diagnostics from the existing activity-log UI. Records remain local, target-scoped, bounded, and clearly advisory rather than executable.

**Blocked by:** 05 — Preview push and pull with accurate exclusions.

**Status:** ready-for-agent

- [ ] Versioned diagnostic storage is separate from the previous-successful baseline and scoped to verified vault/account/root binding.
- [ ] Store preview action/reason metadata, direction, trigger, target binding, safety report, timing, actual scan provenance, and proposed/failed/cancelled outcome where known.
- [ ] Keep only the latest 20 entries no older than 24 hours, enforcing cleanup on load and insertion. Retain at most 5,000 action details per record while keeping complete aggregates and explicitly marking truncation.
- [ ] Open previews may show their full in-memory plans, but persisted history cannot be executed or treated as current state.
- [ ] Provide browse and clear-history interactions; do not display another target's history as the current target's plans.
- [ ] Explain that locally retained diagnostics contain paths until cleared or expired. Store no credentials, file contents, or raw provider payloads.
- [ ] Diagnostic-history writes are the only new persistent preview side effect; baseline and success state remain untouched. History persistence failure must not masquerade as successful storage or invalidate an otherwise valid read-only plan.
- [ ] Manually inspect preview records, target isolation, load/insertion cleanup, truncation, clearing, and storage failure behavior. Automated test additions are out of scope.
