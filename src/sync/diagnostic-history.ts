import localforage from "localforage";
import type { BulkGuardReport } from "./bulk-guard";
import type {
	ActionReasonCode,
	ScanDiagnostics,
	SnapshotProvenance,
	SyncDirection,
	SyncOperation,
	SyncTimingSummary,
	TargetIdentityInfo,
} from "./types";

export type DiagnosticActionItem = {
	path: string;
	operation: SyncOperation;
	reasonCode?: ActionReasonCode | string;
	detail: string;
	destinationSide?: "local" | "remote";
	isOverwrite?: boolean;
	preservesSurvivor?: boolean;
	conflictWinner?: "local" | "remote";
};

export type DiagnosticRecordKind = "preview" | "sync";

export type DiagnosticRunOutcome = "proposed" | "success" | "failure" | "cancelled" | "partial";

export type DiagnosticPlanRecord = {
	id: string;
	kind: DiagnosticRecordKind;
	timestamp: number;
	direction: SyncDirection;
	trigger: string;
	target: TargetIdentityInfo;
	provenance: SnapshotProvenance;
	timing: SyncTimingSummary;
	/** Actual engine scan decision; optional so older records remain readable. */
	scan?: ScanDiagnostics;
	counts: {
		upload: number;
		download: number;
		deleteLocal: number;
		deleteRemote: number;
		conflict: number;
		noop: number;
		totalProposed: number;
	};
	destructiveStats: {
		localDeletes: number;
		remoteDeletes: number;
		localOverwrites: number;
		remoteOverwrites: number;
		totalDestructiveLocal: number;
		totalDestructiveRemote: number;
	};
	safetyReport: BulkGuardReport;
	outcome: DiagnosticRunOutcome;
	outcomeDetail?: string;
	correlationId?: string;
	previewId?: string;
	actions: DiagnosticActionItem[];
	totalActionsCount: number;
	actionsTruncated: boolean;
};

const MAX_RECORDS = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ACTIONS_PER_RECORD = 5000;

function targetBindingKey(target: TargetIdentityInfo): string {
	return `${target.vaultId}:${target.userId}:${target.rootUuid}`;
}

const historyStore = localforage.createInstance({
	name: "obsidian-filen-sync-diagnostics",
	storeName: "plan-history",
});

function pruneRecords(
	records: DiagnosticPlanRecord[],
	now: number = Date.now(),
): DiagnosticPlanRecord[] {
	return records
		.filter((r) => now - r.timestamp <= MAX_AGE_MS)
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, MAX_RECORDS);
}

export function truncateActionsIfNeeded(actions: DiagnosticActionItem[]): {
	actions: DiagnosticActionItem[];
	truncated: boolean;
	totalCount: number;
} {
	const totalCount = actions.length;
	if (totalCount <= MAX_ACTIONS_PER_RECORD) {
		return { actions, truncated: false, totalCount };
	}
	return {
		actions: actions.slice(0, MAX_ACTIONS_PER_RECORD),
		truncated: true,
		totalCount,
	};
}

export async function saveDiagnosticRecord(record: DiagnosticPlanRecord): Promise<void> {
	try {
		const key = targetBindingKey(record.target);
		const existing = (await historyStore.getItem<DiagnosticPlanRecord[]>(key)) ?? [];
		const updated = pruneRecords([record, ...existing]);
		await historyStore.setItem(key, updated);
	} catch (error) {
		// History persistence failure must not invalidate the sync or preview
		console.warn("Filen Sync: failed to save diagnostic plan record", error);
	}
}

export async function getDiagnosticRecords(
	target: TargetIdentityInfo,
): Promise<DiagnosticPlanRecord[]> {
	try {
		const key = targetBindingKey(target);
		const existing = (await historyStore.getItem<DiagnosticPlanRecord[]>(key)) ?? [];
		const pruned = pruneRecords(existing);
		if (pruned.length !== existing.length) {
			await historyStore.setItem(key, pruned);
		}
		return pruned;
	} catch (error) {
		console.warn("Filen Sync: failed to load diagnostic records", error);
		return [];
	}
}

export async function clearDiagnosticRecords(target: TargetIdentityInfo): Promise<void> {
	try {
		const key = targetBindingKey(target);
		await historyStore.removeItem(key);
	} catch (error) {
		console.warn("Filen Sync: failed to clear diagnostic records", error);
	}
}

export async function updateDiagnosticRecordOutcome(
	target: TargetIdentityInfo,
	recordId: string,
	outcome: DiagnosticRunOutcome,
	outcomeDetail?: string,
): Promise<void> {
	try {
		const key = targetBindingKey(target);
		const existing = (await historyStore.getItem<DiagnosticPlanRecord[]>(key)) ?? [];
		let found = false;
		const updated = existing.map((r) => {
			if (r.id === recordId) {
				found = true;
				return { ...r, outcome, outcomeDetail: outcomeDetail ?? r.outcomeDetail };
			}
			return r;
		});
		if (found) {
			await historyStore.setItem(key, updated);
		}
	} catch (error) {
		console.warn("Filen Sync: failed to update diagnostic record outcome", error);
	}
}
