// The assistant's playbook: how to guide setup and how to repair an infeasible
// schedule, as TYPED, VERSIONED DATA rather than one long prompt string.
//
// Tool results carry these values (get_setup_progress, suggest_feasibility_options),
// so they reach the model only when they are relevant, and a test can hold every
// line to account. Bump PLAYBOOK_VERSION on any change to the wording or order.
//
// The repair order follows ward practice: remove a preference before touching
// people, use willing staff and the float pool before asking someone on leave, and
// run a shift short only as the manager's last call. The safety floor is never
// crossed (enforced again in code by repair-options.ts `isSafeOption`).
//
// REST RULES ARE GUIDANCE, NOT LAW (user decision, 2026-09-24; research
// docs/research/2026-09-24-assistant/06-sg-rest-guidelines.md). The Employment Act
// sets a rest day a week and working-hour caps; rest between shifts, the most nights
// in a row and days off after nights are recommended practice with no MOH minimum.
// So a manager may soften or turn off a rest rule, always with REST_PRACTICE_WARNING,
// and a repair may soften one (never delete it) after the ward-internal fixes.
//
// CONTROLLER RULINGS (2026-09-24, binding over the spec draft):
// - No `mark_person_off` arm exists. The borrowed/float nurse repair is expressed
//   with EXISTING arms: `add_person`, then `set_off_request` at weight "must" over
//   the dates she is NOT covering (she is free only on the short dates).
// - Staffing requirements are EXACT counts (`qualifiedPeople` bans everyone else),
//   so "lower a staffing minimum" means editing `requiredNumPeople` of an exact
//   requirement via `edit_staffing_requirement` / `set_staffing_requirement_people`.
// - A skill mix (`skillMix` on a staffing requirement: at least k of a group among its
//   staff, banning nobody) is set with `set_skill_mix` or
//   `add_staffing_requirement.skillMix` (bead nursing-sheduler-2ti). The assistant can
//   add or raise one, and it never removes or lowers one. No repair proposes one, and a
//   skill-mix gap is repaired by borrowing into that group (manager confirms the
//   qualification) or asking a qualified nurse on leave.
// - "Run one short" lowers a single-date requirement outright, and gives any other
//   head count a one-date exception (`set_staffing_requirement_on_date`); every other
//   date keeps its number.

import type { CapabilityId } from "@/lib/capability/help-content";
import type { AssistantCommandType, AssistantCommandV1 } from "@/lib/proposal/commands";

export const PLAYBOOK_VERSION = "2026-09-24.9";

/** Said on the Preview and in the reply whenever a change relaxes a rest rule. */
export const REST_PRACTICE_WARNING =
  "This is a recommended rest practice, not a legal rule. Nurses may be more tired; consider a day off after nights.";

/** Employment Act: at most 12 WORKING hours a day incl. overtime (span minus the unpaid break). */
export const MAX_DAILY_WORKING_MINUTES = 12 * 60;

/**
 * True when a change turns off, deletes or softens a shift sequence (rest) rule.
 * ponytail: reads the commands only, so an edit that narrows a rule but keeps it hard
 * carries no warning; pass the before-state if that ever matters.
 */
export function relaxesRestRule(commands: readonly AssistantCommandV1[]): boolean {
  return commands.some((c) => {
    if (c.type === "set_rule_enabled") return c.ruleKind === "successions" && !c.enabled;
    if (c.type === "remove_rule") return c.ruleKind === "successions";
    if (c.type === "edit_succession_rule") return !/infinity/i.test(c.weight);
    return false;
  });
}

/** Names from plan 2026-09-24-assistant-optimize-run. Change here only. */
export const OPTIMIZE_RUN_TOOL = "request_optimize_run";
export const OPTIMIZE_RESULT_TOOL = "get_optimize_result";

export type SetupStepId =
  | "dates"
  | "people"
  | "shiftTypes"
  | "rules"
  | "requests"
  | "run"
  | "review";

export interface SetupStepGuide {
  id: SetupStepId;
  label: string;
  optional: boolean;
  capabilityId: CapabilityId;
  /** The minimum facts to ask for. Ask only what the schedule does not already say. */
  ask: readonly string[];
  /** Operations (prepare_scenario_change arms) or tools this step uses. */
  proposeWith: readonly string[];
}

