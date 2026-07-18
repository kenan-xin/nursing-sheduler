"use client";

// Load flow UI (T17b-2; prototype ScreenSaveLoad.dc.html:40-48/116-158). The
// primary inbound entry: Upload -> the shared `useScenarioImport` pipeline
// (T17b-3; `prepareScenarioLoad`, T17b-1, pure, mutates nothing -> block on
// V-issues, or gate on `classifyImportVersion` -> full-state replace via the
// store's `loadScenario`). The Edit-YAML entry point in
// `scenario-yaml-preview.tsx` drives the same hook. Self-contained by
// design -- the orchestrator mounts this on the Save & Load screen once the
// concurrently edited page shell and Scenario-file card have both landed.

import { useState } from "react";
import { Button } from "@/components/ui/button";
// Not re-exported from the icon barrel (icons.tsx is owned by a concurrently
// edited ticket) — imported directly per the project's react-icons/fa6
// convention.
import { FaUpload } from "react-icons/fa6";
import { ScenarioIssuesList } from "./scenario-issues-list";
import { UploadModal } from "./upload-modal";
import { VersionConfirmModal } from "./version-confirm-modal";
import { ImportWarningsBanner } from "./import-warnings-banner";
import { buildSampleScenarioYaml } from "./load-controls-core";
import { useScenarioImport } from "./use-scenario-import";

export function LoadControls() {
  const [uploadOpen, setUploadOpen] = useState(false);
  const { issues, clearIssues, confirm, warnings, dismissWarnings, handleFile } =
    useScenarioImport();

  const handleUploadedFile = (text: string) => {
    handleFile(text);
    setUploadOpen(false);
  };

  const handleLoadSample = () => handleUploadedFile(buildSampleScenarioYaml());

  return (
    <section data-testid="load-controls" className="border border-line bg-surface">
      <div className="border-b border-line2 px-[18px] py-4">
        <h2 className="font-heading text-cardhead font-extrabold tracking-tight">Load scenario</h2>
        <p className="mt-1 text-meta text-ink2">
          Upload a saved YAML file, or load a sample to try the app.
        </p>
      </div>
      <div className="flex flex-col gap-3 p-[18px]">
        <div className="flex flex-wrap gap-2.5">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              clearIssues();
              setUploadOpen(true);
            }}
            data-testid="load-upload-button"
          >
            <FaUpload className="size-4" aria-hidden />
            Upload
          </Button>
        </div>
        {issues ? <ScenarioIssuesList issues={issues} /> : null}
        {warnings ? <ImportWarningsBanner warnings={warnings} onDismiss={dismissWarnings} /> : null}
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
          status={confirm.status}
          fileVersion={confirm.fileVersion}
          currentVersion={confirm.currentVersion}
          onContinue={confirm.onContinue}
        />
      ) : null}
    </section>
  );
}
