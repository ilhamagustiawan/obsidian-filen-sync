import type { App, EventRef, TAbstractFile } from "obsidian";
import { Notice, Platform, TFile, TFolder } from "obsidian";
import type { SyncDb } from "../db";
import type { FilenRemoteFs } from "../fs-remote";
import { createSyncPathFilter } from "../path-filters";
import type { FilenSyncSettings } from "../settings";
import { SyncEngine } from "../sync-engine";
import type { BulkGuardReport } from "./bulk-guard";
import { isConflictFilePath } from "./conflict-utils";
import type {
	SyncActivityEvent,
	SyncDirection,
	SyncOperation,
	SyncProgress,
	SyncTimingSummary,
} from "./types";

function formatTimingSummary(timing?: SyncTimingSummary): string {
	if (!timing) return "";
	const parts: string[] = [`total ${(timing.totalMs / 1000).toFixed(1)}s`];
	if (timing.scanMs !== undefined && timing.scanMs > 0) parts.push(`scan ${timing.scanMs}ms`);
	if (timing.planMs !== undefined && timing.planMs > 0) parts.push(`plan ${timing.planMs}ms`);
	if (timing.transferMs !== undefined && timing.transferMs > 0)
		parts.push(`transfer ${timing.transferMs}ms`);
	if (timing.firstTransferMs !== undefined)
		parts.push(`first file in ${timing.firstTransferMs}ms`);
	return ` (${parts.join(", ")})`;
}

export type StatusBarKind = "idle" | "pending" | "syncing" | "success" | "warning" | "error";

export type StatusBarState = {
	kind: StatusBarKind;
	text: string;
	detail: string;
	updatedAt: number | null;
	progress?: SyncProgress;
	isManual?: boolean;
	syncCompleted?: boolean;
};

export type SyncRunResult =
	| {
			kind: "applied";
			applied: number;
			conflicts: number;
			uploaded: number;
			downloaded: number;
			deletedLocal: number;
			deletedRemote: number;
	  }
	| { kind: "up-to-date" }
	| { kind: "skipped"; reason: string }
	| { kind: "cancelled"; reason: string }
	| { kind: "failed"; message: string };

const AUTO_SYNC_FAILURE_BASE_BACKOFF_MS = 30_000;
const AUTO_SYNC_FAILURE_MAX_BACKOFF_MS = 5 * 60_000;
const ERROR_NOTICE_THROTTLE_MS = 15 * 60_000;

export type CoordinatorCallbacks = {
	onStatusChange: (state: StatusBarState) => void;
	onLogActivity: (message: string) => void;
	confirmLocalDeletes: (paths: string[]) => Promise<boolean>;
	confirmBulkOperations: (report: BulkGuardReport) => Promise<boolean>;
	saveSettings: () => Promise<void>;
	prepareTarget?: () => Promise<void>;
};

export class SyncCoordinator {
	private isSyncing = false;
	private isOffline = false;
	private consecutiveNetworkFailures = 0;
	private lastErrorNoticeTime = new Map<string, number>();
	private debounceTimer: number | null = null;
	private intervalId: number | null = null;
	private startupTimerId: number | null = null;
	private vaultEventRefs: EventRef[] = [];
	private autoSyncDomCleanup: (() => void)[] = [];
	private pendingAutoSync = false;
	private nextAutoSyncAllowedAt = 0;
	private lastSyncStartAt = 0;
	private pendingAutoSyncRequiresFullScan = false;
	private autoSyncTransientFailureCount = 0;
	private autoSyncReplanRetryCount = 0;
	private isReplanRetryHeld = false;
	private pendingPaths = new Map<string, number>();
	private changeRevision = 0;
	private lastEditAt = 0;
	private lastStatus: StatusBarState | null = null;
	private confirmationRequired = false;
	private syncEngine: SyncEngine | null = null;
	private invalidateAfterRun = false;
	private autoSyncHasSavedAuth: (() => boolean) | null = null;

	constructor(
		private readonly app: App,
		private readonly pluginId: string,
		private readonly settings: FilenSyncSettings,
		private readonly getRemoteFs: () => FilenRemoteFs,
		private readonly getDb: () => SyncDb | null,
		private readonly callbacks: CoordinatorCallbacks,
	) {}

	get pendingCount(): number {
		return this.pendingPaths.size;
	}

