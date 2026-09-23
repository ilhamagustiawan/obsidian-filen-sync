import type { App, TextComponent } from "obsidian";
import { Notice, PluginSettingTab, Setting } from "obsidian";
import { readActivityLogs, type ActivityLogEntry } from "./activity-logs";
import type FilenSyncPlugin from "./main";
import { DEFAULT_IGNORE_PATTERNS, normalizeIgnorePatterns } from "./path-filters";
import { validateRemoteRoot } from "./sync/path-validation";
export { readFilenAuth, type FilenAuth } from "./auth";

export type SyncedFileRecord = {
	path: string;
	mtime: number;
	ctime: number;
	size: number;
	hash?: string;
	/** Remote UUID assigned by Filen. Tracked to detect remote renames. */
	remoteUuid?: string;
	/** Remote content hash from Filen metadata (SHA-512). */
	remoteHash?: string;
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

export type SyncProgressNoticeMode = "transfers_only" | "always" | "manual_only" | "never";

export type FilenSyncSettings = {
	email: string;
	remoteRoot: string;
	deviceId: string;
	vaultId: string;
	vaultName: string;
	ignorePatterns: string[];
	hasAuth: boolean;
	rememberAuth: boolean;
	syncOnSave: boolean;
	syncOnSaveDelaySeconds: number;
	syncIntervalMinutes: number;
	syncStartupDelaySeconds: number;
	syncPaused: boolean;
	notifyOnBackgroundChange: boolean;
	statusBarIndicatorStyle: "icon" | "full";
	syncProgressNoticeMode: SyncProgressNoticeMode;
	showFloatingSyncIndicator: boolean;
	fastRemotePolling: boolean;
	skipLargeFiles: boolean;
	skipSizeLargerThanMB: number;
	activityLogs: ActivityLogEntry[];
	reconciliationNeeded: boolean;
};

const DEFAULT_REMOTE_ROOT = "/Obsidian";

export const DEFAULT_SETTINGS: FilenSyncSettings = {
	email: "",
	remoteRoot: DEFAULT_REMOTE_ROOT,
	deviceId: "",
	vaultId: "",
	vaultName: "default",
	ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
	hasAuth: false,
	rememberAuth: true,
	syncOnSave: true,
	syncOnSaveDelaySeconds: 2,
	syncIntervalMinutes: 3,
	syncStartupDelaySeconds: 0,
	syncPaused: false,
	notifyOnBackgroundChange: false,
	statusBarIndicatorStyle: "icon",
	syncProgressNoticeMode: "transfers_only",
	showFloatingSyncIndicator: true,
	fastRemotePolling: true,
	skipLargeFiles: true,
	skipSizeLargerThanMB: 50,
	activityLogs: [],
	reconciliationNeeded: false,
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

const readSyncProgressNoticeMode = (value: unknown): SyncProgressNoticeMode => {
	if (value === "always" || value === "manual_only" || value === "never") return value;
	return "transfers_only";
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
			vaultId: readString(value.vaultId, ""),
			vaultName: readString(value.vaultName, DEFAULT_SETTINGS.vaultName),
			ignorePatterns:
				"ignorePatterns" in value
					? normalizeIgnorePatterns(readStringArray(value.ignorePatterns))
					: [...DEFAULT_SETTINGS.ignorePatterns],
			hasAuth: readBoolean(value.hasAuth, DEFAULT_SETTINGS.hasAuth),
			rememberAuth: readBoolean(value.rememberAuth, DEFAULT_SETTINGS.rememberAuth),
			syncOnSave: readBoolean(value.syncOnSave, DEFAULT_SETTINGS.syncOnSave),
			syncOnSaveDelaySeconds: clampNumber(
				readNumber(value.syncOnSaveDelaySeconds, DEFAULT_SETTINGS.syncOnSaveDelaySeconds),
				1,
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
			notifyOnBackgroundChange: readBoolean(
				value.notifyOnBackgroundChange,
				DEFAULT_SETTINGS.notifyOnBackgroundChange,
			),
			statusBarIndicatorStyle: value.statusBarIndicatorStyle === "full" ? "full" : "icon",
			syncProgressNoticeMode: readSyncProgressNoticeMode(value.syncProgressNoticeMode),
			showFloatingSyncIndicator: readBoolean(
				value.showFloatingSyncIndicator,
				DEFAULT_SETTINGS.showFloatingSyncIndicator,
			),
			fastRemotePolling: readBoolean(
				value.fastRemotePolling,
				DEFAULT_SETTINGS.fastRemotePolling,
			),
			skipLargeFiles: readBoolean(value.skipLargeFiles, DEFAULT_SETTINGS.skipLargeFiles),
			skipSizeLargerThanMB: clampNumber(
				readNumber(value.skipSizeLargerThanMB, DEFAULT_SETTINGS.skipSizeLargerThanMB),
				1,
				1000,
			),
			activityLogs: readActivityLogs(value.activityLogs),
			reconciliationNeeded: readBoolean(value.reconciliationNeeded, false),
		};
	},
} as const;

export const getVaultRemoteRoot = (remoteRoot: string, vaultName: string): string => {
	const rawRoot = remoteRoot.trim();
	const rootInput =
		rawRoot.length === 0 || rawRoot === "/"
			? DEFAULT_REMOTE_ROOT
			: rawRoot.startsWith("/")
				? rawRoot
				: `/${rawRoot}`;
	const root = normalizeRemoteRoot(
		validateRemoteRoot(rootInput.endsWith("/") ? rootInput.slice(0, -1) : rootInput),
	);
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

		this.renderAccountSection(containerEl);
		this.renderSyncSection(containerEl);
		this.renderAutoSyncSection(containerEl);
		this.renderActionsSection(containerEl);
	}

	private renderAccountSection(containerEl: HTMLElement): void {
		const section = createSection(
			containerEl,
			"Account",
			"Connect to Filen. Your password and two-factor code are used for login only.",
		);

		new Setting(section)
			.setName("Remember derived credentials")
			.setDesc(
				"Save Filen authentication credentials in Obsidian SecretStorage. They grant account access.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.rememberAuth).onChange(async (value) => {
					try {
						await this.plugin.setRememberAuth(value);
						this.display();
					} catch (error) {
						new Notice(
							error instanceof Error
								? error.message
								: "Could not update credential storage.",
						);
					}
				}),
			);

		if (this.plugin.hasSavedAuth()) {
			const isOffline = this.plugin.isOffline?.() ?? false;
			new Setting(section)
				.setName(isOffline ? "Offline" : "Connected")
				.setDesc(
					(isOffline
						? "You're currently offline. Background sync is paused until network restores."
						: this.plugin.settings.rememberAuth
							? "Derived credentials saved in SecretStorage."
							: "Credentials available for this session only.") +
						" Disconnect to switch accounts.",
				)
				.addButton((button) =>
					button
						.setButtonText("Disconnect")
						.setWarning()
						.onClick(async () => {
							await this.plugin.clearSavedAuth();
							this.display();
						}),
				);

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
						void this.plugin.refreshSyncTarget();
					}),
			);

		new Setting(section)
			.setName("Password")
			.setDesc("Not stored.")
			.addText((text) => {
				text.inputEl.type = "password";
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
						void this.plugin.refreshSyncTarget();
					}),
			);

		new Setting(section)
			.setName("Vault name")
			.setDesc("Used in sync logs.")
			.addText((text) =>
				text.setValue(this.plugin.settings.vaultName).onChange(async (value) => {
					this.plugin.settings.vaultName = value.trim() || "default";
					await this.plugin.saveSettings();
					void this.plugin.refreshSyncTarget();
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

		new Setting(section)
			.setName("Effective remote folder")
			.setDesc(
				getVaultRemoteRoot(this.plugin.settings.remoteRoot, this.plugin.settings.vaultName),
			);

		new Setting(section)
			.setName("Conflict handling")
			.setDesc("Local conflict copies are kept. Plugin data is ignored automatically.");
	}

	private renderAutoSyncSection(containerEl: HTMLElement): void {
		const section = createSection(
			containerEl,
			"Auto-sync",
			this.plugin.settings.reconciliationNeeded
				? "Automatic sync is paused until a successful full two-way sync reconciles an interrupted transfer."
				: "Optional background sync triggers.",
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
			.setName("Floating sync indicator")
			.setDesc(
				"Show a floating progress indicator at the bottom of the workspace while syncing. Recommended for newer Obsidian versions and mobile where the status bar is minimized or absent.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showFloatingSyncIndicator)
					.onChange(async (value) => {
						this.plugin.settings.showFloatingSyncIndicator = value;
						await this.plugin.saveSettings();
						this.plugin.refreshFloatingIndicator();
					}),
			);

		new Setting(section)
			.setName("Sync progress notice")
			.setDesc(
				"Display a notification banner with a progress bar and active file details while syncing.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("transfers_only", "When files are syncing (recommended)")
					.addOption("always", "Always (every sync run)")
					.addOption("manual_only", "Manual sync only")
					.addOption("never", "Never")
					.setValue(this.plugin.settings.syncProgressNoticeMode)
					.onChange(async (value) => {
						this.plugin.settings.syncProgressNoticeMode =
							value as SyncProgressNoticeMode;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(section)
			.setName("Status bar indicator style")
			.setDesc(
				"Choose whether the status bar item displays a compact icon or includes text and progress (when the status bar is visible).",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("icon", "Compact icon (Obsidian Sync style)")
					.addOption("full", "Icon and text")
					.setValue(this.plugin.settings.statusBarIndicatorStyle)
					.onChange(async (value) => {
						this.plugin.settings.statusBarIndicatorStyle =
							value === "full" ? "full" : "icon";
						await this.plugin.saveSettings();
						this.plugin.refreshStatusBar();
					}),
			);

		new Setting(section)
			.setName("Notify when a background sync changes files")
			.setDesc(
				"Show a notice when an automatic background sync updates, uploads, or deletes files.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.notifyOnBackgroundChange)
					.onChange(async (value) => {
						this.plugin.settings.notifyOnBackgroundChange = value;
						await this.plugin.saveSettings();
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
					.setLimits(1, 30, 1)
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

		new Setting(section)
			.setName("Fast remote polling")
			.setDesc(
				"Probe Filen's events feed and skip the full remote scan when nothing changed in the cloud (auto-sync only; manual sync always scans in full).",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.fastRemotePolling).onChange(async (value) => {
					this.plugin.settings.fastRemotePolling = value;
					await this.plugin.saveSettings();
				}),
			);

		let skipSizeText: TextComponent | null = null;
		new Setting(section)
			.setName("Skip large files")
			.setDesc("Skip files larger than N megabytes (left untouched on both sides).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.skipLargeFiles).onChange(async (value) => {
					this.plugin.settings.skipLargeFiles = value;
					await this.plugin.saveSettings();
					skipSizeText?.setDisabled(!value);
				}),
			)
			.addText((text) => {
				skipSizeText = text;
				text.setPlaceholder("50")
					.setValue(String(this.plugin.settings.skipSizeLargerThanMB))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed) && parsed >= 1) {
							this.plugin.settings.skipSizeLargerThanMB = parsed;
							await this.plugin.saveSettings();
						}
					});
				text.setDisabled(!this.plugin.settings.skipLargeFiles);
			});
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
	new Setting(containerEl).setName(title).setDesc(description).setHeading();
	return containerEl;
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
