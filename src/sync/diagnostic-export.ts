import type { DiagnosticPlanRecord } from "./diagnostic-history";
import type { ScanDiagnostics } from "./types";

export type SanitizedDiagnosticAction = {
	pathAlias: string;
	operation: string;
	reasonCode?: string;
	destinationSide?: "local" | "remote";
	isOverwrite?: boolean;
	preservesSurvivor?: boolean;
	conflictWinner?: "local" | "remote";
};

export type SanitizedDiagnosticRecord = {
	id: string;
	kind: string;
	timestamp: number;
	direction: string;
	trigger: string;
	provenance: string;
	timing: {
		totalMs: number;
		scanMs?: number;
		planMs?: number;
		transferMs?: number;
		firstTransferMs?: number;
		targetPrepMs?: number;
		eventProbeMs?: number;
		localScanMs?: number;
		baselineMs?: number;
		remoteScanMs?: number;
		equalityMs?: number;
		directoriesMs?: number;
		executeMs?: number;
	};
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
	safetyReport: {
		blocked: boolean;
		sanitizedReason?: string;
		stats: {
			localDeletes: number;
			remoteDeletes: number;
			localOverwrites: number;
			remoteOverwrites: number;
			totalDestructiveLocal: number;
			totalDestructiveRemote: number;
		};
	};
	outcome: string;
	outcomeDetail?: string;
	correlationId?: string;
	previewId?: string;
	totalActionsCount: number;
	actionsTruncated: boolean;
	actions: SanitizedDiagnosticAction[];
};

export type RedactedDiagnosticExport = {
	exportVersion: 1;
	exportedAt: string;
	recordCount: number;
	records: SanitizedDiagnosticRecord[];
};

/**
 * Sanitizes and redacts diagnostic plan records for privacy-safe export.
 * Replaces paths with stable per-export opaque aliases, masks account and target identifiers,
 * scrubs free-form strings, and excludes credentials, hashes, and file contents.
 */
export function buildRedactedDiagnosticExport(
	records: DiagnosticPlanRecord[],
): RedactedDiagnosticExport {
	const pathAliasMap = new Map<string, string>();
	let pathCounter = 1;

	const getPathAlias = (path: string): string => {
		const existing = pathAliasMap.get(path);
		if (existing !== undefined) return existing;

		const lastDot = path.lastIndexOf(".");
		const ext = lastDot > 0 ? path.slice(lastDot).toLowerCase() : "";
		// Keep safe standard extension, or generic alias
		const safeExt = /^[.][a-z0-9]{1,10}$/u.test(ext) ? ext : "";
		const alias = `file_${String(pathCounter).padStart(4, "0")}${safeExt}`;
		pathCounter += 1;
		pathAliasMap.set(path, alias);
		return alias;
	};

	const sanitizeText = (text?: string): string | undefined => {
		if (!text) return undefined;
		let sanitized = text;

		// Mask UUIDs (e.g. 8-4-4-4-12 hex or alphanumeric UUIDs)
		sanitized = sanitized.replace(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
			"[uuid-redacted]",
		);

		// Mask emails
		sanitized = sanitized.replace(
			/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g,
			"[email-redacted]",
		);

		// Replace any known real paths with their aliases
		for (const [realPath, alias] of pathAliasMap) {
			if (realPath.length > 2 && sanitized.includes(realPath)) {
				sanitized = sanitized.split(realPath).join(alias);
			}
		}

		return sanitized;
	};

	// First pass: collect aliases for all paths in actions to ensure stable mapping
	for (const record of records) {
		for (const action of record.actions) {
			getPathAlias(action.path);
		}
	}

	const sanitizedRecords: SanitizedDiagnosticRecord[] = records.map((record) => {
		const sanitizedActions: SanitizedDiagnosticAction[] = record.actions.map((action) => ({
			pathAlias: getPathAlias(action.path),
			operation: action.operation,
			reasonCode: action.reasonCode,
			destinationSide: action.destinationSide,
			isOverwrite: action.isOverwrite,
			preservesSurvivor: action.preservesSurvivor,
			conflictWinner: action.conflictWinner,
		}));

		return {
			id: record.id,
			kind: record.kind,
			timestamp: record.timestamp,
			direction: record.direction,
			trigger: record.trigger,
			provenance: record.provenance,
			timing: { ...record.timing },
			scan: record.scan,
			counts: { ...record.counts },
			destructiveStats: { ...record.destructiveStats },
			safetyReport: {
				blocked: record.safetyReport.blocked,
				sanitizedReason: sanitizeText(record.safetyReport.reason),
				stats: { ...record.safetyReport.stats },
			},
			outcome: record.outcome,
			outcomeDetail: sanitizeText(record.outcomeDetail),
			correlationId: record.correlationId,
			previewId: record.previewId,
			totalActionsCount: record.totalActionsCount,
			actionsTruncated: record.actionsTruncated,
			actions: sanitizedActions,
		};
	});

	return {
		exportVersion: 1,
		exportedAt: new Date().toISOString(),
		recordCount: sanitizedRecords.length,
		records: sanitizedRecords,
	};
}
