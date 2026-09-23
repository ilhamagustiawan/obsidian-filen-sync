# Obsidian Filen Sync

Sync an Obsidian vault with Filen using a direct folder mirror.

Obsidian Filen Sync mirrors vault files between Obsidian and a folder in your Filen account. It supports manual sync, optional auto-sync, conflict copies, and Filen file versions while keeping sync state locally in the vault's plugin data.

> **Early release:** Keep independent backups until you trust it with your workflow.

## Highlights

- Direct Filen folder mirror for your vault files
- Manual **Sync now** command
- Optional auto-sync on save, after startup, and on an interval
- Native Obsidian-style status bar indicator (animated spinning sync icon during sync, idle state with relative sync time, offline/pause warning states, and 1-click action menu)
- Activity view showing scan, upload, download, delete, and conflict rows
- Conflict copies when the same file changed locally and remotely
- Filen file version list, restore, preview, and delete actions
- Local sync baseline in IndexedDB for change detection
- SHA-256 fallback to handle timestamp drift
- Vault-relative ignore rules with safe Obsidian defaults
- Parallel chunk transfers (1 MiB chunks via a pool of 3 workers) with configurable size limits
- Fast remote polling via Filen events feed with fallback safety rails
- Desktop and mobile support

## How it works

The plugin treats Filen as a remote filesystem. During sync it compares:

1. the current vault files,
2. the current Filen mirror folder, and
3. the previous sync baseline stored locally.

Changed files are uploaded, downloaded, or deleted to make both sides match. If both sides changed since the last baseline, the plugin keeps a conflict copy instead of silently overwriting one side.

## Requirements

- Obsidian `1.11.4` or newer (for SecretStorage)
- A Filen account
- Node.js 20+ and npm for development from source

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
2. Enter your Filen email.
3. Enter your password and optional two-factor code.
4. Keep the default remote folder, or choose a folder dedicated to this vault.
5. Review ignored paths.
6. Select **Login** or **Test connection**.
7. Run **Sync now**.

Your password and two-factor code are used for login and stay in memory only. When **Remember derived credentials** is enabled, derived Filen session tokens/keys are stored in Obsidian SecretStorage; they grant account access and are not protected from malicious plugins or a compromised device. Turn off **Remember derived credentials** to keep credentials for this session only; you will need to log in again after restarting Obsidian. Use **Disconnect** to remove saved credentials and switch accounts. Valid legacy credentials are migrated only after SecretStorage readback verification. Invalid credentials or failed sanitization require reconnection; plugin data is never re-saved with the legacy auth payload.

Sync history is bound to a persistent local vault ID, authenticated Filen user ID, and the resolved UUID of the effective remote folder. If any part changes, history is not reused. Unverified legacy history is left untouched and inactive, so the first sync uses a conservative baseline and may create conflict copies instead of importing old deletion history. A timed-out or aborted transfer can have an uncertain remote result. The plugin saves a non-secret reconciliation-needed marker, pauses automatic sync, and blocks force-upload until outstanding requests settle and a full manual sync succeeds. Client-side checks reduce races but cannot provide server-side compare-and-swap guarantees.

## Commands

| Command                                          | What it does                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Obsidian Filen Sync: Sync now**                | Compare local and remote changes, update both sides, and keep conflict copies when needed. |
| **Obsidian Filen Sync: Force sync current file** | Upload active editor file immediately to Filen, with overwrite confirmation if changed.    |
| **Obsidian Filen Sync: Test Filen connection**   | Check login and remote write/delete access.                                                |
| **Obsidian Filen Sync: Open sync activity**      | Open the sync activity view for the current or last run.                                   |
| **Obsidian Filen Sync: Toggle sync on save**     | Enable or disable save-triggered background sync.                                          |

## Remote layout

Default effective remote folder:

```text
/Obsidian/default
```

Vault files are mirrored directly under that folder:

```text
/Obsidian/default/
  notes/example.md
  assets/image.png
```

The sync baseline stays local. It is not written into the Filen mirror folder.

## Ignore rules

Default ignore rules skip noisy or unsafe paths such as:

- `.obsidian/cache`
- `.obsidian/workspace*.json`
- `.git`
- `node_modules`
- this plugin's own data folder

Add more vault-relative rules in plugin settings if needed.

## Known limitations

- There is no side-by-side conflict resolution UI yet.
- Conflict strategy is not configurable yet.
- Renames are treated as delete plus create.
- Auto-sync is lightweight polling/event sync, not realtime socket sync.

## Privacy

This plugin connects only to Filen. It does not include telemetry or analytics.

Vault file contents and paths are sent to Filen as required for sync, file version, and connection-test actions. Password and two-factor code are not persisted by this plugin. Activity logs may contain filenames and other sensitive path details; they remain in plugin data and are not transmitted as telemetry.

## Development

```bash
npm install
npm run dev
npm run build
npm run test
npm run lint
```

Deploy to the default test vault:

```bash
npm run deploy:test-vault
```

Override the test vault path:

```bash
TEST_VAULT_PATH=/path/to/vault npm run deploy:test-vault
```

## Release

1. Update `manifest.json` and `versions.json`.
2. Run `npm run build`.
3. Create a GitHub release tagged with the exact plugin version, without a leading `v`.
4. Attach `manifest.json`, `main.js`, and `styles.css` as individual assets.

## Contributing

Issues and pull requests are welcome. Keep changes small, typed, and easy to verify.

Before submitting:

```bash
npm run build
npm run test
npm run lint
```

## License

AGPL-3.0-only.

`@filen/sdk` is AGPL, so this plugin is AGPL too.
