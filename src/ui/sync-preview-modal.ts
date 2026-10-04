import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import type FilenSyncPlugin from "../main";
import { getDirectionExplanation } from "../sync/direction-explanation";
import type {
	PlannedAction,
	SyncDirection,
	SyncPreviewResult,
	TargetIdentityInfo,
} from "../sync/types";

const ITEMS_PER_PAGE = 50;

export class SyncPreviewModal extends Modal {
	private direction: SyncDirection;
	private currentPreview: SyncPreviewResult | null = null;
	private isLoading = false;
	private errorMessage: string | null = null;
	private activeFilter: "all" | "upload" | "download" | "delete" | "conflict" = "all";
	private searchQuery = "";
	private currentPage = 1;
	private targetInfo: TargetIdentityInfo | null = null;
	private renewedReviewNeeded = false;
	private renewedPlanDifference = "";

	constructor(
		app: App,
		private readonly plugin: FilenSyncPlugin,
		initialDirection: SyncDirection = "both",
	) {
		super(app);
		this.direction = initialDirection;
	}

	async onOpen(): Promise<void> {
		this.containerEl.addClass("filen-sync-preview-modal-container");
		this.plugin.setPreviewActive(true);
		await this.loadPreview();
	}

	onClose(): void {
		this.contentEl.empty();
		this.plugin.setPreviewActive(false);
	}

