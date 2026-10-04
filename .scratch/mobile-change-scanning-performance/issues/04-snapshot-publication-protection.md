# 04: Snapshot publication protected against concurrent edits

**What to build:** Edits arriving during a scan (including after a file's hash worker finished) invalidate the affected planning evidence. Scan-level revision evidence (vault-event epoch) augments the per-read path/stat checks; a scan that observed invalidation discards its evidence and replans conservatively instead of publishing a stale "fresh" snapshot.

**Blocked by:** None (engine internal safety; can proceed after 01/02 land).

**Status:** ready-for-agent

- [ ] A vault event during local scanning prevents publication of the affected local snapshot; partial results never become empty-side or deletion evidence.
- [ ] LocalHashCache read race protection (same-stat checks between read start/end and across digest) is retained.
- [ ] Edits before reads, during reads, between digest calculations, after a worker completes, and before snapshot publication are covered by tests.
- [ ] Failed or cancelled scans do not advance successful-verification timestamps.