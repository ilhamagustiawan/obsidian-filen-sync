import type { TAbstractFile } from "obsidian";
import { type App, type EventRef, Menu, Modal, Notice, Plugin, TFile, setIcon } from "obsidian";
import {
	ActivityLogModal,
	inferActivityLogKind,
	trimActivityLogs,
	type ActivityLogEntry,
	type ActivityLogKind,
} from "./activity-logs";
import { SyncDb } from "./db";
import { FileVersionModal } from "./file-version-modal";
import { FilenRemoteFs } from "./fs-remote";
import { FilenSyncSetupModal } from "./onboarding-modal";
import { createSyncPathFilter } from "./path-filters";
import { PluginSecrets } from "./secrets";
import {
	FilenSyncSettings,
	FilenSyncSettingTab,
	getVaultRemoteRoot,
	readFilenAuth,
	type FilenAuth,
} from "./settings";
import {
	SyncEngine,
	type SyncActivityEvent,
	type SyncOperation,
	type SyncProgress,
} from "./sync-engine";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasSavedVaultName = (value: unknown): value is { vaultName: string } =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	typeof (value as { vaultName?: unknown }).vaultName === "string" &&
	(value as { vaultName: string }).vaultName.trim().length > 0;

async function withRetry<T>(
	fn: () => Promise<T>,
	options: {
		maxRetries?: number;
		baseDelayMs?: number;
		shouldRetry?: (error: unknown) => boolean;
	} = {},
): Promise<T> {
	const { maxRetries = 2, baseDelayMs = 1000 } = options;
	const shouldRetry = options.shouldRetry ?? isTransientError;

	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (attempt === maxRetries || !shouldRetry(error)) throw error;
			const delay = baseDelayMs * Math.pow(2, attempt);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	throw lastError;
}

function isTransientError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();
	const transientPatterns = [
		"network",
		"timeout",
		"econnreset",
		"econnrefused",
		"etimedout",
		"enotfound",
		"dns",
		"socket",
		"tls",
		"abort",
		"fetch failed",
		"too many requests",
		"rate limit",
		"503",
		"502",
		"504",
		"429",
		"internal server error",
	];
	return transientPatterns.some((pattern) => lower.includes(pattern));
}

type StatusBarKind = "idle" | "syncing" | "success" | "warning" | "error";

type LocalFileActivityAction = "created" | "modified" | "deleted" | "renamed";

type StatusBarState = {
	kind: StatusBarKind;
	text: string;
	detail: string;
	updatedAt: number | null;
};

type SyncRunResult =
	| { kind: "applied"; applied: number; conflicts: number }
	| { kind: "up-to-date" }
	| { kind: "skipped"; reason: string }
	| { kind: "cancelled"; reason: string }
	| { kind: "failed"; message: string };

const AUTO_SYNC_SUCCESS_COOLDOWN_MS = 30_000;
const AUTO_SYNC_FAILURE_BASE_BACKOFF_MS = 30_000;
const AUTO_SYNC_FAILURE_MAX_BACKOFF_MS = 5 * 60_000;

export default class FilenSyncPlugin extends Plugin {
	settings!: FilenSyncSettings;
	private db: SyncDb | null = null;
	private readonly secrets = new PluginSecrets(this.app);
	private unloaded = false;
	private sessionPassword = "";
	private sessionTwoFactorCode = "";
	private statusBarItemEl: HTMLElement | null = null;
	private statusBarIconEl: HTMLElement | null = null;
	private statusBarTextEl: HTMLElement | null = null;
	private statusBarState: StatusBarState = {
		kind: "idle",
		text: "Set up Filen",
		detail: "Open settings to connect your Filen account.",
		updatedAt: null,
	};
	private remoteFs: FilenRemoteFs | null = null;
	private syncEngine: SyncEngine | null = null;
	private isSyncing = false;
	private debounceTimer: number | null = null;
	private intervalId: number | null = null;
	private startupTimerId: number | null = null;
	private vaultEventRefs: EventRef[] = [];
	private workspaceEventRefs: EventRef[] = [];
	private autoSyncDomCleanup: (() => void)[] = [];
	private pendingAutoSync = false;
	private nextAutoSyncAllowedAt = 0;
	private autoSyncTransientFailureCount = 0;
	private lastActiveFilePath: string | null = null;
	private setupPromptShown = false;
	private activityLogListeners = new Set<() => void>();
	private activityLogsSaveTimer: number | null = null;