	private async loadPreview(): Promise<void> {
		this.isLoading = true;
		this.errorMessage = null;
		this.renewedReviewNeeded = false;
		this.render();

		try {
			await this.plugin.prepareSyncTarget(false, { readOnly: true });
			this.targetInfo = await this.plugin.getTargetIdentityInfo(true);
			this.currentPreview = await this.plugin.generatePreview(
				this.direction,
				this.targetInfo,
			);
			this.currentPage = 1;
		} catch (error) {
			this.errorMessage =
				error instanceof Error ? error.message : "Failed to generate preview.";
			this.currentPreview = null;
		} finally {
			this.isLoading = false;
			this.render();
		}
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass("filen-sync-preview-modal");

		// Header
		const headerEl = this.contentEl.createDiv({ cls: "filen-preview-header" });
		headerEl.createEl("h2", { text: "Preview sync changes" });
		const noticeEl = headerEl.createEl("p", {
			cls: "filen-preview-proposed-notice",
			text: "Proposed work (read-only preview — no changes applied to vault or Filen).",
		});
		noticeEl.style.color = "var(--text-muted)";
		noticeEl.style.fontSize = "0.9em";

		if (this.isLoading) {
			const loadingDiv = this.contentEl.createDiv({ cls: "filen-preview-loading" });
			loadingDiv.style.textAlign = "center";
			loadingDiv.style.padding = "40px 20px";
			loadingDiv.createEl("p", {
				text: "Scanning vault and Filen for changes (read-only equality verification)…",
			});
			return;
		}

		if (this.errorMessage) {
			const errorDiv = this.contentEl.createDiv({ cls: "filen-preview-error mod-warning" });
			errorDiv.style.padding = "20px";
			errorDiv.style.border = "1px solid var(--text-error)";
			errorDiv.style.borderRadius = "8px";
			errorDiv.style.marginBottom = "20px";

			errorDiv.createEl("h3", { text: "Preview unavailable", cls: "text-error" });
			errorDiv.createEl("p", { text: this.errorMessage });
			errorDiv.createEl("p", {
				cls: "text-muted",
				text: "No files or remote folders were modified. Verify your connection, credentials, or target folder.",
			});

			const btnBar = this.contentEl.createDiv({ cls: "modal-button-container" });
			const closeBtn = btnBar.createEl("button", { text: "Close" });
			closeBtn.onClickEvent(() => this.close());
			const retryBtn = btnBar.createEl("button", { text: "Retry", cls: "mod-cta" });
			retryBtn.onClickEvent(() => void this.loadPreview());
			return;
		}

		if (!this.currentPreview) return;

		// Verified Target & Freshness
		const metaBar = this.contentEl.createDiv({ cls: "filen-preview-meta-bar" });
		metaBar.style.padding = "8px 12px";
		metaBar.style.background = "var(--background-secondary)";
		metaBar.style.borderRadius = "6px";
		metaBar.style.marginBottom = "14px";
		metaBar.style.fontSize = "0.85em";

		const inspectedTime = new Date(this.currentPreview.createdAt).toLocaleTimeString();
		metaBar.createEl("div", {
			text: `Target: ${this.currentPreview.target.remoteRoot} (Account user #${this.currentPreview.target.userId}) · Inspected at ${inspectedTime} · Provenance: ${this.currentPreview.provenance} scan`,
		});

		// Direction Selector
		const dirContainer = this.contentEl.createDiv({ cls: "filen-preview-direction-container" });
		dirContainer.style.marginBottom = "14px";
		dirContainer.createEl("span", { text: "Direction: ", cls: "text-muted" });

		const directions: Array<{ id: SyncDirection; label: string }> = [
			{ id: "both", label: "Two-way (both)" },
			{ id: "push", label: "Push (local → Filen)" },
			{ id: "pull", label: "Pull (Filen → local)" },
		];

		const dirButtonGroup = dirContainer.createDiv({ cls: "filen-preview-dir-buttons" });
		dirButtonGroup.style.display = "inline-flex";
		dirButtonGroup.style.gap = "6px";
		dirButtonGroup.style.marginLeft = "8px";

		for (const d of directions) {
			const btn = dirButtonGroup.createEl("button", {
				text: d.label,
				cls: this.direction === d.id ? "mod-cta" : "",
			});
			btn.onClickEvent(() => {
				if (this.direction !== d.id) {
					this.direction = d.id;
					void this.loadPreview();
				}
			});
		}

		// Direction Explanation Box
		const explanation = getDirectionExplanation(this.direction);
		const explainBox = this.contentEl.createDiv({ cls: "filen-preview-explain-box" });
		explainBox.style.padding = "10px 14px";
		explainBox.style.background = "var(--background-secondary-alt)";
		explainBox.style.borderLeft = "3px solid var(--interactive-accent)";
		explainBox.style.borderRadius = "4px";
		explainBox.style.marginBottom = "14px";
		explainBox.style.fontSize = "0.85em";

		explainBox.createEl("strong", { text: explanation.summary });
		const detailsList = explainBox.createEl("ul");
		detailsList.style.margin = "6px 0 0 16px";
		detailsList.style.padding = "0";
		for (const detail of explanation.details) {
			detailsList.createEl("li", { text: detail });
		}

		// Renewed Review Warning (if fresh plan changed on Apply attempt)
		if (this.renewedReviewNeeded) {
			const renewedWarn = this.contentEl.createDiv({ cls: "filen-preview-renewed-warning" });
			renewedWarn.style.padding = "12px";
			renewedWarn.style.background = "var(--background-modifier-error)";
			renewedWarn.style.borderRadius = "6px";
			renewedWarn.style.marginBottom = "14px";
			renewedWarn.style.border = "1px solid var(--text-error)";

			renewedWarn.createEl("strong", {
				text: "⚠️ Vault or remote state changed since your preview!",
				cls: "text-error",
			});
			renewedWarn.createEl("p", {
				text:
					this.renewedPlanDifference ||
					"A fresh plan has been prepared. Please review the updated proposed actions before applying.",
				cls: "text-error",
			});
		}

		// Safety Guard Warning (if blocked)
		if (this.currentPreview.safetyReport.blocked) {
			const safetyWarn = this.contentEl.createDiv({ cls: "filen-preview-safety-warning" });
			safetyWarn.style.padding = "12px";
			safetyWarn.style.background = "var(--background-modifier-error)";
			safetyWarn.style.borderRadius = "6px";
			safetyWarn.style.marginBottom = "14px";
			safetyWarn.style.border = "1px solid var(--text-error)";

			safetyWarn.createEl("strong", {
				text: `⚠️ Safety warning: ${this.currentPreview.safetyReport.reason}`,
				cls: "text-error",
			});

			const stats = this.currentPreview.destructiveStats;
			const statsList = safetyWarn.createEl("ul");
			statsList.style.margin = "6px 0 0 16px";
			statsList.createEl("li", {
				text: `Local files affected: ${stats.localDeletes} delete(s), ${stats.localOverwrites} overwrite(s)`,
			});
			statsList.createEl("li", {
				text: `Remote files affected: ${stats.remoteDeletes} delete(s), ${stats.remoteOverwrites} overwrite(s)`,
			});
		}

		// Aggregates & Counts
		const countsBar = this.contentEl.createDiv({ cls: "filen-preview-counts-bar" });
		countsBar.style.display = "flex";
		countsBar.style.flexWrap = "wrap";
		countsBar.style.gap = "8px";
		countsBar.style.marginBottom = "14px";

		const c = this.currentPreview.counts;
		const badges = [
			{ label: `Total actions: ${c.totalProposed}`, color: "var(--text-normal)" },
			{ label: `Uploads: ${c.upload}`, color: "var(--text-accent)" },
			{ label: `Downloads: ${c.download}`, color: "var(--text-accent)" },
			{
				label: `Local deletes: ${c.deleteLocal}`,
				color: c.deleteLocal > 0 ? "var(--text-error)" : "var(--text-muted)",
			},
			{
				label: `Remote deletes: ${c.deleteRemote}`,
				color: c.deleteRemote > 0 ? "var(--text-error)" : "var(--text-muted)",
			},
			{
				label: `Conflicts: ${c.conflict}`,
				color: c.conflict > 0 ? "var(--text-warning)" : "var(--text-muted)",
			},
			{ label: `Unchanged: ${c.noop}`, color: "var(--text-muted)" },
		];

		for (const b of badges) {
			const badge = countsBar.createSpan({ text: b.label });
			badge.style.padding = "3px 8px";
			badge.style.background = "var(--background-secondary)";
			badge.style.borderRadius = "12px";
			badge.style.fontSize = "0.85em";
			badge.style.color = b.color;
		}

		// Exclusions info
		if (this.currentPreview.exclusions.totalExcluded > 0) {
			const excl = this.currentPreview.exclusions;
			const exclDiv = this.contentEl.createDiv({
				cls: "filen-preview-exclusions text-muted",
			});
			exclDiv.style.fontSize = "0.85em";
			exclDiv.style.marginBottom = "12px";
			exclDiv.setText(
				`ℹ️ Excluded files: ${excl.ignoredCount} by ignore patterns, ${excl.tooLargeCount} by file size limit.`,
			);
		}

		// Filter bar & Search
		const filterRow = this.contentEl.createDiv({ cls: "filen-preview-filter-row" });
		filterRow.style.display = "flex";
		filterRow.style.justifyContent = "space-between";
		filterRow.style.alignItems = "center";
		filterRow.style.marginBottom = "10px";

		const filterButtons = filterRow.createDiv({ cls: "filen-preview-filter-buttons" });
		filterButtons.style.display = "flex";
		filterButtons.style.gap = "4px";

		const filters: Array<{
			id: "all" | "upload" | "download" | "delete" | "conflict";
			label: string;
		}> = [
			{ id: "all", label: `All (${c.totalProposed})` },
			{ id: "upload", label: `Uploads (${c.upload})` },
			{ id: "download", label: `Downloads (${c.download})` },
			{ id: "delete", label: `Deletes (${c.deleteLocal + c.deleteRemote})` },
			{ id: "conflict", label: `Conflicts (${c.conflict})` },
		];

		for (const f of filters) {
			const btn = filterButtons.createEl("button", {
				text: f.label,
				cls: this.activeFilter === f.id ? "mod-cta" : "",
			});
			btn.style.fontSize = "0.8em";
			btn.style.padding = "2px 8px";
			btn.onClickEvent(() => {
				this.activeFilter = f.id;
				this.currentPage = 1;
				this.render();
			});
		}

		const searchInput = filterRow.createEl("input", {
			type: "search",
			placeholder: "Filter paths…",
			value: this.searchQuery,
		});
		searchInput.style.fontSize = "0.85em";
		searchInput.style.padding = "3px 8px";
		searchInput.addEventListener("input", (e) => {
			this.searchQuery = (e.target as HTMLInputElement).value;
			this.currentPage = 1;
			this.render();
		});

		// Filter actions list
		const allActions = this.currentPreview.actions.filter((a) => a.operation !== "noop");
		const filteredActions = allActions.filter((a) => {
			if (this.activeFilter === "upload" && a.operation !== "upload") return false;
			if (this.activeFilter === "download" && a.operation !== "download") return false;
			if (
				this.activeFilter === "delete" &&
				a.operation !== "delete-local" &&
				a.operation !== "delete-remote"
			)
				return false;
			if (this.activeFilter === "conflict" && a.operation !== "conflict") return false;
			if (this.searchQuery.trim().length > 0) {
				const query = this.searchQuery.toLowerCase();
				return (
					a.path.toLowerCase().includes(query) || a.detail.toLowerCase().includes(query)
				);
			}
			return true;
		});

		// Action list container (scrollable, bounded)
		const listContainer = this.contentEl.createDiv({ cls: "filen-preview-list-container" });
		listContainer.style.maxHeight = "320px";
		listContainer.style.overflowY = "auto";
		listContainer.style.border = "1px solid var(--background-modifier-border)";
		listContainer.style.borderRadius = "6px";
		listContainer.style.marginBottom = "14px";

		if (filteredActions.length === 0) {
			const emptyP = listContainer.createEl("p", {
				text:
					allActions.length === 0
						? "No changes needed. Vault and Filen are up to date."
						: "No actions match the current filter.",
				cls: "text-muted",
			});
			emptyP.style.textAlign = "center";
			emptyP.style.padding = "24px 12px";
		} else {
			const totalPages = Math.ceil(filteredActions.length / ITEMS_PER_PAGE);
			const startIndex = (this.currentPage - 1) * ITEMS_PER_PAGE;
			const pageActions = filteredActions.slice(startIndex, startIndex + ITEMS_PER_PAGE);

			const table = listContainer.createEl("table");
			table.style.width = "100%";
			table.style.borderCollapse = "collapse";
			table.style.fontSize = "0.85em";

			for (const action of pageActions) {
				const row = table.createEl("tr");
				row.style.borderBottom = "1px solid var(--background-modifier-border)";

				const opCell = row.createEl("td");
				opCell.style.padding = "6px 8px";
				opCell.style.whiteSpace = "nowrap";
				opCell.style.width = "110px";

				const opBadge = opCell.createSpan({ text: this.formatOperationBadge(action) });
				opBadge.style.padding = "2px 6px";
				opBadge.style.borderRadius = "4px";
				opBadge.style.fontSize = "0.85em";
				this.styleOperationBadge(opBadge, action);

				const pathCell = row.createEl("td");
				pathCell.style.padding = "6px 8px";
				const pathSpan = pathCell.createEl("div", { text: action.path });
				pathSpan.style.wordBreak = "break-all";

				const reasonSpan = pathCell.createEl("div", {
					text: action.detail,
					cls: "text-muted",
				});
				reasonSpan.style.fontSize = "0.85em";
				reasonSpan.style.marginTop = "2px";
			}

			// Pagination footer if > 1 page
			if (totalPages > 1) {
				const pager = this.contentEl.createDiv({ cls: "filen-preview-pagination" });
				pager.style.display = "flex";
				pager.style.justifyContent = "space-between";
				pager.style.alignItems = "center";
				pager.style.marginBottom = "14px";
				pager.style.fontSize = "0.85em";

				pager.createSpan({
					text: `Showing ${startIndex + 1}–${Math.min(startIndex + ITEMS_PER_PAGE, filteredActions.length)} of ${filteredActions.length} actions`,
				});

				const navBtns = pager.createDiv();
				const prevBtn = navBtns.createEl("button", { text: "Previous" });
				prevBtn.disabled = this.currentPage <= 1;
				prevBtn.onClickEvent(() => {
					if (this.currentPage > 1) {
						this.currentPage -= 1;
						this.render();
					}
				});

				const nextBtn = navBtns.createEl("button", { text: "Next" });
				nextBtn.style.marginLeft = "6px";
				nextBtn.disabled = this.currentPage >= totalPages;
				nextBtn.onClickEvent(() => {
					if (this.currentPage < totalPages) {
						this.currentPage += 1;
						this.render();
					}
				});
			}
		}

		// Modal Buttons (Footer)
		const footer = this.contentEl.createDiv({ cls: "modal-button-container" });

		const dismissBtn = footer.createEl("button", { text: "Dismiss" });
		dismissBtn.onClickEvent(() => this.close());

		const refreshBtn = footer.createEl("button", { text: "Refresh" });
		refreshBtn.onClickEvent(() => void this.loadPreview());

		const applyBtn = footer.createEl("button", {
			text: this.renewedReviewNeeded ? "Confirm and Apply" : "Apply changes",
			cls: this.currentPreview.safetyReport.blocked ? "mod-warning" : "mod-cta",
		});
		applyBtn.disabled = this.currentPreview.counts.totalProposed === 0;
		applyBtn.onClickEvent(() => void this.handleApply());
	}

