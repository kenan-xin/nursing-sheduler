"use client";

// YAML preview + Edit-YAML mode (T17 repair; prototype ScreenSaveLoad.dc.html:82-113,
// both the `notEditing` and `editing` branches). Presentational: the workspace
// container owns the store subscription, the `prepareExport` result, the edit
// draft, and the shared import pipeline (including the version-confirm modal
// and warnings banner). Read-only mode renders the SAME export the
// Scenario-file card acts on, so the preview, Download, and Copy can never
// disagree about whether the draft is valid. `● SAVED` is the browser
// auto-save badge (T08), independent of dirty/Copy.
//
// R7 v2: an L1 card through the shared surface authority, with a hairline head
// band and a hairline-topped version footer — both single-edge full-bleed bands, so
// they stay square inside the rounded card (DESIGN.md §5).
//
// The editor textarea takes the app's canonical FIELD contract (`--r-ctl`,
// `--surface`, a `--line` hairline, and a focus treatment that reinforces the
// global brand outline), matching `components/ui/input.tsx`. This is a deliberate
// deviation from ScreenSaveLoad.dc.html:104, which authors `background:var(--bg)`:
// `--bg` is the L0 page plane, and §4 gives L0 no role as a child of an L1 card, so
// porting it literally would put an off-ladder tone inside the card. §5's radius
// table names textareas under `--r-ctl` and its Inputs section names `--surface`,
// and a DESIGN.md rule outranks a prototype example.

import type { PrepareExportResult, ScenarioValidationIssue } from "@/lib/scenario";
import { AppVersion } from "@/components/app-version";
import { PersistenceBadge } from "@/components/shell/persistence-status";
import { Button } from "@/components/ui/button";
import { surfaceVariants } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { FaCheck, FaCodeBranch } from "@/components/icons";
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
      className={cn(
        "flex min-w-0 flex-col",
        surfaceVariants({ role: "surface", geometry: "card" }),
      )}
      data-testid="scenario-yaml-preview"
    >
      {/* Head band — a single bottom edge, so it stays square inside the rounded card. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line2 px-5 py-4">
        <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
          {editing ? "Edit YAML Configuration" : "Current state · YAML"}
        </h2>
        {!editing ? <PersistenceBadge /> : null}
      </div>

      {editing ? (
        <div className="flex flex-col gap-3 px-5 py-4" data-testid="scenario-yaml-editor">
          <textarea
            data-testid="scenario-yaml-textarea"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            spellCheck={false}
            className={cn(
              "h-[46vh] w-full min-w-0 resize-y rounded-control border border-line bg-surface p-3",
              "font-mono text-meta leading-relaxed text-ink",
              "transition-[border-color,box-shadow] duration-fast",
              "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30",
            )}
          />
          {issues ? <ScenarioIssuesList issues={issues} /> : null}
          <div className="flex flex-wrap gap-2.5">
            <Button type="button" onClick={onApply} data-testid="yaml-apply-button">
              <FaCheck aria-hidden />
              Apply changes
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={onCancel}
              data-testid="yaml-cancel-button"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : exportResult.ok ? (
        <>
          {/* A code region, so it stays square and keeps `min-w-0` — a non-wrapping
              <pre> in a default `min-width:auto` item pushes the page into
              horizontal scroll instead of scrolling itself (DESIGN.md §7 note 6).

              `tabIndex={0}` because it is a SCROLLABLE region: without it the YAML
              can only be scrolled with a pointer, so a keyboard user cannot reach
              content past the fold (axe `scrollable-region-focusable`). It stays a
              plain <pre> — no role change — and the touch-target selector does not
              claim `[tabindex]`, so this adds a scroll affordance and nothing else. */}
          <pre
            tabIndex={0}
            className="max-h-[56vh] min-w-0 flex-1 overflow-auto whitespace-pre px-5 py-4 font-mono text-meta leading-relaxed text-ink2"
            data-testid="scenario-yaml-content"
          >
            {exportResult.yaml}
          </pre>
          <div
            className="flex flex-wrap items-center gap-2 border-t border-line2 px-5 py-3 text-label font-semibold uppercase tracking-[0.03em] text-ink3"
            data-testid="scenario-version-footer"
          >
            <FaCodeBranch className="size-3 shrink-0" aria-hidden />
            <span>APP VERSION</span>
            <AppVersion />
            <span>· SCHEMA {schema}</span>
          </div>
        </>
      ) : (
        <div className="px-5 py-4">
          <ScenarioIssuesList issues={exportResult.issues} />
        </div>
      )}
    </section>
  );
}
