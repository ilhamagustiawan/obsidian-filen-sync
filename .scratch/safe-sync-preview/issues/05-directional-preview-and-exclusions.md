# 05: Preview push and pull with accurate exclusions

**What to build:** Users select bidirectional, push, or pull preview and inspect the exact proposed effects with explanations of directional preservation behavior. Excluded files are not confused with unchanged planner entries.

**Blocked by:**

- 02 — Explain direction and conflict-preservation behavior.
- 04 — Handle unavailable targets and incomplete previews safely.

**Status:** completed

- [x] Direction selection regenerates a fresh read-only plan using the existing direction contract rather than new one-way modes.
- [x] Show uploads/downloads, destination overwrites, local/remote deletions, conflict winners, and survivor preservation accurately in all directions.
- [x] Reasons use stable planner codes with human-readable presentation; delete-versus-modify recovery does not promise a nonexistent copy.
- [x] Distinguish known filtered exclusions from no-ops and directionally skipped entries. Do not invent per-path records for entries that were never enumerated.
- [x] Changing direction does not mutate content, target structure, baseline, or success state, and preserves preview serialization.
- [x] Manually verify every direction against representative creation, modification, deletion, conflict, ignored-path, and size-filter cases. Automated test additions are out of scope.