export const SETUP_STEPS: readonly SetupStepGuide[] = [
  {
    id: "dates",
    label: "Set the dates",
    optional: false,
    capabilityId: "roster-period",
    ask: ["The first and last day of the roster.", "Whether to import the public holidays."],
    proposeWith: ["set_roster_range"],
  },
  {
    id: "people",
    label: "Add your staff",
    optional: false,
    capabilityId: "staff-list",
    ask: [
      "The nurses' names, as they should appear on the roster.",
      "Which of them are RNs, seniors or in another group that a rule will need.",
    ],
    proposeWith: ["add_person", "add_people_group"],
  },
  {
    id: "shiftTypes",
    label: "Define the shifts",
    optional: false,
    capabilityId: "shift-types",
    ask: [
      "Each shift's code, start time and end time. Suggest the unpaid break; do not ask for it.",
      "If the user is unsure, suggest a common pattern to confirm: three 8-hour shifts (morning, afternoon, night) or 12-hour day and night shifts.",
    ],
    proposeWith: ["add_shift_type", "add_shift_group"],
  },
  {
    id: "rules",
    label: "Set staffing and rules",
    optional: false,
    capabilityId: "staffing-requirements",
    ask: [
      "How many nurses each shift needs, and any skill mix: a minimum from a group among them, such as at least 2 RNs of the 4 on nights. Set it with set_skill_mix or skillMix on add_staffing_requirement; never approximate it by naming who may work the whole shift.",
      "The rest rules the ward uses. Many wards use no day shift straight after a night as a must, and a day off after nights as a preference.",
      "Limits such as the most nights one nurse may work in the period, and whether to balance nights and weekends across the team.",
      "Suggest a rule giving each nurse at least 1 rest day a week, which the Employment Act sets: a shift sequence rule of ALL 7 days in a row at -infinity (no 7 working days in a row), not a total over the period.",
    ],
    proposeWith: [
      "add_staffing_requirement",
      "set_skill_mix",
      "add_succession_rule",
      "add_count_rule",
    ],
  },
  {
    id: "requests",
    label: "Requests and leave",
    optional: true,
    capabilityId: "leave-and-requests",
    ask: [
      "Who has leave or a fixed day off in this period, and on which days. 'Nobody' is a fine answer.",
    ],
    proposeWith: ["add_leave", "set_off_request", "set_shift_request"],
  },
  {
    id: "run",
    label: "Generate the roster",
    optional: false,
    capabilityId: "generate-roster",
    ask: ["Whether to run Optimize now."],
    proposeWith: [OPTIMIZE_RUN_TOOL],
  },
  {
    id: "review",
    label: "Review the roster",
    optional: false,
    capabilityId: "roster-viewer",
    ask: [],
    proposeWith: [OPTIMIZE_RESULT_TOOL],
  },
];

export const SETUP_INSTRUCTIONS: readonly string[] = [
  "Work on nextStep only. Ask its pick-one questions that the schedule does not already answer on one offer_choices card, up to four with moreQuestions, the usual ward value first; ask in text only what has no set answers, such as names.",
  "Never guess a date, number, name or time. If the user is unsure, offer a common ward default and ask them to confirm it.",
  "Put the whole step in one prepare_scenario_change (split it only above the operation limit), say what Apply will do, and stop.",
  "After the user applies, call get_setup_progress again and continue with the new nextStep.",
  "If the user says an optional step does not apply (for example nobody has leave), move on to the step after it.",
  "If knownGaps is above 0, call suggest_feasibility_options before offering to run Optimize.",
];

export type RepairId =
  | "align_overlapping_requirements"
  | "soften_hard_request"
  | "extra_shift_willing_nurse"
  | "relax_count_rule"
  | "soften_rest_rule"
  | "borrow_temporary_nurse"
  | "ask_nurse_on_leave"
  | "run_one_short"
  | "split_long_shift";

