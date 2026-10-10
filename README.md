# Obsidian Filen Sync

Sync an Obsidian vault with Filen using a direct folder mirror.

Obsidian Filen Sync mirrors vault files between Obsidian and a dedicated folder in your Filen account. It provides bidirectional synchronization, one-way push and pull, automatic background sync, conflict preservation, two-pane remote version history, and transfer safety rails, all while isolating sync baselines in local IndexedDB.

> **Early release:** Keep independent backups of your vault until you have verified the plugin with your workflow.

## Highlights

- **Direct Filen folder mirror**: Vault files mirror directly to a readable remote folder (e.g. `/Obsidian/<vaultName>`), without proprietary database blobs or chunked journal locks.
- **Flexible sync modes**: Run full bidirectional **Sync now**, or one-way **Push changed local files** and **Pull changed remote files**.
- **Automatic opening sync**: Checks Filen one second after the workspace is ready and when returning to the app. Save and interval triggers are optional; pause and safety holds still apply.
- **Fast remote polling**: Probes Filen's cloud events feed during auto-sync to skip full remote scans when nothing changed in the cloud.
- **Cheap routine checks on mobile**: Returning to the app and periodic intervals reconcile the full included inventory while reusing still-valid content hashes, so unchanged vaults finish quickly without re-reading every file. Focus and visibility events for the same transition share one reconciliation; manual sync and initial sync still verify fresh content.
- **Native status bar & quiet mobile status**: Real-time sync progress via an unobtrusive spinning ribbon icon on mobile (never obstructing your notes), and a customizable status bar item on desktop. Select **Show sync progress** on demand anytime.
- **Two-pane file version history**: Browse remote file revisions in Filen with grouped dates, side-by-side diff comparison against your local file, one-click preview, copy, and restore.
- **Safety rails & bulk mutation guard**: Prevents catastrophic vault wipes if a folder is emptied or unmounted; prompts for confirmation before bulk overwrites or local deletions.
- **Conflict preservation**: Automatically merges independent changes and pauses competing changes for review, preserving both originals in hidden recovery storage.
- **Target identity isolation**: Sync baselines in local IndexedDB are strictly partitioned by vault ID, authenticated Filen user ID, and remote directory UUID to prevent baseline pollution across accounts or folders.
- **Pre-mutation revalidation**: Re-reads and verifies local hashes and remote UUIDs immediately before uploading or deleting to prevent race conditions.
- **Secure credential storage**: Passwords and two-factor codes stay in memory only. Derived authentication keys/tokens are stored securely in Obsidian `SecretStorage`.
- **Parallel chunk transfers**: Fast 1 MiB chunk streaming via a worker pool with configurable file size limits (skipping large files if desired).
- **Offline & network resilience**: Automatically detects offline network state, gracefully suspends background sync loops, and resumes when reconnected.
- **Cross-platform**: Desktop and mobile support (macOS, Windows, Linux, iOS, and Android).

## How it works

The plugin treats Filen as a remote filesystem. During a bidirectional sync, it compares three sources:

1. **Current local vault files**
2. **Current Filen remote mirror folder**
3. **Previous sync baseline** stored locally in IndexedDB

Based on this comparison:

- **Local additions or edits** are uploaded to Filen.
- **Remote additions or edits** are downloaded to the vault.
- **Local deletions** move corresponding remote files to the Filen trash.
- **Remote deletions** prompt for confirmation before moving local files to the Obsidian system trash.
- **Concurrent edits** use **Automatically merge** by default. Markdown and selected JSON settings combine independent changes against verified last-synced content. Competing changes, missing snapshots, invalid text, and binary conflicts pause that file for review. Pending reviews remain protected during push, pull, and force upload. Other files continue syncing.
- **Selected settings JSON** merges top-level objects with local keys overriding remote keys. Nested objects and arrays are replaced as whole values. Settings sync is disabled by default; enable it and explicitly select core settings or individual plugins’ `data.json`. Workspace/cache files, plugin executables, and this plugin’s own directory remain excluded.
- **Recovery** preserves both original versions locally before automatic conflict writes. Recovery bytes stay in the excluded plugin directory, with metadata isolated by the verified sync target. They are never automatically deleted.

