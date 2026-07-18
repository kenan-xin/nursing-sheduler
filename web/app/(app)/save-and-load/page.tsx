// Save & Load (T08 shell, T17a-4 Scenario-file card + read-only preview,
// T17a-5 Anonymise card). The dedicated persistence surface: the browser
// auto-save explanation, the stateful persistence status (Restoring / Saving
// / Saved / Save failed), the Scenario-file card (Download/Copy — Upload/Edit
// YAML are later tickets), the destructive "Start over" reset (relocated here
// from the top bar per the prototype), the Anonymise card (3 toggles +
// Download-anonymised, DL10 D2), and the read-only YAML preview, the build
// version. A two-column layout (actions left, preview right) faithful to
// ScreenSaveLoad.dc.html.

import { StartOverCard } from "@/components/shell/new-schedule-button";
import { PersistenceBadge } from "@/components/shell/persistence-status";
import { AppVersion } from "@/components/app-version";
import { FaFloppyDisk } from "@/components/icons";
import { AnonymiseCard } from "@/components/save-load/anonymise-card";
import { LoadControls } from "@/components/save-load/load-controls";
import { ScenarioFileCard } from "@/components/save-load/scenario-file-card";
import { ScenarioYamlPreview } from "@/components/save-load/scenario-yaml-preview";

export default function SaveAndLoadPage() {
  return (
    <div
      data-testid="screen"
      data-screen="Save and Load"
      className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8"
    >
      <header className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center border border-line bg-panel text-ink2">
          <FaFloppyDisk className="size-4" />
        </span>
        <div className="flex flex-col gap-0.5">
          <div className="text-label font-semibold uppercase tracking-[0.03em] text-brandink">
            System · Save &amp; Load
          </div>
          <h1 className="font-heading text-title font-semibold tracking-tight">Save &amp; Load</h1>
          <p className="text-meta text-ink2">
            Everything you set up is saved automatically in this browser. Download a copy to back it
            up or share it.
          </p>
        </div>
      </header>

      <section
        data-testid="auto-save-status"
        className="flex flex-col items-start gap-3 border border-line bg-surface p-4"
      >
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <h2 className="font-heading text-title font-semibold tracking-tight">Auto-save</h2>
          <PersistenceBadge />
        </div>
        <p className="max-w-[60ch] text-meta text-ink2">
          Your work is saved to this browser automatically and restored when you return. The badge
          above reflects the latest write.
        </p>
        <AppVersion />
      </section>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <ScenarioFileCard />
          <LoadControls />
          <StartOverCard />
          <AnonymiseCard />
        </div>
        <ScenarioYamlPreview />
      </div>
    </div>
  );
}
