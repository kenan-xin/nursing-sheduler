// What the assistant is told about the current document (T04, closed
// no-consent/no-redaction posture).
//
// The product decision this implements is explicit and closed: once AI is enabled
// and Ready, the COMPLETE relevant scenario may be sent on the first request,
// including real names, descriptions, leave and scheduling values. There is no
// classification step here that pretends to detect sensitive text, and no field
// minimisation -- adding either would be a different product than the one that was
// approved.
//
// What "complete relevant context" excludes is equally explicit, and this module is
// where it is enforced by construction: the payload is projected from the scenario
// document and the route alone, so unrelated browser storage, cookies, other local
// files, and above all the OpenRouter credential have no path into it. The
// credential is a request header consumed by server code (T01) and is never a
// context entry, a tool argument, or a message.

import { ROSTER_OWNER, SIGN_OFF_ROLE } from "@/lib/roster-viewer/swap";
import { REST_PRACTICE_WARNING } from "./playbook";
import { toCanonicalScenarioDocument, type ScenarioUiState } from "@/lib/scenario";

/** One context entry, in the shape the transport's context hook accepts. */
export interface AssistantContextEntry {
  description: string;
  value: string;
}

/**
 * JSON with signed infinities preserved as readable markers.
 *
 * Load-bearing: a hard constraint is authored as `Infinity`, and `JSON.stringify`
 * turns that into `null`. Sending `null` would present every hard rule as an
 * absent one -- the model would then reason about a document the user does not
 * have. The markers match the strict YAML spelling the backend uses, so the two
 * representations describe the same value.
 */
export function stringifyScenario(scenario: ScenarioUiState): string {
  return JSON.stringify(toCanonicalScenarioDocument(scenario), (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return Number.isNaN(value) ? "nan" : value > 0 ? ".inf" : "-.inf";
    }
    return value;
  });
}

/** A compact, host-derived overview. The model gets it without asking. */
export interface ScenarioSummary {
  scenarioId: string;
  documentRevision: number;
  description: string | null;
  rosterPeriod: { start: string; end: string };
  counts: {
    people: number;
    peopleGroups: number;
    shiftTypes: number;
    shiftTypeGroups: number;
    dateGroups: number;
    requestCells: number;
    rules: Record<string, number>;
  };
}

export function summarizeScenario(
  scenario: ScenarioUiState,
  identity: { scenarioId: string; documentRevision: number },
): ScenarioSummary {
  const cards = scenario.cardsByKind;
  return {
    scenarioId: identity.scenarioId,
    documentRevision: identity.documentRevision,
    description: scenario.meta.description ?? null,
    rosterPeriod: { start: scenario.rangeStart, end: scenario.rangeEnd },
    counts: {
      people: scenario.staff.length,
      peopleGroups: scenario.staffGroups.length,
      shiftTypes: scenario.shifts.length,
      shiftTypeGroups: scenario.shiftGroups.length,
      dateGroups: scenario.dateGroups.length,
      requestCells: scenario.reqData.length,
      rules: {
        requirements: cards.requirements.length,
        successions: cards.successions.length,
        counts: cards.counts.length,
        affinities: cards.affinities.length,
        coverings: cards.coverings.length,
      },
    },
  };
}

/**
 * What the model must know about wards and the solver on EVERY turn (2026-09-24
 * knowledge upgrade, backlog ranks 2, 4, 6, 10). Longer explanations live in the help
 * registry (`scheduler-limits` and the rule entries) and are read on demand. Sits after
 * the Employment Act line, which stays the one stated law.
 */
export const KNOWLEDGE_LINES: readonly string[] = [
  "Beyond those Employment Act facts, you are not a source of law or policy: never state a ministry rule or nurse ratio as fact; say the ward decides, and offer the ward's own rule.",
  "A staffing number is exact, not a minimum: for 'at least 2, ideally 3', prepare 2 and say the preferred 3 is set on the Staffing requirements screen.",
  "A skill mix (for example at least 1 RN on a shift, others allowed too) is set with set_skill_mix, or skillMix on add_staffing_requirement; never lower or remove one, and never approximate it by naming who may work the whole shift.",
  "Before promising a rule, make sure the app can express it; when unsure, read explain_app_capability for scheduler-limits and say plainly what it cannot do.",
  "A new optimiser run can change everyone's shifts: for one change to a roster staff already have, such as a nurse on MC, say so and use the cover steps above, or hand edits on the Roster screen, before offering a run.",
  "When two people want the same day off and only one can go, offer the choice with offer_choices to whoever decides leave; never decide it yourself.",
];

/**
 * The authority statement.
 *
 * Not decoration: it states the propose-then-Apply contract. The model never
 * mutates the scenario; `prepare_scenario_change` builds a Preview and only the
 * user's Apply changes anything. Without the "use it instead of refusing" line a
 * model falls back to explaining; without the "never claim applied" line it
 * reports Previews as done. Deliberately operation-agnostic: the supported
 * operations live in the tool's own schema, so this text does not go stale as
 * operation families are added.
 */
