"use client";

// Import warnings banner (T17b-2; FR-SL-31/32; prototype
// ScreenSaveLoad.dc.html:17-31). Non-blocking — the load has already committed
// by the time this renders. Shows the deduped advanced-syntax survivors (V12/V13,
// from `prepareScenarioLoad`'s `warnings`) plus, when present, the shared
// uncredited-leave guard's named findings (qq0.23e, merged in
// `use-scenario-import.ts` before the single `loadScenario` commit).
//
// R7 v2: a PAGE-MOUNTED status banner, so it keeps its tint plus a matching
// semantic border and takes the card radius — the treatment DESIGN.md §1's
// deviation matrix names for exactly this element ("Status-tinted page banners are
// unchanged … which is what the prototype itself authors (ScreenSaveLoad.dc.html:19)").
// Title and body move onto `--warnink`: v1 left them at neutral `--ink`/`--ink2`,
// which reads as an unrelated grey note in dark mode, where the base and ink tiers
// diverge. The leading icon keeps the BASE tier, which §2 defines as "text or icon
// on its own tint". Dismiss is the shared `Button` rather than a hand-rolled 30px
// control, so it inherits the pill geometry, `--sh-1` and the 44px coarse floor.

import { FaTriangleExclamation } from "@/components/icons";
import { Button } from "@/components/ui/button";

export interface ImportWarningsBannerProps {
  warnings: string[];
  onDismiss: () => void;
}

export function ImportWarningsBanner({ warnings, onDismiss }: ImportWarningsBannerProps) {
  if (warnings.length === 0) return null;

  return (
    <div
      data-testid="import-warnings-banner"
      className="flex items-start gap-2.5 rounded-card border border-warn bg-warntint p-3.5"
    >
      <FaTriangleExclamation className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 text-meta font-semibold text-warnink">
          Imported scenario warnings
        </div>
        <ul className="list-disc space-y-1 pl-4.5 text-meta text-warnink">
          {warnings.map((warning, index) => (
            <li key={`${index}-${warning}`}>{warning}</li>
          ))}
        </ul>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="import-warnings-dismiss"
        onClick={onDismiss}
      >
        Dismiss
      </Button>
    </div>
  );
}
