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
// CONTROLLER RULINGS (2026-09-24, binding over the spec draft):
// - No `mark_person_off` arm exists. The borrowed/float nurse repair is expressed
//   with EXISTING arms: `add_person`, then `set_off_request` at weight "must" over
//   the dates she is NOT covering (she is free only on the short dates).
// - Staffing requirements are EXACT counts (`qualifiedPeople` bans everyone else),
//   so "lower a staffing minimum" means editing `requiredNumPeople` of an exact
//   requirement via `edit_staffing_requirement` / `set_staffing_requirement_people`.
// - The assistant cannot create or lower a skill-mix (group-restricted) requirement
//   (bead nursing-sheduler-2ti). No repair proposes one.
// - A single date cannot be overridden on its own (bead nursing-sheduler-2se): "run
//   one short" is advice-only (no ops) unless the requirement it targets already
//   covers that one date alone, in which case `repair-options.ts` may fill ops.

import type { CapabilityId } from "@/lib/capability/help-content";
import type { AssistantCommandType } from "@/lib/proposal/commands";

export const PLAYBOOK_VERSION = "2026-09-24.3";

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
    ask: ["Each shift's code, start time, end time and unpaid break."],
    proposeWith: ["add_shift_type", "add_shift_group"],
  },
  {
    id: "rules",
    label: "Set staffing and rules",
    optional: false,
    capabilityId: "staffing-requirements",
    ask: [
      "How many nurses each shift needs, and how many of them must be from a group such as RNs.",
      "The rest rules the ward uses, for example no day shift straight after a night.",
      "Limits such as the most nights one nurse may work in the period.",
    ],
    proposeWith: ["add_staffing_requirement", "add_succession_rule", "add_count_rule"],
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
  "Work on nextStep only. Ask its questions that the schedule does not already answer, all at once, in plain words.",
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
    opTypes: ["set_shift_request"],
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
    guardrail: "Only within legal rest and contract limits, and only with that nurse's agreement.",
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
    id: "borrow_temporary_nurse",
    title: "Borrow a float, agency or other-ward nurse for the short dates",
    whenToUse: "The ward has too few free nurses on some dates.",
    disruption: "medium",
    confirmation: "lending_ward",
    enforcedBy: "host_question",
    // No `mark_person_off` arm exists: add the temporary nurse, then pin her OFF
    // (weight "must") over every date she is not covering, so she is free only on
    // the short dates (controller ruling, 2026-09-24). A "must" shift request puts her
    // on the short shift, and a hard count rule she would inherit is narrowed to the
    // ward's own staff in the same change.
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
    title: "Run the shift one short on that date",
    whenToUse: "A head-count shift is one short and nobody else can be found.",
    disruption: "high",
    confirmation: "manager",
    enforcedBy: "apply",
    // Advice-only unless the requirement already targets that one date alone: a
    // single-date override is not expressible (bead nursing-sheduler-2se), so a
    // requirement spanning more dates cannot be edited for just the short one.
    opTypes: ["set_staffing_requirement_people", "edit_staffing_requirement"],
    guardrail:
      "Head count only, never below 1, never a skill-mix requirement such as 1 RN per night.",
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
  unexplained: ["soften_hard_request", "relax_count_rule"],
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
  "Never relax or turn off a rest rule, such as no day shift straight after a night.",
  "Never relax or turn off a supervision (preceptor) rule.",
  "Never lower a skill-mix requirement, such as 1 RN on every night, and never create one.",
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
