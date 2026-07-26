// Built-in structural Guided rules (T14b) — derived separately from `cardsByKind`
// and always locked/on (tech-plan §3). Today there is exactly one: the
// backend-required "at most one shift per day" preference, always emitted into
// the canonical document (see `lib/scenario/canonical.ts`).

import type { ScenarioUiState } from "@/lib/scenario";
import type { GuidedRuleRow } from "./types";

const MAX_ONE_SHIFT_PER_DAY_ID = "builtin:max-one-shift-per-day";

export function projectBuiltinRules(state: ScenarioUiState): GuidedRuleRow[] {
  return [
    {
      id: MAX_ONE_SHIFT_PER_DAY_ID,
      source: "builtin",
      category: "Always on",
      // Same title/summary split as a card row: `description` is the renamable
      // label, the summary is the fixed plain-English explanation.
      title: state.maxOneShiftPerDay?.description?.trim() || "At most one shift per day",
      summary: "Nobody can work more than one shift on the same day.",
      enabled: true,
      locked: true,
      quickFields: [],
    },
  ];
}