/** Who must agree before the change is real. */
export type Confirmation = "manager" | "named_nurse" | "lending_ward";
/** How that agreement is captured: the Apply press itself, a host question on the Preview, or chat only. */
export type EnforcedBy = "apply" | "host_question" | "chat";

export interface RepairEntry {
  id: RepairId;
  title: string;
  whenToUse: string;
  disruption: "low" | "medium" | "high";
  confirmation: Confirmation;
  enforcedBy: EnforcedBy;
  /** Empty for advice-only repairs (the assistant opens the screen instead). */
  opTypes: readonly AssistantCommandType[];
  guardrail: string;
}

export const REPAIRS: readonly RepairEntry[] = [
  {
    // A static requirement_conflict: no staffing change helps until the rules agree.
    id: "align_overlapping_requirements",
    title: "Make overlapping staffing requirements agree",
    whenToUse:
      "Two staffing requirements on the same shift ask for exact numbers that cannot both hold.",
    disruption: "medium",
    confirmation: "manager",
    enforcedBy: "apply",
    opTypes: ["set_staffing_requirement_people"],
    guardrail:
      "Only raise the wider requirement to match. Never lower a skill-mix requirement: otherwise open the Staffing requirements screen.",
  },
  {
    id: "soften_hard_request",
    title: "Turn a hard shift request into a strong preference",
    whenToUse: "A hard 'must' or 'never' request takes away the qualified nurse a shift needs.",
    disruption: "low",
    confirmation: "named_nurse",
    enforcedBy: "chat",
    opTypes: ["set_shift_request", "set_off_request"],
    guardrail: "Keep it hard if it is for health, childcare or another formal agreement.",
  },
  {
    id: "extra_shift_willing_nurse",
    title: "One extra shift for a willing nurse",
    whenToUse: "A nurse's own hard limit is what starves the shift.",
    disruption: "medium",
    confirmation: "named_nurse",
    enforcedBy: "host_question",
    opTypes: ["edit_count_rule"],
    guardrail:
      "Only within the Employment Act's working-hour limits and the nurse's contract, and only with that nurse's agreement.",
  },
  {
    id: "relax_count_rule",
    title: "Relax one named limit for this period",
    whenToUse: "A team-wide hard limit (for example the most nights each) cannot cover the demand.",
    disruption: "medium",
    confirmation: "manager",
    enforcedBy: "apply",
    opTypes: ["edit_count_rule"],
    guardrail:
      "Raise by the smallest amount that closes the gap, at most 2, and ask the manager to check legal limits.",
  },
  {
    id: "soften_rest_rule",
    title: "Turn a hard rest rule into a strong preference for this period",
    whenToUse:
      "The run failed with no certain cause and the ward has hard rest rules. Rest rules are recommended practice, not law.",
    disruption: "medium",
    confirmation: "manager",
    enforcedBy: "apply",
    opTypes: ["edit_succession_rule"],
    guardrail:
      "Soften only: never delete it or turn it off, keep who, which shifts and which dates it covers, and always pass on the rest-practice warning.",
  },
  {
    id: "borrow_temporary_nurse",
    title: "Borrow a float, agency or other-ward nurse for the short dates",
    whenToUse: "The ward has too few free nurses on some dates.",
    disruption: "medium",
    confirmation: "lending_ward",
    enforcedBy: "host_question",
    // No `mark_person_off` arm exists: add the nurse, then pin her OFF (weight "must")
    // over every date she is not covering, so she is free only on the short dates
    // (controller ruling, 2026-09-24). A "must" shift request puts her on the short shift, and
    // a hard count rule she would inherit is narrowed to the ward's own staff in the
    // same change.
    opTypes: ["add_person", "set_off_request", "set_shift_request", "edit_count_rule"],
    guardrail:
      "Put her in a skill group only when the manager confirms her qualification. Never invent a name.",
  },
  {
    id: "ask_nurse_on_leave",
    title: "Ask a named nurse on leave to cover one shift",
    whenToUse: "A qualified nurse is on leave on the one day that is one nurse short.",
    disruption: "high",
    confirmation: "named_nurse",
    enforcedBy: "host_question",
    opTypes: ["clear_requests"],
    guardrail:
      "One day only, only with her agreement, and never someone on sick or compassionate leave.",
  },
  {
    id: "run_one_short",
    title: "Run the shift one short on those dates",
    whenToUse:
      "A head-count shift is one short on up to 3 dates and nobody else can be found. More dates is a staffing standard for the manager, not a one-off.",
    disruption: "high",
    confirmation: "manager",
    enforcedBy: "apply",
    // A single-date rule is lowered. Any other head count gets a one-date exception.
    opTypes: [
      "set_staffing_requirement_people",
      "edit_staffing_requirement",
      "set_staffing_requirement_on_date",
    ],
    guardrail:
      "Head count only, never below 1 or below its skill mix, and never for a skill-mix gap such as 1 RN per night.",
  },
  {
    id: "split_long_shift",
    title: "Split a long shift so part-timers can cover half",
    whenToUse: "A long shift (11 hours or more) is short.",
    disruption: "high",
    confirmation: "manager",
    enforcedBy: "apply",
    opTypes: [],
    guardrail: "Advice only: open the Shifts screen, do not prepare it.",
  },
];