### First sync

On an initial sync without prior history, the plugin uses a conservative baseline:

- No deletions are inferred from absence on either side.
- Files present on both sides with identical content fingerprints are verified and linked into the baseline.
- Differing files on both sides pause for review when a safe merge is unavailable.

## Requirements

- Obsidian `1.11.4` or newer (required for `SecretStorage`)
- A Filen account
- Node.js 20+ and npm (only for building from source)

## Installation

### Beta testing via BRAT (Recommended)

You can install beta releases and receive automatic updates using the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin:

1. Install the **BRAT** plugin from Obsidian's Community Plugins directory (**Settings → Community plugins → Browse → Obsidian42 - BRAT**).
2. Open the Obsidian Command Palette (`Ctrl/Cmd + P`) and run:
   **BRAT: Add a beta plugin for testing**
3. Paste this repository path:
    ```text
    ilhamagustiawan/obsidian-filen-sync
    ```
4. Select **Add plugin**. BRAT will download the release assets (`manifest.json`, `main.js`, `styles.css`) and keep the plugin updated automatically.

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ilhamagustiawan/obsidian-filen-sync/releases).
2. In your vault, navigate to `.obsidian/plugins/` and create a folder named `obsidian-filen-sync`:
    ```text
    <vault>/.obsidian/plugins/obsidian-filen-sync/
      main.js
      manifest.json
      styles.css
    ```
3. In Obsidian, open **Settings → Community plugins**, select **Reload plugins**, and enable **Obsidian Filen Sync**.

### Install from source

```bash
npm install
npm run build
```

Copy the built files (`main.js`, `manifest.json`, `styles.css`) into `<vault>/.obsidian/plugins/obsidian-filen-sync/` and enable the plugin in Obsidian.

## Setup