	async onload() {
		this.unloaded = false;
		await this.loadSettings();

		this.statusBarItemEl = this.addStatusBarItem();
		this.initializeStatusBar();
		this.setDefaultStatus();

		const syncRibbonIcon = this.addRibbonIcon("refresh-cw", "Filen: sync now", () => {
			void this.syncNow();
		});
		syncRibbonIcon.addClass("filen-sync-ribbon-sync");

		const activityLogsRibbonIcon = this.addRibbonIcon(
			"list",
			"Filen: open activity logs",
			() => {
				this.openActivityLogs();
			},
		);
		activityLogsRibbonIcon.addClass("filen-sync-ribbon-activity-log");

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				void this.syncNow();
			},
		});

		this.addCommand({
			id: "test-filen-connection",
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			name: "Test Filen connection",
			callback: () => {
				void this.testConnection();
			},
		});

		this.addCommand({
			id: "toggle-sync-on-save",
			name: "Toggle sync on save",
			callback: () => {
				void this.toggleSyncOnSave();
			},
		});

		this.addCommand({
			id: "toggle-auto-sync-paused",
			name: "Pause or resume auto-sync",
			callback: () => {
				void this.toggleSyncPaused();
			},
		});

		this.addCommand({
			id: "open-activity-logs",
			name: "Open activity logs",
			callback: () => {
				this.openActivityLogs();
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				this.addFileMenuItems(menu, file);
			}),
		);

		this.addSettingTab(new FilenSyncSettingTab(this.app, this));
		this.renderStatusBar();
		this.app.workspace.onLayoutReady(() => {
			void this.initializeAfterLayoutReady();
		});
	}

	onunload() {
		this.unloaded = true;
		this.teardownAutoSync();
		if (this.activityLogsSaveTimer !== null) {
			window.clearTimeout(this.activityLogsSaveTimer);
			this.activityLogsSaveTimer = null;
			void this.saveSettings();
		}
		this.activityLogListeners.clear();
		this.syncEngine?.close();
		this.syncEngine = null;
	}

	setSessionPassword(value: string) {
		this.sessionPassword = value;
		this.syncEngine?.close();
		this.syncEngine = null;
		this.remoteFs = null;
	}

	setSessionTwoFactorCode(value: string) {
		this.sessionTwoFactorCode = value;
		this.syncEngine?.close();
		this.syncEngine = null;
		this.remoteFs = null;
	}

	hasSessionPassword(): boolean {
		return this.sessionPassword.length > 0;
	}

	hasSavedAuth(): boolean {
		return this.settings.hasAuth;
	}

	async clearSavedAuth() {
		this.syncEngine?.close();
		this.syncEngine = null;
		this.remoteFs = null;
		this.sessionPassword = "";
		this.sessionTwoFactorCode = "";
		this.settings.hasAuth = false;
		this.secrets.clear();
		this.logActivity("Disconnected from server");
		await this.saveSettings();
		this.setStatus(
			"Not connected",
			"idle",
			"Open settings to connect your Filen account.",
			null,
		);
	}

	async loadSettings() {
		const saved: unknown = await this.loadData();

		// Migration: move plain-text auth from data.json to vault-scoped secret storage.
		if (isRecord(saved) && saved.auth !== null && saved.auth !== undefined) {
			const auth = readFilenAuth(saved.auth);
			if (auth !== null) {
				this.secrets.setAuth(auth as FilenAuth);
			}
			// Scrub the plain-text credentials from data.json immediately.
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete (saved as Record<string, unknown>).auth;
			await this.saveData(saved);
		}

		this.settings = FilenSyncSettings.fromSaved(saved);

		// If auth exists in secret storage, mark the connection as active.
		if (this.secrets.hasAuth()) {
			this.settings.hasAuth = true;
		}

		let shouldSave = false;

		if (!hasSavedVaultName(saved)) {
			this.settings.vaultName = this.app.vault.getName();
			shouldSave = true;
		}

		if (this.settings.deviceId.length === 0) {
			this.settings.deviceId = window.crypto.randomUUID();
			shouldSave = true;
		}

		if (shouldSave) {
			await this.saveSettings();
		}
	}

	private async initializeAfterLayoutReady(): Promise<void> {
		try {
			const db = await SyncDb.open(this.app.vault.getName());
			await db.runMigrations();
			if (this.unloaded) return;
			this.db = db;
			this.setupAutoSync();
			this.renderStatusBar();
			this.maybePromptForSetup();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.error("Filen Sync: failed to initialize after layout ready", error);
			if (!this.unloaded) this.setStatus("Initialization failed", "error", message);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getActivityLogs(): readonly ActivityLogEntry[] {
		return this.settings.activityLogs;
	}

	onActivityLogsChanged(listener: () => void): () => void {
		this.activityLogListeners.add(listener);
		return () => this.activityLogListeners.delete(listener);
	}

	openActivityLogs(): void {
		new ActivityLogModal(this.app, this).open();
	}

	async clearActivityLogs(): Promise<void> {
		this.settings.activityLogs = [];
		this.notifyActivityLogsChanged();
		await this.saveSettings();
	}

	refreshSyncTarget(): void {
		this.syncEngine?.close();
		this.syncEngine = null;
		this.remoteFs = null;
	}

	async syncNow() {
		await this.runSync("Sync");
	}

	async testConnection(): Promise<void> {
		if (this.isSyncing) {
			new Notice("Sync in progress.");
			return;
		}
		this.setStatus("Testing connection…", "syncing", "Checking Filen access...");
		this.logActivity("Connecting to server");
		try {
			const engine = this.getSyncEngine();
			await withRetry(() => engine.testRemote());
			this.logActivity("Connected to server");
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("Connection test: ok");
			this.setStatus("Connection ok", "success", `Connected as ${this.settings.email}.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			this.logActivity(`Connection failed: ${message}`);
			new Notice(`Connection test failed: ${message}`);
			this.setStatus("Connection failed", "error", message);
		}
	}

	openSettingsTab(): void {
		const settingManager = (
			this.app as App & {
				setting: { open: () => void; openTabById: (id: string) => void };
			}
		).setting;
		settingManager.open();
		settingManager.openTabById(this.manifest.id);
	}

	setupAutoSync(): void {
		const { syncOnSave, syncOnSaveDelaySeconds, syncIntervalMinutes, syncStartupDelaySeconds } =
			this.settings;
		const activeFile = this.app.workspace.getActiveFile();
		this.lastActiveFilePath = activeFile?.path ?? null;
		if (this.settings.syncPaused) return;

		this.workspaceEventRefs.push(
			this.app.workspace.on("file-open", (file) => {
				this.lastActiveFilePath = file?.path ?? null;
			}),
		);

		const handleVaultChange =
			(action: LocalFileActivityAction) => (file: TAbstractFile, oldPath?: string) => {
				this.logLocalFileActivity(action, file, oldPath);
				if (!syncOnSave || !this.shouldAutoSyncForFileEvent(file, oldPath)) return;
				this.logActivity(`Auto-sync scheduled in ${syncOnSaveDelaySeconds}s`);
				this.scheduleAutoSync(syncOnSaveDelaySeconds * 1000);
			};
		this.vaultEventRefs.push(this.app.vault.on("modify", handleVaultChange("modified")));
		this.vaultEventRefs.push(this.app.vault.on("create", handleVaultChange("created")));
		this.vaultEventRefs.push(this.app.vault.on("delete", handleVaultChange("deleted")));
		this.vaultEventRefs.push(this.app.vault.on("rename", handleVaultChange("renamed")));

		if (syncOnSave || syncIntervalMinutes > 0) {
			this.registerAutoSyncDomEvent(document, "visibilitychange", () => {
				if (document.visibilityState === "visible") this.scheduleAutoSync(1000);
			});
			this.registerAutoSyncDomEvent(window, "focus", () => {
				this.scheduleAutoSync(1000);
			});
			this.registerAutoSyncDomEvent(window, "online", () => {
				this.scheduleAutoSync(1000);
			});
		}

		if (syncIntervalMinutes > 0) {
			this.intervalId = window.setInterval(
				() => {
					this.requestAutoSync();
				},
				syncIntervalMinutes * 60 * 1000,
			);
		}

		if (syncStartupDelaySeconds > 0) {
			this.startupTimerId = window.setTimeout(() => {
				this.startupTimerId = null;
				this.requestAutoSync();
			}, syncStartupDelaySeconds * 1000);
		}
	}

	private teardownAutoSync(): void {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this.startupTimerId !== null) {
			window.clearTimeout(this.startupTimerId);
			this.startupTimerId = null;
		}
		for (const ref of this.vaultEventRefs) this.app.vault.offref(ref);
		this.vaultEventRefs = [];
		for (const ref of this.workspaceEventRefs) this.app.workspace.offref(ref);
		this.workspaceEventRefs = [];
		for (const cleanup of this.autoSyncDomCleanup) cleanup();
		this.autoSyncDomCleanup = [];
		this.pendingAutoSync = false;
		this.nextAutoSyncAllowedAt = 0;
		this.autoSyncTransientFailureCount = 0;
	}

	refreshAutoSync(): void {
		this.teardownAutoSync();
		this.setupAutoSync();
		if (this.isSyncing) this.renderStatusBar();
		else this.setDefaultStatus();
	}

	private async toggleSyncOnSave(): Promise<void> {
		this.settings.syncOnSave = !this.settings.syncOnSave;
		await this.saveSettings();
		this.refreshAutoSync();
		new Notice(`Sync on save: ${this.settings.syncOnSave ? "enabled" : "disabled"}`);
	}

	private async toggleSyncPaused(): Promise<void> {
		this.settings.syncPaused = !this.settings.syncPaused;
		await this.saveSettings();
		this.refreshAutoSync();
		this.logActivity(this.settings.syncPaused ? "Sync paused" : "Sync resumed");
		new Notice(`Auto-sync ${this.settings.syncPaused ? "paused" : "resumed"}.`);
	}

	private scheduleAutoSync(delayMs: number): void {
		this.pendingAutoSync = true;
		this.scheduleQueuedAutoSync(delayMs);
	}

	private requestAutoSync(): void {
		if (!this.hasAutoSyncEnabled()) return;
		if (!this.hasSavedAuth()) return;
		if (this.isSyncing) {
			this.pendingAutoSync = true;
			return;
		}
		this.pendingAutoSync = false;
		void this.runSync("Auto-sync", { silent: true, autoSync: true });
	}

	private runPendingAutoSync(): void {
		if (!this.pendingAutoSync || !this.hasAutoSyncEnabled()) return;
		this.scheduleQueuedAutoSync(0);
	}

	private scheduleQueuedAutoSync(delayMs: number): void {
		if (!this.pendingAutoSync || !this.hasAutoSyncEnabled() || !this.hasSavedAuth()) return;
		if (this.isSyncing) return;

		const now = Date.now();
		const cooldownDelayMs = Math.max(0, this.nextAutoSyncAllowedAt - now);
		const waitMs = Math.max(delayMs, cooldownDelayMs);
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			this.requestAutoSync();
		}, waitMs);
	}

	private setAutoSyncCooldown(delayMs: number): void {
		this.nextAutoSyncAllowedAt = Date.now() + delayMs;
	}

	private resetAutoSyncBackoff(): void {
		this.autoSyncTransientFailureCount = 0;
		this.setAutoSyncCooldown(AUTO_SYNC_SUCCESS_COOLDOWN_MS);
	}

	private bumpAutoSyncBackoff(error: unknown): void {
		this.autoSyncTransientFailureCount += 1;
		const delayMs = getAutoSyncBackoffMs(error, this.autoSyncTransientFailureCount);
		this.setAutoSyncCooldown(delayMs);
	}

	private hasAutoSyncEnabled(): boolean {
		return (
			!this.settings.syncPaused &&
			(this.settings.syncOnSave ||
				this.settings.syncIntervalMinutes > 0 ||
				this.settings.syncStartupDelaySeconds > 0)
		);
	}

	private logLocalFileActivity(
		action: LocalFileActivityAction,
		file: TAbstractFile,
		oldPath?: string,
	): void {
		if (
			this.isSyncing ||
			!(file instanceof TFile) ||
			!this.shouldLogFileActivity(file, oldPath)
		)
			return;
		switch (action) {
			case "created":
				this.logActivity(`Local created ${file.path}`);
				return;
			case "modified":
				this.logActivity(`Local changed ${file.path}`);
				return;
			case "deleted":
				this.logActivity(`Local deleted ${file.path}`);
				return;
			case "renamed":
				this.logActivity(
					oldPath !== undefined
						? `Local renamed ${oldPath} → ${file.path}`
						: `Local renamed ${file.path}`,
				);
				return;
		}
	}

	private shouldLogFileActivity(file: TFile, oldPath?: string): boolean {
		const pathFilter = createSyncPathFilter({
			configDir: this.app.vault.configDir,
			pluginId: this.manifest.id,
			ignorePatterns: this.settings.ignorePatterns,
		});
		return (
			!pathFilter.isIgnored(file.path) &&
			(oldPath === undefined || !pathFilter.isIgnored(oldPath))
		);
	}

	private shouldAutoSyncForFileEvent(file: TAbstractFile, oldPath?: string): boolean {
		if (!(file instanceof TFile)) return false;

		const pathFilter = createSyncPathFilter({
			configDir: this.app.vault.configDir,
			pluginId: this.manifest.id,
			ignorePatterns: this.settings.ignorePatterns,
		});
		if (
			pathFilter.isIgnored(file.path) ||
			(oldPath !== undefined && pathFilter.isIgnored(oldPath))
		) {
			return false;
		}

		const activePath = this.app.workspace.getActiveFile()?.path ?? this.lastActiveFilePath;
		if (activePath === null) return true;
		return file.path === activePath || oldPath === activePath;
	}

	private registerAutoSyncDomEvent<K extends keyof WindowEventMap>(
		target: Window,
		type: K,
		listener: (event: WindowEventMap[K]) => void,
	): void;
	private registerAutoSyncDomEvent<K extends keyof DocumentEventMap>(
		target: Document,
		type: K,
		listener: (event: DocumentEventMap[K]) => void,
	): void;
	private registerAutoSyncDomEvent(
		target: Window | Document,
		type: string,
		listener: EventListener,
	): void {
		target.addEventListener(type, listener);
		this.autoSyncDomCleanup.push(() => target.removeEventListener(type, listener));
	}

	private async runSync(
		label: string,
		options: { silent?: boolean; autoSync?: boolean } = {},
	): Promise<SyncRunResult> {
		if (this.isSyncing) {
			const reason = "Sync already in progress.";
			this.logActivity(`${label} skipped: sync already in progress`);
			if (!options.silent) new Notice(reason);
			return { kind: "skipped", reason };
		}

		this.isSyncing = true;
		this.setStatus(`${label}…`, "syncing", "Starting...");
		this.logActivity(`${label} started`);
		this.logActivity("Connecting to server");

		try {
			const engine = this.getSyncEngine();

			// Auto-sync skips local-delete confirmation to avoid blocking;
			// instead it notifies the user and defers to manual sync.
			const confirmDeletes = options.silent
				? async (paths: string[]) => {
						new Notice(
							`Filen Sync: ${paths.length} local file(s) need deletion confirmation. Run Sync now.`,
						);
						return false;
					}
				: (paths: string[]) => this.confirmLocalDeletes(paths);

			const result = await withRetry(() =>
				engine.sync(
					(p: SyncProgress) =>
						this.setStatus(
							`${label}…`,
							"syncing",
							`${p.current}/${p.total} · ${p.path}`,
						),
					confirmDeletes,
					(event: SyncActivityEvent) => this.logSyncActivity(event),
				),
			);

			if (result.cancelled) {
				const reason = "Local deletes need confirmation. Run Sync now.";
				this.logActivity("Sync paused. Local deletes need confirmation.");
				this.setStatus("Sync paused", "warning", reason);
				if (options.autoSync) this.resetAutoSyncBackoff();
				return { kind: "cancelled", reason };
			}

			if (options.autoSync) this.resetAutoSyncBackoff();

			if (result.applied === 0 && result.conflicts === 0) {
				this.logActivity("Fully synced");
				this.setStatus("up to date", "success", "No changes detected.", null);
				return { kind: "up-to-date" };
			}

			const parts: string[] = [];
			if (result.applied > 0) parts.push(`${result.applied} applied`);
			if (result.conflicts > 0) parts.push(`${result.conflicts} conflict(s)`);
			const summary = parts.join(", ");

			this.logActivity(
				result.conflicts > 0 ? `Sync complete with ${summary}` : "Fully synced",
			);
			this.setStatus(
				summary,
				result.conflicts > 0 ? "warning" : "success",
				`${label}: ${summary}`,
			);

			if (!options.silent) {
				new Notice(`${label}: ${summary}`);
			} else if (result.conflicts > 0) {
				new Notice(
					`Filen Sync: ${result.conflicts} conflict(s) — conflict copies saved in vault.`,
				);
			}

			return { kind: "applied", applied: result.applied, conflicts: result.conflicts };
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			this.logActivity(`${label} failed: ${message}`);
			if (options.autoSync && isTransientError(error)) {
				this.pendingAutoSync = true;
				this.bumpAutoSyncBackoff(error);
			}
			this.setStatus(`${label} failed`, "error", message);
			if (!options.silent) new Notice(`${label} failed: ${message}`);
			console.error(`Filen Sync: ${label} failed`, error);
			if (
				message.includes("API key") ||
				message.includes("api key") ||
				message.includes("auth expired")
			) {
				this.syncEngine?.close();
				this.syncEngine = null;
			}
			return { kind: "failed", message };
		} finally {
			this.isSyncing = false;
			this.runPendingAutoSync();
		}
	}

	private logSyncActivity(event: SyncActivityEvent): void {
		switch (event.type) {
			case "connected":
				this.logActivity("Connected to server. Detecting changes...");
				return;
			case "operation-planned":
				this.logPlannedSyncOperation(event.operation, event.path, event.detail);
				return;
			case "operation-start":
				this.logActivity(syncOperationStartMessage(event.operation, event.path));
				return;
			case "operation-complete":
				this.logActivity(syncOperationCompleteMessage(event.operation, event.path));
				return;
			case "accepted":
				this.logActivity(`Accepted ${event.path}`);
				return;
		}
	}

	private logPlannedSyncOperation(operation: SyncOperation, path: string, detail: string): void {
		switch (operation) {
			case "download":
				this.logActivity(`Server pushed ${path}`);
				return;
			case "upload":
				this.logActivity(`Local changed ${path}`);
				return;
			case "delete-local":
				this.logActivity(`Server deleted ${path}`);
				return;
			case "delete-remote":
				this.logActivity(`Local deleted ${path}`);
				return;
			case "conflict":
				this.logActivity(`Conflict detected ${path}`);
				return;
			default:
				if (detail.length > 0) this.logActivity(`${detail} ${path}`);
		}
	}

	private confirmLocalDeletes(paths: string[]): Promise<boolean> {
		const examples = paths.slice(0, 8).join(", ");
		const more = paths.length > 8 ? `, and ${paths.length - 8} more` : "";
		const message = `Sync would delete ${paths.length} local file(s) that no longer exist in Filen: ${examples}${more}. Deleted files go to the system trash.`;
		return confirmAction(this.app, "Delete local files?", message, "Delete local files");
	}

	private getOrCreateRemoteFs(): FilenRemoteFs {
		if (this.settings.email.length === 0) {
			throw new Error("Filen email missing. Add it in plugin settings.");
		}
		const savedAuth = this.secrets.getAuth();
		if (savedAuth === null && this.sessionPassword.length === 0) {
			throw new Error("Filen password missing. Enter it once in plugin settings.");
		}

		if (this.remoteFs === null) {
			this.remoteFs = new FilenRemoteFs({
				email: this.settings.email,
				password: this.sessionPassword,
				twoFactorCode: this.sessionTwoFactorCode,
				remoteRoot: getVaultRemoteRoot(this.settings.remoteRoot, this.settings.vaultName),
				auth: savedAuth as FilenAuth | null,
				saveAuth: async (auth) => {
					this.secrets.setAuth(auth);
					this.settings.hasAuth = true;
					this.settings.email = auth.email;
					if (this.sessionPassword.length > 0) {
						this.secrets.setPassword(this.sessionPassword);
					}
					await this.saveSettings();
					if (!this.isSyncing) this.setDefaultStatus();
					else this.renderStatusBar();
				},
			});
		}

		return this.remoteFs;
	}

	private getSyncEngine(): SyncEngine {
		if (!this.db) {
			throw new Error(
				"Database not initialized yet. Please wait for the vault to finish loading.",
			);
		}
		const remote = this.getOrCreateRemoteFs();

		if (this.syncEngine === null) {
			this.syncEngine = new SyncEngine({
				app: this.app,
				db: this.db,
				pluginId: this.manifest.id,
				settings: this.settings,
				remote,
			});
		}

		return this.syncEngine;
	}

	private addFileMenuItems(menu: Menu, file: TAbstractFile) {
		if (!(file instanceof TFile)) return;
		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle("Filen: sync now");
			item.setIcon("refresh-cw");
			item.onClick(() => {
				void this.syncNow();
			});
		});
		menu.addItem((item) => {
			item.setTitle("Filen: version history");
			item.setIcon("history");
			item.onClick(() => {
				this.openVersionHistory(file);
			});
		});
	}

	private openVersionHistory(file: TFile): void {
		try {
			const remote = this.getOrCreateRemoteFs();
			new FileVersionModal({
				app: this.app,
				remote,
				filePath: file.path,
				fileName: file.name,
				onRestored: async () => {
					await this.runRestoreSync();
				},
			}).open();
		} catch (error) {
			new Notice(error instanceof Error ? error.message : "Failed to open version history.");
		}
	}

	private async runRestoreSync(): Promise<void> {
		const result = await this.runSync("Restore sync", { silent: true });
		switch (result.kind) {
			case "applied":
			case "up-to-date":
				return;
			case "skipped":
			case "cancelled":
				throw new Error(result.reason);
			case "failed":
				throw new Error(result.message);
		}
	}

	private initializeStatusBar(): void {
		if (this.statusBarItemEl === null) return;
		this.statusBarItemEl.empty();
		this.statusBarItemEl.addClass("filen-sync-status-item");
		this.statusBarIconEl = this.statusBarItemEl.createSpan({ cls: "filen-sync-status-icon" });
		this.statusBarTextEl = this.statusBarItemEl.createSpan({ cls: "filen-sync-status-text" });
		this.registerDomEvent(this.statusBarItemEl, "click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openStatusBarMenu(event);
		});
	}

	private openStatusBarMenu(event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) => {
			item.setTitle("Sync now");
			item.setIcon("refresh-cw");
			item.onClick(() => {
				void this.syncNow();
			});
		});
		menu.addItem((item) => {
			item.setTitle(this.settings.syncPaused ? "Resume auto-sync" : "Pause auto-sync");
			item.setIcon(this.settings.syncPaused ? "circle-play" : "pause");
			item.onClick(() => {
				void this.toggleSyncPaused();
			});
		});
		menu.addItem((item) => {
			item.setTitle("Open activity log");
			item.setIcon("align-left");
			item.onClick(() => {
				this.openActivityLogs();
			});
		});
		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle(
				this.hasSavedAuth() ? "Open Obsidian Filen Sync settings" : "Connect Filen",
			);
			item.setIcon("settings");
			item.onClick(() => {
				this.openSettingsTab();
			});
		});
		menu.showAtMouseEvent(event);
	}

	private maybePromptForSetup(): void {
		if (this.hasSavedAuth() || this.setupPromptShown) return;
		this.setupPromptShown = true;
		new FilenSyncSetupModal({
			app: this.app,
			onOpenSettings: () => this.openSettingsTab(),
		}).open();
	}

	private logActivity(
		message: string,
		kind: ActivityLogKind = inferActivityLogKind(message),
	): void {
		this.settings.activityLogs = trimActivityLogs([
			...this.settings.activityLogs,
			{ at: Date.now(), message, kind },
		]);
		this.notifyActivityLogsChanged();
		this.queueActivityLogsSave();
	}

	private notifyActivityLogsChanged(): void {
		for (const listener of this.activityLogListeners) listener();
	}

	private queueActivityLogsSave(): void {
		if (this.activityLogsSaveTimer !== null) window.clearTimeout(this.activityLogsSaveTimer);
		this.activityLogsSaveTimer = window.setTimeout(() => {
			this.activityLogsSaveTimer = null;
			void this.saveSettings();
		}, 1000);
	}

	private setDefaultStatus(): void {
		if (this.hasSavedAuth()) {
			if (this.settings.syncPaused) {
				this.setStatus(
					"Paused",
					"warning",
					"Auto-sync is paused. Manual sync is still available.",
					null,
				);
				return;
			}
			this.setStatus("Ready", "success", `Connected as ${this.settings.email}.`, null);
			return;
		}
		this.setStatus(
			"Disconnected",
			"idle",
			"Open settings to connect your Filen account.",
			null,
		);
	}

	private setStatus(
		text: string,
		kind: StatusBarKind,
		detail: string,
		updatedAt: number | null = Date.now(),
	): void {
		this.statusBarState = { kind, text, detail, updatedAt };
		this.renderStatusBar();
	}

	private renderStatusBar(): void {
		if (
			this.statusBarItemEl === null ||
			this.statusBarIconEl === null ||
			this.statusBarTextEl === null
		)
			return;

		const iconOnly = isAllFilesSyncedStatus(this.statusBarState);
		setIcon(this.statusBarIconEl, iconForStatus(this.statusBarState, iconOnly));
		this.statusBarTextEl.setText(iconOnly ? "" : `Filen ${this.statusBarState.text}`);
		this.statusBarItemEl.removeClass(
			"is-idle",
			"is-syncing",
			"is-success",
			"is-warning",
			"is-error",
		);
		this.statusBarItemEl.addClass(`is-${this.statusBarState.kind}`);
		this.statusBarItemEl.toggleClass("is-icon-only", iconOnly);
		const tooltip = this.buildStatusTooltip();
		this.statusBarItemEl.setAttr("aria-label", tooltip);
		this.statusBarItemEl.setAttr("title", tooltip);
	}

	private buildStatusTooltip(): string {
		const statusText = isAllFilesSyncedStatus(this.statusBarState)
			? "All files synced"
			: this.statusBarState.text;
		const detailText =
			this.statusBarState.text === "Ready"
				? "No pending changes detected."
				: this.statusBarState.detail;

		const lines = [
			statusText,
			detailText,
			this.hasSavedAuth() ? `Account: ${this.settings.email}` : "Account: not connected",
			`Auto-sync: ${this.describeAutoSync()}`,
		];

		if (this.statusBarState.updatedAt !== null) {
			lines.push(`Updated: ${formatStatusTime(this.statusBarState.updatedAt)}`);
		}

		lines.push("Click for actions.");
		return lines.join("\n");
	}

	private describeAutoSync(): string {
		if (this.settings.syncPaused) return "paused";
		const parts: string[] = [];
		if (this.settings.syncOnSave)
			parts.push(`on save (${this.settings.syncOnSaveDelaySeconds}s delay)`);
		if (this.settings.syncIntervalMinutes > 0)
			parts.push(`every ${this.settings.syncIntervalMinutes} min`);
		if (this.settings.syncStartupDelaySeconds > 0)
			parts.push(`${this.settings.syncStartupDelaySeconds}s after startup`);
		return parts.length > 0 ? parts.join(", ") : "off";
	}
}

const confirmAction = (
	app: App,
	title: string,
	message: string,
	confirmText: string,
): Promise<boolean> =>
	new Promise((resolve) => {
		new ConfirmActionModal(app, title, message, confirmText, resolve).open();
	});

class ConfirmActionModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly confirmText: string,
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: this.title });
		this.contentEl.createEl("p", { text: this.message });

		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		const cancelButton = actions.createEl("button", { text: "Cancel" });
		cancelButton.addEventListener("click", () => {
			this.finish(false);
		});

		const confirmButton = actions.createEl("button", { text: this.confirmText });
		confirmButton.addClass("mod-warning");
		confirmButton.addEventListener("click", () => {
			this.finish(true);
		});
	}

	onClose(): void {
		if (!this.resolved) this.finish(false);
	}

	private finish(confirmed: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(confirmed);
		this.close();
	}
}

const isAllFilesSyncedStatus = (state: StatusBarState): boolean =>
	state.kind === "success" && (state.text === "up to date" || state.text === "Ready");

const iconForStatus = (state: StatusBarState, iconOnly = false): string => {
	if (iconOnly) return "refresh-cw";
	if (state.text === "Paused") return "pause";
	switch (state.kind) {
		case "syncing":
			return "refresh-cw";
		case "success":
			return "check";
		case "warning":
			return "alert-triangle";
		case "error":
			return "x-circle";
		default:
			return "cloud-off";
	}
};

const syncOperationStartMessage = (operation: SyncOperation, path: string): string => {
	switch (operation) {
		case "upload":
			return `Uploading file ${path}`;
		case "download":
			return `Downloading file ${path}`;
		case "delete-local":
			return `Deleting local file ${path}`;
		case "delete-remote":
			return `Deleting remote file ${path}`;
		case "conflict":
			return `Resolving conflict ${path}`;
		default:
			return `Syncing ${path}`;
	}
};

const syncOperationCompleteMessage = (operation: SyncOperation, path: string): string => {
	switch (operation) {
		case "upload":
			return `Uploading complete ${path}`;
		case "download":
			return `Downloading complete ${path}`;
		case "delete-local":
			return `Local delete complete ${path}`;
		case "delete-remote":
			return `Remote delete complete ${path}`;
		case "conflict":
			return `Conflict resolved ${path}`;
		default:
			return `Sync complete ${path}`;
	}
};

const formatStatusTime = (epochMs: number): string =>
	new Date(epochMs).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});

const getAutoSyncBackoffMs = (error: unknown, failureCount: number): number => {
	const retryAfterMs = readRetryAfterMs(error);
	if (retryAfterMs !== null) {
		return Math.min(
			Math.max(retryAfterMs, AUTO_SYNC_FAILURE_BASE_BACKOFF_MS),
			AUTO_SYNC_FAILURE_MAX_BACKOFF_MS,
		);
	}
	return Math.min(
		AUTO_SYNC_FAILURE_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, failureCount - 1)),
		AUTO_SYNC_FAILURE_MAX_BACKOFF_MS,
	);
};

const readRetryAfterMs = (error: unknown): number | null => {
	const message = error instanceof Error ? error.message : String(error);
	const secondsMatch = message.match(/retry[- ]after[^0-9]*(\d+)\s*(seconds?|secs?|s)\b/iu);
	const secondsValue = secondsMatch?.[1];
	if (secondsValue !== undefined) return Number.parseInt(secondsValue, 10) * 1000;
	const msMatch = message.match(/retry[- ]after[^0-9]*(\d+)\s*(milliseconds?|msecs?|ms)\b/iu);
	const msValue = msMatch?.[1];
	if (msValue !== undefined) return Number.parseInt(msValue, 10);
	return null;
};
