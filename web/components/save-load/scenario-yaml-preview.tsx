"use client";

// YAML preview + Edit-YAML mode (T17a-4 read-only; T17b-3 Edit-YAML; prototype
// ScreenSaveLoad.dc.html:82-113, both the `notEditing` and `editing` branches).
// Read-only, always renders the SAME `prepareExport` result the Scenario-file
// card acts on, so the preview, Download, and Copy can never disagree about
// whether the draft is valid. `● SAVED` is the browser auto-save badge (T08),
// independent of dirty/Copy. Edit YAML seeds a textarea from that same YAML;
// Apply drives it through the shared `useScenarioImport` pipeline (T17b-3) --
// the same block / version-confirm / warnings / replace machinery as the
// Upload path in `load-controls.tsx`. Cancel discards the draft with no state
// change.

import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { pickScenario, useScenarioStore } from "@/lib/store";
import { prepareExport } from "@/lib/scenario";
import { AppVersion } from "@/components/app-version";
import { PersistenceBadge } from "@/components/shell/persistence-status";
import { FaCodeBranch } from "@/components/icons";
// Not re-exported from the icon barrel (icons.tsx is owned by a concurrently
// edited ticket) — imported directly per the project's react-icons/fa6
// convention.
import { FaPen } from "react-icons/fa6";
import { Button } from "@/components/ui/button";
import { ScenarioIssuesList } from "./scenario-issues-list";
import { VersionConfirmModal } from "./version-confirm-modal";
import { ImportWarningsBanner } from "./import-warnings-banner";
import { useScenarioImport } from "./use-scenario-import";

export function ScenarioYamlPreview() {
  // `pickScenario` builds a fresh object each call — `useShallow` compares its
  // fields rather than reference identity, avoiding the classic zustand v5
  // "getSnapshot should be cached" infinite-render loop.
  const scenario = useScenarioStore(useShallow(pickScenario));
  const result = useMemo(() => prepareExport(scenario), [scenario]);
  const schema = scenario.meta.apiVersion;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const { issues, clearIssues, confirm, warnings, dismissWarnings, handleFile } = useScenarioImport(
    { onCommitted: () => setEditing(false) },
  );

  const startEdit = () => {
    clearIssues();
    setDraft(result.ok ? result.yaml : "");
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft("");
    clearIssues();
  };

  const applyEdit = () => handleFile(draft);

  return (
    <section
      className="flex flex-col border border-line bg-surface"
      data-testid="scenario-yaml-preview"
    >
      <div className="flex items-center justify-between border-b border-line2 px-[18px] py-4">
        <h2 className="font-heading text-cardhead font-extrabold tracking-tight">
          {editing ? "Edit YAML Configuration" : "Current state · YAML"}
        </h2>
        <div className="flex items-center gap-2.5">
          {!editing ? <PersistenceBadge /> : null}
          {result.ok ? (
            <Button
              type="button"
              variant="outline"
              onClick={editing ? cancelEdit : startEdit}
              data-testid="yaml-edit-toggle"
            >
              <FaPen className="size-4" aria-hidden />
              Edit YAML
            </Button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="flex flex-col gap-3 p-[18px]" data-testid="scenario-yaml-editor">
          <textarea
            data-testid="scenario-yaml-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="h-[46vh] resize-y border border-line bg-bg p-3 font-mono text-meta leading-relaxed text-ink"
          />
          {issues ? <ScenarioIssuesList issues={issues} /> : null}
          <div className="flex gap-2.5">
            <Button type="button" onClick={applyEdit} data-testid="yaml-apply-button">
              Apply changes
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={cancelEdit}
              data-testid="yaml-cancel-button"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : result.ok ? (
        <>
          <pre
            className="max-h-[56vh] flex-1 overflow-auto whitespace-pre p-[18px] font-mono text-meta leading-relaxed text-ink2"
            data-testid="scenario-yaml-content"
          >
            {result.yaml}
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
          <ScenarioIssuesList issues={result.issues} />
        </div>
      )}

      {warnings ? (
        <div className="border-t border-line2 p-[18px]">
          <ImportWarningsBanner warnings={warnings} onDismiss={dismissWarnings} />
        </div>
      ) : null}

      {confirm ? (
        <VersionConfirmModal
          open
          onOpenChange={(open) => {
            if (!open) confirm.onCancel();
          }}
          status={confirm.status}
          fileVersion={confirm.fileVersion}
          currentVersion={confirm.currentVersion}
          onContinue={confirm.onContinue}
        />
      ) : null}
    </section>
  );
}
