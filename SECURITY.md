# Security policy

## Supported versions

Security fixes are developed for the latest released version. The plugin requires Obsidian 1.11.4 or newer for its SecretStorage integration.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through the repository owner's GitHub security advisories. Do not include vault contents, passwords, two-factor codes, or derived Filen credentials in a public issue.

## Security and privacy notes

- The plugin sends vault file contents and paths to Filen for sync operations. It makes no telemetry or analytics requests.
- Raw passwords and two-factor codes are not intentionally persisted. Derived Filen authentication credentials are saved in Obsidian SecretStorage by default and permit account access. They do not protect against malicious plugins, a compromised device, or someone with access to the unlocked Obsidian profile.
- Activity logs are local and may include filenames or paths. Treat them as sensitive.
- Remote sync deletes are sent to Filen trash, not permanently deleted. Local sync deletes use Obsidian's system trash.
- Legacy plaintext authentication is migrated only after SecretStorage write/read verification. Stop syncing before downgrading; never restore deprecated password persistence.
- Back up the vault and preserve its sync history before upgrades. Test migrations and recovery on a scratch vault first.

## Network

The plugin communicates with Filen using the official `@filen/sdk` through Obsidian's `requestUrl` transport. It does not disable TLS certificate validation.
