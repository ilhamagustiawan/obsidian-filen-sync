# 01: Observable scan mode, fallback reason, and stage timings

**What to build:** Routine and explicit runs record the scan decision the engine actually made (narrow / reconcile / full), the explicit fallback reason when conservative, per-stage timing (target prep, event probe, local scan, baseline, remote, equality, plan, directories, execute), and aggregate scan counters (local reads, bytes, hash hits/misses, equality work, remote probes/refreshes). The coordinator stops inferring provenance from supplied hints. The diagnostic modal displays the new fields; older records remain readable.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Engine returns actual scan mode + fallback reason in every outcome and preview; narrow status is never inferred from supplied hints.
- [ ] Timing summary distinguishes stage durations from elapsed total; coordinator target preparation and engine event probing are included in end-to-end elapsed time.
- [ ] Counters are bounded aggregates (no contents, credentials, or raw provider payloads).
- [ ] Coordinator records actual provenance from the engine result instead of hint presence.
- [ ] Diagnostic modal shows mode, fallback, and stage timings without crashing on older records (new fields optional).