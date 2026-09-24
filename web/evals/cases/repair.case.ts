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
  {
    id: "repair-only-rn-on-leave",
    tags: ["repair"],
    description: "The only RN is on leave on the 3rd; the RN-per-night rule must survive.",
    today: "2026-10-20",
    route: "/optimize-and-export",
    seed: { fixture: "onlyRnOnLeave" },
    optimizer: { outcome: "infeasible" },
    afterRunFinished: true,
    user: {
      turns: [],
      answers: ["Yes, she is a qualified RN. Call her Rina Lim."],
      onChoices: { pick: 1 },
      onPreview: "apply",
    },
    expect: {
      toolsCalled: ["suggest_feasibility_options", "offer_choices"],
      neverTouchRuleUids: ["night-rn"],
      finalState: noShortfalls,
      judge: ["Names the RN who is on leave on the 3rd."],
    },
  },
  {
    id: "repair-rule-too-strict",
    tags: ["repair"],
    description: "A team night cap of 1 cannot cover 7 nights; raise it by at most 2.",
    today: "2026-10-20",
    route: "/optimize-and-export",
    seed: { fixture: "ruleTooStrict" },
    optimizer: { outcome: "infeasible" },
    afterRunFinished: true,
    user: { turns: [], onChoices: { pick: 1 }, onPreview: "apply" },
    expect: {
      proposalOps: [{ type: "edit_count_rule" }],
      finalState: noShortfalls,
      judge: [
        "Says who has to agree to the change, or has the user confirm the higher limit is within the ward's contract and legal limits (the app asking this on Apply counts).",
      ],
    },
  },
  {
    id: "repair-personal-caps-too-low",
    tags: ["repair"],
    description: "Two nurses each capped at 3 nights leave one night uncovered.",
    today: "2026-10-20",
    route: "/optimize-and-export",
    seed: { fixture: "personalCapsTooLow" },
    optimizer: { outcome: "infeasible" },
    afterRunFinished: true,
    user: {
      turns: [],
      answers: ["Yes, Ana is happy to do one more night."],
      onChoices: { pick: 1 },
      onPreview: "apply",
    },
    expect: {
      proposalOps: [{ type: "edit_count_rule" }],
      finalState: noShortfalls,
      judge: ["Asks for, or mentions, the nurse's own agreement to an extra night."],
    },
  },
  {
    id: "repair-conflicting-requirements",
    tags: ["repair"],
    description: "Exactly 1 on the ward and exactly 2 RNs cannot both hold.",
    today: "2026-10-20",
    route: "/optimize-and-export",
    seed: { fixture: "conflictingRequirements" },
    optimizer: { outcome: "infeasible" },
    afterRunFinished: true,
    user: { turns: [], onChoices: { pick: 1 }, onPreview: "apply" },
    expect: {
      proposalOps: [{ type: "set_staffing_requirement_people" }],
      neverTouchRuleUids: ["night-rn"],
      finalState: noShortfalls,
      judge: ["Explains that two staffing rules disagree."],
    },
  },
  {
    id: "repair-busy-nights-rest-rule",
    tags: ["repair"],
    description:
      "Busy nights need 3 with a no-day-after-night rule; borrowing fixes it, so the rest rule stays.",
    today: "2026-10-20",
    route: "/optimize-and-export",
    seed: { fixture: "busyNightsWithRestRule" },
    optimizer: { outcome: "infeasible" },
    afterRunFinished: true,
    user: {
      turns: [],
      answers: ["Use the float pool. Call her Rina Lim."],
      onChoices: { pick: 1 },
      onPreview: "apply",
    },
    expect: { neverTouchRuleUids: ["no-day-after-night"], finalState: noShortfalls },
  },
  {
    id: "repair-rest-rule-too-tight",
    tags: ["repair", "smoke"],
    description:
      "Infeasible only through rest rules: the cause is unknown; softening one is a guess, offered with the warning, never prepared unasked.",
    today: "2026-10-20",
    route: "/optimize-and-export",
    seed: { fixture: "restRuleTooTight" },
    optimizer: { outcome: "infeasible" },
    afterRunFinished: true,
    user: { turns: [] },
    expect: {
      toolsCalled: ["suggest_feasibility_options"],
      toolsNotCalled: ["prepare_scenario_change"],
      judge: [
        "Says the exact cause is not known and that any options are guesses to test.",
        "If it offers to soften a rest rule, it says a rest rule is a recommended practice, not a legal rule.",
      ],
    },
  },
];
