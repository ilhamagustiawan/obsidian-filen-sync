import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import type FilenSyncPlugin from "../main";
import { buildRedactedDiagnosticExport } from "../sync/diagnostic-export";
import {
	clearDiagnosticRecords,
	getDiagnosticRecords,
	type DiagnosticPlanRecord,
} from "../sync/diagnostic-history";
import type { TargetIdentityInfo } from "../sync/types";

export class DiagnosticHistoryModal extends Modal {
	private records: DiagnosticPlanRecord[] = [];
	private targetInfo: TargetIdentityInfo | null = null;
	private isLoading = true;
	private selectedRecord: DiagnosticPlanRecord | null = null;

	constructor(
		app: App,
		private readonly plugin: FilenSyncPlugin,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.containerEl.addClass("filen-diagnostic-history-modal-container");
		await this.loadRecords();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async loadRecords(): Promise<void> {
		this.isLoading = true;
		this.render();

		try {
			this.targetInfo = await this.plugin.getTargetIdentityInfo(true);
			this.records = await getDiagnosticRecords(this.targetInfo);
		} catch (error) {
			console.warn("Failed to load diagnostic records", error);
			this.records = [];
		} finally {
			this.isLoading = false;
			this.render();
		}
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass("filen-diagnostic-history-modal");

		// Header
		const headerEl = this.contentEl.createDiv({ cls: "filen-history-header" });
		headerEl.createEl("h2", { text: "Diagnostic plan history" });
		headerEl.createEl("p", {
			cls: "text-muted",
			text: "Recent sync plans and previews are retained locally (latest 20 runs within 24 hours). Diagnostics contain file paths until cleared or expired. No credentials, encryption keys, or note contents are stored.",
		});

		if (this.isLoading) {
			const loadingDiv = this.contentEl.createDiv();
			loadingDiv.style.textAlign = "center";
			loadingDiv.style.padding = "30px";
			loadingDiv.createEl("p", { text: "Loading diagnostic history…" });
			return;
		}

		if (this.records.length === 0) {
			const emptyDiv = this.contentEl.createDiv();
			emptyDiv.style.textAlign = "center";
			emptyDiv.style.padding = "30px 10px";
			emptyDiv.createEl("p", {
				text: "No recent diagnostic plan history recorded for this target.",
			});

			const btnBar = this.contentEl.createDiv({ cls: "modal-button-container" });
			const closeBtn = btnBar.createEl("button", { text: "Close" });
			closeBtn.onClickEvent(() => this.close());
			return;
		}

		// Records Table / List
		const tableContainer = this.contentEl.createDiv();
		tableContainer.style.maxHeight = "360px";
		tableContainer.style.overflowY = "auto";
		tableContainer.style.border = "1px solid var(--background-modifier-border)";
		tableContainer.style.borderRadius = "6px";
		tableContainer.style.marginBottom = "14px";

		const table = tableContainer.createEl("table");
		table.style.width = "100%";
		table.style.borderCollapse = "collapse";
		table.style.fontSize = "0.85em";

		// Table Header
		const thead = table.createEl("thead");
		const headerRow = thead.createEl("tr");
		headerRow.style.borderBottom = "2px solid var(--background-modifier-border)";
		headerRow.style.background = "var(--background-secondary)";

		const cols = ["Time", "Type", "Direction", "Trigger", "Proposed", "Outcome"];
		for (const col of cols) {
			const th = headerRow.createEl("th", { text: col });
			th.style.padding = "6px 8px";
			th.style.textAlign = "left";
		}

		// Table Body
		const tbody = table.createEl("tbody");
		for (const record of this.records) {
			const row = tbody.createEl("tr");
			row.style.borderBottom = "1px solid var(--background-modifier-border)";
			row.style.cursor = "pointer";

			const timeStr = new Date(record.timestamp).toLocaleTimeString();
			const tdTime = row.createEl("td", { text: timeStr });
			tdTime.style.padding = "6px 8px";
			tdTime.style.whiteSpace = "nowrap";

			const tdKind = row.createEl("td");
			tdKind.style.padding = "6px 8px";
			const kindBadge = tdKind.createSpan({ text: record.kind.toUpperCase() });
			kindBadge.style.padding = "2px 5px";
			kindBadge.style.borderRadius = "3px";
			kindBadge.style.fontSize = "0.8em";
			if (record.kind === "preview") {
				kindBadge.style.background = "var(--background-secondary)";
				kindBadge.style.color = "var(--text-accent)";
			} else {
				kindBadge.style.background = "var(--interactive-accent)";
				kindBadge.style.color = "var(--text-on-accent)";
			}

			const tdDir = row.createEl("td", { text: record.direction });
			tdDir.style.padding = "6px 8px";

			const tdTrigger = row.createEl("td", { text: record.trigger });
			tdTrigger.style.padding = "6px 8px";
			tdTrigger.style.color = "var(--text-muted)";

			const countStr = `${record.counts.totalProposed} (${record.counts.upload}↑ ${record.counts.download}↓ ${record.counts.deleteLocal + record.counts.deleteRemote}✕)`;
			const tdCounts = row.createEl("td", { text: countStr });
			tdCounts.style.padding = "6px 8px";

			const tdOutcome = row.createEl("td");
			tdOutcome.style.padding = "6px 8px";
			const outBadge = tdOutcome.createSpan({ text: record.outcome });
			outBadge.style.padding = "2px 5px";
			outBadge.style.borderRadius = "3px";
			outBadge.style.fontSize = "0.8em";
			if (record.outcome === "success") {
				outBadge.style.color = "var(--text-success)";
			} else if (record.outcome === "failure") {
				outBadge.style.color = "var(--text-error)";
			} else if (record.outcome === "cancelled") {
				outBadge.style.color = "var(--text-warning)";
			} else {
				outBadge.style.color = "var(--text-muted)";
			}

			row.onClickEvent(() => {
				this.selectedRecord = this.selectedRecord?.id === record.id ? null : record;
				this.render();
			});
		}

		// Selected record details view
		if (this.selectedRecord) {
			const sel = this.selectedRecord;
			const detailBox = this.contentEl.createDiv({ cls: "filen-history-detail-box" });
			detailBox.style.padding = "12px";
			detailBox.style.background = "var(--background-secondary)";
			detailBox.style.borderRadius = "6px";
			detailBox.style.marginBottom = "14px";
			detailBox.style.fontSize = "0.85em";

			detailBox.createEl("h4", {
				text: `Record ${sel.id} (${sel.kind}) · ${new Date(sel.timestamp).toLocaleString()}`,
			});

			const metaP = detailBox.createEl("p", { cls: "text-muted" });
			metaP.setText(
				`Trigger: ${sel.trigger} · Mode: ${sel.provenance} · Direction: ${sel.direction} · Outcome: ${sel.outcome}`,
			);

			if (sel.scan) {
				const scanP = detailBox.createEl("p", { cls: "text-muted" });
				const fallback = sel.scan.fallbackReason
					? ` · Fallback: ${sel.scan.fallbackReason}`
					: "";
				scanP.setText(
					`Scan: ${sel.scan.mode} (${sel.scan.localReads} reads, ${sel.scan.localReadBytes}B, ${sel.scan.hashHits} hash hits, ${sel.scan.hashMisses} misses, ${sel.scan.equalityComparisons} equality checks, ${sel.scan.equalityDownloads} downloads, ${sel.scan.remoteProbes} probes, ${sel.scan.remoteRefreshes} refreshes, ${sel.scan.remoteReuses} reuses)${fallback}`,
				);
			}

			const timing = sel.timing;
			const stageParts = [
				["target prep", timing.targetPrepMs],
				["probe", timing.eventProbeMs],
				["local", timing.localScanMs],
				["baseline", timing.baselineMs],
				["remote", timing.remoteScanMs],
				["equality", timing.equalityMs],
				["plan", timing.planMs],
				["dirs", timing.directoriesMs],
				["apply", timing.executeMs],
				["transfer", timing.transferMs],
			]
				.filter(([, ms]) => typeof ms === "number" && ms > 0)
				.map(([name, ms]) => `${name} ${ms}ms`)
				.join(", ");
			const timingP = detailBox.createEl("p", { cls: "text-muted" });
			timingP.setText(
				`Elapsed ${(timing.totalMs / 1000).toFixed(1)}s · ${stageParts || "no stage timing recorded"}`,
			);

			if (sel.outcomeDetail) {
				detailBox.createEl("p", { text: `Reason / Detail: ${sel.outcomeDetail}` });
			}

			if (sel.actionsTruncated) {
				detailBox.createEl("p", {
					cls: "text-warning",
					text: `⚠️ Action list truncated: retained 5,000 of ${sel.totalActionsCount} actions. Aggregates above reflect full totals.`,
				});
			}

			if (sel.actions.length > 0) {
				const sampleActions = sel.actions.slice(0, 15);
				detailBox.createEl("strong", {
					text: `Action samples (showing ${sampleActions.length} of ${sel.actions.length}):`,
				});
				const actionUl = detailBox.createEl("ul");
				actionUl.style.margin = "4px 0 0 16px";
				for (const act of sampleActions) {
					actionUl.createEl("li", {
						text: `[${act.operation}] ${act.path} — ${act.detail}`,
					});
				}
			}
		}

		// Footer Buttons
		const footer = this.contentEl.createDiv({ cls: "modal-button-container" });

		const clearBtn = footer.createEl("button", { text: "Clear history", cls: "mod-warning" });
		clearBtn.onClickEvent(() => void this.handleClearHistory());

		const exportBtn = footer.createEl("button", {
			text: "Export redacted diagnostics",
			cls: "mod-cta",
		});
		exportBtn.onClickEvent(() => void this.handleExport());

		const closeBtn = footer.createEl("button", { text: "Close" });
		closeBtn.onClickEvent(() => this.close());
	}

	private async handleClearHistory(): Promise<void> {
		if (!this.targetInfo) return;
		await clearDiagnosticRecords(this.targetInfo);
		this.records = [];
		this.selectedRecord = null;
		new Notice("Diagnostic plan history cleared.");
		this.render();
	}

	private async handleExport(): Promise<void> {
		if (this.records.length === 0) {
			new Notice("No records to export.");
			return;
		}

		try {
			const redactedExport = buildRedactedDiagnosticExport(this.records);
			const jsonString = JSON.stringify(redactedExport, null, 2);

			// Copy to clipboard
			await navigator.clipboard.writeText(jsonString);

			// Also save to vault root for convenience
			const filename = `filen-sync-diagnostics-export-${Date.now()}.json`;
			await this.plugin.app.vault.adapter.write(filename, jsonString);

			new Notice(
				`Redacted diagnostic export copied to clipboard and saved to vault root as "${filename}". No credentials, notes, or real paths were included.`,
				8000,
			);
		} catch (error) {
			const msg = error instanceof Error ? error.message : "Export failed";
			new Notice(`Export failed: ${msg}`);
		}
	}
}
