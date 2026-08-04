"use client";

// Scenario-file card (T17 repair; prototype ScreenSaveLoad.dc.html:40-48). All
// four file actions live here in the prototype's order — Download, Upload,
// Copy, Edit YAML. Download/Copy route through the pure
// `performDownload`/`performCopy` core so the backup-freshness decision
// (Download records the backup via `recordBackup`, Copy never does) stays enforced
// by the core's dependency shapes. Upload and Edit YAML are triggers only — the
// workspace container owns the upload modal, the edit draft, and the single
// shared `useScenarioImport` pipeline they feed.
//
// R7 v2: an L1 card through the shared surface authority, with the prototype's
// hairline-separated head band (ScreenSaveLoad.dc.html:41). The three non-primary
// actions are `secondary`, not `outline`: the prototype edges them with `--line`
// (`:43-45`), and DESIGN.md §5 reserves `outline` for the heavier `--rule` edge.

import { useState } from "react";
import { toast } from "sonner";
import { useScenarioStore } from "@/lib/store";
import type { ScenarioUiState, ScenarioValidationIssue } from "@/lib/scenario";
import { Button } from "@/components/ui/button";
import { surfaceVariants } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { FaCheck, FaCopy, FaDownload, FaPen, FaUpload } from "@/components/icons";
import { BackupStatusBadge } from "./backup-status-badge";
import { performCopy, performDownload, SCENARIO_DOWNLOAD_FILENAME } from "./scenario-file-export";
import { ScenarioIssuesList } from "./scenario-issues-list";

/** Trigger a browser file download for the given text via a throwaway `<a>`. */
function writeYamlFile(yaml: string, filename: string) {
  const blob = new Blob([yaml], { type: "text/yaml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const COPY_LABEL_MS = 1500;

export interface ScenarioFileCardProps {
  /** The current committed draft — Download/Copy export exactly this. */
  scenario: ScenarioUiState;
  /** False when the draft fails export validation, so Edit YAML has nothing valid to seed from. */
  canEditYaml: boolean;
  /** True while the Edit-YAML mode is active (the trigger disables to avoid re-seeding over the draft). */
  editing: boolean;
  /** V-issues from a failed Upload. The Edit-YAML path surfaces its own inside the editor. */
  importIssues: ScenarioValidationIssue[] | null;
  onUpload: () => void;
  onStartEdit: () => void;
}

export function ScenarioFileCard({
  scenario,
  canEditYaml,
  editing,
  importIssues,
  onUpload,
  onStartEdit,
}: ScenarioFileCardProps) {
  const recordBackup = useScenarioStore((s) => s.recordBackup);
  const [copied, setCopied] = useState(false);
  const [issues, setIssues] = useState<ScenarioValidationIssue[] | null>(null);

  const handleDownload = () => {
    const result = performDownload(scenario, { writeFile: writeYamlFile, recordBackup });
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues(null);
    toast.success(`Downloaded ${SCENARIO_DOWNLOAD_FILENAME}`);
  };

  const handleCopy = () => {
    // Captured by the injected `writeClipboard` below so the confirmation only
    // fires once the browser clipboard write actually resolves (FR-SL-09):
    // a rejected promise must never flip the button to "Copied!".
    let clipboardWrite: Promise<void> | undefined;
    const result = performCopy(scenario, {
      writeClipboard: (yaml) => {
        clipboardWrite = navigator.clipboard.writeText(yaml);
      },
    });
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues(null);
    clipboardWrite
      ?.then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPY_LABEL_MS);
      })
      .catch((err) => {
        console.error("Failed to copy to clipboard:", err);
      });
  };

  return (
    <section
      className={cn("flex flex-col", surfaceVariants({ role: "surface", geometry: "card" }))}
      data-testid="scenario-file-card"
    >
      {/* Head band — a single bottom edge, so it stays square inside the rounded card. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line2 px-5 py-4">
        <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
          Scenario file
        </h2>
        <BackupStatusBadge />
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex flex-wrap gap-2.5">
          <Button type="button" onClick={handleDownload} data-testid="scenario-download-button">
            <FaDownload aria-hidden />
            Download
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={onUpload}
            data-testid="scenario-upload-button"
          >
            <FaUpload aria-hidden />
            Upload
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleCopy}
            data-testid="scenario-copy-button"
          >
            {copied ? <FaCheck aria-hidden /> : <FaCopy aria-hidden />}
            {copied ? "Copied!" : "Copy"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={onStartEdit}
            disabled={!canEditYaml || editing}
            data-testid="scenario-edit-yaml-button"
          >
            <FaPen aria-hidden />
            Edit YAML
          </Button>
        </div>
        {issues ? <ScenarioIssuesList issues={issues} /> : null}
        {importIssues ? <ScenarioIssuesList issues={importIssues} /> : null}
      </div>
    </section>
  );
}
