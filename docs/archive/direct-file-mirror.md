# Plan: direct file mirror

Status: implemented as MVP.

The plugin mirrors vault files into one Filen folder and uses IndexedDB as the
last-synced baseline.

## Architecture

```text
LOCAL vault files
   <-> SyncEngine decision table
PREV SYNC state  <- IndexedDB / SyncDb
   <-> SyncEngine decision table
REMOTE Filen folder
```

See `docs/filen-sync-implementation-plan.md` for current architecture.

## Implemented files

| File                        | Status                                                |
| --------------------------- | ----------------------------------------------------- |
| `src/fs-remote.ts`          | Filen `RemoteFs`; walk/read/write/delete/version APIs |
| `src/sync-engine.ts`        | 3-way compare; push/pull/conflict copy                |
| `src/settings.ts`           | Saved auth, remote root, device/vault labels          |
| `src/db.ts`                 | Prev-sync IndexedDB store                             |
| `src/progress-view.ts`      | Sync progress UI                                      |
| `src/file-version-modal.ts` | Filen versions UI                                     |

## Decision table target

| Local vs prev | Remote vs prev | Expected                    |
| ------------- | -------------- | --------------------------- |
| same          | same           | skip                        |
| changed       | same           | upload local                |
| same          | changed        | download remote             |
| missing       | same           | delete remote               |
| same          | missing        | delete local                |
| changed       | changed        | conflict copy + chosen side |
| new           | new            | conflict; newer wins        |

## Current gaps

- Delete rows in the decision table are not implemented correctly yet.
- Remote overwrite behavior still needs runtime confirmation against Filen SDK.
- Remote walk performs `stat()` per entry; large vault cost unknown.
- Sync runs sequentially.

## Resolved questions

| Question          | Current answer                                              |
| ----------------- | ----------------------------------------------------------- |
| Sync model        | Direct mirror                                               |
| Prev-sync storage | IndexedDB via `localforage`                                 |
| Hash              | Local SHA-256 only when metadata changed                    |
| Root mkdir        | Implemented via `getParentUuid()` recursive-ish path ensure |
| Socket            | Disabled: `connectToSocket: false`                          |
