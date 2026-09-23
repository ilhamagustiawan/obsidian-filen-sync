import type { PlannedAction } from "./types";

export type BulkGuardThresholds = {
	/** Absolute number of destructive operations before requiring confirmation. Default 20. */
	maxDestructiveFiles?: number;
	/** Minimum files affected before percentage threshold applies. Default 5. */
	minPercentageFiles?: number;
	/** Percentage of destination files (0.0 to 1.0) before requiring confirmation. Default 0.20 (20%). */
	percentageThreshold?: number;
};

export type BulkGuardReport = {
	blocked: boolean;
	reason?: string;
	stats: {
		localDeletes: number;
		remoteDeletes: number;
		localOverwrites: number;
		remoteOverwrites: number;
		totalDestructiveLocal: number;
		totalDestructiveRemote: number;
	};
};

/**
 * Evaluates whether planned operations exceed safety thresholds for mass deletion or overwrites.
 *
 * Rules:
 * 1. Blocks if destructive operations on either side exceed maxDestructiveFiles (default 20).
 * 2. Blocks if destructive operations exceed percentageThreshold (default 20%) AND at least minPercentageFiles (default 5).
 * 3. Blocks if an existing populated side suddenly reports 0 files while the baseline had files.
 */
export function checkBulkGuard(
	actions: PlannedAction[],
	context: {
		totalLocalFiles: number;
		totalRemoteFiles: number;
		totalBaselineFiles: number;
	},
	thresholds: BulkGuardThresholds = {},
): BulkGuardReport {
	const maxDestructive = thresholds.maxDestructiveFiles ?? 20;
	const minPctFiles = thresholds.minPercentageFiles ?? 5;
	const pctThreshold = thresholds.percentageThreshold ?? 0.2;

	let localDeletes = 0;
	let remoteDeletes = 0;
	let localOverwrites = 0;
	let remoteOverwrites = 0;

	for (const action of actions) {
		switch (action.operation) {
			case "delete-local":
				localDeletes += 1;
				break;
			case "delete-remote":
				remoteDeletes += 1;
				break;
			case "download":
				// Overwrite if detail implies replacement
				if (
					action.detail.includes("Remote changed") ||
					action.detail.includes("overwriting")
				) {
					localOverwrites += 1;
				}
				break;
			case "upload":
				if (
					action.detail.includes("Local changed") ||
					action.detail.includes("overwriting")
				) {
					remoteOverwrites += 1;
				}
				break;
		}
	}

	const totalDestructiveLocal = localDeletes + localOverwrites;
	const totalDestructiveRemote = remoteDeletes + remoteOverwrites;

	const stats = {
		localDeletes,
		remoteDeletes,
		localOverwrites,
		remoteOverwrites,
		totalDestructiveLocal,
		totalDestructiveRemote,
	};

	// Guard against unexpectedly empty sides
	if (context.totalBaselineFiles >= 5) {
		if (context.totalLocalFiles === 0 && context.totalRemoteFiles > 0) {
			return {
				blocked: true,
				reason: `Safety guard: vault appears empty while ${context.totalRemoteFiles} files exist remotely. Refusing to delete remote files.`,
				stats,
			};
		}
		if (context.totalRemoteFiles === 0 && context.totalLocalFiles > 0) {
			return {
				blocked: true,
				reason: `Safety guard: remote folder appears empty while ${context.totalLocalFiles} files exist locally. Refusing to delete local files.`,
				stats,
			};
		}
	}

	// Absolute threshold check
	if (totalDestructiveLocal >= maxDestructive) {
		return {
			blocked: true,
			reason: `Safety guard: sync would modify or delete ${totalDestructiveLocal} local files (threshold: ${maxDestructive}).`,
			stats,
		};
	}
	if (totalDestructiveRemote >= maxDestructive) {
		return {
			blocked: true,
			reason: `Safety guard: sync would modify or delete ${totalDestructiveRemote} remote files (threshold: ${maxDestructive}).`,
			stats,
		};
	}

	// Percentage threshold check
	if (
		context.totalLocalFiles > 0 &&
		totalDestructiveLocal >= minPctFiles &&
		totalDestructiveLocal / context.totalLocalFiles >= pctThreshold
	) {
		const pct = Math.round((totalDestructiveLocal / context.totalLocalFiles) * 100);
		return {
			blocked: true,
			reason: `Safety guard: sync would modify or delete ${totalDestructiveLocal} local files (${pct}% of vault, threshold: ${Math.round(pctThreshold * 100)}%).`,
			stats,
		};
	}

	if (
		context.totalRemoteFiles > 0 &&
		totalDestructiveRemote >= minPctFiles &&
		totalDestructiveRemote / context.totalRemoteFiles >= pctThreshold
	) {
		const pct = Math.round((totalDestructiveRemote / context.totalRemoteFiles) * 100);
		return {
			blocked: true,
			reason: `Safety guard: sync would modify or delete ${totalDestructiveRemote} remote files (${pct}% of remote files, threshold: ${Math.round(pctThreshold * 100)}%).`,
			stats,
		};
	}

	return {
		blocked: false,
		stats,
	};
}