	get retryAt(): number | null {
		if (this.isReplanRetryHeld) return null;
		if (this.autoSyncTransientFailureCount > 0 || this.autoSyncReplanRetryCount > 0) {
			return this.nextAutoSyncAllowedAt;
		}
		return null;
	}

	get isReplanHeld(): boolean {
		return this.isReplanRetryHeld;
	}

	recordSyncStart(): void {
		this.lastSyncStartAt = Date.now();
		this.nextAutoSyncAllowedAt = Math.max(
			this.nextAutoSyncAllowedAt,
			this.lastSyncStartAt + (this.settings.minimumAutoSyncIntervalSeconds ?? 10) * 1000,
		);
	}

	private publishStatus(state: StatusBarState): void {
		this.lastStatus = state;
		this.callbacks.onStatusChange(state);
	}

	getConflictFiles(): TFile[] {
		return (this.app.vault.getFiles?.() ?? []).filter((f) => isConflictFilePath(f.path));
	}

	get conflictCount(): number {
		return this.getConflictFiles().length;
	}

	private publishPending(): void {
		if (this.isSyncing || this.isReplanRetryHeld) return;
		const conflictCount = this.conflictCount;
		if (conflictCount > 0) {
			this.publishStatus({
				kind: "warning",
				text: `${conflictCount} conflict${conflictCount === 1 ? "" : "s"} to review`,
				detail:
					this.pendingCount > 0
						? `${this.pendingCount} local changes pending · ${conflictCount} conflict${conflictCount === 1 ? "" : "s"} to review`
						: `${conflictCount} conflict(s) to review in vault.`,
				updatedAt: Date.now(),
			});
			return;
		}
		if (
			this.lastStatus?.kind === "warning" &&
			!this.lastStatus.text.toLowerCase().includes("conflict")
		)
			return;
		if (this.lastStatus?.kind === "error") return;
		if (this.pendingCount > 0) {
			this.publishStatus({
				kind: "idle",
				text: "Ready",
				detail: "Local changes are queued for automatic sync.",
				updatedAt: Date.now(),
			});
		} else if (
			this.lastStatus?.kind === "warning" &&
			this.lastStatus.text.toLowerCase().includes("conflict")
		) {
			this.publishStatus({
				kind: "idle",
				text: "up to date",
				detail: "All conflicts resolved and files up to date.",
				updatedAt: Date.now(),
			});
		}
	}

	get active(): boolean {
		return this.isSyncing;
	}

	get offline(): boolean {
		return this.isOffline;
	}

	resetOffline(): void {
		this.setOffline(false);
		this.consecutiveNetworkFailures = 0;
	}

	setOffline(offline: boolean): void {
		if (this.isOffline === offline) return;
		this.isOffline = offline;
		if (offline) {
			this.publishStatus({
				kind: "warning",
				text: "offline",
				detail: "You're offline — sync resumes when you're back",
				updatedAt: Date.now(),
			});
		} else {
			this.publishStatus({
				kind: "idle",
				text: "Ready",
				detail: "Connected",
				updatedAt: Date.now(),
			});
		}
	}

	close(): void {
		this.teardownAutoSync();
		this.syncEngine?.close();
		this.syncEngine = null;
	}

	invalidateEngine(): void {
		if (this.isSyncing) {
			this.invalidateAfterRun = true;
			return;
		}
		this.syncEngine?.close();
		this.syncEngine = null;
	}

	private getSyncEngine(): SyncEngine {
		const db = this.getDb();
		if (db === null) {
			throw new Error(
				"Database not initialized yet. Please wait for vault to finish loading.",
			);
		}
		if (this.syncEngine === null) {
			this.syncEngine = new SyncEngine({
				app: this.app,
				db,
				pluginId: this.pluginId,
				settings: { ...this.settings, ignorePatterns: [...this.settings.ignorePatterns] },
				remote: this.getRemoteFs(),
			});
		}
		return this.syncEngine;
	}

	private showThrottledNotice(text: string, isManual: boolean): void {
		if (isManual) {
			new Notice(text);
			return;
		}
		const now = Date.now();
		const lastShown = this.lastErrorNoticeTime.get(text) ?? 0;
		if (now - lastShown >= ERROR_NOTICE_THROTTLE_MS) {
			this.lastErrorNoticeTime.set(text, now);
			new Notice(text);
		}
	}

