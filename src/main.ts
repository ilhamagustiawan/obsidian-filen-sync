import { selectedSettingsPaths } from "./sync/settings-paths";
import { DeletedFilesModal } from "./ui/deleted-files-modal";
import { ConflictResolverModal } from "./ui/conflict-resolver-modal";
import type { App, Menu, Modal, TAbstractFile } from "obsidian";
import { Notice, Platform, Plugin, TFile } from "obsidian";
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
} from "./settings";
import type { BulkGuardReport } from "./sync/bulk-guard";
import {
	SyncCoordinator,
	type StatusBarKind,
	type StatusBarState,
	type SyncRunResult,
} from "./sync/coordinator";
import { SyncNoticeController } from "./ui/sync-notice";
import { MobileSyncIndicator } from "./ui/mobile-sync-indicator";
import { AuthSession } from "./auth";
import { forceUploadFile } from "./sync/force-upload";
import { confirmDestructiveAction } from "./ui/confirm";
import { StatusBar } from "./ui/status-bar";

import { SyncPreviewModal } from "./ui/sync-preview-modal";
import { DiagnosticHistoryModal } from "./ui/diagnostic-history-modal";
import type { SyncDirection, SyncPreviewResult, TargetIdentityInfo } from "./sync/types";

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
	private dbReadOnly = false;
	private resolver: ConflictResolverModal | null = null;
	private openingConflictReview = false;
	private ownedModals = new Set<Modal>();
	private reviewPending = false;
	private reviewTimer: number | null = null;
	private targetGeneration = 0;
	private targetBindingKey: string | null = null;
	private targetPreparation: Promise<void> | null = null;
	private forceSyncInProgress = false;
	private reconciliationPersistenceFailed = false;
	private readonly secrets = new PluginSecrets(this.app);
	private readonly auth = new AuthSession(this.secrets);
	private unloaded = false;
	private lastSyncTimestamp: number | null = null;
	private lastSyncResultSummary: string | null = null;
	private statusBar!: StatusBar;
	private noticeController!: SyncNoticeController;
	private mobileIndicator!: MobileSyncIndicator;
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

		this.lastSyncTimestamp = this.settings.lastSyncTimestamp;
		this.lastSyncResultSummary = this.settings.lastSyncResultSummary;
		this.statusBar = this.createStatusBar();
		this.noticeController = new SyncNoticeController(
			() => this.openActivityLogs(),
			() => this.statusBar.exactLastSyncSummary(),
			(e) => this.statusBar.openMenu(e),
			() => Platform.isMobile,
			() => this.settings.showFloatingSyncIndicator,
		);

		this.mobileIndicator = new MobileSyncIndicator(
			this,
			() => this.settings.showFloatingSyncIndicator,
			() => this.showSyncProgressNoticeOnDemand(),
			(event) => this.statusBar.openMenu(event),
			() => this.statusBar.iconModel(),
		);

		this.coordinator = new SyncCoordinator(
			this.app,
			this.manifest.id,
			this.settings,
			() => this.getOrCreateRemoteFs(),
			() => this.db,
			{
				onReviewConflicts: () => this.scheduleConflictReview(),
				onOpeningCheckChange: (check) => this.mobileIndicator.onOpeningCheckChange(check),
				getAutoSyncBlockReason: () =>
					!this.hasSavedAuth()
						? "Connect Filen to sync"
						: this.settings.reconciliationNeeded || needsRemoteReconciliation()
							? "Transfer recovery needed — select Sync now"
							: this.forceSyncInProgress
								? "Force upload in progress"
								: null,
				onStatusChange: (state) => {
					this.statusBarState = state;
					if (state.syncCompleted) {
						this.lastSyncTimestamp = Date.now();
						this.settings.lastSyncTimestamp = this.lastSyncTimestamp;
						this.lastSyncResultSummary = state.detail || state.text;
						this.settings.lastSyncResultSummary = this.lastSyncResultSummary;
						void this.saveSettings();
					}
					this.updateStatusDisplays();
				},
				onLogActivity: (message) => {
					this.logActivity(message);
				},
				confirmLocalDeletes: (paths) => this.confirmLocalDeletes(paths),
				confirmBulkOperations: (report) => this.confirmBulkOperations(report),
				saveSettings: () => this.saveSettings(),
				prepareTarget: (options) => this.prepareSyncTarget(false, options),
				getTargetInfo: (noCreate) => this.getTargetIdentityInfo(noCreate),
			},
		);

		this.statusBar.attach(this.addStatusBarItem());
		this.setDefaultStatus();

		if (!Platform.isMobile) {
			this.registerInterval(
				window.setInterval(() => {
					if (!this.coordinator.active) {
						this.updateStatusDisplays();
					}
				}, 1000),
			);
		}

		const syncRibbonIcon = this.addRibbonIcon("refresh-cw", "Filen: sync menu", (evt) =>
			this.statusBar.openMenu(evt),
		);
		syncRibbonIcon.addClass("filen-sync-ribbon-sync");
		this.statusBar.attachRibbon(syncRibbonIcon);

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
			id: "review-conflicts",
			name: "Review conflict files",
			callback: () => {
				void this.openConflictResolver();
			},
		});

		this.addCommand({
			id: "show-sync-progress",
			name: "Show sync progress",
			callback: () => this.showSyncProgressNoticeOnDemand(),
		});

		this.addCommand({
			id: "initial-sync",
			name: "Initial sync",
			callback: () => {
				void this.initialSync();
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
			id: "preview-sync-changes",
			name: "Preview changes",
			callback: () => {
				this.previewChanges("both");
			},
		});

		this.addCommand({
			id: "preview-push-local",
			name: "Preview push (local to Filen)",
			callback: () => {
				this.previewChanges("push");
			},
		});

		this.addCommand({
			id: "preview-pull-remote",
			name: "Preview pull (Filen to local)",
			callback: () => {
				this.previewChanges("pull");
			},
		});

		this.addCommand({
			id: "open-diagnostic-history",
			name: "Open diagnostic plan history",
			callback: () => {
				this.openDiagnosticHistory();
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
		this.statusBar.render();

		this.app.workspace.onLayoutReady(() => {
			void this.initializeAfterLayoutReady();
		});
	}

	private createStatusBar(): StatusBar {
		return new StatusBar({
			plugin: this,
			settings: () => this.settings,
			state: () => this.statusBarState,
			coordinator: () => this.coordinator,
			connected: () => this.hasSavedAuth(),
			offline: () => this.isOffline(),
			lastSync: () => ({
				timestamp: this.lastSyncTimestamp,
				summary: this.lastSyncResultSummary,
			}),
			actions: {
				reviewConflicts: () => void this.openConflictResolver(),
				togglePaused: () =>
					void this.coordinator.toggleSyncPaused(() => this.canAutoSync()),
				openVersionHistory: (file) => this.openVersionHistory(file),
				openActivityLogs: () => this.openActivityLogs(),
				openDeletedFiles: () => void this.openDeletedFiles(),
				openSettings: () => this.openSettingsTab(),
				syncNow: () => void this.syncNow(),
				showProgress: () => this.showSyncProgressNoticeOnDemand(),
				preview: (direction) => this.previewChanges(direction),
				forceSync: (file) => void this.forceSyncFile(file),
				pushLocal: () => void this.pushLocal(),
				pullRemote: () => void this.pullRemote(),
				openDiagnosticHistory: () => this.openDiagnosticHistory(),
			},
		});
	}

	onunload() {
		this.unloaded = true;
		if (this.reviewTimer !== null) window.clearTimeout(this.reviewTimer);
		this.reviewTimer = null;
		this.reviewPending = false;
		for (const modal of this.ownedModals) modal.close();
		this.ownedModals.clear();
		this.coordinator.close();
		this.noticeController?.closeNotice();
		this.mobileIndicator?.close();
		if (this.activityLogsSaveTimer !== null) {
			window.clearTimeout(this.activityLogsSaveTimer);
			this.activityLogsSaveTimer = null;
			void this.saveSettings();
		}
		this.activityLogListeners.clear();
		this.auth.clear();
		this.remoteFs = null;
		void this.db?.close();
		this.db = null;
	}

	setSessionPassword(value: string) {
		this.auth.password = value;
		this.coordinator.invalidateEngine();
		this.remoteFs = null;
	}

	setSessionTwoFactorCode(value: string) {
		this.auth.twoFactorCode = value;
		this.coordinator.invalidateEngine();
		this.remoteFs = null;
	}

	hasSessionPassword(): boolean {
		return this.auth.password.length > 0;
	}

	hasSavedAuth(): boolean {
		return this.auth.hasAuth();
	}

	private canAutoSync(): boolean {
		return (
			this.hasSavedAuth() &&
			!this.forceSyncInProgress &&
			!this.settings.reconciliationNeeded &&
			!needsRemoteReconciliation()
		);
	}

	isOffline(): boolean {
		return this.coordinator?.offline ?? false;
	}

	async setRememberAuth(remember: boolean): Promise<void> {
		const hasAuth = this.auth.setRemember(remember);
		this.settings.rememberAuth = remember;
		this.settings.hasAuth = hasAuth;
		await this.saveSettings();
		await this.refreshSyncTarget();
	}

	async clearSavedAuth() {
		this.coordinator.invalidateEngine();
		this.remoteFs = null;
		this.auth.clear();
		this.auth.legacyInvalid = false;
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
				this.auth.legacyInvalid = true;
			} else {
				try {
					this.auth.persistVerified(auth);
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
			if (secretMigrationFailed) this.auth.legacyInvalid = true;
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
		if (this.auth.legacyInvalid) {
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
		this.statusBar.render();
		this.maybePromptForSetup();
	}

	refreshSyncConfiguration(): void {
		this.coordinator.invalidateEngine();
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
		this.openManagedModal(new ActivityLogModal(this.app, this));
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
		else this.statusBar.render();
	}

	async prepareSyncTarget(
		fromForceUpload = false,
		options: { readOnly?: boolean } = {},
	): Promise<void> {
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
			const identity = await remote.getTargetIdentity({ noCreate: options.readOnly });
			if (generation !== this.targetGeneration || this.unloaded) {
				throw new Error("Sync target changed during preparation. Retry the sync.");
			}
			const bindingKey = JSON.stringify([
				this.settings.vaultId,
				identity.userId,
				identity.rootUuid,
			]);
			if (
				this.db !== null &&
				this.targetBindingKey === bindingKey &&
				(!this.dbReadOnly || options.readOnly)
			)
				return;
			const db = await SyncDb.open(
				{
					vaultId: this.settings.vaultId,
					userId: identity.userId,
					remoteRootUuid: identity.rootUuid,
				},
				{ readOnly: options.readOnly },
			);
			try {
				if (!options.readOnly) {
					await db.runMigrations();
				}
				if (generation !== this.targetGeneration || this.unloaded) {
					throw new Error("Sync target changed during preparation. Retry the sync.");
				}
				const previousDb = this.db;
				this.db = db;
				this.dbReadOnly = options.readOnly ?? false;
				this.targetBindingKey = bindingKey;
				await previousDb?.close();
				this.coordinator.invalidateEngine();
				await this.coordinator.refreshConflicts();
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

	async getTargetIdentityInfo(noCreate = true): Promise<TargetIdentityInfo> {
		const remote = this.getOrCreateRemoteFs();
		const identity = await remote.getTargetIdentity({ noCreate });
		return {
			userId: identity.userId,
			rootUuid: identity.rootUuid,
			remoteRoot: getVaultRemoteRoot(this.settings.remoteRoot, this.settings.vaultName),
			vaultId: this.settings.vaultId,
		};
	}

	previewChanges(direction: SyncDirection = "both"): void {
		if (this.coordinator.active) {
			new Notice("A sync is already in progress.");
			return;
		}
		this.openManagedModal(new SyncPreviewModal(this.app, this, direction));
	}

	openDiagnosticHistory(): void {
		this.openManagedModal(new DiagnosticHistoryModal(this.app, this));
	}

	setPreviewActive(active: boolean): void {
		this.coordinator.setPreviewActive(active, () => this.canAutoSync());
	}

	async generatePreview(
		direction: SyncDirection,
		targetInfo: TargetIdentityInfo,
	): Promise<SyncPreviewResult> {
		return this.coordinator.generatePreview(direction, targetInfo);
	}

	async runApplySync(direction: SyncDirection): Promise<SyncRunResult> {
		return this.coordinator.runSync("Apply preview", direction, { isManual: true });
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
		this.mobileIndicator?.refreshVisibility();
	}

	private showSyncProgressNoticeOnDemand(): void {
		this.noticeController.showOnDemand(this.statusBarState);
	}

	async initialSync(): Promise<SyncRunResult> {
		const result = await this.coordinator.runSync("Initial sync", "both", {
			isManual: true,
			initialSync: true,
		});
		if (result.kind === "applied" || result.kind === "up-to-date")
			await this.clearReconciliationNeeded();
		return result;
	}

	async syncNow(): Promise<SyncRunResult> {
		const result = await this.coordinator.runSync("Sync", "both", { isManual: true });
		if (result.kind === "applied" || result.kind === "up-to-date") {
			await this.clearReconciliationNeeded();
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
			await this.clearReconciliationNeeded();
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
			await this.clearReconciliationNeeded();
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

	async testConnection(): Promise<boolean> {
		if (this.coordinator.active) {
			new Notice("Sync in progress.");
			return false;
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
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			this.logActivity(`Connection failed: ${message}`);
			new Notice(`Connection test failed: ${message}`);
			this.setStatus("Connection failed", "error", message);
			return false;
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
		// Folder paths arrive with a trailing slash.
		const items = paths.some((path) => path.endsWith("/")) ? "item" : "file";
		const message = `Sync would delete ${paths.length} local ${items}(s) that no longer exist in Filen: ${examples}${more}. Deleted ${items}s go to the system trash.`;
		return confirmDestructiveAction(
			this.app,
			`Delete local ${items}s?`,
			message,
			`Delete local ${items}s`,
		);
	}

	private confirmBulkOperations(report: BulkGuardReport): Promise<boolean> {
		const lines: string[] = [];
		if (report.reason) {
			lines.push(report.reason);
		} else {
			lines.push("A large number of files would be deleted or overwritten.");
		}
		lines.push("");
		lines.push("Proposed destructive effects:");
		lines.push(
			`• Local: ${report.stats.localDeletes} delete(s), ${report.stats.localOverwrites} overwrite(s)`,
		);
		lines.push(
			`• Remote: ${report.stats.remoteDeletes} delete(s), ${report.stats.remoteOverwrites} overwrite(s)`,
		);
		lines.push("");
		lines.push("Proceed with this sync run?");
		return confirmDestructiveAction(
			this.app,
			"Mass changes detected",
			lines.join("\n"),
			"Proceed with sync",
		);
	}

	private getOrCreateRemoteFs(): FilenRemoteFs {
		if (this.settings.email.length === 0) {
			throw new Error("Filen email missing. Add it in plugin settings.");
		}
		const savedAuth = this.auth.current;
		if (savedAuth === null && this.auth.password.length === 0) {
			throw new Error("Filen password missing. Enter it once in plugin settings.");
		}

		if (this.remoteFs === null) {
			this.remoteFs = new FilenRemoteFs({
				email: this.settings.email,
				password: this.auth.password,
				twoFactorCode: this.auth.twoFactorCode,
				remoteRoot: getVaultRemoteRoot(this.settings.remoteRoot, this.settings.vaultName),
				auth: savedAuth,
				saveAuth: async (auth) => {
					this.auth.store(auth, this.settings.rememberAuth);
					this.settings.hasAuth = true;
					this.settings.email = auth.email;
					await this.saveSettings();
					await this.refreshSyncTarget();
					if (!this.coordinator.active) this.setDefaultStatus();
					else this.statusBar.render();
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
			new Notice("You're offline. Reconnect, then try the upload again.");
			return;
		}

		if (!this.hasSavedAuth()) {
			new Notice("Filen not connected. Please log in first in settings.");
			return;
		}

		this.forceSyncInProgress = true;
		this.coordinator.recordSyncStart();
		this.setStatus("Syncing…", "syncing", `Preparing to upload ${file.path}...`);
		try {
			await this.prepareSyncTarget(true);
			const result = await forceUploadFile(file, {
				app: this.app,
				db: () => this.db,
				remote: this.getOrCreateRemoteFs(),
				confirmOverwrite: (target) =>
					confirmDestructiveAction(
						this.app,
						"Overwrite remote file?",
						`The remote copy of "${target.name}" has changed since the last sync. Overwrite it with your local copy?\n\n(The current remote version will be saved in version history.)`,
						"Overwrite remote",
					),
				onUploading: () =>
					this.setStatus("Syncing…", "syncing", `Uploading ${file.path}...`),
			});
			if (result.kind === "cancelled") {
				this.logActivity(`Force sync cancelled for ${file.path}: remote changed`);
				this.setDefaultStatus();
				return;
			}

			this.coordinator.resetOffline();
			this.lastSyncTimestamp = Date.now();
			this.settings.lastSyncTimestamp = this.lastSyncTimestamp;
			this.lastSyncResultSummary = `Force uploaded ${file.path}`;
			this.settings.lastSyncResultSummary = this.lastSyncResultSummary;
			await this.saveSettings();
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
		void this.openVerifiedVersionHistory(file);
	}

	private async openVerifiedVersionHistory(file: TFile): Promise<void> {
		try {
			await this.prepareSyncTarget();
			if (this.unloaded) return;
			const remote = this.getOrCreateRemoteFs();
			const db = this.db!;
			this.openManagedModal(
				new FileVersionModal({
					db,
					pluginId: this.manifest.id,
					verifyTarget: () => this.verifyDialogTarget(db),
					onLocalRestored: (path) => this.coordinator.queueResolvedChange(path),
					app: this.app,
					remote,
					filePath: file.path,
					fileName: file.name,
					onRestored: async () => {
						await this.runRestoreSync();
					},
				}),
			);
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

	private openManagedModal(modal: Modal): void {
		this.ownedModals.add(modal);
		const close = modal.onClose.bind(modal);
		modal.onClose = () => {
			this.ownedModals.delete(modal);
			close();
		};
		modal.open();
	}

	private async verifyDialogTarget(db: SyncDb): Promise<void> {
		await this.prepareSyncTarget();
		if (this.unloaded || this.db?.targetKey !== db.targetKey)
			throw new Error(
				"Sync target changed. Close this dialog and reopen it for the current target.",
			);
	}

	private async openDeletedFiles(): Promise<void> {
		try {
			await this.prepareSyncTarget(false, { readOnly: true });
			if (!this.db || this.unloaded) return;
			const db = this.db;
			this.openManagedModal(
				new DeletedFilesModal(
					this.app,
					this.getOrCreateRemoteFs(),
					db,
					(path) => {
						this.coordinator.invalidateEngine();
						this.coordinator.queueResolvedChange(path);
					},
					() => this.verifyDialogTarget(db),
				),
			);
		} catch (e) {
			new Notice(e instanceof Error ? e.message : "Could not open deleted files.");
		}
	}

	private scheduleConflictReview(): void {
		this.reviewPending = true;
		if (this.reviewTimer !== null || this.unloaded) return;
		this.reviewTimer = window.setTimeout(() => {
			this.reviewTimer = null;
			if (!this.reviewPending || this.unloaded) return;
			const doc = typeof activeDocument === "undefined" ? document : activeDocument;
			if (
				doc.visibilityState === "hidden" ||
				this.resolver ||
				doc.querySelector(".modal-container")
			) {
				this.scheduleConflictReview();
				return;
			}
			this.reviewPending = false;
			void this.openConflictResolver();
		}, 1000);
	}

	private async openConflictResolver(): Promise<void> {
		if (this.resolver || this.openingConflictReview) return;
		this.openingConflictReview = true;
		this.coordinator.setConflictReviewActive(true);
		try {
			await this.prepareSyncTarget();
			if (!this.db || this.unloaded) return;
			this.reviewPending = false;
			const db = this.db;
			this.resolver = new ConflictResolverModal({
				verifyTarget: () => this.verifyDialogTarget(db),
				app: this.app,
				db,
				pluginId: this.manifest.id,
				files: () => this.coordinator.getConflictFiles(),
				conflicts: () => this.coordinator.getManagedConflicts(),
				refreshConflict: (path) => this.coordinator.refreshConflict(path, db.targetKey),
				applyConflict: (resolution) =>
					this.coordinator.resolveConflict(resolution, db.targetKey),
				applyLegacy: (path, bytes, hash, copies) =>
					this.coordinator.resolveLegacyConflict(path, bytes, hash, copies, db.targetKey),
				onSynced: () => this.updateStatusDisplays(),
				selectedSettings: selectedSettingsPaths(
					this.app.vault.configDir,
					this.manifest.id,
					this.settings.syncSettings,
					this.settings.selectedSettings,
				),
				onResolved: (path) => {
					this.coordinator.queueResolvedChange(path);
					this.updateStatusDisplays();
				},
				onClosed: () => {
					this.resolver = null;
					this.coordinator.setConflictReviewActive(false);
				},
			});
			this.openManagedModal(this.resolver);
		} catch (e) {
			new Notice(e instanceof Error ? e.message : "Could not open conflict review.");
		} finally {
			this.openingConflictReview = false;
			if (!this.resolver) this.coordinator.setConflictReviewActive(false);
		}
	}

	private maybePromptForSetup(): void {
		if (this.hasSavedAuth() || this.setupPromptShown) return;
		this.setupPromptShown = true;
		this.openManagedModal(
			new FilenSyncSetupModal({
				app: this.app,
				onOpenSettings: () => this.openSettingsTab(),
			}),
		);
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
		if (
			this.coordinator?.active ||
			this.coordinator?.pendingCount > 0 ||
			this.statusBarState.kind === "error" ||
			this.statusBarState.kind === "warning"
		) {
			this.updateStatusDisplays();
			return;
		}
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
		this.statusBar.render();
		this.statusBar.renderRibbon();
		this.mobileIndicator?.onStatusChange(this.statusBarState);
		this.noticeController?.onStatusChange(this.statusBarState);
	}
}
