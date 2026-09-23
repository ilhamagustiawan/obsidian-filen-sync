import type { App, TAbstractFile } from "obsidian";
import { Menu, Modal, Notice, Platform, Plugin, TFile, setIcon, setTooltip } from "obsidian";
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
import { PluginSecrets } from "./secrets";
import {
	getOutstandingMutationRequests,
	needsRemoteReconciliation,
	setRemoteReconciliationRequired,
	setUncertainMutationHandler,
} from "./obsidian-axios-adapter";
import {
	FilenSyncSettings,
	FilenSyncSettingTab,
	getVaultRemoteRoot,
	readFilenAuth,
	type FilenAuth,
} from "./settings";
import type { BulkGuardReport } from "./sync/bulk-guard";
import {
	SyncCoordinator,
	formatRelativeTime,
	type StatusBarKind,
	type StatusBarState,
	type SyncRunResult,
} from "./sync/coordinator";
import { FloatingSyncIndicator } from "./ui/floating-sync-indicator";
import { SyncNoticeController } from "./ui/sync-notice";
import { sha256Hex } from "./sync/executor";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasSavedVaultName = (value: unknown): value is { vaultName: string } =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	typeof (value as { vaultName?: unknown }).vaultName === "string" &&
	(value as { vaultName: string }).vaultName.trim().length > 0;

export default class FilenSyncPlugin extends Plugin {
	settings!: FilenSyncSettings;
	private db: SyncDb | null = null;
	private targetGeneration = 0;
	private targetBindingKey: string | null = null;
	private targetPreparation: Promise<void> | null = null;
	private forceSyncInProgress = false;
	private reconciliationPersistenceFailed = false;
	private readonly secrets = new PluginSecrets(this.app);
	private unloaded = false;
	private sessionPassword = "";
	private sessionTwoFactorCode = "";
	private sessionAuth: FilenAuth | null = null;
	private legacyAuthInvalid = false;
	private lastSyncTimestamp: number | null = null;
	private statusBarItemEl: HTMLElement | null = null;
	private statusBarIconEl: HTMLElement | null = null;
	private statusBarTextEl: HTMLElement | null = null;
	private syncRibbonIconEl: HTMLElement | null = null;
	private noticeController!: SyncNoticeController;
	private floatingIndicator!: FloatingSyncIndicator;
	private statusBarState: StatusBarState = {
		kind: "idle",
		text: "Set up Filen",
		detail: "Open settings to connect your Filen account.",
		updatedAt: null,
	};
	private remoteFs: FilenRemoteFs | null = null;
	private coordinator!: SyncCoordinator;
	private setupPromptShown = false;
	private activityLogListeners = new Set<() => void>();
	private activityLogsSaveTimer: number | null = null;

