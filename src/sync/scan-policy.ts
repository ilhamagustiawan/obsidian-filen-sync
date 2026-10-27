import type { ScanPolicy, SyncRunOptions } from "./engine-types";
import type { ScanFallbackReason, ScanMode } from "./types";

export type ScanPolicyInputs = {
	syncSettings?: boolean;
	options: SyncRunOptions;
	replanAttempts: number;
	snapshotValid: boolean;
	cacheValid: boolean;
	probeHasChanges: boolean;
	probeFailed: boolean;
	probeStatus: "available" | "unsupported" | "disabled";
	hasValidFileHints: boolean;
};

export function deriveScanPolicy({
	syncSettings,
	options,
	replanAttempts,
	snapshotValid,
	cacheValid,
	probeHasChanges,
	probeFailed,
	probeStatus,
	hasValidFileHints,
}: ScanPolicyInputs): ScanPolicy {
	const isManual = options.isManual === true;
	const isInitial = options.initialSync === true;
	const forceVerified = isManual || isInitial;
	const verifyContents =
		forceVerified || options.fullScan === true || options.verifyContents === true;
	const refreshRemote =
		forceVerified || options.fullScan === true || options.refreshRemote === true;

	const narrow =
		!syncSettings &&
		!verifyContents &&
		!refreshRemote &&
		replanAttempts === 0 &&
		snapshotValid &&
		cacheValid &&
		!probeHasChanges &&
		hasValidFileHints;

	if (narrow) {
		return { mode: "narrow", verifyContents, refreshRemote, narrow: true };
	}

	const hasAnyHints = options.scanHints !== undefined && options.scanHints.length > 0;
	const folderHintsOnly = hasAnyHints && !hasValidFileHints;

	let fallbackReason: ScanFallbackReason | string | undefined;
	if (isManual) fallbackReason = "manual-sync";
	else if (isInitial) fallbackReason = "initial-sync";
	else if (replanAttempts > 0) fallbackReason = "replan";
	else if (options.verifyContents === true) fallbackReason = "explicit-verify";
	else if (options.fullScan === true || options.refreshRemote === true)
		fallbackReason = "explicit-refresh";
	else if (folderHintsOnly) fallbackReason = "folder-hints";
	else if (!hasAnyHints) fallbackReason = "missing-hints";
	else if (probeStatus === "unsupported") fallbackReason = "no-remote-event-support";
	else if (probeStatus === "disabled") fallbackReason = "fast-polling-disabled";
	else if (probeFailed) fallbackReason = "remote-probe-failed";
	else if (probeHasChanges) fallbackReason = "remote-changes-detected";
	else if (!cacheValid && !snapshotValid) fallbackReason = "cold-session";
	else if (!cacheValid) fallbackReason = "stale-remote-tree";
	else if (!snapshotValid) fallbackReason = "stale-local-snapshot";
	else fallbackReason = "ambiguous-hints";

	const mode: ScanMode = verifyContents && refreshRemote ? "full" : "reconcile";
	return { mode, fallbackReason, verifyContents, refreshRemote, narrow: false };
}
