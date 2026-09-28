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
// CONTROLLER RULINGS (2026-09-24, binding over the spec draft; d582 of 2026-09-27):
// - No `mark_person_off` arm exists, and a borrowed/float nurse is no longer a roster
//   person. The repair books TEMPORARY COVERS (`add_temporary_cover`): one per short
//   (date, shift), each a staffing credit on one date and one shift, so no rule, pin
//   or roster cell names her and nothing else about the ward changes.
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

export const PLAYBOOK_VERSION = "2026-09-28.3";

/**
 * How every `offer_choices` option must read (bead tpt2). The card is a pick, not a prompt:
 * each option is a complete answer the user can choose without reading anything else, and a
 * numeric question offers the concrete numbers with their unit while the card's own
 * free-text box carries any other answer. Never a bare action such as "Set a number". The
 * `offer_choices` tool description carries these lines, and the tool refuses a label listed
 * in `PLACEHOLDER_OPTION_LABELS` (use-choice-tools) so the rule has a runtime edge too.
 */
export const CHOICE_OPTION_RULES: readonly string[] = [
  "Every option is a complete, self-explanatory answer the user can pick on its own, not an action or a prompt for more: write the answer itself.",
  "When the question needs a number, offer the concrete numbers with their unit as the options, for example '1 senior every night' and '2 seniors every night'; the card's free-text box already carries any other answer.",
  "Never offer a placeholder such as 'Set a number', 'Choose a value', 'Custom', 'Other value' or 'Enter a number'.",
  "Never re-ask a question the user already answered in this thread; use their earlier answer.",
];

/** Said on the Preview and in the reply whenever a change relaxes a rest rule. */
export const REST_PRACTICE_WARNING =
  "This is a recommended rest practice, not a legal rule. Nurses may be more tired; consider a day off after nights.";

/** Said in the reply whenever a change adds or sets a balance (as close to T as possible) rule. */
export const BALANCE_RULE_NOTE =
  "A fairness rule gives the optimiser more to weigh up: the run can take longer, and it may stop at its time limit with a usable roster that is not proven the best.";

/**
 * True when a change adds or sets a count rule of the balance kind (bead hnd). Only
 * `|x - T|^2` counts: it is the one expression the solver scores as a squared gap per
 * person, which is what slows a run. The other five (`x <= T`, `x = T`, ...) are a single
 * yes/no per person, the same cost as any cap, whether or not the ward calls it fair.
 */
