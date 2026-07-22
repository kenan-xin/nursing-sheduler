// Save & Load (T08 shell, T17 Save/Load + anonymise). The dedicated persistence
// surface: the browser auto-save explanation, the stateful persistence status
// (Restoring / Saving / Saved / Save failed), and the workspace below — the
// Scenario-file card (Download / Upload / Copy / Edit YAML, per the prototype),
// the destructive "Start over" reset (relocated here from the top bar per the
// prototype), the Anonymise card (3 toggles + Download-anonymised, DL10 D2),
// and the YAML preview/editor panel with the build version. A two-column
// layout (actions left, preview right) faithful to ScreenSaveLoad.dc.html.

import { PersistenceBadge } from "@/components/shell/persistence-status";
import { AppVersion } from "@/components/app-version";
import { FaFloppyDisk } from "@/components/icons";
import { SaveLoadWorkspace } from "@/components/save-load/save-load-workspace";

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
            up or share it, load a scenario file, or edit the YAML directly.
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

      <SaveLoadWorkspace />
    </div>
  );
}
