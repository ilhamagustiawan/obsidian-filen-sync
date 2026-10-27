import type { BulkGuardReport } from "./bulk-guard";
import type { SyncProgress, TargetIdentityInfo } from "./types";

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

export type CoordinatorCallbacks = {
	onStatusChange: (state: StatusBarState) => void;
	onReviewConflicts?: () => void;
	onOpeningCheckChange?: (state: OpeningCheckState) => void;
	getAutoSyncBlockReason?: () => string | null;
	onLogActivity: (message: string) => void;
	confirmLocalDeletes: (paths: string[]) => Promise<boolean>;
	confirmBulkOperations: (report: BulkGuardReport) => Promise<boolean>;
	saveSettings: () => Promise<void>;
	prepareTarget?: (options?: { readOnly?: boolean }) => Promise<void>;
	getTargetInfo?: (noCreate?: boolean) => Promise<TargetIdentityInfo>;
};

export type OpeningCheckState =
	| { kind: "scheduled"; scheduledAt: number }
	| { kind: "cleared" }
	| { kind: "blocked"; text: string };

export type CoordinatorRunOptions = {
	silent?: boolean;
	autoSync?: boolean;
	isManual?: boolean;
	initialSync?: boolean;
	fullScan?: boolean;
	correlationId?: string;
	previewId?: string;
};
