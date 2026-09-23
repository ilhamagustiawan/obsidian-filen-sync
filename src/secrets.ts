import type { App } from "obsidian";
import { readFilenAuth, type FilenAuth } from "./auth";

const AUTH_ID = "filen-sync-auth";
const PASSWORD_ID = "filen-sync-password";

/**
 * Typed wrapper around Obsidian's SecretStorage API for this plugin.
 *
 * Hides JSON serialization and the "empty-string sentinel" pattern
 * (SecretStorage has no delete, so we store "" to signal absence).
 */
export class PluginSecrets {
	constructor(private readonly app: App) {}

	// ── Auth ────────────────────────────────────────────────────────

	/** Store the FilenAuth credentials. */
	setAuth(auth: FilenAuth): void {
		this.app.secretStorage.setSecret(AUTH_ID, JSON.stringify(auth));
	}

	/** Retrieve the stored FilenAuth, or null. */
	getAuth(): FilenAuth | null {
		const raw = this.app.secretStorage.getSecret(AUTH_ID);
		if (!raw) return null;
		try {
			return readFilenAuth(JSON.parse(raw));
		} catch {
			return null;
		}
	}

	/** Clear persisted derived credentials. */
	clearAuth(): void {
		this.app.secretStorage.setSecret(AUTH_ID, "");
	}

	/** True when auth credentials are present. */
	hasAuth(): boolean {
		return this.getAuth() !== null;
	}

	/** Remove a raw password left by versions that persisted it. */
	clearLegacyPassword(): void {
		this.app.secretStorage.setSecret(PASSWORD_ID, "");
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/** Wipe all secrets (auth + password). */
	clear(): void {
		this.app.secretStorage.setSecret(AUTH_ID, "");
		this.app.secretStorage.setSecret(PASSWORD_ID, "");
	}
}
