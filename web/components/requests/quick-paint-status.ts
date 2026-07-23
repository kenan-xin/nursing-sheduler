// Quick-paint status line — FR-SR-29, four variants. Pure helper so the wording
// is unit-tested independently of the panel that renders it. Ground truth is the
// old app's `getQuickAddStatus`/`parseW`
// (web-frontend/src/app/shift-requests/page.tsx ~362/381) — the strings below are
// copied verbatim (only the tone names are renamed to this ticket's vocabulary:
// old "warning" splits into "clear" (no targets) vs "removal" (weight 0); old
// "neutral" is "apply").

import { RESERVED_SHIFT_TYPE } from "@/lib/scenario";
import { computeQuickPaintCellIntent } from "./requests-gestures";
import { weightDisplayLabel } from "./requests-model";

const INFINITY_TOKENS = ["∞", "+∞", "inf", "+inf", "infinity", "+infinity"];
const NEG_INFINITY_TOKENS = ["-∞", "-inf", "-infinity"];

/**
 * Parse quick-paint weight text 1:1 with the old app's `parseW`: infinity
 * spellings (case-insensitive), `""` → `0`, otherwise `parseInt`; `NaN` → `null`
 * (invalid). Deliberately simpler than `weight-field.tsx`'s `parseWeightInput`
 * (no k/m/b/t suffixes, no raw-text-on-invalid fallback) — quick-paint's status
 * line needs a clean invalid signal, not a partial draft to keep typing into.
 */
export function parseQuickPaintWeight(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (INFINITY_TOKENS.includes(trimmed)) return Infinity;
  if (NEG_INFINITY_TOKENS.includes(trimmed)) return -Infinity;
  if (trimmed === "") return 0;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? null : parsed;
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

  const parsed = parseQuickPaintWeight(weight);
  if (parsed === null) {
    return {
      tone: "error",
      text: "Enter a valid weight before dragging over cells to apply preferences.",
    };
  }

  const targets = appliedQuickPaintTargets(selectedIds, parsed).join(", ");
  if (parsed === 0) {
    return {
      tone: "removal",
      text: `Drag over cells to remove ${targets}. Empty cells without it will not change.`,
    };
  }

  return {
    tone: "apply",
    text: `Drag over cells to apply ${targets} with weight ${weightDisplayLabel(parsed)}.`,
  };
}
