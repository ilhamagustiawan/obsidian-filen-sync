import type { App } from "obsidian";
import { PluginSettingTab, Setting } from "obsidian";
import { readActivityLogs, type ActivityLogEntry } from "./activity-logs";
import type FilenSyncPlugin from "./main";
import { DEFAULT_IGNORE_PATTERNS, normalizeIgnorePatterns } from "./path-filters";
import { PluginSecrets } from "./secrets";

export type SyncedFileRecord = {
	path: string;
	mtime: number;
	ctime: number;
	size: number;
	hash?: string;
	/** Remote UUID assigned by Filen. Tracked to detect remote renames. */
	remoteUuid?: string;
	/** Unix-ms timestamp of the last successful sync operation for this file. */
	lastSyncAt?: number;
	/** Which side was last known to have the canonical version. */
	lastKnownSide?: "local" | "remote" | "both";
};

/**
 * Schema version for the sync-state database.
 * Bump this when SyncedFileRecord or the DB layout changes.
 * Migrations run automatically when the stored version is lower.
 */
export const SYNC_DB_SCHEMA_VERSION = 1;

export type FilenAuth = {
	email: string;
	masterKeys: string[];
	apiKey: string;
	publicKey: string;
	privateKey: string;
	authVersion: 1 | 2 | 3;
	baseFolderUUID: string;
	userId: number;
};

export type FilenSyncSettings = {
	email: string;
	remoteRoot: string;
	deviceId: string;
	vaultName: string;
	ignorePatterns: string[];
	hasAuth: boolean;
	syncOnSave: boolean;
	syncOnSaveDelaySeconds: number;
	syncIntervalMinutes: number;
	syncStartupDelaySeconds: number;
	syncPaused: boolean;
	activityLogs: ActivityLogEntry[];
};

const DEFAULT_REMOTE_ROOT = "/Obsidian";

export const DEFAULT_SETTINGS: FilenSyncSettings = {
	email: "",
	remoteRoot: DEFAULT_REMOTE_ROOT,
	deviceId: "",
	vaultName: "default",
	ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
	hasAuth: false,
	syncOnSave: true,
	syncOnSaveDelaySeconds: 5,
	syncIntervalMinutes: 3,
	syncStartupDelaySeconds: 0,
	syncPaused: false,
	activityLogs: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown, fallback: string): string =>
	typeof value === "string" ? value : fallback;

const readBoolean = (value: unknown, fallback: boolean): boolean =>
	typeof value === "boolean" ? value : fallback;

const readNumber = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) ? value : fallback;

const clampNumber = (value: number, min: number, max: number): number =>
	Math.min(max, Math.max(min, value));

const readStringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const readAuthVersion = (value: unknown): 1 | 2 | 3 | null => {
	if (value === 1 || value === 2 || value === 3) {
		return value;
	}

	return null;
};

export const readFilenAuth = (value: unknown): FilenAuth | null => {
	if (!isRecord(value)) {
		return null;
	}

	const email = readString(value.email, "");
	const masterKeys = readStringArray(value.masterKeys);
	const apiKey = readString(value.apiKey, "");
	const publicKey = readString(value.publicKey, "");
	const privateKey = readString(value.privateKey, "");
	const authVersion = readAuthVersion(value.authVersion);
	const baseFolderUUID = readString(value.baseFolderUUID, "");
	const userId = readNumber(value.userId, 0);

	if (
		email.length === 0 ||
		masterKeys.length === 0 ||
		apiKey.length === 0 ||
		publicKey.length === 0 ||
		privateKey.length === 0 ||
		authVersion === null ||
		baseFolderUUID.length === 0 ||
		userId <= 0
	) {
		return null;
	}

	return {
		email,
		masterKeys,
		apiKey,
		publicKey,
		privateKey,
		authVersion,
		baseFolderUUID,
		userId,
	};
};

