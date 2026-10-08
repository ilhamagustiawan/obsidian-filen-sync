# Mobile change-scanning measurements (checked in)

These are deterministic synthetic measurements recorded from `npm test`
(`test/benchmark-workloads.test.mjs` and `test/scan-policy.test.mjs`). They are
**mocked-vault benchmarks, not device throughput evidence**: real-device
verification on Android/iOS is not yet performed. The measurements justify which
policy defaults are enabled.

## Single-read equality (`resolveRemoteFileHashes`)

Workload B - first sync of 100 identical files (1 ms controlled remote latency):

| Revision                                                             | Local planning reads | Remote equality downloads | Result                         |
| -------------------------------------------------------------------- | -------------------- | ------------------------- | ------------------------------ |
| Before (local hash read + separate SHA-512 read, fallback downloads) | 200                  | 100                       | 100 files downloaded to verify |
| After (one stable read per file computes SHA-256 + SHA-512)          | **100**              | **0**                     | identical, no downloads        |

Both fingerprints always refer to the same verified bytes. Absent/invalid remote
hashes keep the download fallback, which still recognizes identical content
without falsely declaring identity.

## Concurrent small-file hashing gate

Workload D - cold re-verification of 200 files (2 KiB each, 1 ms controlled
latency, `maxWorkers: 2`, `maxInFlightBytes: 8 MiB` accounted):

| Mode                            | Elapsed    | Local reads | Peak workers | Peak in-flight (accounted) |
| ------------------------------- | ---------- | ----------- | ------------ | -------------------------- |
| Serial hashing                  | 11.2 ms    | 200         | 1            | —                          |
| Byte-bounded concurrent hashing | **7.1 ms** | 200         | 2            | 0.0 MiB (sub-budget files) |

One-file auto-sync under the pool: 1 planning read, ~2 ms, no regression.

**Gate result:** concurrent small-file hashing keeps identical reads and bounds
(never more than 2 workers; large files at/above 8 MiB stay serial; a single
oversized accounted job runs only in isolation) and is therefore enabled by
default (`HASH_POOL_ENABLED = true`). Serial hashing remains available by
flipping that constant, and the byte budget covers known digest/read copies with
an `accountFactor` of 2.

## Routine reconcile behavior

- Unchanged foreground/interval reconcile with valid hashes: **0 content reads**,
  0 hash misses, remote tree reused (1 probe, 0 refreshes).
- Hash verification deadline (5 minutes) is not extended by inventory refreshes;
  a missed same-stat edit is discovered when the TTL expires.
- Routine reconcile discovers additions, deletions, file renames, folder
  renames, and exclusions with an empty pending-path set, with final effects
  equivalent to a full fresh reconciliation.

## Real-device caveat

Real Android/iOS validation (device, OS, Obsidian version, file counts, network
conditions, per-stage timings, responsiveness) has **not** been performed in this
repository. The numbers above are mocked-vault measurements only and must not be
cited as device throughput evidence.