export function setsBalanceRule(commands: readonly AssistantCommandV1[]): boolean {
  return commands.some(
    (c) =>
      (c.type === "add_count_rule" || c.type === "edit_count_rule") && c.expression === "|x - T|^2",
  );
}

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
    if (c.type === "edit_shift_sequence_rule") return !/infinity/i.test(c.weight);
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
    ask: [
      "The first and last day of the roster.",
      "Recommend 28 days (4 weeks) first, since a roster period is usually 4 weeks, not a calendar month: offer '4 weeks: 1-28 Oct', or, when the previous period's end or the staff's history is known, 'day after the last period + 27 days'. Offer the calendar month as the second option. Never present 28 days as \"only\".",
      "Whether to import the public holidays.",
    ],
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
      "'Optional, ideally N' (or 'at least R, ideally N') is requiredNumPeople R, often 0, plus preferredNumPeople N on add_staffing_requirement. A required count alone is exact, and a required count of 0 alone forbids the shift.",
      "Ask about every worked shift the step's detail lists with no staffing requirement, on a choice card with the usual numbers, such as '1 senior every night' and 'Optional: 0 required, ideally 1 senior'; never guess it.",
      // Bead 4h5a: spike numbers in the bead notes (13 nurses, 31 days: exact counts left 12 days off each and A_sup empty; these weights filled A_sup every day, then 7 third mornings).
      "After the staffing numbers, read staffingBalance from get_setup_progress and say its sentence in plain words. When spareShifts is above 0 the staff can work more than the minimums need: on one offer_choices card ask where the spare shifts go, by default first an optional senior lead slot (ideally 1 senior), then a 3rd nurse on mornings, then a 3rd on afternoons, and ask each nurse's contracted working days (default shiftsEach, 5 in every 7 days). Then set preferredNumPeople on those requirements with weights -300, -200 and -100 in that order, and add_contracted_hours for the staff, one day either side of the contract (hoursPerShift 8 for a contract in days). The contract's fewest days times the staff must not exceed mostShifts once the 'ideally' counts are set, or no roster is possible.",
      "Prefer a contracted working target over a cap on days off: a cap cannot make anyone work a shift the staffing numbers do not allow. Never propose a days-off cap below staffingBalance.fewestOffDaysEach; show the arithmetic from its sentence instead.",
      "Never say a rule over any 7 days in a row is impossible: add_rest_days_rule is one.",
      "The rest rules the ward uses. Many wards use no day shift straight after a night as a must, and a day off after nights as a preference.",
      "Limits such as the most nights one nurse may work in the period, and whether to balance nights and weekends across the team.",
      "Suggest a rule giving each nurse at least 1 rest day a week, which the Employment Act sets: a shift sequence rule of ALL 7 days in a row at -infinity (no 7 working days in a row), not a total over the period. On any card that offers it, label it a must.",
      "For every ward, also suggest 2 rest days in any 7 days in a row, the usual ward practice, as a strong preference: add_rest_days_rule, one rule for everyone. A week here is any 7 days in a row, not Monday to Sunday. It counts back into the days before the roster from each nurse's history, so when the staff have no history, ask for each nurse's shifts on the last 6 days of the previous month before relying on it.",
      "Anyone who should work together or apart, such as two nurses never on the same night: add_pairing_rule, -infinity for never, a negative number for apart where possible. And any new nurse or student who must always have a named senior or group on shift with them: add_supervision_rule, always a must.",
    ],
    proposeWith: [
      "add_staffing_requirement",
      "set_skill_mix",
      "add_shift_sequence_rule",
      "add_rest_days_rule",
      "add_contracted_hours",
      "add_count_rule",
      "add_pairing_rule",
      "add_supervision_rule",
    ],
  },
  {
    id: "requests",
    label: "Requests and leave",
    optional: true,
    capabilityId: "leave-and-requests",
    ask: [
      "Who has leave or a fixed day off in this period, and on which days. Ask this on an offer_choices card with 'Nobody has leave or days off' and 'Yes, I will list them' as the options; the card's own free-text box stays for the days.",
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

/** Held in the prepare_scenario_change description and the setup instructions (hg9v). */
export const TRUTHFUL_SUMMARY_RULE =
  "The summary, and anything you say about the change before or after Apply, describes only what its operations set; never claim a setting, such as a preferred count, that no operation sets.";

export const SETUP_INSTRUCTIONS: readonly string[] = [
  "Work on nextStep only. Ask its pick-one questions that the schedule does not already answer on one offer_choices card, up to four with moreQuestions, the usual ward value first; ask in text only what has no set answers, such as names. A setup question with a short, common answer set always goes on a choice card, never plain text.",
  "Never guess a date, number, name or time. If the user is unsure, offer a common ward default and ask them to confirm it.",
  "Put the whole step in one prepare_scenario_change (split it only above the operation limit), say what Apply will do, and stop.",
  "After the user applies, call get_setup_progress again and continue with the new nextStep.",
  "If the user says an optional step does not apply (for example nobody has leave), move on to the step after it.",
  "If knownGaps is above 0, call suggest_feasibility_options before offering to run Optimize.",
  TRUTHFUL_SUMMARY_RULE,
];

export type RepairId =
  | "align_overlapping_requirements"
  | "soften_hard_request"
  | "extra_shift_willing_nurse"
  | "relax_count_rule"
  | "soften_rest_rule"
  | "borrow_temporary_nurse"
  | "add_staff_member"
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
    opTypes: ["edit_shift_sequence_rule"],
    guardrail:
      "Soften only: never delete it or turn it off, keep who, which shifts and which dates it covers, and always pass on the rest-practice warning.",
  },
  {
    id: "borrow_temporary_nurse",
    title: "Book a temporary cover nurse for the short dates",
    whenToUse: "The ward has too few free nurses on some dates.",
    disruption: "medium",
    confirmation: "lending_ward",
    enforcedBy: "chat",
    // A cover is a staffing credit, not a solver person (d582): the option books one
    // `add_temporary_cover` per short (date, shift), so no roster cell, count rule or pin
    // is needed. The lending ward is agreed in chat before the covers are shown.
    opTypes: ["add_temporary_cover"],
    guardrail:
      "Put her in a staff group only when the manager confirms her qualification. Never invent a name.",
  },
  {
    // bead 2vtv: a real staff member for the whole period, not a cover. The manager's
    // Apply is the decision; the Staff screen shows the new row (iwo).
    id: "add_staff_member",
    title: "Add a nurse to the staff list for the whole period",
    whenToUse:
      "The ward is short on many days of the period, not just a bad day: a new starter, a transfer or a relief nurse on the roster.",
    disruption: "medium",
    confirmation: "manager",
    enforcedBy: "apply",
    opTypes: ["add_person"],
    guardrail:
      "Head count only: put her in a staff group only when the manager names it. Ask for her name; never invent one.",
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
    "add_staff_member",
    "run_one_short",
    "split_long_shift",
  ],
  // Spec: 1, 3, as hypotheses. A blind borrow is not a guess worth testing.
  // Softening a rest rule comes last. Only here: the static check does not model rest
  // rules, so it never blames them for a proven gap.
  unexplained: ["soften_hard_request", "relax_count_rule", "soften_rest_rule"],
};

/** More short dates than this is a staffing problem, not a bad day. */
export const CHRONIC_DATE_COUNT = 3;
export const MAX_CAP_RAISE = 2;
export const MAX_OPTIONS = 3;
export const MAX_BORROWED = 3;
export const MAX_NEW_STAFF = 2;
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
  `After the user applies a fix, offer a run with ${OPTIMIZE_RUN_TOOL} and never say a run has started; once it finishes, read ${OPTIMIZE_RESULT_TOOL} and say in one sentence whether the schedule can now be built.`,
  "Never suggest anything in safetyFloor, even if the user asks.",
];
