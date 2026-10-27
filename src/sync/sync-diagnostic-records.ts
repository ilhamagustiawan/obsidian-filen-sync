import type { DiagnosticPlanRecord } from "./diagnostic-history";
import type {
	SnapshotProvenance,
	SyncDirection,
	SyncOutcome,
	SyncTimingSummary,
	TargetIdentityInfo,
} from "./types";

type SyncRecordContext = {
	direction: SyncDirection;
	isManual: boolean;
	target: TargetIdentityInfo;
	correlationId?: string;
	previewId?: string;
};

const syncRecordId = (): string => `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const syncTrigger = (context: SyncRecordContext): string =>
	context.isManual ? (context.previewId ? "apply-preview" : "manual") : "auto";

const destructiveStats = (localDeletes: number, remoteDeletes: number) => ({
	localDeletes,
	remoteDeletes,
	localOverwrites: 0,
	remoteOverwrites: 0,
	totalDestructiveLocal: localDeletes,
	totalDestructiveRemote: remoteDeletes,
});

export function buildSyncSuccessRecord(
	context: SyncRecordContext,
	result: SyncOutcome,
	provenance: SnapshotProvenance,
	timing: SyncTimingSummary,
): DiagnosticPlanRecord {
	const deletedLocal = result.deletedLocal ?? 0;
	const deletedRemote = result.deletedRemote ?? 0;
	return {
		id: syncRecordId(),
		kind: "sync",
		timestamp: Date.now(),
		direction: context.direction,
		trigger: syncTrigger(context),
		target: context.target,
		provenance,
		timing,
		scan: result.scanDiagnostics,
		counts: {
			upload: result.uploaded ?? 0,
			download: result.downloaded ?? 0,
			deleteLocal: deletedLocal,
			deleteRemote: deletedRemote,
			conflict: result.conflicts,
			noop: 0,
			totalProposed: result.applied,
		},
		destructiveStats: destructiveStats(deletedLocal, deletedRemote),
		safetyReport: {
			blocked: false,
			stats: destructiveStats(deletedLocal, deletedRemote),
		},
		outcome: result.cancelled ? "cancelled" : "success",
		outcomeDetail: result.cancelReason,
		correlationId: context.correlationId,
		previewId: context.previewId,
		actions: [],
		totalActionsCount: result.applied,
		actionsTruncated: false,
	};
}

export function buildSyncFailureRecord(
	context: SyncRecordContext,
	message: string,
): DiagnosticPlanRecord {
	return {
		id: syncRecordId(),
		kind: "sync",
		timestamp: Date.now(),
		direction: context.direction,
		trigger: syncTrigger(context),
		target: context.target,
		provenance: "full",
		timing: { totalMs: 0 },
		counts: {
			upload: 0,
			download: 0,
			deleteLocal: 0,
			deleteRemote: 0,
			conflict: 0,
			noop: 0,
			totalProposed: 0,
		},
		destructiveStats: destructiveStats(0, 0),
		safetyReport: {
			blocked: false,
			stats: destructiveStats(0, 0),
		},
		outcome: "failure",
		outcomeDetail: message,
		correlationId: context.correlationId,
		previewId: context.previewId,
		actions: [],
		totalActionsCount: 0,
		actionsTruncated: false,
	};
}
