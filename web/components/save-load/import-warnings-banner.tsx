"use client";

// Import warnings banner (T17b-2; FR-SL-31/32; prototype
// ScreenSaveLoad.dc.html:17-31). Non-blocking — the load has already committed
// by the time this renders. Shows the deduped advanced-syntax survivors (V12/V13,
// from `prepareScenarioLoad`'s `warnings`) plus, when present, the shared
// uncredited-leave guard's named findings (qq0.23e, merged in
// `use-scenario-import.ts` before the single `loadScenario` commit).

import { FaTriangleExclamation } from "@/components/icons";

export interface ImportWarningsBannerProps {
  warnings: string[];
  onDismiss: () => void;
}

export function ImportWarningsBanner({ warnings, onDismiss }: ImportWarningsBannerProps) {
  if (warnings.length === 0) return null;

  return (
    <div
      data-testid="import-warnings-banner"
      className="flex items-start gap-2.5 border border-warn bg-warntint p-3.5"
    >
      <FaTriangleExclamation className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 text-meta font-semibold">Imported scenario warnings</div>
        <ul className="list-disc space-y-1 pl-[18px] text-meta text-ink2">
          {warnings.map((warning, index) => (
            <li key={`${index}-${warning}`}>{warning}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        data-testid="import-warnings-dismiss"
        onClick={onDismiss}
        className="h-[30px] shrink-0 border border-line bg-surface px-3 text-meta font-semibold outline-none hover:bg-panel focus-visible:ring-2 focus-visible:ring-brand"
      >
        Dismiss
      </button>
    </div>
  );
}