export const FilenSyncSettings = {
	fromSaved(value: unknown): FilenSyncSettings {
		if (!isRecord(value)) {
			return {
				...DEFAULT_SETTINGS,
				ignorePatterns: [...DEFAULT_SETTINGS.ignorePatterns],
				activityLogs: [],
			};
		}

		return {
			email: readString(value.email, DEFAULT_SETTINGS.email),
			remoteRoot: readString(value.remoteRoot, DEFAULT_REMOTE_ROOT),
			deviceId: readString(value.deviceId, ""),
			vaultName: readString(value.vaultName, DEFAULT_SETTINGS.vaultName),
			ignorePatterns:
				"ignorePatterns" in value
					? normalizeIgnorePatterns(readStringArray(value.ignorePatterns))
					: [...DEFAULT_SETTINGS.ignorePatterns],
			hasAuth: readBoolean(value.hasAuth, DEFAULT_SETTINGS.hasAuth),
			syncOnSave: readBoolean(value.syncOnSave, DEFAULT_SETTINGS.syncOnSave),
			syncOnSaveDelaySeconds: clampNumber(
				readNumber(value.syncOnSaveDelaySeconds, DEFAULT_SETTINGS.syncOnSaveDelaySeconds),
				5,
				30,
			),
			syncIntervalMinutes: readNumber(
				value.syncIntervalMinutes,
				DEFAULT_SETTINGS.syncIntervalMinutes,
			),
			syncStartupDelaySeconds: readNumber(
				value.syncStartupDelaySeconds,
				DEFAULT_SETTINGS.syncStartupDelaySeconds,
			),
			syncPaused: readBoolean(value.syncPaused, DEFAULT_SETTINGS.syncPaused),
			activityLogs: readActivityLogs(value.activityLogs),
		};
	},
} as const;

export const getVaultRemoteRoot = (remoteRoot: string, vaultName: string): string => {
	const root = normalizeRemoteRoot(remoteRoot || DEFAULT_REMOTE_ROOT);
	const vaultSegment = normalizeRemoteSegment(vaultName || "default");
	if (root.split("/").filter(Boolean).pop() === vaultSegment) {
		return root;
	}

	return `${root.replace(/\/+$/u, "")}/${vaultSegment}`;
};

