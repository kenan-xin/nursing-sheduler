"use client";

// Anonymise card (T17a-5; prototype ScreenSaveLoad.dc.html:61-79). DL10 D2
// overrides the prototype: exactly 3 toggles, no 4th "Remove free-text
// descriptions" toggle -- descriptions are preserved. Routes through
// `performAnonymisedDownload`, which always calls `prepareAnonymizedExport`
// (T17a-2) so the transform runs on a clone; the live scenario is never
// mutated and `recordBackup` is deliberately never called here (an anonymised
// copy is not a Workspace backup).
//
// R7 v2: an L1 card through the shared surface authority, with the prototype's
// hairline-separated head band carrying both the title and its description
// (ScreenSaveLoad.dc.html:63-66).

import { useState } from "react";
import { toast } from "sonner";
import { FaUserSecret } from "react-icons/fa6";
import { useShallow } from "zustand/react/shallow";
import { pickScenario, useScenarioStore } from "@/lib/store";
import { getMissingPreferredScatterDateGroups, type ScenarioValidationIssue } from "@/lib/scenario";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { surfaceVariants } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import {
  ANONYMISE_TOGGLES,
  defaultAnonymiseToggleState,
  filenameForToggles,
  isAnonymiseDownloadEnabled,
  performAnonymisedDownload,
  type AnonymiseToggleState,
} from "./anonymise-export";
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

export function AnonymiseCard() {
  // `pickScenario` builds a fresh object each call — `useShallow` compares its
  // fields so a run of unrelated store writes doesn't force an infinite re-render.
  const scenario = useScenarioStore(useShallow(pickScenario));
  const [toggles, setToggles] = useState<AnonymiseToggleState>(defaultAnonymiseToggleState);
  const [issues, setIssues] = useState<ScenarioValidationIssue[] | null>(null);
  const downloadEnabled = isAnonymiseDownloadEnabled(toggles);
  // FR-SL-38 / V20 — while Scatter is on, warn when a preferred WORKDAY/NON-WORKDAY
  // date group is missing, since scatter silently falls back to WEEKDAY/WEEKEND.
  const missingScatterGroups = toggles.scatter
    ? getMissingPreferredScatterDateGroups(scenario.dateGroups)
    : [];

  const handleDownload = () => {
    if (!downloadEnabled) return;
    const result = performAnonymisedDownload(scenario, toggles, { writeFile: writeYamlFile });
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues(null);
    toast.success(`Downloaded ${filenameForToggles(toggles)}`);
  };

  return (
    <section
      className={cn("flex flex-col", surfaceVariants({ role: "surface", geometry: "card" }))}
      data-testid="anonymise-card"
    >
      {/* Head band — a single bottom edge, so it stays square inside the rounded card. */}
      <div className="flex flex-col gap-1 border-b border-line2 px-5 py-4">
        <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
          Anonymise
        </h2>
        <p className="max-w-[60ch] text-meta text-ink2">
          Strip identifying data before sharing a scenario for support.
        </p>
      </div>
      <div className="flex flex-col gap-3.5 px-5 py-4">
        {ANONYMISE_TOGGLES.map((toggle) => (
          <div
            key={toggle.key}
            className="flex items-center justify-between gap-3"
            data-testid={`anonymise-toggle-row-${toggle.key}`}
          >
            {/* `aria-labelledby` rather than a duplicated `aria-label`: the switch's
                accessible name then IS the visible text, so the two can never drift
                (axe `aria-toggle-field-name` — the row's label was a bare sibling
                span, which left all three toggles unnamed to assistive tech). */}
            <span
              id={`anonymise-toggle-label-${toggle.key}`}
              className="text-meta font-semibold text-ink"
            >
              {toggle.label}
            </span>
            <Switch
              checked={toggles[toggle.key]}
              onCheckedChange={(checked) =>
                setToggles((prev) => ({ ...prev, [toggle.key]: checked }))
              }
              aria-labelledby={`anonymise-toggle-label-${toggle.key}`}
              data-testid={`anonymise-toggle-${toggle.key}`}
            />
          </div>
        ))}
        <p className="text-meta text-ink3">Free-text descriptions are not changed.</p>
        {/* Text on `--surface`, not on its own tint, so it takes the deepest
            semantic tier. §2 scopes the BASE tier to "text or icon on its own
            tint"; v1's `--warn` here was the on-tint value used off-tint, which
            reads noticeably lighter than it should in dark mode. */}
        {missingScatterGroups.length > 0 ? (
          <p className="text-meta text-warnink" data-testid="anonymise-scatter-fallback-warning">
            {`Warning: ${missingScatterGroups.join(" and ")} ${missingScatterGroups.length === 1 ? "group is" : "groups are"} missing. Scattering will fall back to WEEKDAY and WEEKEND groups.`}
          </p>
        ) : null}
        <Button
          type="button"
          onClick={handleDownload}
          disabled={!downloadEnabled}
          data-testid="anonymise-download-button"
          className="self-start"
        >
          <FaUserSecret aria-hidden />
          Download anonymised
        </Button>
        {issues ? <ScenarioIssuesList issues={issues} /> : null}
      </div>
    </section>
  );
}