1. Open **Settings → Obsidian Filen Sync**.
2. Enter your Filen **Email**.
3. Enter your **Password** and optional **Two-factor code**.
4. Check the **Remote folder** (default: `/Obsidian`) and **Vault name** (default: your vault's folder name).
5. Review **Ignore paths** for any custom vault-relative patterns.
6. Select **Login** or **Test connection**.
7. Run **Initial sync** from the command palette. It checks local and remote files in full, preserves sync history, and keeps conflict and deletion safeguards. Safe to retry after a partial failure.

### Credential security

- Your **password** and **two-factor code** are used for login authentication and remain in memory only. They are never written to disk or transmitted to any third party.
- When **Remember derived credentials** is enabled (default), derived Filen session keys/tokens are saved in Obsidian's native `SecretStorage`.
- When **Remember derived credentials** is turned off, credentials stay in memory for the current Obsidian session only; you will need to log in again after restarting Obsidian.
- Select **Disconnect** at any time to wipe stored session credentials and reset authentication.

## Commands

All commands can be invoked from the Obsidian Command Palette (`Ctrl/Cmd + P`):

| Command                                            | What it does                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Obsidian Filen Sync: Initial sync**              | Fully verify both sides during setup or recovery; preserve existing sync history.                          |
| **Obsidian Filen Sync: Sync now**                  | Compare local and remote changes, apply updates bidirectionally, and preserve conflict copies when needed. |
| **Obsidian Filen Sync: Push changed local files**  | Upload changed local files to Filen without pulling remote changes or deleting local files.                |
| **Obsidian Filen Sync: Pull changed remote files** | Download changed remote files from Filen without uploading local changes or deleting remote files.         |
| **Obsidian Filen Sync: Force sync current file**   | Upload active editor file directly to Filen, with overwrite confirmation if the remote copy changed.       |
| **Obsidian Filen Sync: Test Filen connection**     | Test Filen authentication and remote read/write access.                                                    |
| **Obsidian Filen Sync: Pause or resume auto-sync** | Pause or resume background auto-sync triggers without affecting manual commands.                           |
| **Obsidian Filen Sync: Toggle sync on save**       | Enable or disable save-triggered background sync.                                                          |
| **Obsidian Filen Sync: Open activity logs**        | Open the sync activity modal showing recent connection, scan, transfer, and conflict events.               |

## User interface

### Sync progress and status

Desktop status-bar, ribbon, and mobile right-sidebar buttons share the same status and always open the sync menu. Green circle/check means a complete successful run with no pending changes or unresolved issues. Purple arrows indicate syncing; purple pause indicates paused sync; purple circle indicates pending/checking. Disconnected/offline is red, conflicts are amber, and errors are red. Animations respect reduced-motion preferences.

The menu starts with **Review conflicts (N)** when needed, followed by **Pause/Resume**, **Version history**, **Open Sync log**, **Deleted files**, and **Sync settings**. Version history is disabled unless a Markdown note is active. **Sync now** and **Show sync progress** remain available; push, pull, previews, force upload, and diagnostics are grouped under **Advanced**.

**Show sync progress** opens a centered live progress popup with Close and Escape controls. Transfer totals describe transfer progress; they do not imply whole-run completion. Rendering stays throttled, and terminal results dismiss after a short delay. Automatic runs keep progress in the icons. Pausing stops subsequent automatic runs while an active operation finishes safely.

### Mobile status

One persistent button lives in the right sidebar and remounts after layout changes. It uses the same menu and states as desktop. **Show mobile sync status** controls visibility without disabling synchronization. Connected, unpaused vaults check shortly after opening even when save and interval sync are disabled. Returning to the app coalesces duplicate checks; offline checks recover on reconnection. **Initial sync** keeps full verification.

### Conflict review

New unresolved conflicts open one resolver after synchronization. Pending reviews survive restarts and remain isolated to the selected Filen target. Closing the resolver leaves both originals unchanged.

Review the base, local, and Filen versions. Independent Markdown edits and JSON keys merge automatically; competing sections require a choice. Whole-file choices handle binary files and deletions. Editable text results are validated before saving. Comparisons use Google's diff-match-patch locally, without sending content to Google, with bounded size and execution time.

**Apply and sync** revalidates the reviewed versions and writes the approved result to both the vault and Filen immediately. Writes are guarded but cannot be atomic across both systems; interrupted approvals retain recovery snapshots and can resume safely. Changed originals require a fresh review.

After successful resolution, all reviewed legacy `.sync-conflict-*` files for that original are removed from both the vault and Filen, including duplicate copies. Cleanup uses trash, preserves hidden recovery backups, and only clears the review after verifying no copies remain. New or changed copies require review before deletion. Failed cleanup remains pending for retry.

### Deleted files

Browse searchable Filen trash scoped to the verified remote root and target-bound historical UUID mappings. Unknown ownership is excluded. Restoring requires confirmation, fresh membership checks, and unoccupied local and remote destinations. If the original parent is unavailable, restore that parent in Filen first. Successful restores invalidate caches and queue reconciliation. No permanent-delete or empty-trash action is provided.

### File context menu

Right-click any file in the file explorer or active editor tab to access:

- **Force sync to Filen**: Uploads the file immediately to Filen. Prompts for confirmation if the remote copy changed since the last baseline.
- **Filen: sync now**: Runs a two-way sync.
- **Filen: version history**: Opens the two-pane version history modal for that file.

### Two-pane file version history

The centered history window uses a date-grouped timeline on the left and independently scrolling preview on the right. Revision counts, local times, and accent selection identify the selected revision. **Filen versions** and **Local recovery** are separate sources; no author or device identity is invented.

The fixed header contains the filename, **Show changes**, **Copy**, **Restore**, and Close. Normal previews use Obsidian’s Markdown renderer, including tables. **Show changes** compares the revision with the current file within bounded comparison limits. **Copy** copies source text. **Restore** confirms the file and revision, saves current bytes in local recovery, then restores and reconciles. Narrow screens use timeline/preview navigation with **Back**. Stale previews are ignored and render resources are released on selection changes and close.

### Activity logs

The activity log modal displays recent events (up to 500 entries) in a structured, diagnostic view:

- **Timestamps & badges**: Clear local timestamps (`YYYY-MM-DD HH:mm:ss`) with category badges (**General**, **Error**, **Conflict**, **Skipped**, **Account**, **Network**).
- **Fast filtering**: Quickly toggle between **All**, **Activity** (routine operations and successful transfers), and **Issues** (conflicts, errors, skipped files, and network/account notices).
- **Instant search**: Case-insensitive search filter by file path, event message, or timestamp.
- **Summary**: Live "Showing N of M" counter indicating visible vs total logged entries.
- **Immediate clear**: Clear log history directly with the **Clear logs** button.
- **Noise reduction**: Clean signal without duplicate lifecycle spam — raw edit events, routine connection success, and automatic no-op sync passes are omitted, logging concise past-tense transfer entries and aggregate outcomes.

## Remote layout

By default, the plugin mirrors files under:

```text
/Obsidian/<vaultName>
```

For example, a vault named `personal` with notes and attachments mirrors to:

```text
/Obsidian/personal/
  Daily Notes/2026-05-24.md
  Projects/Roadmap.md
  attachments/diagram.png
```

The sync baseline is maintained locally in IndexedDB inside the vault's plugin storage. It is never written into your remote Filen folder.

## Settings reference

### Account

| Setting                          | Description                                                                                        | Default |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | ------- |
| **Remember derived credentials** | Store derived session keys in Obsidian `SecretStorage`. If disabled, credentials stay in RAM only. | Enabled |
| **Email**                        | Your Filen account email.                                                                          | Empty   |
| **Password**                     | Your Filen account password (session-only; never stored on disk).                                  | Empty   |
| **Two-factor code**              | One-time 2FA verification code (if enabled on your Filen account).                                 | Empty   |
| **Login / Disconnect**           | Connect to your Filen account or disconnect to clear stored credentials.                           | —       |

### Sync

| Setting           | Description                                                            | Default            |
| ----------------- | ---------------------------------------------------------------------- | ------------------ |
| **Remote folder** | Base remote folder in Filen. The vault name is appended automatically. | `/Obsidian`        |
| **Vault name**    | Remote subfolder name representing this vault.                         | Current vault name |
| **Ignore paths**  | Vault-relative paths or glob patterns to exclude from synchronization. | Default patterns   |

### Auto-sync & UI

| Setting                        | Description                                                                                         | Default      |
| ------------------------------ | --------------------------------------------------------------------------------------------------- | ------------ |
| **Auto-sync paused**           | Pause background sync triggers without disabling manual commands.                                   | Disabled     |
| **Sync progress**              | Open centered details explicitly from the menu.                                                     | On demand    |
| **Show mobile sync status**    | Show the persistent right-sidebar status button.                                                    | Enabled      |
| **Status bar indicator style** | Choose between **Compact icon** (native Obsidian Sync style) or **Icon and text**.                  | Compact icon |
| **Sync on file save**          | Batch file changes after the save delay; automatic runs also respect the minimum gap below.         | Enabled      |
| **Sync on save delay**         | Wait this long after the latest save before syncing (1 to 30 seconds).                              | `2` seconds  |
| **Minimum automatic sync gap** | Wait at least this long between automatic sync starts (5 to 120 seconds). Manual sync is immediate. | `10` seconds |
| **Background sync interval**   | Periodic sync interval in minutes (0 to 60; 0 disables interval sync).                              | `3` minutes  |
| **Fast remote polling**        | Query Filen's cloud events feed to skip full remote scans when nothing changed remotely.            | Enabled      |
| **Skip large files**           | Skip transferring files larger than the specified threshold.                                        | Enabled      |
| **Skip size threshold**        | Maximum file size in megabytes before skipping (1 to 1000 MB).                                      | `50` MB      |

## Ignore rules

Default ignore rules skip noisy, device-specific, or internal paths:

- `.obsidian/cache`
- `.obsidian/workspace*.json`
- `.git`
- `node_modules`
- The plugin's internal data directory

Add custom vault-relative paths or glob patterns in **Settings → Obsidian Filen Sync → Ignore paths**, one per line.

## Safety and data integrity

- **Bulk operation guard**: If an operation would delete or overwrite an unusually large volume of files (such as when a folder was emptied or unlinked), sync pauses and requests explicit confirmation.
- **Local delete confirmation**: When remote deletions would remove local files, a confirmation modal details the affected files. Approved local deletions move to the Obsidian system trash.
- **Remote trash**: Remote deletions move files to Filen's cloud trash rather than permanently deleting them.
- **Pre-mutation revalidation**: Files are re-read and re-hashed immediately before upload to guarantee that in-progress edits are not corrupted. Remote entries are verified by UUID and hash before deletion or replacement.
- **Session-only scoped scanning**: Save-triggered automatic runs use cached scan snapshots and path hints to refresh and plan only changed candidate files without scanning the rest of the vault. If any condition is uncertain (such as remote cloud changes, stale local/remote caches, folder operations, or interval/manual sync), the engine automatically falls back to a full reconciliation.
- **Independent scan policy**: Routine foreground and interval runs enumerate the complete inventory and reuse still-valid session hashes (finding adds, deletes, renames, and folder changes even with no queued edits), refresh remote metadata only when the probe, expiry, or explicit verification requires it, and never extend a hash's verification deadline. Manual, initial, preview, and recovery runs keep fresh verification. First-sync equality derives both fingerprints from one stable read, and small-file hashing is bounded by workers and an accounted byte budget.
- **Transfer recovery & reconciliation**: If a transfer times out or is aborted with an uncertain outcome, the plugin marks reconciliation as required, pauses automatic sync, and prevents force uploads until a full two-way sync reconciles state safely.
- **Target identity binding**: Baselines are isolated by `(vaultId, userId, remoteRootUuid)`. Switching Filen accounts or changing the remote folder automatically re-binds cleanly without corrupting previous baselines.

## Known limitations

- **Merge snapshots**: Markdown merging is limited to 1 MiB per version and 64 MiB of snapshots per target. Snapshots come only from verified sync/equality; evicted or missing snapshots fall back to review. Local recovery has no automatic expiry and consumes vault storage.
- **File renames**: Detected via remote UUID tracking where available. Moves across different directory structures may be processed as delete plus create.
- **Collaboration**: Designed for personal vault synchronization across devices; not intended as a real-time multi-user concurrent editor.

## Privacy and compliance

- **Direct communication**: All network traffic connects directly to Filen's official API servers using Obsidian's native `requestUrl` transport.
- **Zero telemetry**: The plugin contains no tracking, telemetry, or analytics.
- **Data scope**: File contents and paths are sent to Filen solely as needed for sync, versioning, and connection testing.
- **Credentials**: Passwords and two-factor codes are held in memory only during authentication. Stored session keys use Obsidian's protected `SecretStorage`.
- **Local logs**: Activity logs reside strictly in plugin memory and local storage; they are never sent externally.

## Development

Prerequisites: Node.js 20+ and npm.

```bash
# Install dependencies
npm install

# Watch mode for development
npm run dev

# Production build
npm run build

# Run unit and integration tests
npm run test

# Code quality and formatting
npm run lint       # oxlint
npm run fmt:check  # oxfmt check
npm run fmt        # oxfmt auto-format
```

### Deploy to local test vault

```bash
npm run deploy:test-vault
```

To specify a custom test vault path:

```bash
TEST_VAULT_PATH=/path/to/vault npm run deploy:test-vault
```

## Release

1. Update `version` in `package.json`, `manifest.json`, and `versions.json` (or use `npm version <patch|minor|major>`).
2. Run `npm run build` and `npm run test`.
3. Create a GitHub release tagged with the exact version (e.g. `1.0.0`, without a leading `v`).
4. Attach `manifest.json`, `main.js`, and `styles.css` as release assets.

## License

AGPL-3.0-only.

`@filen/sdk` is licensed under AGPLv3, and this plugin is licensed under AGPLv3 as well.

Google’s diff-match-patch implementation is pinned to `1.0.5` and bundled for browser use. Its Apache 2.0 license is included in [licenses/diff-match-patch.txt](licenses/diff-match-patch.txt) and the generated bundle.
