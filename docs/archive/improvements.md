# Improvement plan

Current baseline: direct Filen folder mirror, manual sync only.

## Highest priority

### Delete propagation

Implement missing-side decisions against prev-sync state.

| Case                              | Action                           |
| --------------------------------- | -------------------------------- |
| local missing, remote equals prev | delete remote, delete DB record  |
| remote missing, local equals prev | delete local, delete DB record   |
| local missing, remote changed     | pull remote or conflict per mode |
| remote missing, local changed     | push local or conflict per mode  |

This is the main correctness gap.

### Runtime verification

Verify against real Filen account:

1. Re-upload same path replaces file rather than creating duplicate.
2. Uploaded `lastModified` survives `walk()` as `stat.mtimeMs`.
3. Recursive `readdir()` returns stable relative paths.
4. `mkdir()` path handling works for nested folders.
5. Mobile can login, read, write, and build with SDK bundle.

## Next

### File filtering

Add ignore rules before auto-sync.

Minimum:

- Skip plugin data dir.
- Optional user ignore list.
- Size limit guard for very large files.

### Auto-sync

Settings:

```ts
syncOnSave: boolean;
autoSyncIntervalMinutes: number;
syncOnStartDelaySeconds: number;
```

Triggers:

- Debounced `vault.on("modify")`.
- `registerInterval()` for periodic sync.
- Startup delay after layout ready.

Keep `isSyncing` guard; skip trigger when sync already running.

### Progress error states

Current failed sync only updates top-level status. Mark active file row as
`failed` before throwing so the progress view shows the last failing path.

## Later

- Conflict strategy setting: keep newer, keep local, keep remote.
- Safer local delete: use Obsidian trash when available.
- Concurrency with bounded queue after delete logic is correct.
- Rename detection if user demand exists.
- Plugin-level E2EE if data must stay portable outside Filen account encryption.
- Chunking/dedup if large binary files become common.
