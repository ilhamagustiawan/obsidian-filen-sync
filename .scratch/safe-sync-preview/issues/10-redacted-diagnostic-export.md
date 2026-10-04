# 10: Export redacted diagnostic history

**What to build:** Users explicitly export privacy-safe retained plan diagnostics for troubleshooting. Useful relationships remain understandable without disclosing filenames, account identity, secrets, or note contents, and nothing is uploaded automatically.

**Blocked by:** 09 — Record sync outcomes alongside previews.

**Status:** completed

- [x] Provide an explicit export action from diagnostic history, with a clear explanation of exported data and existing local path retention.
- [x] Replace paths with stable per-export opaque aliases that preserve relationships across selected records without exposing original names.
- [x] Redact folder names and account/vault/root identifiers, including leaks through free-form reasons, errors, and provider messages. Prefer allowlisted structured output rather than blindly serializing records.
- [x] Never export credentials, derived auth, master keys, content hashes, file contents, or raw provider payloads. No unredacted export option is introduced.
- [x] Preserve safe reason codes, directions, triggers, counts, timings, provenance, safety outcomes, execution outcomes, correlation, and explicit truncation indicators.
- [x] Export is user-initiated and works through a vault-scoped or platform-supported save/share flow; no automatic upload, telemetry, or arbitrary filesystem access is introduced.
- [x] Manually inspect exports containing identifying paths and error messages, cross-record references, truncated records, cancelled runs, and partial failures on desktop and mobile. Automated test additions are out of scope.
