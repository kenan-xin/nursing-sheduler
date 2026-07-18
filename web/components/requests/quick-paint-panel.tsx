"use client";

// Quick-paint preset panel (T11, FR-SR-27-29; prototype
// ScreenRequests.dc.html:40-58): shift-type/OFF/LEAVE/group chip multi-select +
// weight input + ±∞ shortcuts, with a single status line computed internally by
// the pure `quickPaintStatus` helper (FR-SR-29's four verbatim variants). The
// container owns the drag/paint gesture — this panel only configures the preset.

import { Input } from "@/components/ui/input";
import { FaCircleExclamation } from "@/components/icons";
// Not re-exported from the icon barrel (icons.tsx is owned by a concurrently
// edited ticket) — imported directly per the project's react-icons/fa6
// convention (see upload-modal.tsx).
import { FaBrush } from "react-icons/fa6";
import { quickPaintStatus } from "./quick-paint-status";

export interface PaintTarget {
  id: string;
  name: string;
}

export interface QuickPaintPanelProps {
  targets: PaintTarget[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  weight: string;
  onWeightChange: (v: string) => void;
  onSetPosInf: () => void;
  onSetNegInf: () => void;
}

const TONE_CLASS: Record<ReturnType<typeof quickPaintStatus>["tone"], string> = {
  clear: "bg-warntint text-ink2",
  error: "bg-errortint text-error",
  removal: "bg-warntint text-ink2",
  apply: "bg-panel text-ink2",
};

export function QuickPaintPanel({
  targets,
  selectedIds,
  onToggle,
  weight,
  onWeightChange,
  onSetPosInf,
  onSetNegInf,
}: QuickPaintPanelProps) {
  const status = quickPaintStatus(selectedIds, weight);

  return (
    <div className="mb-3 border border-line bg-surface p-4" data-testid="quick-paint-panel">
      <div className="font-heading text-cardhead font-extrabold tracking-tight">
        Add shift preference
      </div>
      <p className="mb-3.5 mt-0.5 text-meta text-ink3">
        Pick one or more targets and a weight, then drag across grid cells to apply. Select nothing
        to clear cells instead.
      </p>

      <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-ink2">
        Shift types{" "}
        <span className="font-normal normal-case tracking-normal text-ink3">
          — select multiple to set each
        </span>
      </div>
      <div className="mb-4 flex flex-wrap gap-2" data-testid="quick-paint-chips">
        {targets.map((target) => {
          const checked = selectedIds.includes(target.id);
          return (
            <button
              key={target.id}
              type="button"
              aria-pressed={checked}
              data-testid={`quick-paint-chip-${target.id}`}
              title={target.name}
              onClick={() => onToggle(target.id)}
              className={
                checked
                  ? "inline-flex items-center gap-2 border border-brand bg-brandtint px-3 py-1.5 text-meta font-semibold text-brandink"
                  : "inline-flex items-center gap-2 border border-line bg-transparent px-3 py-1.5 text-meta font-semibold text-ink2 hover:bg-panel"
              }
            >
              <span
                className={
                  checked
                    ? "flex size-3.5 items-center justify-center border border-brand bg-brand text-[9px] text-onbrand"
                    : "flex size-3.5 items-center justify-center border border-line"
                }
              >
                {checked ? "✓" : ""}
              </span>
              {target.id}
            </button>
          );
        })}
      </div>

      <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-ink2">
        Weight <span className="font-normal normal-case tracking-normal text-ink3">(priority)</span>
      </div>
      <div className="flex max-w-[440px] items-center gap-2">
        <Input
          value={weight}
          onChange={(e) => onWeightChange(e.target.value)}
          placeholder="0"
          data-testid="quick-paint-weight-input"
          className="h-9.5 flex-1 font-mono"
        />
        <button
          type="button"
          data-testid="quick-paint-pos-inf"
          onClick={onSetPosInf}
          className="h-9.5 flex-none border border-success bg-successtint px-3.5 font-mono text-meta font-bold text-success"
        >
          +∞
        </button>
        <button
          type="button"
          data-testid="quick-paint-neg-inf"
          onClick={onSetNegInf}
          className="h-9.5 flex-none border border-warn bg-warntint px-3.5 font-mono text-meta font-bold text-warn"
        >
          −∞
        </button>
      </div>

      <div
        data-testid="quick-paint-status"
        className={`mt-3.5 flex items-center gap-1.5 px-3 py-2 text-meta ${TONE_CLASS[status.tone]}`}
      >
        {status.tone === "error" ? (
          <FaCircleExclamation className="size-3" />
        ) : (
          <FaBrush className="size-3" />
        )}
        {status.text}
      </div>
    </div>
  );
}