export type Situation = "capped" | "acute" | "chronic" | "unexplained";

export const REPAIR_ORDER: Record<Situation, readonly RepairId[]> = {
  capped: [
    "align_overlapping_requirements",
    "extra_shift_willing_nurse",
    "relax_count_rule",
    "borrow_temporary_nurse",
    "run_one_short",
  ],
  acute: [
    "align_overlapping_requirements",
    "soften_hard_request",
    "borrow_temporary_nurse",
    "ask_nurse_on_leave",
    "run_one_short",
    "split_long_shift",
  ],
  chronic: [
    "align_overlapping_requirements",
    "borrow_temporary_nurse",
    "run_one_short",
    "split_long_shift",
  ],
  // Spec: 1, 3, as hypotheses. A whole-period borrow is not a guess worth testing.
  // Softening a rest rule comes last. Only here: the static check does not model rest
  // rules, so it never blames them for a proven gap.
  unexplained: ["soften_hard_request", "relax_count_rule", "soften_rest_rule"],
};

/** More short dates than this is a staffing problem, not a bad day. */
export const CHRONIC_DATE_COUNT = 3;
export const MAX_CAP_RAISE = 2;
export const MAX_OPTIONS = 3;
export const MAX_BORROWED = 3;
export const MAX_EXPLAINED_FINDINGS = 5;
/** The strength a softened request gets (a finite weight the solver may break only if it must). */
export const SOFT_REQUEST_WEIGHT = 10;
export const LONG_SHIFT_MINUTES = 660;

export const SAFETY_FLOOR: readonly string[] = [
  "Never delete a rest rule, such as no day shift straight after a night, or narrow who or what it covers. Softening it or turning it off is the manager's call and always carries the rest-practice warning.",
  "Never relax or turn off a supervision (preceptor) rule.",
  "Never remove or lower a skill-mix requirement, such as 1 RN on every night, change its group or delete that group, and never ban everyone else from a shift to stand in for one.",
  "Never set a staffing requirement to 0 or turn one off.",
  "Never raise a limit by more than 2, or remove a limit.",
  "Never remove or move leave without the nurse's own agreement, and never ask a nurse on sick or compassionate leave.",
  "Never put a borrowed nurse in a skill group unless the manager confirms her qualification.",
  "Never invent a person's name.",
];

export const FEASIBILITY_INSTRUCTIONS: readonly string[] = [
  "Say in one or two sentences which day and shift is short and why, naming the numbers and who is away.",
  "Findings from the static check are certain and may be stated as the cause. If there are none, say the cause is unknown and that the options are guesses to test.",
  "Offer the options in order, one line each, saying who must agree. Offer no more than three.",
  "Ask every needsFromUser question before preparing an option. Never invent an answer.",
  "After an infeasible Optimize run, test the options' operations with test_feasibility_candidates before calling any option tested. Otherwise call it untested.",
  "Prepare only the option the user picks. The app then asks for the agreement it needs, and the user applies it and runs Optimize again.",
  "Never suggest anything in safetyFloor, even if the user asks.",
];
