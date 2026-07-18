"use client";

// Scenario-file card (T17a-4; prototype ScreenSaveLoad.dc.html:40-48, Download +
// Copy only — Upload/Edit YAML are later tickets). Both actions route through
// the pure `performDownload`/`performCopy` core so the dirty-machinery decision
// (Download clears dirty via `markSaved`, Copy never does) is enforced by the
// core's dependency shapes, not by care taken here.

import { useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { pickScenario, useScenarioStore } from "@/lib/store";
import type { ScenarioValidationIssue } from "@/lib/scenario";
import { Button } from "@/components/ui/button";
import { FaCheck, FaCopy, FaDownload } from "@/components/icons";
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

export function ScenarioFileCard() {
  // `pickScenario` builds a fresh object each call — `useShallow` compares its
  // fields so a run of unrelated store writes doesn't force an infinite re-render.
  const scenario = useScenarioStore(useShallow(pickScenario));
  const markSaved = useScenarioStore((s) => s.markSaved);
  const [copied, setCopied] = useState(false);
  const [issues, setIssues] = useState<ScenarioValidationIssue[] | null>(null);

  const handleDownload = () => {
    const result = performDownload(scenario, { writeFile: writeYamlFile, markSaved });
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
    <section className="border border-line bg-surface" data-testid="scenario-file-card">
      <div className="border-b border-line2 px-[18px] py-4">
        <h2 className="font-heading text-cardhead font-extrabold tracking-tight">Scenario file</h2>
      </div>
      <div className="flex flex-col gap-3 p-[18px]">
        <div className="flex flex-wrap gap-2.5">
          <Button type="button" onClick={handleDownload} data-testid="scenario-download-button">
            <FaDownload className="size-4" aria-hidden />
            Download
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleCopy}
            data-testid="scenario-copy-button"
          >
            {copied ? (
              <FaCheck className="size-4" aria-hidden />
            ) : (
              <FaCopy className="size-4" aria-hidden />
            )}
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>
        {issues ? <ScenarioIssuesList issues={issues} /> : null}
      </div>
    </section>
  );
}
