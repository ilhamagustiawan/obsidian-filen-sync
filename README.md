# Obsidian Filen Sync

Sync an Obsidian vault with Filen using a direct folder mirror.

Obsidian Filen Sync mirrors vault files between Obsidian and a folder in your Filen account. It supports manual sync, optional auto-sync, conflict copies, and Filen file versions while keeping sync state locally in the vault's plugin data.

> **Early release:** Keep independent backups until you trust it with your workflow.

## Highlights

- Direct Filen folder mirror for your vault files
- Manual **Sync now**, **Push local**, and **Pull remote** commands
- Optional auto-sync on save, after startup, and on an interval
- Status bar indicator with sync details and quick actions
- Activity view showing scan, upload, download, delete, and conflict rows
- Conflict copies when the same file changed locally and remotely
- Filen file version list, restore, preview, and delete actions
- Local sync baseline in IndexedDB for change detection
- SHA-256 fallback to handle timestamp drift
- Vault-relative ignore rules with safe Obsidian defaults
- Desktop and mobile support

## How it works

The plugin treats Filen as a remote filesystem. During sync it compares:

1. the current vault files,
2. the current Filen mirror folder, and
3. the previous sync baseline stored locally.

Changed files are uploaded, downloaded, or deleted to make both sides match. If both sides changed since the last baseline, the plugin keeps a conflict copy instead of silently overwriting one side.

## Requirements

- Obsidian `0.15.0` or newer
- A Filen account
- Node.js 18+ and npm for development from source

## Install from source

```bash
npm install
npm run build
```

Copy the release files into your vault plugin folder:

```text
<vault>/.obsidian/plugins/obsidian-filen-sync/
  main.js
  manifest.json
  styles.css
```

Then enable **Obsidian Filen Sync** in **Settings → Community plugins**.

## Setup

1. Open **Settings → Obsidian Filen Sync**.
2. Enter your Filen email.
3. Enter your password and optional two-factor code.
4. Keep the default remote folder, or choose a folder dedicated to this vault.
5. Review ignored paths.
6. Select **Login** or **Test connection**.
7. Run **Sync now**.

Your password and two-factor code are kept in memory only for the current Obsidian session. Saved Filen authentication data is stored in Obsidian plugin data. Use **Disconnect** to remove saved auth and switch accounts.

## Commands

| Command                                            | What it does                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Obsidian Filen Sync: Sync now**                  | Compare local and remote changes, update both sides, and keep conflict copies when needed. |
| **Obsidian Filen Sync: Push changed local files**  | Upload local changes to Filen without pulling remote changes.                              |
| **Obsidian Filen Sync: Pull changed remote files** | Download remote changes without pushing local changes.                                     |
| **Obsidian Filen Sync: Test Filen connection**     | Check login and remote write/delete access.                                                |
| **Obsidian Filen Sync: Open sync activity**        | Open the sync activity view for the current or last run.                                   |
| **Obsidian Filen Sync: Toggle sync on save**       | Enable or disable save-triggered background sync.                                          |

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

Vault file contents and paths are sent to Filen as required for sync, push, pull, file version, and connection-test actions. Password and two-factor code are not persisted by this plugin.

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