	private formatOperationBadge(action: PlannedAction): string {
		switch (action.operation) {
			case "upload":
				return action.isOverwrite ? "Upload (overwrite)" : "Upload";
			case "download":
				return action.isOverwrite ? "Download (overwrite)" : "Download";
			case "delete-local":
				return "Delete local";
			case "delete-remote":
				return "Delete remote";
			case "conflict":
				return action.preservesSurvivor
					? "Preserve survivor"
					: `Conflict (${action.conflictWinner ?? "local"} wins)`;
			default:
				return action.operation;
		}
	}

	private styleOperationBadge(el: HTMLElement, action: PlannedAction): void {
		if (action.operation === "delete-local" || action.operation === "delete-remote") {
			el.style.background = "var(--background-modifier-error)";
			el.style.color = "var(--text-error)";
		} else if (action.operation === "conflict") {
			el.style.background = "var(--background-modifier-warning)";
			el.style.color = "var(--text-warning)";
		} else if (action.isOverwrite) {
			el.style.background = "var(--background-modifier-warning)";
			el.style.color = "var(--text-warning)";
		} else {
			el.style.background = "var(--background-secondary)";
			el.style.color = "var(--text-accent)";
		}
	}

	/**
	 * Fresh plan apply with renewed review detection (Ticket 07).
	 * Never sends stale preview actions directly to execution.
	 */
	private async handleApply(): Promise<void> {
		if (!this.currentPreview || !this.targetInfo) return;

		this.isLoading = true;
		this.render();

		try {
			// Fresh target preparation and planning check
			await this.plugin.prepareSyncTarget(false);
			const freshTarget = await this.plugin.getTargetIdentityInfo(false);

			// Check if target identity changed
			const targetChanged =
				freshTarget.userId !== this.targetInfo.userId ||
				freshTarget.rootUuid !== this.targetInfo.rootUuid ||
				freshTarget.vaultId !== this.targetInfo.vaultId;

			if (targetChanged) {
				this.targetInfo = freshTarget;
				this.currentPreview = await this.plugin.generatePreview(
					this.direction,
					freshTarget,
				);
				this.renewedReviewNeeded = true;
				this.renewedPlanDifference =
					"Target folder identity changed. Please review the updated plan.";
				this.isLoading = false;
				this.render();
				return;
			}

			// Generate fresh plan to compare against reviewed preview
			const freshPreview = await this.plugin.generatePreview(this.direction, freshTarget);

			// Compare plan actions
			const reviewedActions = this.currentPreview.actions.filter(
				(a: PlannedAction) => a.operation !== "noop",
			);
			const freshActions = freshPreview.actions.filter(
				(a: PlannedAction) => a.operation !== "noop",
			);

			let planChanged = reviewedActions.length !== freshActions.length;
			if (!planChanged) {
				const freshActionMap = new Map<string, PlannedAction>(
					freshActions.map((a: PlannedAction) => [a.path, a]),
				);
				for (const reviewed of reviewedActions) {
					const fresh = freshActionMap.get(reviewed.path);
					if (
						!fresh ||
						fresh.operation !== reviewed.operation ||
						fresh.isOverwrite !== reviewed.isOverwrite ||
						fresh.conflictWinner !== reviewed.conflictWinner
					) {
						planChanged = true;
						break;
					}
				}
			}

			// If plan changed and user hasn't already accepted the renewed review
			if (planChanged && !this.renewedReviewNeeded) {
				this.currentPreview = freshPreview;
				this.renewedReviewNeeded = true;
				this.renewedPlanDifference = `Proposed actions changed since your preview (${reviewedActions.length} previously, now ${freshActions.length}). Please review before proceeding.`;
				this.isLoading = false;
				this.render();
				return;
			}

			// User confirmed or plan matches: close preview and execute fresh sync run
			this.close();
			const result = await this.plugin.runApplySync(this.direction);

			if (result.kind === "applied") {
				new Notice(`Applied preview: ${result.applied} file(s) synced.`);
			} else if (result.kind === "up-to-date") {
				new Notice("Files are up to date.");
			} else if (result.kind === "cancelled") {
				new Notice(`Sync cancelled: ${result.reason}`);
			} else if (result.kind === "failed") {
				new Notice(`Sync failed: ${result.message}`);
			}
		} catch (error) {
			this.errorMessage = error instanceof Error ? error.message : "Apply failed.";
			this.isLoading = false;
			this.render();
		}
	}
}
