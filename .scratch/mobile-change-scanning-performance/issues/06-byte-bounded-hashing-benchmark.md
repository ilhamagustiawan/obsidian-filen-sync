# 06: Byte-bounded concurrent small-file hashing, measurement-gated

**What to build:** Hash small files through a two-worker pool that enforces both a worker limit and an explicit accounted in-flight byte budget (large attachments serial, a single oversized file only in isolation). Worker failure stops new work and drains in-flight operations. Enable by default only if checked-in deterministic benchmarks show no correctness, memory, responsiveness, or one-file regression; otherwise keep serial hashing and record the measurements.

**Blocked by:** 01 (stage timing/counters needed to measure), 05 (unifies single-read bytes).

**Status:** completed

- [x] Hashing concurrency is bounded by workers AND accounted bytes (copy-aware, not just file lengths).
- [x] Large attachments hash serially; one oversized file may run only in isolation.
- [x] Failed workers stop scheduling, drain in-flight work, and never publish partial snapshots.
- [x] Deterministic benchmark compares concurrent vs serial hashing under identical inputs and controlled latency; result documented in the benchmark output.
- [x] No user-facing fast mode is introduced; policy is enabled (or kept serial) based on the checked-in measurements.
