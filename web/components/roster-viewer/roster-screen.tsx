"use client";

// Roster screen (G4 — the dedicated /roster route).
//
// The roster viewer finally has its own route. This screen mounts the existing
// F4/F5 roster surface — the same `RosterSection` Optimize already used to
// embed — under a real `/roster` URL with the prototype-faithful page header
// (ScreenSchedule.dc.html:35-37). It reuses the existing F1 storage reader
// and the same F2 capture surface the screen already mounts; no second
// storage, capture, import, clear, autosave, or candidate protocol is created.
//
// The capture gate is resolved HERE for the same reason Optimize resolves it:
// `RosterSection` reaches `capture.gate.dismissDurableCandidate(...)` for the
// durable candidate pointer on screen. The gate is app-lifetime (it lives at
// module scope), so resolving it again on this route attaches to the SAME
// singleton — it is never duplicated.
//
// The screen follows the same page-plane conventions as `OptimizeAndExportScreen`
// (a `Surface` with `data-testid="screen"` + a `data-screen` label), so the
// shell chrome, the hydration gate, and the route-validity gate treat this
// page identically to every other product route.

import { Surface } from "@/components/ui/surface";
import { RosterSection } from "./roster-section";
import { useRosterCapture } from "@/lib/optimize";

export function RosterScreen() {
  // The capture surface is app-lifetime; mounting it here attaches to the
  // shared singleton. `stateFor` is never read on this route (the per-run
  // capture notice belongs to Optimize's terminal panel) — but the gate is
  // what `RosterSection` uses to dismiss a durable candidate, so resolving
  // it once on mount keeps the section's surface unchanged.
  const capture = useRosterCapture();

  return (
    <Surface
      level="page"
      geometry="square"
      data-testid="screen"
      data-screen="Roster"
      className="flex flex-col gap-4"
    >
      {/* v2 page head (ScreenSchedule.dc.html:35-37): label eyebrow in
          `--brandink`, then the Display step — Figtree 700 / 1.15 / -0.015em
          (DESIGN.md §3). Mirrors Optimize's page head so the two routes share
          one page-plane recipe. */}
      <header className="flex flex-col gap-2">
        <div className="text-label font-semibold uppercase tracking-[0.03em] text-brandink">
          Output · Roster
        </div>
        <h1 className="font-heading text-display font-bold leading-[1.15] tracking-[-0.015em] text-ink">
          Review &amp; adjust the roster
        </h1>
        <p className="max-w-[66ch] text-ink2">
          View the saved roster, edit assignments, and export the result.
        </p>
      </header>

      {/* F4 — the roster surface. Renders the editable viewer when a working
          roster exists, the empty/loading states when it does not, and the
          candidate Load/Dismiss actions that surface a durable F2 candidate.
          The section composes the F1/F3 authorities; no second storage,
          capture, import, clear, autosave, or candidate protocol lives here. */}
      <RosterSection capture={capture} />
    </Surface>
  );
}

export default RosterScreen;
