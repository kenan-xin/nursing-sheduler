// Quick-paint status line — FR-SR-29, four variants. Pure helper so the wording
// is unit-tested independently of the panel that renders it. Ground truth is the
// old app's `getQuickAddStatus`/`parseW`
// (web-frontend/src/app/shift-requests/page.tsx ~362/381) — the strings below are
// copied verbatim (only the tone names are renamed to this ticket's vocabulary:
// old "warning" splits into "clear" (no targets) vs "removal" (weight 0); old
// "neutral" is "apply"). The LEAVE line and the OFF "replaces" suffix are v2
// additions: v1 had no LEAVE, and its OFF was additive.

import { isValidWeightValue, parseWeightInput } from "@/components/card-editor/weight-value";
import { RESERVED_SHIFT_TYPE } from "@/lib/scenario";
import { computeQuickPaintCellIntent } from "./requests-gestures";
import { weightDisplayLabel } from "./requests-model";

/**
 * Parse quick-paint weight text with the cell editor's `parseWeightInput`, so the
 * same text means the same weight on both paths (`10k` is 10000). `""` → `0`;
 * anything the shared parser keeps as raw text → `null` (invalid), because the
 * status line needs a clean invalid signal.
 */
export function parseQuickPaintWeight(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  const parsed = parseWeightInput(trimmed);
  return isValidWeightValue(parsed) ? parsed : null;
}

export interface QuickPaintStatus {
  tone: "clear" | "error" | "removal" | "apply";
  text: string;
}

/**
 * The targets the drag will ACTUALLY paint, resolved through the gesture's own
 * precedence (`computeQuickPaintCellIntent`): LEAVE overrides everything, and a
 * co-selected OFF is dropped once a worked shift is also selected. The status
 * line announces this resolved set rather than the raw `selectedIds`, so e.g.
 * `OFF + AM` announces only `AM` (what's applied), not both. `weight` is already
 * parsed and non-null at the call site (the invalid-weight case returns "error"
 * before this runs).
 */
function appliedQuickPaintTargets(selectedIds: readonly string[], weight: number): string[] {
  const intent = computeQuickPaintCellIntent(selectedIds, weight);
  if (!intent) return [];
  switch (intent.mode) {
    case "erase":
      return [];
    case "day-state":
      return [
        intent.dayState.kind === "leave" ? RESERVED_SHIFT_TYPE.leave : RESERVED_SHIFT_TYPE.off,
      ];
    case "requests":
      return [...intent.deltas.keys()];
  }
}

/**
 * FR-SR-29 (verbatim strings): no targets selected → "clear" (dragging clears
 * cells); an unparseable weight → "error"; a valid weight of exactly `0` →
 * "removal" (dragging removes those types); otherwise → "apply".
 */
export function quickPaintStatus(selectedIds: readonly string[], weight: string): QuickPaintStatus {
  if (selectedIds.length === 0) {
    return {
      tone: "clear",
      text: "Drag over cells to clear existing requests or history. Empty cells will not change.",
    };
  }

  // LEAVE wins over every other target and ignores the weight
  // (`computeQuickPaintCellIntent`), so it is announced before the weight is read.
  if (selectedIds.includes(RESERVED_SHIFT_TYPE.leave)) {
    return { tone: "apply", text: "Drag to pin paid leave. Weight is not used." };
  }

  const parsed = parseQuickPaintWeight(weight);
  if (parsed === null) {
    return {
      tone: "error",
      text: "Enter a valid weight before dragging over cells to apply preferences.",
    };
  }

  const applied = appliedQuickPaintTargets(selectedIds, parsed);
  const targets = applied.join(", ");
  if (parsed === 0) {
    return {
      tone: "removal",
      text: `Drag over cells to remove ${targets}. Empty cells without it will not change.`,
    };
  }

  return {
    tone: "apply",
    text:
      `Drag over cells to apply ${targets} with weight ${weightDisplayLabel(parsed)}.` +
      (applied[0] === RESERVED_SHIFT_TYPE.off ? " This replaces shift requests in each cell." : ""),
  };
}
