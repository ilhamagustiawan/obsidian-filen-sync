# 02: Explain direction and conflict-preservation behavior

**What to build:** Users understand the current push/pull contracts before running them, including destination overwrites, propagated deletions, and reverse transfers that preserve a modified survivor. Conflict descriptions accurately state whether a copy will be created.

**Blocked by:** None (can start immediately).

**Status:** completed

- [x] Command explanations and confirmation surfaces reflect the complete current direction branch table without changing command IDs or reconciliation semantics.
- [x] Explain that push can propagate local deletions and overwrite remote content, and pull can propagate remote deletions and overwrite local content.
- [x] Explain restoration of unchanged survivors and reverse transfers for delete-versus-modify preservation.
- [x] Explain directional destination overwrites when both copies changed, rather than promising bidirectional conflict-copy behavior.
- [x] Distinguish normal bidirectional losing-copy preservation from delete-versus-modify survivor restoration that creates no duplicate.
- [x] Manually compare explanations with new, unchanged, modified, deleted, both-modified, and delete-versus-modify behavior in every direction. Automated test additions are out of scope.
