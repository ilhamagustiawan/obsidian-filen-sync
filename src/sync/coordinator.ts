import { selectedSettingsPaths } from "./settings-paths";
import { LocalEditPendingError } from "./local-edit-pending";
import type { App, EventRef, TAbstractFile } from "obsidian";
import { Notice, Platform, TFile, TFolder } from "obsidian";
import type { SyncDb } from "../db";
import type { ConflictRecord, ConflictResolution } from "./conflict-types";
import type { ConflictContext } from "./conflict-store";
import {
	applyConflictResolution,
	captureReviewedLegacyConflict,
	loadConflictForReview,
} from "./conflict-review";
import type { FilenRemoteFs } from "../fs-remote";
import type { FilenSyncSettings } from "../settings";
import { LOCAL_HASH_CACHE_TTL_MS } from "./local-hash-cache";
import { createDefaultHashingPool, HASH_POOL_ENABLED, SyncEngine } from "../sync-engine";
import type { BulkGuardReport, BulkGuardThresholds } from "./bulk-guard";
import { getOriginalPathFromConflictPath, isConflictFilePath } from "./conflict-utils";
import { saveDiagnosticRecord, truncateActionsIfNeeded } from "./diagnostic-history";
import type {
	CoordinatorCallbacks,
	CoordinatorRunOptions,
	StatusBarState,
	SyncRunResult,
} from "./coordinator-types";
import {
	getAutoSyncBackoffMs,
	isNetworkClassError,
	isReplanError,
	isTransientError,
} from "./sync-errors";
import { derivePendingStatus } from "./pending-status";
import {
	formatTimingSummary,
	progressDetail,
	progressLabel,
	syncOperationCompleteMessage,
} from "./sync-status-format";
import { buildSyncFailureRecord, buildSyncSuccessRecord } from "./sync-diagnostic-records";
import { shouldAutoSyncForFileEvent, updateConflictIndex } from "./vault-change-events";
import type {
	SyncActivityEvent,
	SyncDirection,
	SyncPreviewResult,
	SyncProgress,
	SyncTimingSummary,
	TargetIdentityInfo,
} from "./types";

export type {
	CoordinatorCallbacks,
	OpeningCheckState,
	StatusBarKind,
	StatusBarState,
	SyncRunResult,
} from "./coordinator-types";
export { isNetworkClassError, isReplanError } from "./sync-errors";
export { formatRelativeTime } from "./sync-status-format";

const ERROR_NOTICE_THROTTLE_MS = 15 * 60_000;
/** A resume trigger that close to a successful reconciliation is coalesced away. */
const RESUME_RECONCILE_SKIP_MS = 60_000;