	async onload() {
		this.unloaded = false;
		await this.loadSettings();
		setRemoteReconciliationRequired(this.settings.reconciliationNeeded);
		setUncertainMutationHandler(async () => {
			this.settings.reconciliationNeeded = true;
			try {
				await this.saveSettings();
			} catch {
				this.reconciliationPersistenceFailed = true;
				new Notice(
					"Could not persist transfer-recovery state; sync is disabled until restart and repair.",
				);
				throw new Error("Could not persist transfer-recovery state.");
			}
		});
		this.register(() => setUncertainMutationHandler(null));

		this.noticeController = new SyncNoticeController(
			() => this.settings,
			() => this.openActivityLogs(),
		);

		this.floatingIndicator = new FloatingSyncIndicator(
			this.app,
			() => this.settings,
			(e) => this.openStatusBarMenu(e),
		);

		this.coordinator = new SyncCoordinator(
			this.app,
			this.manifest.id,
			this.settings,
			() => this.getOrCreateRemoteFs(),
			() => this.db,
			{
				onStatusChange: (state) => {
					this.statusBarState = state;
					if (
						state.kind === "success" ||
						(state.kind === "idle" && state.text === "up to date")
					) {
						this.lastSyncTimestamp = Date.now();
					}
					this.updateStatusDisplays();
					this.noticeController.onStatusChange(state);
					this.floatingIndicator.onStatusChange(state);
				},
				onLogActivity: (message) => {
					this.logActivity(message);
				},
				confirmLocalDeletes: (paths) => this.confirmLocalDeletes(paths),
				confirmBulkOperations: (report) => this.confirmBulkOperations(report),
				saveSettings: () => this.saveSettings(),
				prepareTarget: () => this.prepareSyncTarget(),
			},
		);

		this.statusBarItemEl = this.addStatusBarItem();
		this.initializeStatusBar();
		this.setDefaultStatus();

		if (!Platform.isMobile) {
			this.registerInterval(
				window.setInterval(() => {
					if (
						!this.coordinator.active &&
						(this.statusBarState.kind === "idle" ||
							this.statusBarState.kind === "success")
					) {
						this.updateStatusDisplays();
					}
				}, 60_000),
			);
		}

		this.syncRibbonIconEl = this.addRibbonIcon("refresh-cw", "Filen: sync now", () => {
			if (this.coordinator.active) {
				this.showSyncProgressNoticeOnDemand();
			} else {
				void this.syncNow();
			}
		});
		this.syncRibbonIconEl.addClass("filen-sync-ribbon-sync");

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
			id: "force-sync-current-file",
			name: "Force sync current file",
			callback: () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice("No active file to sync.");
					return;
				}
				void this.forceSyncFile(activeFile);
			},
		});

		this.addCommand({
			id: "push-local",
			name: "Push changed local files",
			callback: () => {
				void this.pushLocal();
			},
		});

		this.addCommand({
			id: "pull-remote",
			name: "Pull changed remote files",
			callback: () => {
				void this.pullRemote();
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
				void this.coordinator.toggleSyncOnSave(() => this.canAutoSync());
			},
		});

		this.addCommand({
			id: "toggle-auto-sync-paused",
			name: "Pause or resume auto-sync",
			callback: () => {
				void this.coordinator.toggleSyncPaused(() => this.canAutoSync());
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
		this.coordinator.close();
		this.noticeController?.closeNotice();
		this.floatingIndicator?.destroy();
		if (this.activityLogsSaveTimer !== null) {
			window.clearTimeout(this.activityLogsSaveTimer);
			this.activityLogsSaveTimer = null;
			void this.saveSettings();
		}
		this.activityLogListeners.clear();
		this.sessionPassword = "";
		this.sessionTwoFactorCode = "";
		this.sessionAuth = null;
		this.remoteFs = null;
		void this.db?.close();
		this.db = null;
	}

	setSessionPassword(value: string) {
		this.sessionPassword = value;
		this.coordinator.invalidateEngine();
		this.remoteFs = null;
	}

	setSessionTwoFactorCode(value: string) {
		this.sessionTwoFactorCode = value;
		this.coordinator.invalidateEngine();
		this.remoteFs = null;
	}

	hasSessionPassword(): boolean {
		return this.sessionPassword.length > 0;
	}

	hasSavedAuth(): boolean {
		return this.secrets.hasAuth() || this.sessionAuth !== null;
	}

	private canAutoSync(): boolean {
		return (
			this.hasSavedAuth() &&
			!this.settings.reconciliationNeeded &&
			!needsRemoteReconciliation()
		);
	}

	isOffline(): boolean {
		return this.coordinator?.offline ?? false;
	}

	async setRememberAuth(remember: boolean): Promise<void> {
		const auth = this.secrets.getAuth() ?? this.sessionAuth;
		if (remember) {
			if (auth !== null) {
				this.secrets.setAuth(auth);
				if (JSON.stringify(this.secrets.getAuth()) !== JSON.stringify(auth)) {
					throw new Error("Could not verify Filen credentials in SecretStorage.");
				}
			}
			this.sessionAuth = null;
		} else {
			if (auth !== null) this.sessionAuth = auth;
			this.secrets.clearAuth();
		}
		this.settings.rememberAuth = remember;
		this.settings.hasAuth = auth !== null;
		await this.saveSettings();
		await this.refreshSyncTarget();
	}

	async clearSavedAuth() {
		this.coordinator.invalidateEngine();
		this.remoteFs = null;
		this.sessionPassword = "";
		this.sessionTwoFactorCode = "";
		this.sessionAuth = null;
		this.legacyAuthInvalid = false;
		this.settings.hasAuth = false;
		this.secrets.clear();
		this.logActivity("Disconnected from server");
		await this.saveSettings();
		await this.refreshSyncTarget();
		this.setStatus(
			"Not connected",
			"idle",
			"Open settings to connect your Filen account.",
			null,
		);
	}

	async loadSettings() {
		const saved: unknown = await this.loadData();

		// Never reserialize legacy credentials, even when validation or SecretStorage
		// migration fails. Reconnection is safer than preserving an unknown auth blob.
		let secretMigrationFailed = false;
		if (isRecord(saved) && saved.auth !== null && saved.auth !== undefined) {
			const auth = readFilenAuth(saved.auth);
			if (auth === null) {
				this.legacyAuthInvalid = true;
			} else {
				try {
					this.secrets.setAuth(auth);
					if (JSON.stringify(this.secrets.getAuth()) !== JSON.stringify(auth)) {
						secretMigrationFailed = true;
					}
				} catch {
					secretMigrationFailed = true;
				}
			}
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete (saved as Record<string, unknown>).auth;
			// Do not silently proceed if plaintext sanitization could not be persisted.
			try {
				await this.saveData(saved);
			} catch {
				new Notice(
					"Could not safely remove legacy credentials from plugin data; sync is disabled.",
				);
				throw new Error("Could not sanitize saved Filen credentials. Sync is disabled.");
			}
			if (secretMigrationFailed) this.legacyAuthInvalid = true;
		}
		this.secrets.clearLegacyPassword();

		this.settings = FilenSyncSettings.fromSaved(saved);
		this.settings.hasAuth = this.secrets.hasAuth();

		let shouldSave = false;

		if (!hasSavedVaultName(saved)) {
			this.settings.vaultName = this.app.vault.getName();
			shouldSave = true;
		}

		if (this.settings.deviceId.length === 0) {
			this.settings.deviceId = window.crypto.randomUUID();
			shouldSave = true;
		}
		if (this.settings.vaultId.length === 0) {
			this.settings.vaultId = window.crypto.randomUUID();
			shouldSave = true;
		}

		if (shouldSave) {
			await this.saveSettings();
		}
		if (this.legacyAuthInvalid) {
			new Notice(
				"Saved Filen credentials need repair. Reconnect in settings; sync history was preserved.",
			);
		}
		if (secretMigrationFailed) {
			this.secrets.clearAuth();
			this.settings.hasAuth = false;
		}
	}

	private async initializeAfterLayoutReady(): Promise<void> {
		if (this.unloaded) return;
		this.coordinator.setupAutoSync(() => this.canAutoSync());
		this.renderStatusBar();
		this.maybePromptForSetup();
	}

	async saveSettings() {
		await this.saveData({ ...this.settings });
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

	async refreshSyncTarget(): Promise<void> {
		this.targetGeneration += 1;
		if (!this.forceSyncInProgress) this.coordinator.invalidateEngine();
		this.remoteFs = null;
		this.targetBindingKey = null;
		const previousDb = this.db;
		this.db = null;
		await previousDb?.close();
		this.coordinator.refreshAutoSync(() => this.canAutoSync());
		if (!this.coordinator.active) this.setDefaultStatus();
		else this.renderStatusBar();
	}

	private async prepareSyncTarget(fromForceUpload = false): Promise<void> {
		if (this.reconciliationPersistenceFailed) {
			throw new Error("Transfer recovery state could not be saved. Sync is disabled.");
		}
		if (this.forceSyncInProgress && !fromForceUpload) {
			throw new Error("A force upload is in progress. Wait for it to finish before syncing.");
		}
		if (getOutstandingMutationRequests() > 0) {
			throw new Error(
				"A previous Filen mutation may still complete. Wait for it to settle, then run a fresh sync before making further changes.",
			);
		}
		if (this.targetPreparation !== null) return this.targetPreparation;
		const generation = this.targetGeneration;
		const preparation = (async () => {
			const remote = this.getOrCreateRemoteFs();
			const identity = await remote.getTargetIdentity();
			if (generation !== this.targetGeneration || this.unloaded) {
				throw new Error("Sync target changed during preparation. Retry the sync.");
			}
			const bindingKey = JSON.stringify([
				this.settings.vaultId,
				identity.userId,
				identity.rootUuid,
			]);
			if (this.db !== null && this.targetBindingKey === bindingKey) return;
			const db = await SyncDb.open({
				vaultId: this.settings.vaultId,
				userId: identity.userId,
				remoteRootUuid: identity.rootUuid,
			});
			try {
				await db.runMigrations();
				if (generation !== this.targetGeneration || this.unloaded) {
					throw new Error("Sync target changed during preparation. Retry the sync.");
				}
				const previousDb = this.db;
				this.db = db;
				this.targetBindingKey = bindingKey;
				await previousDb?.close();
				this.coordinator.invalidateEngine();
			} catch (error) {
				await db.close();
				throw error;
			}
		})();
		this.targetPreparation = preparation;
		try {
			await preparation;
		} finally {
			if (this.targetPreparation === preparation) this.targetPreparation = null;
		}
	}

	refreshAutoSync(): void {
		this.coordinator.refreshAutoSync(() => this.canAutoSync());
		if (!this.coordinator.active) this.setDefaultStatus();
		else this.updateStatusDisplays();
	}

	refreshStatusBar(): void {
		this.updateStatusDisplays();
	}

	refreshFloatingIndicator(): void {
		this.floatingIndicator.refreshVisibility();
	}

	private showSyncProgressNoticeOnDemand(): void {
		this.noticeController.showOnDemand(this.statusBarState);
		if (this.settings.showFloatingSyncIndicator) {
			this.floatingIndicator.onStatusChange(this.statusBarState);
		}
	}

	async syncNow(): Promise<SyncRunResult> {
		const result = await this.coordinator.runSync("Sync", "both", { isManual: true });
		if (result.kind === "applied" || result.kind === "up-to-date") {
			this.lastSyncTimestamp = Date.now();
			await this.clearReconciliationNeeded();
			this.setDefaultStatus();
		}
		return result;
	}

	async pushLocal(): Promise<SyncRunResult> {
		if (needsRemoteReconciliation() || this.settings.reconciliationNeeded) {
			const message = "Run a full two-way sync to reconcile the previous transfer first.";
			new Notice(message);
			return { kind: "failed", message };
		}
		const result = await this.coordinator.runSync("Push local", "push", { isManual: true });
		if (result.kind === "applied" || result.kind === "up-to-date") {
			this.lastSyncTimestamp = Date.now();
			await this.clearReconciliationNeeded();
			this.setDefaultStatus();
		}
		return result;
	}

	async pullRemote(): Promise<SyncRunResult> {
		if (needsRemoteReconciliation() || this.settings.reconciliationNeeded) {
			const message = "Run a full two-way sync to reconcile the previous transfer first.";
			new Notice(message);
			return { kind: "failed", message };
		}
		const result = await this.coordinator.runSync("Pull remote", "pull", { isManual: true });
		if (result.kind === "applied" || result.kind === "up-to-date") {
			this.lastSyncTimestamp = Date.now();
			await this.clearReconciliationNeeded();
			this.setDefaultStatus();
		}
		return result;
	}

	private async clearReconciliationNeeded(): Promise<void> {
		if (!needsRemoteReconciliation() && !this.settings.reconciliationNeeded) return;
		setRemoteReconciliationRequired(false);
		this.settings.reconciliationNeeded = false;
		await this.saveSettings();
		this.coordinator.refreshAutoSync(() => this.canAutoSync());
	}

	async testConnection(): Promise<void> {
		if (this.coordinator.active) {
			new Notice("Sync in progress.");
			return;
		}
		this.setStatus("Testing connection…", "syncing", "Checking Filen access...");
		this.logActivity("Connecting to server");
		try {
			const remote = this.getOrCreateRemoteFs();
			await remote.checkConnect();
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

	private confirmLocalDeletes(paths: string[]): Promise<boolean> {
		const examples = paths.slice(0, 8).join(", ");
		const more = paths.length > 8 ? `, and ${paths.length - 8} more` : "";
		const message = `Sync would delete ${paths.length} local file(s) that no longer exist in Filen: ${examples}${more}. Deleted files go to the system trash.`;
		return confirmAction(this.app, "Delete local files?", message, "Delete local files");
	}

	private confirmBulkOperations(report: BulkGuardReport): Promise<boolean> {
		const message = `${report.reason ?? "A large number of files would be deleted or overwritten."}\n\nProceed with this sync run?`;
		return confirmAction(this.app, "Mass changes detected", message, "Proceed with sync");
	}

	private getOrCreateRemoteFs(): FilenRemoteFs {
		if (this.settings.email.length === 0) {
			throw new Error("Filen email missing. Add it in plugin settings.");
		}
		const savedAuth = this.secrets.getAuth() ?? this.sessionAuth;
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
					if (this.settings.rememberAuth) {
						this.secrets.setAuth(auth);
						if (JSON.stringify(this.secrets.getAuth()) !== JSON.stringify(auth)) {
							throw new Error("Could not verify Filen credentials in SecretStorage.");
						}
						this.sessionAuth = null;
					} else {
						this.sessionAuth = auth;
					}
					this.legacyAuthInvalid = false;
					this.settings.hasAuth = true;
					this.settings.email = auth.email;
					this.sessionPassword = "";
					this.sessionTwoFactorCode = "";
					await this.saveSettings();
					await this.refreshSyncTarget();
					if (!this.coordinator.active) this.setDefaultStatus();
					else this.renderStatusBar();
				},
			});
		}

		return this.remoteFs;
	}

	async forceSyncFile(file: TFile): Promise<void> {
		if (this.coordinator.active || this.forceSyncInProgress) {
			new Notice("A sync is already in progress.");
			return;
		}
		if (needsRemoteReconciliation() || this.settings.reconciliationNeeded) {
			new Notice("Run a full sync to reconcile the previous uncertain transfer first.");
			return;
		}
		if (this.settings.syncPaused) {
			new Notice("Sync is paused. Resume sync to continue.");
			return;
		}

		const isOffline =
			this.isOffline() || (typeof navigator !== "undefined" && navigator.onLine === false);
		if (isOffline) {
			new Notice("You're offline — sync resumes when you're back");
		}

		if (!this.hasSavedAuth()) {
			new Notice("Filen not connected. Please log in first in settings.");
			return;
		}

		this.forceSyncInProgress = true;
		this.setStatus("Syncing…", "syncing", `Preparing to upload ${file.path}...`);
		try {
			await this.prepareSyncTarget(true);
			const remote = this.getOrCreateRemoteFs();
			const baseline = this.db ? await this.db.getFile(file.path) : null;
			const remoteEntry = await remote.stat?.(file.path);

			let remoteChanged = false;
			if (remoteEntry !== undefined && remoteEntry !== null) {
				if (!baseline) {
					remoteChanged = true;
				} else if (
					baseline.remoteUuid === undefined ||
					remoteEntry.uuid !== baseline.remoteUuid ||
					(remoteEntry.remoteHash !== undefined &&
						baseline.remoteHash !== undefined &&
						remoteEntry.remoteHash !== baseline.remoteHash) ||
					remoteEntry.mtime !== baseline.mtime ||
					remoteEntry.size !== baseline.size
				) {
					remoteChanged = true;
				}
			}

			if (remoteChanged) {
				const confirmed = await confirmAction(
					this.app,
					"Overwrite remote file?",
					`The remote copy of "${file.name}" has changed since the last sync. Overwrite it with your local copy?\n\n(The current remote version will be saved in version history.)`,
					"Overwrite remote",
				);
				if (!confirmed) {
					this.logActivity(`Force sync cancelled for ${file.path}: remote changed`);
					this.setDefaultStatus();
					return;
				}
			}

			this.setStatus("Syncing…", "syncing", `Uploading ${file.path}...`);
			const expectedMtime = file.stat.mtime;
			const expectedSize = file.stat.size;
			const content = await this.app.vault.readBinary(file);
			const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
			const localHash = await sha256Hex(bytes);
			if (file.stat.mtime !== expectedMtime || file.stat.size !== expectedSize) {
				throw new Error("Local file changed while it was being read. Run a fresh sync.");
			}
			const reReadContent = await this.app.vault.readBinary(file);
			const reReadBytes =
				reReadContent instanceof Uint8Array ? reReadContent : new Uint8Array(reReadContent);
			if ((await sha256Hex(reReadBytes)) !== localHash) {
				throw new Error(
					"Local file content changed while it was being read. Run a fresh sync.",
				);
			}

			const uploadedRemote = await remote.writeFile(
				file.path,
				bytes,
				expectedMtime,
				file.stat.ctime,
				remoteEntry?.uuid,
			);
			if (file.stat.mtime !== expectedMtime || file.stat.size !== expectedSize) {
				throw new Error("Local file changed during upload. Run a fresh sync.");
			}

			if (this.db) {
				await this.db.setFile(file.path, {
					path: file.path,
					mtime: expectedMtime,
					ctime: file.stat.ctime,
					size: bytes.byteLength,
					hash: localHash,
					remoteUuid: uploadedRemote.uuid,
					remoteHash: uploadedRemote.remoteHash,
					lastSyncAt: Date.now(),
					lastKnownSide: "local",
				});
			}

			this.coordinator.resetOffline();
			this.lastSyncTimestamp = Date.now();
			this.setDefaultStatus();
			this.logActivity(`Force uploaded ${file.path}`);
			new Notice(`Uploaded "${file.name}" to Filen.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			this.logActivity(`Force upload failed for ${file.path}: ${message}`);
			this.setStatus("Upload failed", "error", message);
			new Notice(`Force upload failed: ${message}`);
		} finally {
			this.forceSyncInProgress = false;
			this.coordinator.invalidateEngine();
		}
	}

	private addFileMenuItems(menu: Menu, file: TAbstractFile) {
		if (!(file instanceof TFile)) return;
		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle("Force sync to Filen");
			item.setIcon("upload");
			item.onClick(() => {
				void this.forceSyncFile(file);
			});
		});
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
		const result = await this.coordinator.runSync("Restore sync", "both", { silent: true });
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
		this.registerDomEvent(this.statusBarItemEl, "contextmenu", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openStatusBarMenu(event);
		});
	}

	private openStatusBarMenu(event: MouseEvent): void {
		const menu = new Menu();

		if (this.statusBarState.kind === "syncing") {
			menu.addItem((item) => {
				item.setTitle("Open activity log");
				item.setIcon("align-left");
				item.onClick(() => {
					this.openActivityLogs();
				});
			});
		} else {
			menu.addItem((item) => {
				item.setTitle("Sync now");
				item.setIcon("refresh-cw");
				item.onClick(() => {
					void this.syncNow();
				});
			});
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile instanceof TFile) {
				menu.addItem((item) => {
					item.setTitle(`Force sync "${activeFile.name}"`);
					item.setIcon("file-up");
					item.onClick(() => {
						void this.forceSyncFile(activeFile);
					});
				});
			}
			menu.addItem((item) => {
				item.setTitle("Push local files");
				item.setIcon("arrow-up");
				item.onClick(() => {
					void this.pushLocal();
				});
			});
			menu.addItem((item) => {
				item.setTitle("Pull remote files");
				item.setIcon("arrow-down");
				item.onClick(() => {
					void this.pullRemote();
				});
			});
		}

		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle(this.settings.syncPaused ? "Resume auto-sync" : "Pause auto-sync");
			item.setIcon(this.settings.syncPaused ? "circle-play" : "pause");
			item.onClick(() => {
				void this.coordinator.toggleSyncPaused(() => this.canAutoSync());
			});
		});

		if (this.statusBarState.kind !== "syncing") {
			menu.addItem((item) => {
				item.setTitle("Open activity log");
				item.setIcon("align-left");
				item.onClick(() => {
					this.openActivityLogs();
				});
			});
		}

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
			if (this.isOffline()) {
				this.setStatus(
					"offline",
					"warning",
					"You're offline — sync resumes when you're back",
					null,
				);
				return;
			}
			this.setStatus("idle", "idle", `Connected as ${this.settings.email}.`, null);
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
		this.updateStatusDisplays();
	}

	private updateStatusDisplays(): void {
		this.renderStatusBar();
		this.updateRibbonIcon();
	}

	private updateRibbonIcon(): void {
		if (this.syncRibbonIconEl === null) return;
		this.syncRibbonIconEl.removeClass("is-syncing", "is-error", "is-warning");

		if (this.statusBarState.kind === "syncing") {
			this.syncRibbonIconEl.addClass("is-syncing");
			if (this.statusBarState.progress && this.statusBarState.progress.total > 0) {
				const pct = Math.round(
					(this.statusBarState.progress.current / this.statusBarState.progress.total) *
						100,
				);
				const pathDetail = this.statusBarState.progress.path
					? ` · ${this.statusBarState.progress.path.split("/").pop()}`
					: "";
				const tooltip = `Filen: Syncing ${this.statusBarState.progress.current}/${this.statusBarState.progress.total} (${pct}%)${pathDetail}\nClick for sync details`;
				setTooltip(this.syncRibbonIconEl, tooltip);
				this.syncRibbonIconEl.setAttr("aria-label", tooltip);
			} else {
				const tooltip = `Filen: ${this.statusBarState.text}\nClick for sync details`;
				setTooltip(this.syncRibbonIconEl, tooltip);
				this.syncRibbonIconEl.setAttr("aria-label", tooltip);
			}
			return;
		}

		if (this.statusBarState.kind === "error") {
			this.syncRibbonIconEl.addClass("is-error");
			const tooltip = `Filen: Sync failed (${this.statusBarState.detail})\nClick to retry sync`;
			setTooltip(this.syncRibbonIconEl, tooltip);
			this.syncRibbonIconEl.setAttr("aria-label", tooltip);
			return;
		}

		if (this.statusBarState.kind === "warning") {
			this.syncRibbonIconEl.addClass("is-warning");
			const tooltip = `Filen: ${this.statusBarState.text}\n${this.statusBarState.detail}`;
			setTooltip(this.syncRibbonIconEl, tooltip);
			this.syncRibbonIconEl.setAttr("aria-label", tooltip);
			return;
		}

		const tooltip =
			this.lastSyncTimestamp !== null && this.lastSyncTimestamp > 0
				? `Filen: Up to date (${formatRelativeTime(this.lastSyncTimestamp)})\nClick to sync now`
				: "Filen: Sync now";
		setTooltip(this.syncRibbonIconEl, tooltip);
		this.syncRibbonIconEl.setAttr("aria-label", tooltip);
	}

	private renderStatusBar(): void {
		if (
			this.statusBarItemEl === null ||
			this.statusBarIconEl === null ||
			this.statusBarTextEl === null
		)
			return;

		this.statusBarItemEl.removeClass(
			"is-idle",
			"is-syncing",
			"is-success",
			"is-warning",
			"is-error",
		);

		if (this.settings.statusBarIndicatorStyle === "icon") {
			this.statusBarItemEl.addClass("is-icon-only");
		} else {
			this.statusBarItemEl.removeClass("is-icon-only");
		}

		if (!this.hasSavedAuth()) {
			setIcon(this.statusBarIconEl, "cloud-off");
			this.statusBarTextEl.setText("Filen: disconnected");
			this.statusBarItemEl.addClass("is-idle");
			const tooltip = this.buildStatusTooltip();
			setTooltip(this.statusBarItemEl, tooltip);
			this.statusBarItemEl.setAttr("aria-label", tooltip);
			this.statusBarItemEl.setAttr("title", tooltip);
			return;
		}

		if (this.settings.syncPaused) {
			setIcon(this.statusBarIconEl, "pause");
			this.statusBarTextEl.setText("Filen: paused");
			this.statusBarItemEl.addClass("is-warning");
			const tooltip = this.buildStatusTooltip();
			setTooltip(this.statusBarItemEl, tooltip);
			this.statusBarItemEl.setAttr("aria-label", tooltip);
			this.statusBarItemEl.setAttr("title", tooltip);
			return;
		}

		if (this.isOffline()) {
			setIcon(this.statusBarIconEl, "cloud-off");
			this.statusBarTextEl.setText("Filen: offline");
			this.statusBarItemEl.addClass("is-warning");
			const tooltip = this.buildStatusTooltip();
			setTooltip(this.statusBarItemEl, tooltip);
			this.statusBarItemEl.setAttr("aria-label", tooltip);
			this.statusBarItemEl.setAttr("title", tooltip);
			return;
		}

		if (this.statusBarState.kind === "syncing") {
			setIcon(this.statusBarIconEl, "refresh-cw");
			if (this.statusBarState.progress && this.statusBarState.progress.total > 0) {
				const pct = Math.round(
					(this.statusBarState.progress.current / this.statusBarState.progress.total) *
						100,
				);
				this.statusBarTextEl.setText(
					`Filen: ${this.statusBarState.progress.current}/${this.statusBarState.progress.total} (${pct}%)`,
				);
			} else {
				this.statusBarTextEl.setText(`Filen ${this.statusBarState.text}`);
			}
			this.statusBarItemEl.addClass("is-syncing");
			const tooltip = this.buildStatusTooltip();
			setTooltip(this.statusBarItemEl, tooltip);
			this.statusBarItemEl.setAttr("aria-label", tooltip);
			this.statusBarItemEl.setAttr("title", tooltip);
			return;
		}

		if (this.statusBarState.kind === "error") {
			setIcon(this.statusBarIconEl, "alert-circle");
			this.statusBarTextEl.setText(`Filen: error`);
			this.statusBarItemEl.addClass("is-error");
			const tooltip = this.buildStatusTooltip();
			setTooltip(this.statusBarItemEl, tooltip);
			this.statusBarItemEl.setAttr("aria-label", tooltip);
			this.statusBarItemEl.setAttr("title", tooltip);
			return;
		}

		// Idle / success state: native Obsidian Sync uses the sync icon "refresh-cw"
		setIcon(this.statusBarIconEl, "refresh-cw");
		if (this.lastSyncTimestamp !== null && this.lastSyncTimestamp > 0) {
			const relative = formatRelativeTime(this.lastSyncTimestamp);
			this.statusBarTextEl.setText(`Filen: idle · ${relative}`);
		} else {
			this.statusBarTextEl.setText("Filen: idle");
		}
		this.statusBarItemEl.addClass("is-idle");
		const tooltip = this.buildStatusTooltip();
		setTooltip(this.statusBarItemEl, tooltip);
		this.statusBarItemEl.setAttr("aria-label", tooltip);
		this.statusBarItemEl.setAttr("title", tooltip);
	}

	private buildStatusTooltip(): string {
		const lines: string[] = ["Filen Sync"];

		if (!this.hasSavedAuth()) {
			lines.push("Not connected", "Click to configure account.");
			return lines.join("\n");
		}

		if (this.settings.syncPaused) {
			lines.push("Sync paused", "Click to resume or view actions.");
			return lines.join("\n");
		}

		if (this.isOffline()) {
			lines.push("Offline", "Sync will resume automatically when reconnected.");
			return lines.join("\n");
		}

		if (this.statusBarState.kind === "syncing") {
			const label = isAllFilesSyncedStatus(this.statusBarState)
				? "All files synced"
				: this.statusBarState.text;
			lines.push(label ? `Syncing: ${label}` : "Syncing…");
			if (this.statusBarState.progress && this.statusBarState.progress.total > 0) {
				const pct = Math.round(
					(this.statusBarState.progress.current / this.statusBarState.progress.total) *
						100,
				);
				lines.push(
					`Progress: ${this.statusBarState.progress.current}/${this.statusBarState.progress.total} files (${pct}%)`,
				);
				if (this.statusBarState.progress.path) {
					lines.push(`File: ${this.statusBarState.progress.path}`);
				}
			} else if (this.statusBarState.detail) {
				lines.push(this.statusBarState.detail);
			}
			lines.push("Click for sync actions.");
			return lines.join("\n");
		}

		if (this.statusBarState.kind === "error") {
			lines.push("Sync error");
			if (this.statusBarState.detail) {
				lines.push(this.statusBarState.detail);
			}
			lines.push("Click to view activity log.");
			return lines.join("\n");
		}

		// Idle / fully synced
		if (this.lastSyncTimestamp !== null && this.lastSyncTimestamp > 0) {
			lines.push(`Fully synced (${formatRelativeTime(this.lastSyncTimestamp)})`);
		} else {
			lines.push("Ready");
		}

		if (this.statusBarState.detail && this.statusBarState.text !== "Ready") {
			lines.push(this.statusBarState.detail);
		}

		lines.push(`Auto-sync: ${this.describeAutoSync()}`);
		lines.push("Click for sync menu.");
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
