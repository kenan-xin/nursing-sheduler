"use client";

// Save & Load workspace (T17 repair; prototype ScreenSaveLoad.dc.html:37-114).
// The screen's single client orchestration seam: one store subscription, one
// `prepareExport` derivation, and one `useScenarioImport` instance shared by
// both inbound entry points — the Upload modal and the Edit-YAML Apply — so
// each drives the same pure `prepareScenarioLoad` gate (block on V-issues,
// version-confirm, warnings, `loadScenario` replace). Editing/draft/upload
// state is lifted here and passed down as explicit props: `ScenarioFileCard`
// owns the action triggers, `ScenarioYamlPreview` owns preview/editor
// rendering. The import warnings banner sits above the two-column grid, as in
// the prototype.

import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { pickScenario, useScenarioStore } from "@/lib/store";
import { prepareWorkspaceExport } from "@/lib/scenario";
import { StartOverCard } from "@/components/shell/new-schedule-button";
import { useLosableDraft } from "@/components/shell/use-losable-draft";
import { AnonymiseCard } from "./anonymise-card";
import { ImportWarningsBanner } from "./import-warnings-banner";
import { buildSampleScenarioYaml } from "./load-controls-core";
import { ScenarioFileCard } from "./scenario-file-card";
import { ScenarioYamlPreview } from "./scenario-yaml-preview";
import { UploadModal } from "./upload-modal";
import { useScenarioImport } from "./use-scenario-import";
import { VersionConfirmModal } from "./version-confirm-modal";

export function SaveLoadWorkspace() {
  // `pickScenario` builds a fresh object each call — `useShallow` compares its
  // fields rather than reference identity, avoiding the classic zustand v5
  // "getSnapshot should be cached" infinite-render loop.
  const scenario = useScenarioStore(useShallow(pickScenario));
  // The Save/Load screen previews and edits the Workspace V1 backup (DL13 D6),
  // which preserves incomplete authoring state — not the strict solver projection.
  const exportResult = useMemo(() => prepareWorkspaceExport(scenario), [scenario]);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // FR-PR-06: register the open Edit-YAML draft as a losable draft (T08a).
  useLosableDraft("save-load:edit-yaml", editing, "Edit YAML");
  const { issues, clearIssues, clearImportState, confirm, warnings, dismissWarnings, handleFile } =
    useScenarioImport({ onCommitted: () => setEditing(false) });

  const openUpload = () => {
    clearIssues();
    setUploadOpen(true);
  };

  const handleUploadedFile = (text: string) => {
    handleFile(text);
    setUploadOpen(false);
  };

  const handleLoadSample = () => handleUploadedFile(buildSampleScenarioYaml());

  // The draft is seeded in the click event from the current validated export —
  // never effect-derived — so the editor always opens on the latest committed
  // state. Cancel discards the draft; a committed Apply exits edit mode via
  // `onCommitted` above.
  const startEdit = () => {
    clearIssues();
    setDraft(exportResult.ok ? exportResult.yaml : "");
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft("");
    clearIssues();
  };

  const handleResetComplete = () => {
    setEditing(false);
    setDraft("");
    clearImportState();
  };

  const applyEdit = () => handleFile(draft);

  return (
    <>
      {warnings ? <ImportWarningsBanner warnings={warnings} onDismiss={dismissWarnings} /> : null}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <ScenarioFileCard
            scenario={scenario}
            canEditYaml={exportResult.ok}
            editing={editing}
            importIssues={editing ? null : issues}
            onUpload={openUpload}
            onStartEdit={startEdit}
          />
          <StartOverCard onResetComplete={handleResetComplete} />
          <AnonymiseCard />
        </div>
        <ScenarioYamlPreview
          exportResult={exportResult}
          schema={scenario.meta.apiVersion}
          editing={editing}
          draft={draft}
          issues={editing ? issues : null}
          onDraftChange={setDraft}
          onApply={applyEdit}
          onCancel={cancelEdit}
        />
      </div>

      <UploadModal
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onFile={handleUploadedFile}
        onLoadSample={handleLoadSample}
      />

      {confirm ? (
        <VersionConfirmModal
          open
          onOpenChange={(open) => {
            if (!open) confirm.onCancel();
          }}
          title={confirm.title}
          description={confirm.description}
          onContinue={confirm.onContinue}
        />
      ) : null}
    </>
  );
}