export class SyncCoordinator {
	private isSyncing = false;
	private conflictsIndex: Map<string, TFile> | null = null;
	private managedConflicts = new Map<string, ConflictRecord>();
	private conflictTargetKey: string | undefined;
	private savedNewConflicts = false;
	private isPreviewActive = false;
	private conflictReviewActive = false;
	private closed = false;
	private conflictWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
	private isOffline = false;
	private consecutiveNetworkFailures = 0;
	private lastErrorNoticeTime = new Map<string, number>();
	private debounceTimer: number | null = null;
	private intervalId: number | null = null;
	private startupInitialized = false;
	private openingCheckPending = false;
	private vaultEventRefs: EventRef[] = [];
	private autoSyncDomCleanup: (() => void)[] = [];
	private pendingAutoSync = false;
	private nextAutoSyncAllowedAt = 0;
	private lastSyncStartAt = 0;
	private pendingAutoSyncRequiresFullScan = false;
	private lastSuccessfulAutoSyncAt: number | null = null;
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
		if (this.conflictsIndex === null)
			this.conflictsIndex = new Map(
				(this.app.vault.getFiles?.() ?? [])
					.filter((f) => isConflictFilePath(f.path))
					.map((f) => [f.path, f]),
			);
		return [...this.conflictsIndex.values()];
	}

	get conflictCount(): number {
		return new Set([
			...this.getConflictFiles().map((file) => getOriginalPathFromConflictPath(file.path)),
			...this.getManagedConflicts().map((record) => record.path),
		]).size;
	}
	getManagedConflicts(): ConflictRecord[] {
		if (this.conflictTargetKey !== this.getDb()?.targetKey) return [];
		return [...this.managedConflicts.values()];
	}
	async refreshConflicts(): Promise<void> {
		const db = this.getDb();
		const records = (await db?.getConflicts?.()) ?? new Map<string, ConflictRecord>();
		if (db !== this.getDb()) return;
		if (
			this.isSyncing &&
			[...records].some(
				([path, record]) => this.managedConflicts.get(path)?.revision !== record.revision,
			)
		)
			this.savedNewConflicts = true;
		this.managedConflicts = records;
		this.conflictTargetKey = db?.targetKey;
		this.publishPending();
	}
	private conflictContext(db: SyncDb): ConflictContext {
		const remote = this.getRemoteFs();
		return {
			app: this.app,
			db,
			remote,
			pluginId: this.pluginId,
			verifyTarget: async () => {
				await this.callbacks.prepareTarget?.();
				if (this.getDb()?.targetKey !== db.targetKey || this.getRemoteFs() !== remote)
					throw new Error("Sync target changed; conflict application remains pending.");
			},
			selectedSettings: selectedSettingsPaths(
				this.app.vault.configDir,
				this.pluginId,
				this.settings.syncSettings,
				this.settings.selectedSettings,
			),
		};
	}
	private async conflictSession<T>(
		targetKey: string | undefined,
		work: (context: ConflictContext) => Promise<T>,
		label: string,
	): Promise<T> {
		const requestedAt = performance.now();
		await new Promise<void>((resolve, reject) => {
			if (this.closed) return reject(new Error("Sync coordinator closed."));
			this.conflictWaiters.push({ resolve, reject });
			this.startNextConflict();
		});
		const startedAt = performance.now();
		try {
			if (this.closed) throw new Error("Sync coordinator closed.");
			await this.callbacks.prepareTarget?.();
			const db = this.getDb();
			if (!db || !targetKey || db.targetKey !== targetKey)
				throw new Error("Sync target changed. Reopen conflict review.");
			return await work(this.conflictContext(db));
		} finally {
			try {
				await this.refreshConflicts();
			} finally {
				this.isSyncing = false;
				this.invalidateEngine();
				this.publishPending();
				this.startNextConflict();
				this.runPendingAutoSync();
				this.callbacks.onLogActivity(
					`${label} finished (wait ${Math.round(startedAt - requestedAt)}ms, work ${Math.round(performance.now() - startedAt)}ms)`,
				);
			}
		}
	}
	/** Reserve the operation before waking its caller, so background work cannot overtake it. */
	private startNextConflict(): void {
		if (this.closed || this.isSyncing || this.isPreviewActive) return;
		const next = this.conflictWaiters.shift();
		if (!next) return;
		this.isSyncing = true;
		next.resolve();
	}

	setConflictReviewActive(active: boolean): void {
		this.conflictReviewActive = active;
		if (!active) this.runPendingAutoSync();
	}
	async refreshConflict(path: string, targetKey: string | undefined): Promise<ConflictRecord> {
		return this.conflictSession(
			targetKey,
			(context) => loadConflictForReview(context, path),
			"Conflict review",
		);
	}
	async resolveConflict(
		resolution: ConflictResolution,
		targetKey: string | undefined,
	): Promise<void> {
		await this.conflictSession(
			targetKey,
			async (context) => {
				const record = await context.db.getConflict?.(resolution.path);
				await applyConflictResolution(context, resolution);
				for (const copy of record?.copies ?? []) this.conflictsIndex?.delete(copy.path);
				this.pendingPaths.delete(resolution.path);
				this.callbacks.onLogActivity(`Conflict resolved and synced: ${resolution.path}`);
			},
			"Conflict application",
		);
	}
	async resolveLegacyConflict(
		path: string,
		bytes: Uint8Array,
		hash: string,
		copies: Array<{ path: string; hash: string }>,
		targetKey: string | undefined,
	): Promise<void> {
		await this.conflictSession(
			targetKey,
			async (context) => {
				const reviewed = await captureReviewedLegacyConflict(context, path, hash, copies);
				await applyConflictResolution(context, {
					path,
					revision: reviewed.revision,
					bytes,
				});
				for (const copy of reviewed.copies ?? []) this.conflictsIndex?.delete(copy.path);
				this.pendingPaths.delete(path);
				this.callbacks.onLogActivity(`Legacy conflict resolved and synced: ${path}`);
			},
			"Legacy conflict application",
		);
	}

	private publishPending(): void {
		if (this.isSyncing || this.isReplanRetryHeld) return;
		const next = derivePendingStatus(this.conflictCount, this.pendingCount, this.lastStatus);
		if (next) this.publishStatus(next);
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
		this.closed = true;
		for (const waiter of this.conflictWaiters.splice(0))
			waiter.reject(new Error("Sync coordinator closed."));
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
			const context = this.conflictContext(db);
			this.syncEngine = new SyncEngine({
				app: this.app,
				db,
				pluginId: this.pluginId,
				settings: { ...this.settings, ignorePatterns: [...this.settings.ignorePatterns] },
				remote: context.remote,
				verifyTarget: context.verifyTarget,
				hashingPool: HASH_POOL_ENABLED ? createDefaultHashingPool() : undefined,
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

	get isPreviewing(): boolean {
		return this.isPreviewActive;
	}

	setPreviewActive(active: boolean, canAutoSync?: () => boolean): void {
		this.isPreviewActive = active;
		if (!active) this.startNextConflict();
		if (!active && canAutoSync) {
			const pending = this.pendingAutoSync;
			const fullScan = this.pendingAutoSyncRequiresFullScan;
			this.refreshAutoSync(canAutoSync);
			this.pendingAutoSync ||= pending;
			this.pendingAutoSyncRequiresFullScan ||= fullScan;
		}
		if (!active) this.runPendingAutoSync();
	}

	async generatePreview(
		direction: SyncDirection = "both",
		targetInfo: TargetIdentityInfo,
		onProgress?: (progress: SyncProgress) => void,
		bulkThresholds?: BulkGuardThresholds,
	): Promise<SyncPreviewResult> {
		if (this.isSyncing) {
			throw new Error("Cannot preview while sync is in progress.");
		}
		this.isPreviewActive = true;
		await this.callbacks.prepareTarget?.({ readOnly: true });
		const engine = this.getSyncEngine();
		const result = await engine.previewPlan(direction, targetInfo, onProgress, bulkThresholds);

		const { actions, truncated } = truncateActionsIfNeeded(
			result.actions.map((a) => ({
				path: a.path,
				operation: a.operation,
				reasonCode: a.reasonCode,
				detail: a.detail,
				destinationSide: a.destinationSide,
				isOverwrite: a.isOverwrite,
				preservesSurvivor: a.preservesSurvivor,
				conflictWinner: a.conflictWinner,
			})),
		);

		const previewId = `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		await saveDiagnosticRecord({
			id: previewId,
			kind: "preview",
			timestamp: result.createdAt,
			direction: result.direction,
			trigger: "manual-preview",
			target: result.target,
			provenance: result.provenance,
			timing: result.timing,
			counts: result.counts,
			destructiveStats: result.destructiveStats,
			safetyReport: result.safetyReport,
			outcome: "proposed",
			actions,
			totalActionsCount: result.actions.length,
			actionsTruncated: truncated,
		});

		return result;
	}

	async runSync(
		label: string,
		direction: SyncDirection = "both",
		options: CoordinatorRunOptions = {},
	): Promise<SyncRunResult> {
		if (this.closed) return { kind: "skipped", reason: "Sync coordinator closed." };
		if (options.autoSync && this.conflictReviewActive) {
			this.pendingAutoSync = true;
			this.pendingAutoSyncRequiresFullScan ||= options.fullScan === true;
			return { kind: "skipped", reason: "Conflict review in progress." };
		}
		if (this.isSyncing || this.isPreviewActive) {
			const reason = this.isSyncing ? "Sync already in progress." : "Preview in progress.";
			this.callbacks.onLogActivity(`${label} skipped: ${reason.toLowerCase()}`);
			if (options.autoSync) {
				this.pendingAutoSync = true;
				if (options.fullScan) this.pendingAutoSyncRequiresFullScan = true;
			}
			if (!options.silent && !this.isPreviewActive) new Notice(reason);
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
		this.clearOpeningCheck();
		if (isManual) this.callbacks.onLogActivity(`${label} started`);

		let targetInfo: TargetIdentityInfo | null = null;
		try {
			const targetPrepStart = performance.now();
			await this.callbacks.prepareTarget?.();
			await this.refreshConflicts();
			if (this.callbacks.getTargetInfo) {
				targetInfo = await this.callbacks.getTargetInfo(false);
			}
			const targetPrepMs = Math.round(performance.now() - targetPrepStart);
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
						detail: progressDetail(p),
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

			await this.refreshConflicts();
			if (result.newConflicts?.length) this.savedNewConflicts = true;
			// End-to-end elapsed time includes coordinator target preparation.
			const engineTiming = result.timing ?? { totalMs: 0 };
			const timingWithPrep: SyncTimingSummary = {
				...engineTiming,
				totalMs: engineTiming.totalMs + targetPrepMs,
				targetPrepMs: targetPrepMs > 0 ? targetPrepMs : undefined,
			};

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

			// A complete, non-cancelled run advances the successful-verification
			// timestamp; failed, skipped, and cancelled runs never do.
			this.lastSuccessfulAutoSyncAt = Date.now();
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

			if (
				result.newConflicts === undefined
					? result.conflicts > 0
					: result.newConflicts.length > 0
			) {
				const details = result.conflictCopies?.length
					? result.conflictCopies.map((c) => c.originalPath).join(", ")
					: (result.newConflicts?.join(", ") ?? `${result.conflicts} file(s)`);
				new Notice(
					`Filen Sync: Conflict detected in ${details} — files paused for review in the sync menu.`,
					10000,
				);
				this.callbacks.onLogActivity(
					`Conflict detected: ${details} — originals preserved; review in sync menu.`,
				);
			}

			if (targetInfo) {
				await saveDiagnosticRecord(
					buildSyncSuccessRecord(
						{
							direction,
							isManual,
							target: targetInfo,
							correlationId: options.correlationId,
							previewId: options.previewId,
						},
						result,
						result.provenance ?? (scanHints ? "narrow" : "full"),
						timingWithPrep,
					),
				);
			}

			if (result.applied === 0 && !hasConflicts) {
				if (isManual)
					this.callbacks.onLogActivity(
						`Sync complete: up to date${formatTimingSummary(timingWithPrep)}`,
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
				`Sync complete: ${summary}${formatTimingSummary(timingWithPrep)}`,
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

			if (targetInfo) {
				await saveDiagnosticRecord(
					buildSyncFailureRecord(
						{
							direction,
							isManual,
							target: targetInfo,
							correlationId: options.correlationId,
							previewId: options.previewId,
						},
						message,
					),
				);
			}

			if (isNetworkClassError(error)) {
				this.consecutiveNetworkFailures += 1;
				if (this.consecutiveNetworkFailures >= 2) {
					this.setOffline(true);
				}
			} else {
				this.consecutiveNetworkFailures = 0;
			}

			// Typing invalidates a snapshot; it is not a repeated remote race and
			// must not exhaust the bounded conflict/replan recovery budget.
			if (options.autoSync && error instanceof LocalEditPendingError) {
				this.pendingAutoSync = true;
				this.pendingAutoSyncRequiresFullScan = true;
				this.nextAutoSyncAllowedAt = Math.max(
					this.lastSyncStartAt +
						(this.settings.minimumAutoSyncIntervalSeconds ?? 10) * 1000,
					Date.now() + this.settings.syncOnSaveDelaySeconds * 1000,
				);
				this.publishStatus({
					kind: "pending",
					text: "Sync pending",
					detail: "Editing in progress; retrying after a pause.",
					updatedAt: Date.now(),
					isManual: false,
				});
				return { kind: "failed", message };
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
			try {
				await this.refreshConflicts();
			} catch (error) {
				this.callbacks.onLogActivity(`Could not refresh conflict status: ${String(error)}`);
			}
			this.isSyncing = false;
			if (this.savedNewConflicts) {
				this.savedNewConflicts = false;
				this.callbacks.onReviewConflicts?.();
			}
			if (this.invalidateAfterRun) {
				this.invalidateAfterRun = false;
				this.invalidateEngine();
			}
			this.startNextConflict();
			this.runPendingAutoSync();
		}
	}

	queueResolvedChange(path: string): void {
		this.syncEngine?.invalidateLocal(path);
		this.pendingPaths.set(path, ++this.changeRevision);
		this.publishPending();
		if (!this.settings.syncPaused && this.autoSyncHasSavedAuth)
			this.scheduleAutoSync(
				this.settings.syncOnSaveDelaySeconds * 1000,
				this.autoSyncHasSavedAuth,
				false,
			);
	}

	setupAutoSync(hasSavedAuth: () => boolean): void {
		this.autoSyncHasSavedAuth = hasSavedAuth;
		const startup = !this.startupInitialized;
		this.startupInitialized = true;
		const { syncOnSave, syncOnSaveDelaySeconds, syncIntervalMinutes } = this.settings;

		this.getConflictFiles();
		const handleVaultChange = (action: string) => (file: TAbstractFile, oldPath?: string) => {
			if (
				updateConflictIndex(this.conflictsIndex!, action, file, oldPath) &&
				this.isSyncing &&
				action === "created"
			)
				this.savedNewConflicts = true;

			this.syncEngine?.invalidateLocal(file.path, file instanceof TFolder);
			if (oldPath !== undefined)
				this.syncEngine?.invalidateLocal(oldPath, file instanceof TFolder);
			if (action === "deleted" || action === "renamed") {
				if (
					isConflictFilePath(file.path) ||
					(oldPath !== undefined && isConflictFilePath(oldPath))
				) {
					this.publishPending();
				}
			}
			if (!shouldAutoSyncForFileEvent(this.app, this.pluginId, this.settings, file, oldPath))
				return;
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

		if (this.settings.syncPaused) {
			if (startup) this.reportOpeningBlock(hasSavedAuth);
			return;
		}

		this.registerAutoSyncDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible") this.scheduleResumeAutoSync(hasSavedAuth);
		});
		this.registerAutoSyncDomEvent(window, "focus", () => {
			this.scheduleResumeAutoSync(hasSavedAuth);
		});
		this.registerAutoSyncDomEvent(window, "online", () => {
			this.resetOffline();
			this.scheduleReconnectAutoSync(hasSavedAuth);
		});

		if (syncIntervalMinutes > 0) {
			this.intervalId = window.setInterval(
				() => {
					this.requestAutoSync(hasSavedAuth, false);
				},
				syncIntervalMinutes * 60 * 1000,
			);
		}

		if (startup) this.scheduleOpeningCheck(hasSavedAuth);
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
		this.clearOpeningCheck();
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

	/**
	 * Resume trigger (visibility/focus) for the same app transition. Routine
	 * resume runs use the reconcile policy (no forced content verification), and
	 * duplicate triggers share one pending reconciliation.
	 */
	private scheduleResumeAutoSync(hasSavedAuth: () => boolean): void {
		if (this.isReplanRetryHeld) return;
		if (this.resumeCoalescingBlocked()) return;
		this.scheduleOpeningCheck(hasSavedAuth);
	}

	/**
	 * Reconnect recovery must never be suppressed by the resume cooldown, so
	 * offline changes are still checked. It still coalesces duplicate online
	 * events into one pending reconciliation.
	 */
	private scheduleReconnectAutoSync(hasSavedAuth: () => boolean): void {
		if (this.isReplanRetryHeld) return;
		this.scheduleOpeningCheck(hasSavedAuth, true);
	}

	private scheduleOpeningCheck(hasSavedAuth: () => boolean, recoverQueued = false): void {
		if (this.isSyncing || (this.pendingAutoSync && !recoverQueued)) return;
		if (this.reportOpeningBlock(hasSavedAuth)) return;
		this.openingCheckPending = true;
		this.pendingAutoSync = true;
		this.scheduleQueuedAutoSync(1000, hasSavedAuth);
	}

	private reportOpeningBlock(hasSavedAuth: () => boolean): boolean {
		const offline = typeof navigator !== "undefined" && navigator.onLine === false;
		const reason = this.settings.syncPaused
			? "Sync paused"
			: this.isReplanRetryHeld || this.confirmationRequired
				? "Sync needs review — select Sync now"
				: this.callbacks.getAutoSyncBlockReason?.() ||
					(!hasSavedAuth()
						? "Connect Filen to sync"
						: offline
							? "Offline — waiting for connection"
							: null);
		if (!reason) return false;
		this.openingCheckPending = false;
		this.callbacks.onOpeningCheckChange?.({ kind: "blocked", text: reason });
		return true;
	}

	private clearOpeningCheck(): void {
		if (!this.openingCheckPending) return;
		this.openingCheckPending = false;
		this.callbacks.onOpeningCheckChange?.({ kind: "cleared" });
	}

	private resumeCoalescingBlocked(): boolean {
		if (this.pendingAutoSync) return true;
		if (this.isSyncing) {
			return true;
		}
		const now = Date.now();
		const sinceSuccess =
			this.lastSuccessfulAutoSyncAt === null
				? Number.POSITIVE_INFINITY
				: now - this.lastSuccessfulAutoSyncAt;
		// Skip a resume event that arrives shortly after a successful reconciliation
		// with no queued edits while the hash evidence is still valid. Overdue
		// verification and queued edits are never skipped.
		if (
			this.pendingCount === 0 &&
			sinceSuccess < RESUME_RECONCILE_SKIP_MS &&
			sinceSuccess < LOCAL_HASH_CACHE_TTL_MS
		) {
			return true;
		}
		return false;
	}

	private requestAutoSync(hasSavedAuth: () => boolean, fullScan = true): void {
		this.pendingAutoSyncRequiresFullScan ||= fullScan;
		if (this.openingCheckPending && this.reportOpeningBlock(hasSavedAuth)) {
			this.pendingAutoSync = false;
			return;
		}
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
		if (this.isSyncing || this.isPreviewActive || this.conflictReviewActive) {
			this.pendingAutoSync = true;
			return;
		}
		const editDeadline =
			this.pendingCount > 0
				? this.lastEditAt + this.settings.syncOnSaveDelaySeconds * 1000
				: 0;
		const waitMs = Math.max(this.nextAutoSyncAllowedAt, editDeadline) - Date.now();
		if (waitMs > 0) {
			this.scheduleAutoSync(waitMs, hasSavedAuth, fullScan);
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
			this.closed ||
			this.conflictReviewActive ||
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
		if (this.isSyncing || this.isPreviewActive || this.conflictReviewActive || this.closed)
			return;

		const now = Date.now();
		const cooldownDelayMs = Math.max(0, this.nextAutoSyncAllowedAt - now);
		const waitMs = Math.max(delayMs, cooldownDelayMs);
		if (this.openingCheckPending) {
			this.callbacks.onOpeningCheckChange?.({ kind: "scheduled", scheduledAt: now + waitMs });
		}
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
		// Opening and reconnect checks remain enabled independently of optional save/interval triggers.
		return !this.settings.syncPaused;
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
