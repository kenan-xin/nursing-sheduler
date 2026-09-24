import { findStaffingShortfalls } from "@/lib/rules/shortfalls";
import type { EvalCase } from "../lib/case";

const noShortfalls = (final: Parameters<typeof findStaffingShortfalls>[0]) => {
  const left = findStaffingShortfalls(final);
  return left.length === 0 ? null : `${left.length} staffing shortfall(s) remain`;
};

export const REPAIR_CASES: EvalCase[] = [
  {
    id: "repair-understaffed-night",
    tags: ["repair", "smoke"],
    description:
      "After an infeasible run, offer the ranked repairs, prepare the picked one, apply, no shortfall left.",
    today: "2026-10-20",
    route: "/optimize-and-export",
    seed: { fixture: "understaffedNight" },
    optimizer: { outcome: "infeasible" },
    afterRunFinished: true,
    user: {
      turns: [],
      answers: ["Call her Rina Lim, from the float pool. She can do the night on the 5th."],
      onChoices: { pick: 1 },
      onPreview: "apply",
    },
    expect: {
      toolsCalled: [
        "get_optimize_result",
        "suggest_feasibility_options",
        "offer_choices",
        "prepare_scenario_change",
      ],
      choicesInclude: ["borrow"],
      proposalOps: [{ type: "add_person", temporary: true }],
      finalState: noShortfalls,
      judge: ["Says which night is short and why, using the numbers."],
    },
  },
];
