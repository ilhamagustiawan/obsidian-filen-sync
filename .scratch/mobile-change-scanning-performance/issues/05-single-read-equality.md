# 05: Single-read first-sync equality fingerprints

**What to build:** Eligible no-baseline equality candidates (equal size/mtime, validated Filen SHA-512) derive both local SHA-256 and SHA-512 fingerprints from one stable binary read, so first sync with mostly identical files avoids redundant local I/O. The SHA-256 baseline format, SHA-512 validation, mismatch policy, and remote-download fallback for absent/invalid hashes all remain.

**Blocked by:** None (content-hash helpers and engine plumbing already exist).

**Status:** completed

- [x] Eligible equality candidates with valid metadata require one local planning read for both fingerprints and zero remote content downloads.
- [x] A fresh SHA-512 match is never paired with an older cached SHA-256 without fresh same-bytes proof.
- [x] Invalid/missing remote hashes retain the equality fallback (remote download for SHA-256) and never falsely declare files identical.
- [x] Mismatched content keeps the existing conflict/upload decisions without extra downloads; executor revalidation reads stay separate and uncounted.
- [x] Cached hashes (not whole-vault byte buffers) continue to persist across runs in the session cache.