	async runSync(
		label: string,
		direction: SyncDirection = "both",
		options: {
			silent?: boolean;
			autoSync?: boolean;
			isManual?: boolean;
			initialSync?: boolean;
			fullScan?: boolean;
		} = {},
	): Promise<SyncRunResult> {
		if (this.isSyncing) {
			const reason = "Sync already in progress.";
			this.callbacks.onLogActivity(`${label} skipped: sync already in progress`);
			if (!options.silent) new Notice(reason);
			return { kind: "skipped", reason };
		}

		const isManual = options.isManual ?? !options.autoSync;
		const browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;
		if (browserOffline) {
			this.setOffline(true);
		}

		if (isManual && this.isOffline) {
			new Notice("You're offline — sync resumes when you're back");
		}

		const pendingAtStart = new Map(this.pendingPaths);
		const scanHints =
			options.autoSync && options.fullScan !== true ? [...pendingAtStart.keys()] : undefined;
		this.pendingAutoSync = false;
		this.pendingAutoSyncRequiresFullScan = false;
		this.recordSyncStart();
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (isManual) this.confirmationRequired = false;
		this.isSyncing = true;
		this.publishStatus({
			kind: "syncing",
			text: "Connecting…",
			detail: `${label}: connecting to Filen.`,
			updatedAt: Date.now(),
			isManual,
			progress: { current: 0, total: 0, path: "" },
		});
		if (isManual) this.callbacks.onLogActivity(`${label} started`);

		try {
			await this.callbacks.prepareTarget?.();
			const engine = this.getSyncEngine();

			const confirmDeletes = options.silent
				? async (paths: string[]) => {
						this.showThrottledNotice(
							`Filen Sync: ${paths.length} local file(s) need deletion confirmation. Run Sync now.`,
							false,
						);
						return false;
					}
				: (paths: string[]) => this.callbacks.confirmLocalDeletes(paths);

			const confirmBulk = options.silent
				? async (report: BulkGuardReport) => {
						this.showThrottledNotice(
							`Filen Sync: Mass changes detected (${report.reason ?? "safety limit"}). Auto-sync paused. Run Sync now.`,
							false,
						);
						return false;
					}
				: (report: BulkGuardReport) => this.callbacks.confirmBulkOperations(report);

			const result = await engine.sync(
				(p: SyncProgress) => {
					this.publishStatus({
						kind: "syncing",
						text: progressLabel(p),
						detail:
							p.phase === "transferring"
								? `${p.current}/${p.total} changes complete · ${p.path}${p.totalBytes === undefined ? "" : ` · ${((p.completedBytes ?? 0) / 1048576).toFixed(1)} / ${(p.totalBytes / 1048576).toFixed(1)} MB`}`
								: progressLabel(p),
						updatedAt: Date.now(),
						progress: p,
						isManual,
					});
				},
				confirmDeletes,
				(event: SyncActivityEvent) => this.logSyncActivity(event),
				direction,
				confirmBulk,
				undefined,
				{
					isManual,
					initialSync: options.initialSync,
					fullScan: options.fullScan ?? isManual,
					scanHints,
				},
			);

			// Reaching here means remote access succeeded
			this.resetOffline();

			if (result.cancelled) {
				this.confirmationRequired = true;
				const reason = result.cancelReason ?? "Sync paused. Confirmation required.";
				this.callbacks.onLogActivity(`Sync paused: ${reason}`);
				this.publishStatus({
					kind: "warning",
					text: "Confirmation needed",
					detail: reason,
					updatedAt: Date.now(),
					isManual,
				});
				if (options.autoSync) this.resetAutoSyncBackoff();
				return { kind: "cancelled", reason };
			}

			this.resetAutoSyncBackoff();
			this.autoSyncReplanRetryCount = 0;
			this.isReplanRetryHeld = false;
			if (direction !== "pull")
				for (const [path, revision] of pendingAtStart) {
					if (this.pendingPaths.get(path) === revision) this.pendingPaths.delete(path);
				}

			const conflictCount = this.conflictCount;
			const hasConflicts = result.conflicts > 0 || conflictCount > 0;
			const effectiveConflicts = Math.max(result.conflicts, conflictCount);

			if (result.conflicts > 0) {
				const details = result.conflictCopies?.length
					? result.conflictCopies.map((c) => c.originalPath).join(", ")
					: `${result.conflicts} file(s)`;
				new Notice(
					`Filen Sync: Conflict detected in ${details} — conflict copy saved in vault. Review in sync menu.`,
					10000,
				);
				this.callbacks.onLogActivity(
					`Conflict detected: ${details} — review conflict copies in sync menu.`,
				);
			}

			if (result.applied === 0 && !hasConflicts) {
				if (isManual)
					this.callbacks.onLogActivity(
						`Sync complete: up to date${formatTimingSummary(result.timing)}`,
					);
				this.publishStatus({
					kind: this.pendingCount > 0 ? "idle" : "success",
					text: "up to date",
					detail:
						this.pendingCount > 0
							? "Local changes are queued for automatic sync."
							: "No changes detected.",
					updatedAt: Date.now(),
					isManual,
					syncCompleted: true,
				});
				return { kind: "up-to-date" };
			}

			const parts: string[] = [];
			if (result.applied > 0) parts.push(`${result.applied} applied`);
			if (effectiveConflicts > 0) parts.push(`${effectiveConflicts} conflict(s)`);
			const summary = parts.join(", ");

			this.callbacks.onLogActivity(
				`Sync complete: ${summary}${formatTimingSummary(result.timing)}`,
			);
			this.publishStatus({
				kind: hasConflicts ? "warning" : this.pendingCount > 0 ? "idle" : "success",
				text: hasConflicts ? `${effectiveConflicts} conflict(s) to review` : summary,
				detail: `${label}: ${summary}`,
				updatedAt: Date.now(),
				isManual,
				syncCompleted: true,
			});

			return {
				kind: "applied",
				applied: result.applied,
				conflicts: result.conflicts,
				uploaded: result.uploaded ?? 0,
				downloaded: result.downloaded ?? 0,
				deletedLocal: result.deletedLocal ?? 0,
				deletedRemote: result.deletedRemote ?? 0,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			this.callbacks.onLogActivity(`${label} failed: ${message}`);

			if (isNetworkClassError(error)) {
				this.consecutiveNetworkFailures += 1;
				if (this.consecutiveNetworkFailures >= 2) {
					this.setOffline(true);
				}
			} else {
				this.consecutiveNetworkFailures = 0;
			}

			const replanRace = options.autoSync && isReplanError(error);
			if (replanRace) {
				if (this.autoSyncReplanRetryCount < 3) {
					this.autoSyncReplanRetryCount += 1;
					this.pendingAutoSync = true;
					this.pendingAutoSyncRequiresFullScan = true;
					const replanBackoffMs = 1000 * Math.pow(2, this.autoSyncReplanRetryCount);
					const minGapMs = (this.settings.minimumAutoSyncIntervalSeconds ?? 10) * 1000;
					this.nextAutoSyncAllowedAt = Math.max(
						this.lastSyncStartAt + minGapMs,
						Date.now() + replanBackoffMs,
					);
					this.publishStatus({
						kind: "pending",
						text: "Sync pending",
						detail: `Changes detected during sync (${this.autoSyncReplanRetryCount}/3); retrying...`,
						updatedAt: Date.now(),
						isManual: false,
					});
					return { kind: "failed", message };
				}
				this.isReplanRetryHeld = true;
				this.publishStatus({
					kind: "error",
					text: "Sync needs review — select Sync now",
					detail: "Concurrent changes detected repeatedly. Select Sync now to resolve.",
					updatedAt: Date.now(),
					isManual: false,
				});
				this.callbacks.onLogActivity(
					"Sync held: concurrent changes detected repeatedly. Select Sync now to resolve.",
				);
				if (!Platform.isMobile) {
					this.showThrottledNotice(
						"Filen Sync: Sync needs review — select Sync now",
						false,
					);
				}
				return { kind: "failed", message };
			}

			if (options.autoSync && isTransientError(error)) {
				this.pendingAutoSync = true;
				this.bumpAutoSyncBackoff(error);
			}
			this.publishStatus({
				kind: "error",
				text: this.isReplanRetryHeld
					? "Sync needs review — select Sync now"
					: `${label} failed`,
				detail: message,
				updatedAt: Date.now(),
				isManual,
			});

			if (!options.silent) {
				new Notice(`${label} failed: ${message}`);
			} else if (options.autoSync) {
				if (!Platform.isMobile) {
					this.showThrottledNotice(`Filen auto-sync failed: ${message}`, false);
				}
			}

			console.error(`Filen Sync: ${label} failed`, error);
			if (
				message.includes("API key") ||
				message.includes("api key") ||
				message.includes("auth expired")
			) {
				this.invalidateEngine();
			}
			return { kind: "failed", message };
		} finally {
			this.isSyncing = false;
			if (this.invalidateAfterRun) {
				this.invalidateAfterRun = false;
				this.invalidateEngine();
			}
			this.runPendingAutoSync();
		}
	}

	setupAutoSync(hasSavedAuth: () => boolean): void {
		this.autoSyncHasSavedAuth = hasSavedAuth;
		const { syncOnSave, syncOnSaveDelaySeconds, syncIntervalMinutes, syncStartupDelaySeconds } =
			this.settings;

		const handleVaultChange = (action: string) => (file: TAbstractFile, oldPath?: string) => {
			this.syncEngine?.invalidateLocal(file.path);
			if (oldPath !== undefined) this.syncEngine?.invalidateLocal(oldPath);
			if (action === "deleted" || action === "renamed") {
				if (
					isConflictFilePath(file.path) ||
					(oldPath !== undefined && isConflictFilePath(oldPath))
				) {
					this.publishPending();
				}
			}
			if (!this.shouldAutoSyncForFileEvent(file, oldPath)) return;
			this.pendingPaths.set(file.path, ++this.changeRevision);
			if (oldPath !== undefined) this.pendingPaths.set(oldPath, this.changeRevision);
			this.lastEditAt = Date.now();
			if (!this.isReplanRetryHeld) {
				this.publishPending();
			}
			if (!syncOnSave || this.settings.syncPaused || this.isReplanRetryHeld) return;
			this.scheduleAutoSync(
				syncOnSaveDelaySeconds * 1000,
				hasSavedAuth,
				!(file instanceof TFile),
			);
		};
		this.vaultEventRefs.push(this.app.vault.on("modify", handleVaultChange("modified")));
		this.vaultEventRefs.push(this.app.vault.on("create", handleVaultChange("created")));
		this.vaultEventRefs.push(this.app.vault.on("delete", handleVaultChange("deleted")));
		this.vaultEventRefs.push(this.app.vault.on("rename", handleVaultChange("renamed")));

		if (this.settings.syncPaused) return;

		if (syncOnSave || syncIntervalMinutes > 0) {
			this.registerAutoSyncDomEvent(document, "visibilitychange", () => {
				if (document.visibilityState === "visible")
					this.scheduleAutoSync(1000, hasSavedAuth, true);
			});
			this.registerAutoSyncDomEvent(window, "focus", () => {
				this.scheduleAutoSync(1000, hasSavedAuth, true);
			});
			this.registerAutoSyncDomEvent(window, "online", () => {
				this.resetOffline();
				this.scheduleAutoSync(1000, hasSavedAuth, true);
			});
		}

		if (syncIntervalMinutes > 0) {
			this.intervalId = window.setInterval(
				() => {
					this.requestAutoSync(hasSavedAuth, true);
				},
				syncIntervalMinutes * 60 * 1000,
			);
		}

		if (syncStartupDelaySeconds > 0) {
			this.startupTimerId = window.setTimeout(() => {
				this.startupTimerId = null;
				this.requestAutoSync(hasSavedAuth, true);
			}, syncStartupDelaySeconds * 1000);
		}
	}

	teardownAutoSync(): void {
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
		for (const cleanup of this.autoSyncDomCleanup) cleanup();
		this.autoSyncDomCleanup = [];
		this.pendingAutoSync = false;
	}

	refreshAutoSync(hasSavedAuth: () => boolean): void {
		this.teardownAutoSync();
		this.setupAutoSync(hasSavedAuth);
		this.publishPending();
		if (this.pendingCount > 0 && !this.settings.syncPaused && this.settings.syncOnSave)
			this.scheduleAutoSync(this.settings.syncOnSaveDelaySeconds * 1000, hasSavedAuth, false);
	}

	async toggleSyncOnSave(hasSavedAuth: () => boolean): Promise<void> {
		this.settings.syncOnSave = !this.settings.syncOnSave;
		await this.callbacks.saveSettings();
		this.refreshAutoSync(hasSavedAuth);
		new Notice(`Sync on save: ${this.settings.syncOnSave ? "enabled" : "disabled"}`);
	}

	async toggleSyncPaused(hasSavedAuth: () => boolean): Promise<void> {
		this.settings.syncPaused = !this.settings.syncPaused;
		await this.callbacks.saveSettings();
		this.refreshAutoSync(hasSavedAuth);
		this.callbacks.onLogActivity(this.settings.syncPaused ? "Sync paused" : "Sync resumed");
		new Notice(`Auto-sync ${this.settings.syncPaused ? "paused" : "resumed"}.`);
	}

	private scheduleAutoSync(delayMs: number, hasSavedAuth: () => boolean, fullScan = true): void {
		if (this.isReplanRetryHeld) return;
		this.pendingAutoSync = true;
		this.pendingAutoSyncRequiresFullScan ||= fullScan;
		this.scheduleQueuedAutoSync(delayMs, hasSavedAuth);
	}

	private requestAutoSync(hasSavedAuth: () => boolean, fullScan = true): void {
		this.pendingAutoSyncRequiresFullScan ||= fullScan;
		if (this.isReplanRetryHeld) return;
		if (!this.hasAutoSyncEnabled() || this.confirmationRequired) return;
		if (!hasSavedAuth()) return;
		const browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;
		if (browserOffline) {
			if (browserOffline && !this.isOffline) {
				this.setOffline(true);
			}
			return;
		}
		if (this.isSyncing) {
			this.pendingAutoSync = true;
			return;
		}
		const editDeadline =
			this.pendingCount > 0
				? this.lastEditAt + this.settings.syncOnSaveDelaySeconds * 1000
				: 0;
		const waitMs = Math.max(this.nextAutoSyncAllowedAt, editDeadline) - Date.now();
		if (waitMs > 0) {
			this.scheduleAutoSync(waitMs, hasSavedAuth);
			return;
		}
		this.pendingAutoSync = false;
		void this.runSync("Auto-sync", "both", {
			silent: true,
			autoSync: true,
			fullScan: this.pendingAutoSyncRequiresFullScan,
		});
	}

	private runPendingAutoSync(): void {
		if (
			this.isReplanRetryHeld ||
			!this.pendingAutoSync ||
			!this.hasAutoSyncEnabled() ||
			this.autoSyncHasSavedAuth === null
		) {
			return;
		}
		this.scheduleQueuedAutoSync(
			Math.max(0, this.lastEditAt + this.settings.syncOnSaveDelaySeconds * 1000 - Date.now()),
			this.autoSyncHasSavedAuth,
		);
	}

	private scheduleQueuedAutoSync(delayMs: number, hasSavedAuth: () => boolean): void {
		if (
			this.isReplanRetryHeld ||
			!this.pendingAutoSync ||
			!this.hasAutoSyncEnabled() ||
			!hasSavedAuth() ||
			this.confirmationRequired
		)
			return;
		if (this.isSyncing) return;

		const now = Date.now();
		const cooldownDelayMs = Math.max(0, this.nextAutoSyncAllowedAt - now);
		const waitMs = Math.max(delayMs, cooldownDelayMs);
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			this.requestAutoSync(hasSavedAuth, this.pendingAutoSyncRequiresFullScan);
		}, waitMs);
	}

	private setAutoSyncCooldown(delayMs: number): void {
		this.nextAutoSyncAllowedAt = Date.now() + delayMs;
	}

	private resetAutoSyncBackoff(): void {
		this.autoSyncTransientFailureCount = 0;
		this.autoSyncReplanRetryCount = 0;
		this.nextAutoSyncAllowedAt = Math.max(
			0,
			this.lastSyncStartAt + (this.settings.minimumAutoSyncIntervalSeconds ?? 10) * 1000,
		);
	}

	private bumpAutoSyncBackoff(error: unknown): void {
		this.autoSyncTransientFailureCount += 1;
		const delayMs = getAutoSyncBackoffMs(error, this.autoSyncTransientFailureCount);
		const minGapMs = (this.settings.minimumAutoSyncIntervalSeconds ?? 10) * 1000;
		this.nextAutoSyncAllowedAt = Math.max(
			this.lastSyncStartAt + minGapMs,
			Date.now() + delayMs,
		);
	}

	private hasAutoSyncEnabled(): boolean {
		return (
			!this.settings.syncPaused &&
			(this.settings.syncOnSave ||
				this.settings.syncIntervalMinutes > 0 ||
				this.settings.syncStartupDelaySeconds > 0)
		);
	}

	private shouldAutoSyncForFileEvent(file: TAbstractFile, oldPath?: string): boolean {
		if (!(file instanceof TFile) && !(file instanceof TFolder)) return false;
		const pathFilter = createSyncPathFilter({
			configDir: this.app.vault.configDir,
			pluginId: this.pluginId,
			ignorePatterns: this.settings.ignorePatterns,
			maxFileSizeBytes: this.settings.skipLargeFiles
				? this.settings.skipSizeLargerThanMB * 1048576
				: undefined,
		});
		if (
			pathFilter.isIgnored(file.path, file instanceof TFile ? file.stat?.size : undefined) &&
			(oldPath === undefined ||
				pathFilter.isIgnored(oldPath, file instanceof TFile ? file.stat?.size : undefined))
		) {
			return false;
		}

		return true;
	}

	private registerAutoSyncDomEvent(
		target: Window | Document,
		type: string,
		listener: EventListener,
	): void {
		target.addEventListener(type, listener);
		this.autoSyncDomCleanup.push(() => target.removeEventListener(type, listener));
	}

	private logSyncActivity(event: SyncActivityEvent): void {
		switch (event.type) {
			case "connected":
				this.resetOffline();
				return;
			case "operation-complete":
				this.callbacks.onLogActivity(
					syncOperationCompleteMessage(event.operation, event.path),
				);
				return;
			case "diagnostic":
				this.callbacks.onLogActivity(event.message);
				return;
			case "accepted":
				if (event.operation === "noop" && event.path.length > 0) {
					this.callbacks.onLogActivity(event.path);
				}
				return;
			case "operation-planned":
			case "operation-start":
				return;
		}
	}
}

