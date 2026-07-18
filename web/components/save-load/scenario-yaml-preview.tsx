"use client";

// YAML preview + Edit-YAML mode (T17 repair; prototype ScreenSaveLoad.dc.html:82-113,
// both the `notEditing` and `editing` branches). Presentational: the workspace
// container owns the store subscription, the `prepareExport` result, the edit
// draft, and the shared import pipeline (including the version-confirm modal
// and warnings banner). Read-only mode renders the SAME export the
// Scenario-file card acts on, so the preview, Download, and Copy can never
// disagree about whether the draft is valid. `● SAVED` is the browser
// auto-save badge (T08), independent of dirty/Copy.

import type { PrepareExportResult, ScenarioValidationIssue } from "@/lib/scenario";
import { AppVersion } from "@/components/app-version";
import { PersistenceBadge } from "@/components/shell/persistence-status";
import { Button } from "@/components/ui/button";
import { FaCodeBranch } from "@/components/icons";
import { ScenarioIssuesList } from "./scenario-issues-list";

export interface ScenarioYamlPreviewProps {
  /** The workspace's validated export — the YAML to preview, or the blocking V-issues. */
  exportResult: PrepareExportResult;
  /** `scenario.meta.apiVersion`, shown in the footer. */
  schema: string;
  editing: boolean;
  /** The workspace-owned edit draft (seeded from `exportResult` on Edit). */
  draft: string;
  /** V-issues from a failed Apply. The Upload path surfaces its own in the Scenario-file card. */
  issues: ScenarioValidationIssue[] | null;
  onDraftChange: (value: string) => void;
  onApply: () => void;
  onCancel: () => void;
}

export function ScenarioYamlPreview({
  exportResult,
  schema,
  editing,
  draft,
  issues,
  onDraftChange,
  onApply,
  onCancel,
}: ScenarioYamlPreviewProps) {
  return (
    <section
      className="flex flex-col border border-line bg-surface"
      data-testid="scenario-yaml-preview"
    >
      <div className="flex items-center justify-between border-b border-line2 px-[18px] py-4">
        <h2 className="font-heading text-cardhead font-extrabold tracking-tight">
          {editing ? "Edit YAML Configuration" : "Current state · YAML"}
        </h2>
        {!editing ? <PersistenceBadge /> : null}
      </div>

      {editing ? (
        <div className="flex flex-col gap-3 p-[18px]" data-testid="scenario-yaml-editor">
          <textarea
            data-testid="scenario-yaml-textarea"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            spellCheck={false}
            className="h-[46vh] resize-y border border-line bg-bg p-3 font-mono text-meta leading-relaxed text-ink"
          />
          {issues ? <ScenarioIssuesList issues={issues} /> : null}
          <div className="flex gap-2.5">
            <Button type="button" onClick={onApply} data-testid="yaml-apply-button">
              Apply changes
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              data-testid="yaml-cancel-button"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : exportResult.ok ? (
        <>
          <pre
            className="max-h-[56vh] flex-1 overflow-auto whitespace-pre p-[18px] font-mono text-meta leading-relaxed text-ink2"
            data-testid="scenario-yaml-content"
          >
            {exportResult.yaml}
          </pre>
          <div
            className="flex items-center gap-2 border-t border-line2 px-[18px] py-2.5 text-label font-semibold uppercase tracking-[0.03em] text-ink3"
            data-testid="scenario-version-footer"
          >
            <FaCodeBranch className="size-3" aria-hidden />
            <span>APP VERSION</span>
            <AppVersion />
            <span>· SCHEMA {schema}</span>
          </div>
        </>
      ) : (
        <div className="p-[18px]">
          <ScenarioIssuesList issues={exportResult.issues} />
        </div>
      )}
    </section>
  );
}
