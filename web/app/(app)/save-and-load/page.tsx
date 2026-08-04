// Save & Load (T08 shell, T17 Save/Load + anonymise). The dedicated persistence
// surface: the browser auto-save explanation, the stateful persistence status
// (Restoring / Saving / Saved / Save failed), and the workspace below — the
// Scenario-file card (Download / Upload / Copy / Edit YAML, per the prototype),
// the destructive "Start over" reset (relocated here from the top bar per the
// prototype), the Anonymise card (3 toggles + Download-anonymised, DL10 D2),
// and the YAML preview/editor panel with the build version. A two-column
// layout (actions left, preview right) faithful to ScreenSaveLoad.dc.html.
//
// R7 v2: the route root is the L0 page plane through the shared surface authority,
// and the Auto-save explainer is an L1 card with a hairline head band (DESIGN.md
// §4) rather than v1's flat bordered box. The v1 icon tile in front of the heading
// is gone — ScreenSaveLoad.dc.html:11-14 authors an eyebrow plus a Display heading
// with no tile — and the heading moves from v1's Title step to Display at v2's
// lighter weight (§3: "v1 used Figtree 800; v2 is one step lighter").

import { PersistenceBadge } from "@/components/shell/persistence-status";
import { AppVersion } from "@/components/app-version";
import { Surface, surfaceVariants } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { SaveLoadWorkspace } from "@/components/save-load/save-load-workspace";

export default function SaveAndLoadPage() {
  return (
    <Surface
      level="page"
      geometry="square"
      data-testid="screen"
      data-screen="Save and Load"
      className="flex flex-col gap-4"
    >
      <header className="flex flex-col gap-2">
        <div className="text-label font-semibold uppercase tracking-[0.03em] text-brandink">
          System · Save &amp; Load
        </div>
        <h1 className="font-heading text-display font-bold leading-[1.15] tracking-[-0.015em] text-ink">
          Save &amp; Load
        </h1>
        <p className="max-w-[64ch] text-ink2">
          Everything you set up is saved automatically in this browser. Download a copy to back it
          up or share it, load a scenario file, or edit the YAML directly.
        </p>
      </header>

      <section
        data-testid="auto-save-status"
        className={cn("flex flex-col", surfaceVariants({ role: "surface", geometry: "card" }))}
      >
        {/* Head band — a single bottom edge, so it stays square inside the rounded card. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line2 px-5 py-4">
          <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
            Auto-save
          </h2>
          <PersistenceBadge />
        </div>
        <div className="flex flex-col items-start gap-2 px-5 py-4">
          <p className="max-w-[64ch] text-meta text-ink2">
            Your work is saved to this browser automatically and restored when you return. The badge
            above reflects the latest write.
          </p>
          <AppVersion />
        </div>
      </section>

      <SaveLoadWorkspace />
    </Surface>
  );
}