export class FilenSyncSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: FilenSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("filen-sync-settings");

		const intro = containerEl.createDiv({ cls: "filen-sync-settings-hero" });
		intro.createDiv({ text: "Obsidian Filen Sync", cls: "filen-sync-settings-hero-title" });
		intro.createEl("p", {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			text: "Mirror this vault to a Filen folder with manual sync, optional auto-sync, and conflict copies.",
		});

		this.renderAccountSection(containerEl);
		this.renderSyncSection(containerEl);
		this.renderAutoSyncSection(containerEl);
		this.renderActionsSection(containerEl);
	}

	private renderAccountSection(containerEl: HTMLElement): void {
		const section = createSection(
			containerEl,
			"Account",
			"Connect to Filen. Your password and two-factor code are kept only for this Obsidian session.",
		);

		if (this.plugin.hasSavedAuth()) {
			const card = section.createDiv({ cls: "filen-sync-settings-card is-connected" });
			const header = card.createDiv({ cls: "filen-sync-settings-card-header" });
			header.createEl("div", { text: "Connected", cls: "filen-sync-settings-card-badge" });
			header.createEl("div", {
				text: `Connected as ${this.plugin.settings.email}`,
				cls: "filen-sync-settings-card-title",
			});
			card.createEl("p", {
				text: "Session saved.",
				cls: "filen-sync-settings-card-copy",
			});
			const actions = card.createDiv({ cls: "filen-sync-settings-card-actions" });
			const disconnect = actions.createEl("button", { text: "Disconnect" });
			disconnect.addClass("mod-warning");
			disconnect.addEventListener("click", () => {
				void (async () => {
					await this.plugin.clearSavedAuth();
					this.display();
				})();
			});
			card.createEl("p", {
				text: "Disconnect to switch accounts.",
				cls: "filen-sync-settings-card-note",
			});

			new Setting(section)
				.setName("Account email")
				.setDesc("Saved account.")
				.addText((text) => text.setValue(this.plugin.settings.email).setDisabled(true));
			return;
		}

		new Setting(section)
			.setName("Email")
			.setDesc("Filen account email.")
			.addText((text) =>
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					.setPlaceholder("name@example.com")
					.setValue(this.plugin.settings.email)
					.onChange(async (value) => {
						this.plugin.settings.email = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(section)
			.setName("Password")
			.setDesc("Not stored.")
			.addText((text) => {
				text.inputEl.type = "password";
				if (!this.plugin.hasSessionPassword()) {
					const stored = new PluginSecrets(this.plugin.app).getPassword();
					if (stored.length > 0) {
						text.setValue(stored);
						this.plugin.setSessionPassword(stored);
					}
				}
				text.setPlaceholder(
					this.plugin.hasSessionPassword() ? "••••••••" : "Password",
				).onChange((value) => {
					this.plugin.setSessionPassword(value);
				});
			});

		new Setting(section)
			.setName("Two-factor code")
			.setDesc("If enabled.")
			.addText((text) =>
				text.setPlaceholder("123456").onChange((value) => {
					this.plugin.setSessionTwoFactorCode(value.trim());
				}),
			);

		new Setting(section)
			.setName("Login")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Connect to Filen.")
			.addButton((button) =>
				button
					.setButtonText("Login")
					.setCta()
					.onClick(async () => {
						try {
							await this.plugin.testConnection();
							this.display();
						} catch {
							// Error is already handled by testConnection notice
						}
					}),
			);
	}

	private renderSyncSection(containerEl: HTMLElement): void {
		const section = createSection(
			containerEl,
			"Sync",
			"Choose the Filen mirror folder and decide which vault paths should be ignored.",
		);

		new Setting(section)
			.setName("Remote folder")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Base Filen folder. The vault name is appended automatically.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_REMOTE_ROOT)
					.setValue(this.plugin.settings.remoteRoot)
					.onChange(async (value) => {
						this.plugin.settings.remoteRoot = value.trim() || DEFAULT_REMOTE_ROOT;
						await this.plugin.saveSettings();
						this.plugin.refreshSyncTarget();
					}),
			);

		new Setting(section)
			.setName("Vault name")
			.setDesc("Used in sync logs.")
			.addText((text) =>
				text.setValue(this.plugin.settings.vaultName).onChange(async (value) => {
					this.plugin.settings.vaultName = value.trim() || "default";
					await this.plugin.saveSettings();
					this.plugin.refreshSyncTarget();
				}),
			);

		new Setting(section)
			.setName("Ignore paths")
			.setDesc("One path or glob per line.")
			.addTextArea((text) => {
				text.setPlaceholder(DEFAULT_IGNORE_PATTERNS.join("\n"))
					.setValue(this.plugin.settings.ignorePatterns.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.ignorePatterns = normalizeIgnorePatterns(
							value.split(/\r?\n/u),
						);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
				text.inputEl.cols = 40;
			});

		const note = section.createDiv({ cls: "filen-sync-settings-note" });
		note.createEl("strong", { text: "Effective remote folder" });
		note.createSpan({
			text: ` ${getVaultRemoteRoot(this.plugin.settings.remoteRoot, this.plugin.settings.vaultName)}`,
		});

		const conflictNote = section.createDiv({ cls: "filen-sync-settings-note" });
		conflictNote.createEl("strong", { text: "Conflict handling" });
		conflictNote.createSpan({ text: " Local conflict copies are kept." });
		section.createEl("p", {
			text: "Plugin data is ignored automatically.",
			cls: "filen-sync-settings-note",
		});
	}

	private renderAutoSyncSection(containerEl: HTMLElement): void {
		const section = createSection(
			containerEl,
			"Auto-sync",
			"Optional background sync triggers.",
		);

		new Setting(section)
			.setName("Auto-sync paused")
			.setDesc("Pause background triggers without disabling manual sync.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncPaused).onChange(async (value) => {
					this.plugin.settings.syncPaused = value;
					await this.plugin.saveSettings();
					this.plugin.refreshAutoSync();
				}),
			);

		new Setting(section)
			.setName("Sync on file save")
			.setDesc("Sync after file changes.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnSave).onChange(async (value) => {
					this.plugin.settings.syncOnSave = value;
					await this.plugin.saveSettings();
					this.plugin.refreshAutoSync();
				}),
			);

		const delaySetting = new Setting(section);
		delaySetting
			.setName(`Sync on save delay (${this.plugin.settings.syncOnSaveDelaySeconds} sec)`)
			.setDesc("Delay before syncing.")
			.addSlider((slider) =>
				slider
					.setLimits(5, 30, 1)
					.setValue(this.plugin.settings.syncOnSaveDelaySeconds)
					.setDynamicTooltip()
					.onChange(async (value) => {
						delaySetting.setName(`Sync on save delay (${value} sec)`);
						this.plugin.settings.syncOnSaveDelaySeconds = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAutoSync();
					}),
			);

		const intervalSetting = new Setting(section);
		intervalSetting
			.setName(
				`Background sync interval (${formatInterval(this.plugin.settings.syncIntervalMinutes)})`,
			)
			.setDesc("Set 0 to disable.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 60, 1)
					.setValue(this.plugin.settings.syncIntervalMinutes)
					.setDynamicTooltip()
					.onChange(async (value) => {
						intervalSetting.setName(
							`Background sync interval (${formatInterval(value)})`,
						);
						this.plugin.settings.syncIntervalMinutes = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAutoSync();
					}),
			);

		new Setting(section)
			.setName("Sync after startup")
			.setDesc("Set 0 to disable.")
			.addText((text) =>
				text
					.setPlaceholder("0")
					.setValue(String(this.plugin.settings.syncStartupDelaySeconds))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed) && parsed >= 0) {
							this.plugin.settings.syncStartupDelaySeconds = parsed;
							await this.plugin.saveSettings();
							this.plugin.refreshAutoSync();
						}
					}),
			);
	}

	private renderActionsSection(containerEl: HTMLElement): void {
		const section = createSection(containerEl, "Actions", "Run manual tasks.");

		new Setting(section)
			.setName("Test connection")
			.setDesc("Check account and folder.")
			.addButton((button) =>
				button.setButtonText("Test").onClick(() => {
					void this.plugin.testConnection();
				}),
			);

		new Setting(section)
			.setName("Sync now")
			.setDesc("Run bidirectional sync.")
			.addButton((button) =>
				button
					.setButtonText("Sync")
					.setCta()
					.onClick(() => {
						void this.plugin.syncNow();
					}),
			);
	}
}

const createSection = (
	containerEl: HTMLElement,
	title: string,
	description: string,
): HTMLElement => {
	const section = containerEl.createDiv({ cls: "filen-sync-settings-section" });
	section.createDiv({ text: title, cls: "filen-sync-settings-section-title" });
	section.createEl("p", { text: description, cls: "filen-sync-settings-section-description" });
	return section;
};

const normalizeRemoteRoot = (path: string): string => {
	const normalized = path.trim().replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/\/+$/u, "");
	if (normalized.length === 0 || normalized === "/") {
		return DEFAULT_REMOTE_ROOT;
	}

	return normalized.startsWith("/") ? normalized : `/${normalized}`;
};

const normalizeRemoteSegment = (segment: string): string => {
	const normalized = segment.trim().replace(/\\/gu, "/").split("/").filter(Boolean).join("-");
	return normalized.length > 0 ? normalized : "default";
};

const formatInterval = (minutes: number): string => (minutes === 0 ? "Off" : `${minutes} min`);