function isTransientError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();
	if (lower.includes("timed out") || lower.includes("request was cancelled")) return false;
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

const syncOperationCompleteMessage = (operation: SyncOperation, path: string): string => {
	switch (operation) {
		case "upload":
			return `Uploaded ${path}`;
		case "download":
			return `Downloaded ${path}`;
		case "delete-local":
			return `Deleted locally ${path}`;
		case "delete-remote":
			return `Deleted remotely ${path}`;
		case "conflict":
			return `Conflict copy created for ${path}`;
		default:
			return `Synced ${path}`;
	}
};

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

export function formatRelativeTime(epochMs: number, now = Date.now()): string {
	const diffMs = Math.max(0, now - epochMs);
	const diffSecs = Math.floor(diffMs / 1000);
	if (diffSecs < 60) return "just now";
	const diffMins = Math.floor(diffSecs / 60);
	if (diffMins === 1) return "1 minute ago";
	if (diffMins < 60) return `${diffMins} minutes ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours === 1) return "1 hour ago";
	if (diffHours < 24) return `${diffHours} hours ago`;
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays === 1) return "1 day ago";
	return `${diffDays} days ago`;
}

export function isNetworkClassError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();
	const patterns = [
		"network",
		"econnrefused",
		"econnreset",
		"etimedout",
		"enotfound",
		"timeout",
		"timed out",
		"dns",
		"socket",
		"tls",
		"offline",
		"fetch failed",
		"connection refused",
		"connection closed",
		"unreachable",
		"gateway",
		"502",
		"503",
		"504",
	];
	return patterns.some((p) => lower.includes(p));
}

function progressLabel(progress: SyncProgress): string {
	switch (progress.phase) {
		case "scanning-local":
			return "Checking local files…";
		case "scanning-remote":
			return "Checking Filen…";
		case "planning":
			return "Comparing changes…";
		case "directories":
			return "Preparing folders…";
		case "confirming":
			return "Waiting for confirmation…";
		case "transferring":
			return `${progress.operation === "upload" ? "Uploading" : progress.operation === "download" ? "Downloading" : "Applying changes"} · ${progress.current}/${progress.total}`;
		default:
			return "Syncing…";
	}
}

export function isReplanError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("Replan the sync") || message.includes("Changes detected during sync");
}
