# 01: Make destructive guards independent of wording

**What to build:** Users receive consistent destructive-change confirmations regardless of how action descriptions are worded. Use explicit planner effects to classify deletions and replacement of existing destinations, including conflict-winner application, while preserving existing sync behavior.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Planned actions expose stable reason codes and explicit destination/effect metadata; presentation text never controls safety decisions.
- [ ] Deletes and overwrites are counted separately for each side. Conflict-winner replacement counts even when the losing content is preserved; conflict-copy creation, directory work, and no-ops do not inflate destructive-file counts.
- [ ] Preserve confirmation defaults: 20 destructive files per side; five or more destructive files affecting at least 20% of that side; unexpectedly empty-side protection with at least five baseline files.
- [ ] Preserve separate local-delete confirmation and unattended refusal when confirmation is required.
- [ ] Changing human-readable detail does not change guard results. Existing direction semantics, target binding, and recovery behavior remain unchanged.
- [ ] Manually verify all directions, overwrite/conflict classifications, guard boundaries, and automatic-sync refusal in a disposable vault. Automated test additions are out of scope.