export const ASSISTANT_AUTHORITY_STATEMENT = [
  "You can read this schedule and explain it. You cannot change it directly.",
  "You can PROPOSE a change with prepare_scenario_change: it shows the user a Preview, and nothing changes until the user presses Apply.",
  "When the user asks for a change that prepare_scenario_change supports, prepare it instead of refusing or only explaining.",
  "Before proposing a change that names people, staff groups, shifts or rules, use their ids exactly as the schedule shows them, and call get_schedule_section (staff, shifts or rules) when unsure; never guess a name. If the app refuses an id and lists the valid ones, choose from that list or ask the user.",
  "If no supported operation covers the change, say so plainly, then use open_app_screen or explain where in the app they can make it.",
  "You can OFFER an optimiser run with request_optimize_run; it starts only when the user presses Run. Read how it went with get_optimize_result, and never say a run has started or finished unless that tool says so.",
  "You can read the saved roster with get_roster; never ask the user who works which shift. To change who works a shift, call find_swap_partners, then prepare_roster_swap: it shows a card, and the roster changes only when the user presses Apply there.",
  `To cover a shift (a swap request, or MC, sick or emergency leave with reason sick_or_emergency), follow the step find_swap_partners returns and say it in plain words: step 1 swap or cover within the ward; step 2 ask someone who is off or on leave to come in, as a request that names the pay-back (overtime pay, or off-in-lieu); step 3 ask the nursing supervisor for the relief pool, then another ward or an agency, with prepare_borrowed_cover, and remind the user to let their ${ROSTER_OWNER} know; step 4, only when the user says no temporary nurse is available, run the shift one short with the ${SIGN_OFF_ROLE}'s sign-off, never dropping the nurse in charge (NIC). Never skip a step, never blame the nurse on MC.`,
  'Never claim to have applied, saved, queued or scheduled anything; a prepared Preview is not applied until the user applies it. After preparing, say "I\'ve prepared ...; check it and press Apply", and never use the past tense (added, turned off, changed) until the user presses Apply.',
  "Tell law from guidance. The law (Employment Act) is: 1 rest day a week, at most 12 working hours a day, including overtime, 44 hours a week averaged over 3 weeks for shift workers, and at most 72 hours of overtime a month. Working hours are a shift's clock time minus its unpaid break: 08:00 to 20:30 with a 2-hour break is 10.5 hours, within the limit.",
  `Rest rules (rest between shifts, the most nights in a row, days off after nights, such as no day shift straight after a night) are recommended practice, not law: MOH sets no minimum rest between shifts, so never give a number for one. When the user asks to turn off, relax or soften a rest rule, prepare it (turn it off rather than delete it) and say in one short line: "${REST_PRACTICE_WARNING}"`,
  "When the user presses Apply, the app itself opens the screen that holds the change and outlines what changed; when you prepare a change, tell the user which screen that will be.",
  "When the user's message says they applied a change, reply in one short line that confirms it and moves to the next step (call get_setup_progress when setting up); do not ask them to confirm again.",
  "When their message says an optimiser run finished and failed, call get_optimize_result, then suggest_feasibility_options, and offer its options with offer_choices.",
  "When the user names a month without a year, use the next such month from today's date, and check it against the roster period if one is set.",
  "To set up a schedule step by step, call get_setup_progress and follow its nextStep. When a schedule is short-staffed or an Optimize run is infeasible, call suggest_feasibility_options and offer at most three of its options.",
  "Never write a pick-one question as plain text (for example 'Ben Tan or Chloe Lim?', 'yes or no?', which option?): call offer_choices instead and keep your text to one short line; set multiple true only when several answers can be true together, never for alternatives such as repair options, yes/no or did-you-mean.",
  ...KNOWLEDGE_LINES,
  "The people you help are nurses and nurse managers, not technical users.",
  "Talk like a helpful colleague on the ward, not a manual: warm, short and to the point.",
  "Use everyday words a nurse uses; no technical or product jargon, ids, tool names or field names.",
  "Keep most replies to one to three short sentences. Use a short list only for real choices or steps.",
  "Do not repeat what the Preview already shows; say in one line what you prepared and what to check.",
  "When a detail has a sensible usual value, suggest it instead of asking; the user can change it in the Preview.",
  "Ask at most one question at a time, and only when you truly cannot choose for them.",
].join(" ");

export interface BuildContextInput {
  scenario: ScenarioUiState;
  scenarioId: string;
  documentRevision: number;
  /** Current route path, e.g. `/shift-requests`. */
  routePath: string;
  /** Human label for that route, when the nav registry knows one. */
  routeLabel: string | null;
  /** The browser clock at send time; injected by tests. */
  now?: Date;
}

/** Local today as "2026-09-24 (Thursday 24 September 2026)". */
export function describeToday(now: Date): string {
  const iso = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const weekday = now.toLocaleDateString("en-GB", { weekday: "long" });
  const month = now.toLocaleDateString("en-GB", { month: "long" });
  return `${iso} (${weekday} ${now.getDate()} ${month} ${now.getFullYear()})`;
}

/** The complete context set attached to a turn. Deliberately only these four. */
export function buildAssistantContext(input: BuildContextInput): AssistantContextEntry[] {
  return [
    {
      description: ASSISTANT_AUTHORITY_STATEMENT,
      value: "propose-then-apply",
    },
    {
      description:
        "The complete current scheduling scenario, as the backend-facing document. " +
        "Weights of `.inf` / `-.inf` are HARD constraints; numeric weights are soft preferences.",
      value: stringifyScenario(input.scenario),
    },
    {
      description: "The screen the user is looking at right now.",
      value: JSON.stringify({
        path: input.routePath,
        label: input.routeLabel,
        scenarioId: input.scenarioId,
        documentRevision: input.documentRevision,
      }),
    },
    {
      description: "Today's date, where the user is.",
      value: describeToday(input.now ?? new Date()),
    },
  ];
}
