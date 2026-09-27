"use client";

// The assistant's roster tools (bead nursing-sheduler-73z, plan 2026-09-24-roster-aware-assistant).
//
// READ, SUGGEST, OFFER. `get_roster` reads the saved roster. `find_swap_partners` asks
// the HOST who can take someone's shifts without breaking a hard rule the roster was
// solved under. `prepare_roster_swap` shows a card with the exact cells. Only the
// user's Apply click changes the roster, through the Roster screen's own edit session
// (`lib/roster/change-request.ts`): one undo step, one autosave, the same export.
// No handler writes a roster or a scenario. The ladder tools prepare a pending LINKED
// proposal (leave move, MC leave, temporary cover) that applies only with the roster cells.
// With no saved roster, `prepare_borrowed_cover` shows a plain Preview of the covers instead.

import { z } from "zod";
import { useModelVisibleTool } from "./register-model-visible-tool";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { OPTIMIZE_RUN_TOOL } from "@/lib/ai/assistant/playbook";
import { rankRepairOptions } from "@/lib/ai/assistant/repair-options";
import { findStaffingShortfalls } from "@/lib/rules/shortfalls";
import { applyAssistantCommands } from "@/lib/proposal";
import {
  buildBorrowView,
  buildOvertimeView,
  buildRosterChangeView,
  buildShortView,
  buildSickView,
  buildTradeView,
  describeRosterChangeOutcome,
  readRosterForAssistant,
  shiftName,
  STEP_LABEL,
  summarizeRoster,
  tradeAgreement,
  type AssistantRosterRead,
  type RosterChangeView,
} from "@/lib/ai/assistant/roster-context";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { generateDateItems } from "@/lib/dates/date-id";
import type { AssistantCommandV1 } from "@/lib/proposal";
import { deriveCurrentDays, type RosterDocument } from "@/lib/roster";
import type { RequirementCover } from "@/lib/roster-viewer/requirements";
import { readRosterChangeOutcome, type RosterCellChange } from "@/lib/roster/change-request";
import { countHeadroom, dayCode, deriveRuleModel, plainDate } from "@/lib/roster-viewer/rule-check";
import {
  type CoverLadder,
  findCoverLadder,
  findDateIdx,
  findPersonIdx,
  givingProblem,
  personName,
  planSickCover,
  planSwap,
  planTrade,
  ROSTER_OWNER,
  SIGN_OFF_ROLE,
  type SwapContext,
  type SwapPlan,
  type TradeVariant,
} from "@/lib/roster-viewer/swap";
import type { PersonRef } from "@/lib/scenario";
import { isRosterSaved } from "@/lib/optimize/roster-generated";
import {
  assistantProposalCommands,
  pickScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { assertTurnAuthority, SUPERSEDED } from "./turn-authority";

const DATE_HELP = "A roster date as YYYY-MM-DD.";

export const rosterReadParameters = z.object({
  fromDate: z.string().optional().describe(`${DATE_HELP} Omit to start at the roster's first day.`),
  toDate: z.string().optional().describe(`${DATE_HELP} Omit to end at the roster's last day.`),
  people: z
    .array(z.string().min(1))
    .max(40)
    .optional()
    .describe("Only these people, by the name the roster shows. Omit for everyone."),
});

const REASON = z
  .enum(["swap", "sick_or_emergency"])
  .describe(
    "swap: the person wants to change these shifts. sick_or_emergency: the person is on sick, " +
      "MC or emergency leave on these dates; they go on leave and take nothing back.",
  );

export const swapPartnerParameters = z.object({
  person: z
    .string()
    .min(1)
    .describe("The person who needs to give up shifts, as the roster names them."),
  dates: z.array(z.string()).min(1).max(7).describe(`The dates they need to give up. ${DATE_HELP}`),
  reason: REASON,
  noTemporaryNurse: z
    .boolean()
    .optional()
    .describe(
      "true ONLY after the user says the relief pool, other wards and agencies have nobody.",
    ),
});

export const swapPrepareParameters = swapPartnerParameters.extend({
  partner: z
    .string()
    .optional()
    .describe(
      "Who takes the shifts, as the roster names them. Omit only to record sick leave with no cover.",
    ),
  laterDates: z
    .array(z.string())
    .max(7)
    .optional()
    .describe(
      `Step 2 trades only: the later dates from find_swap_partners, in the same order. ${DATE_HELP}`,
    ),
  summary: z
    .string()
    .min(1)
    .describe("Why, in one plain sentence a ward manager understands. Shown as your reasoning."),
});

export const borrowParameters = z.object({
  person: z.string().min(1).describe("Whose shifts are uncovered, as the roster names them."),
  dates: z.array(z.string()).min(1).max(7).describe(`The uncovered dates. ${DATE_HELP}`),
  reason: REASON,
  name: z
    .string()
    .min(1)
    .describe(
      "The nurse's name as the user said it, with the lending ward in brackets, for example " +
        "Haseena (Ward 3). Never invent one.",
    ),
  names: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe(
      "With no saved roster, when more than one nurse is missing: the other lent nurses' names, " +
        "written like name. One cover is booked per name. Never invent one.",
    ),
  groups: z
    .array(z.string())
    .max(5)
    .describe("Staff groups the nurse belongs to. The app adds the skill group the shift needs."),
  lenderConfirmed: z
    .boolean()
    .describe(
      "true ONLY after the user said in chat that the lending ward or agency agreed to lend this " +
        "nurse, or every nurse named in names.",
    ),
  summary: z.string().min(1).describe("Why, in one plain sentence. Shown as your reasoning."),
});

const PLAIN_WORDS =
  " Name shifts as shiftNames gives them, never by code, and call each nurse by name rather than a pronoun.";

type Linked = {
  proposalId: string;
  baseDocumentRevision?: number;
  assumptionIds: string[];
  assumptions: { type: string; question: string }[];
};

/**
 * Prepare the schedule half of a roster change as a LINKED proposal: validated by the
 * same host transforms as any Preview, but shown on the roster card instead of as a
 * separate Preview, and applied with the roster cells or not at all (Task 9A).
 */
async function prepareLinked(
  commands: AssistantCommandV1[],
  rationale: string,
): Promise<{ ok: true; linked: Linked } | { ok: false; message: string }> {
  const outcome = await assistantProposalCommands.prepare({
    proposalId: crypto.randomUUID(),
    threadId: null,
    turnId: useAssistantStore.getState().activeTurnId,
    registryStamp: capabilityRegistryStamp(),
    commands,
    rationale,
    evidence: [{ kind: "user_statement", label: "Asked to cover a shift", reference: null }],
    outcome: "untested",
  });
  if (outcome.ok) {
    return {
      ok: true,
      linked: {
        proposalId: outcome.proposal.proposalId,
        baseDocumentRevision: outcome.proposal.baseDocumentRevision,
        assumptionIds: outcome.proposal.assumptions.map((a) => a.assumptionId),
        assumptions: outcome.proposal.assumptions.map((a) => ({
          type: a.type,
          question: a.question,
        })),
      },
    };
  }
  if (outcome.reason === "rejected") {
    return {
      ok: false,
      message: `The schedule could not take that change, so no card was shown: ${outcome.rejection.message}`,
    };
  }
  if (outcome.reason === "not-owner") {
    return {
      ok: false,
      message:
        "This schedule is being edited in another tab, so nothing was prepared. Tell the user they can take over editing in this tab.",
    };
  }
  if (outcome.reason === "fenced") return { ok: false, message: SUPERSEDED };
  return {
    ok: false,
    message: "The app could not prepare that change right now, and nothing was altered.",
  };
}

/** `move_leave` takes the LIVE schedule's span-formatted date id, not an ISO date. */
function liveDateId(iso: string): string | null {
  const scenario = pickScenario(useScenarioStore.getState());
  return (
    generateDateItems({ start: scenario.rangeStart, end: scenario.rangeEnd }).find(
      (item) => item.iso === iso,
    )?.id ?? null
  );
}

/** One `add_leave` per date: the MC goes into the leave record so a new run knows. */
const addLeave = (personId: PersonRef, isos: readonly string[]): AssistantCommandV1[] =>
  isos.map(
    (iso): AssistantCommandV1 => ({ type: "add_leave", personId, startDate: iso, endDate: iso }),
  );

/** The partners the ladder ranked for these dates, best first; empty from step 3 up. */
const rankedPartners = (ctx: SwapContext, ladder: CoverLadder): string[] => [
  ...new Set(
    [...ladder.candidates, ...ladder.overtime, ...ladder.trades].map((c) =>
      personName(ctx.context, c.partnerIdx),
    ),
  ),
];

/**
 * The valid choices for a refusal: the ranked partners, else everyone else on the roster.
 *
 * An OBJECT, never a bare string: CopilotKit passes a string result to the model verbatim,
 * so a ward-supplied name inside the sentence could carry a newline and start a forged
 * line. `partners` carries the same names as data, and `guidance` the same wording.
 */
function partnerChoices(
  ctx: SwapContext,
  personIdx: number,
  ladder: CoverLadder,
): { guidance: string; partners: string[] } {
  const ranked = rankedPartners(ctx, ladder);
  if (ranked.length > 0) {
    return {
      guidance: `Partners who can take these shifts: ${ranked.join(", ")}.`,
      partners: ranked,
    };
  }
  const others = ctx.context.people.flatMap((p, i) => (i === personIdx ? [] : [String(p.id)]));
  return {
    guidance: `Nobody can take these shifts as the roster stands. People on it: ${others.join(", ")}.`,
    partners: others,
  };
}

/** "Step 1 still has options: SN-Cara, SN-Eve." The lower step comes first. */
const stillHasOptions = (
  ctx: SwapContext,
  ladder: CoverLadder,
): { guidance: string; partners: string[] } => {
  const ranked = rankedPartners(ctx, ladder);
  return {
    guidance: `Step ${ladder.step} still has options${ranked.length > 0 ? `: ${ranked.join(", ")}` : ""}.`,
    partners: ranked,
  };
};

const CARD_SHOWN =
  "The user now sees a card with the exact change and every rule it was checked against. " +
  "Nothing has changed yet; only the user can apply it, on the card. Do not say the roster " +
  'has changed: say "I\'ve prepared ...", and never use the past tense until the user ' +
  "presses Apply. In one short sentence, say which step this is and who does what. Then wait.";

/** Step 4 with no shortfall: the ward need is met without the person (a cover may fill it). */
const nothingToCover = (ladder: CoverLadder): boolean =>
  ladder.step === 4 && ladder.short?.ok === true && ladder.short.shortfalls.length === 0;

const NOTHING_TO_COVER =
  "Nothing to cover: the ward still has enough staff on these shifts without this nurse " +
  "(a temporary cover may already fill it).";

const ROSTER_BUSY =
  "The user is applying the last roster change right now, so no new card was shown and " +
  "nothing was altered. Wait for it to finish, then ask again.";

/**
 * Show the card, or cancel the just-prepared linked proposal when the card is busy. A
 * card this one replaces takes its linked proposal with it, so none is left applicable.
 */
function showCard(
  change: Parameters<typeof assistantActions.showRosterChange>[0],
  turnEpoch: number,
): boolean {
  const replaced = useAssistantStore.getState().activeRosterChange?.linked ?? null;
  if (assistantActions.showRosterChange(change, turnEpoch)) {
    if (replaced) void assistantProposalCommands.cancel(replaced.proposalId);
    return true;
  }
  if (change.linked) void assistantProposalCommands.cancel(change.linked.proposalId);
  return false;
}

/**
 * With no saved roster (after an infeasible run) a cover is still just a staffing credit
 * (bead 20wo): the covers are the scenario's own short (date, shift) slots on these dates,
 * the same ones suggest_feasibility_options' borrow repair books. Each missing nurse the
 * repair counts is one named cover, in its order (bead v9lu): the user's names go to them in
 * turn, and the ones left unnamed are `missing`. The repair gives a nurse at most one slot a
 * day, so no name lands twice on a date and shift. A sick nurse named in the scenario gets her
 * leave first (`add_leave`, as the Requests screen records it), so her own shifts count too.
 */
function scenarioCovers(
  args: Pick<z.infer<typeof borrowParameters>, "person" | "reason" | "groups" | "dates">,
  names: readonly string[],
): {
  covers: Extract<AssistantCommandV1, { type: "add_temporary_cover" }>[];
  missing: number;
  leave: AssistantCommandV1[];
  shortDates: string[];
} {
  const live = pickScenario(useScenarioStore.getState());
  const personIdx =
    args.reason === "sick_or_emergency" ? findPersonIdx({ people: live.staff }, args.person) : -1;
  const leave = personIdx < 0 ? [] : addLeave(live.staff[personIdx].id, args.dates);
  // A leave the record refuses (already on leave, a date off the period) is left out.
  const withLeave = applyAssistantCommands(live, leave);
  const [state, recorded] = withLeave.ok ? [withLeave.next, leave] : [live, []];
  const borrow = rankRepairOptions(state, findStaffingShortfalls(state), {
    runInfeasible: true,
  }).find((option) => option.repairId === "borrow_temporary_nurse");
  const slots = (borrow?.operations ?? []).flatMap((op) =>
    op.type === "add_temporary_cover" ? [op] : [],
  );
  const onDates = slots.filter((op) => args.dates.includes(op.date));
  // The repair names its nurses "Borrowed nurse 1", "Borrowed nurse 2"...: one per missing nurse.
  const nurses = [...new Set(onDates.map((op) => op.name))];
  const covers = onDates.flatMap((op) => {
    const name = names[nurses.indexOf(op.name)];
    return name === undefined
      ? []
      : [{ ...op, name, groups: [...new Set([...args.groups, ...op.groups])] }];
  });
  return {
    covers,
    missing: Math.max(0, nurses.length - names.length),
    leave: recorded,
    shortDates: [...new Set(slots.map((op) => op.date))],
  };
}

/** A cover's date and shift in the scenario's words, so the model names the shift it got. */
function coverSlot(cover: { date: string; shiftType: string }): string {
  const shift = pickScenario(useScenarioStore.getState()).shifts.find(
    (s) => String(s.id) === cover.shiftType,
  );
  return `${plainDate(cover.date)}, ${shift?.description ?? cover.shiftType}`;
}

const NO_ROSTER =
  "There is no saved roster yet. If the user wants one, offer a run with request_optimize_run.";

/**
 * Why there is no roster to read. After a run that made one (bead pu5), "offer a run" is the
 * wrong steer for a change to a roster staff may already work from. Says only what is known:
 * the XLSX only when the download is recorded.
 */
function noRoster(): string {
  const view = useHotStore.getState().runView;
  const made =
    view.lifecycle === "completed" && (view.outcome === "optimal" || view.outcome === "feasible");
  if (!made || isRosterSaved(view)) return NO_ROSTER;
  return (
    "The last optimiser run made a roster, but no copy of it is saved in the app, so you cannot " +
    "see who works when; say so, and never guess it. " +
    (view.download.status === "downloaded" ? "The user downloaded it as an XLSX file. " : "") +
    "For a change to a roster staff already work from, such as a swap or someone off sick, tell " +
    "the user a new run can change everyone's shifts, and use the cover steps instead of offering one."
  );
}
const UNREADABLE =
  "The saved roster cannot be read in this browser right now, and nothing was changed. Tell the " +
  "user, and suggest they open the Roster screen.";
const LOAD_FIRST =
  "A newer roster from the last optimiser run is waiting to be loaded, so no swap was prepared. " +
  "Ask the user to open the Roster screen and press Load first, so the swap is made on the roster they mean.";

type Resolved =
  | { ok: true; ctx: SwapContext; personIdx: number; dateIdxs: number[]; baselineId: string }
  | { ok: false; message: string };

/** The solve's cover ledger plus the scenario's covers right now (d582, spec §4). */
function rosterCover(document: RosterDocument): RequirementCover {
  return {
    decrements: document.cover.decrements,
    live: pickScenario(useScenarioStore.getState()).temporaryCover,
  };
}

function resolveSwap(
  read: AssistantRosterRead,
  person: string,
  dates: readonly string[],
): Resolved {
  if (read.status === "unavailable") return { ok: false, message: UNREADABLE };
  if (read.status === "none") {
    return { ok: false, message: read.newerRunWaiting ? LOAD_FIRST : noRoster() };
  }
  if (read.newerRunWaiting) return { ok: false, message: LOAD_FIRST };
  const { document } = read;
  const model = deriveRuleModel(document.submission, rosterCover(document));
  if (model === null) {
    return {
      ok: false,
      message:
        "The rules this roster was made with cannot be read, so no swap can be checked. The user can " +
        "still change it by hand on the Roster screen.",
    };
  }
  const { context } = document;
  const personIdx = findPersonIdx(context, person);
  if (personIdx < 0) {
    const everyone = context.people.map((p) => String(p.id)).join(", ");
    return {
      ok: false,
      message: `No one called "${person}" is on this roster. People on it: ${everyone}.`,
    };
  }
  const dateIdxs = [...new Set(dates.map((iso) => findDateIdx(context, iso)))].sort(
    (a, b) => a - b,
  );
  if (dateIdxs.some((d) => d < 0)) {
    const isos = context.calendar.map((day) => day.iso);
    return {
      ok: false,
      message: `Some of those dates are outside this roster, which runs from ${isos[0]} to ${isos[isos.length - 1]}.`,
    };
  }
  return {
    ok: true,
    ctx: { context, days: deriveCurrentDays(document.solvedDays, document.edits), model },
    personIdx,
    dateIdxs,
    baselineId: document.provenance.solvedBaselineId,
  };
}

export function useRosterTools(agentId: string, turnEpoch: number): void {
  useModelVisibleTool(
    {
      name: "get_roster",
      agentId,
      description:
        "Read the saved roster: who works which shift, day off or leave on each date, and any hard " +
        "rule it breaks now. Use it for any question about who works when, before suggesting a " +
        "swap, and after the user applies one. Never ask the user who works which shift.",
      parameters: rosterReadParameters,
      handler: async (args, { token, signal }) => {
        const read = await readRosterForAssistant();
        const late = assertTurnAuthority(token, signal);
        if (late) return { guidance: late };
        if (read.status === "unavailable") return { guidance: UNREADABLE };
        if (read.status === "none")
          return { guidance: read.newerRunWaiting ? LOAD_FIRST : noRoster() };
        const summary = summarizeRoster(
          read.document,
          args,
          read.newerRunWaiting,
          rosterCover(read.document),
        );
        if (typeof summary === "string") return { guidance: summary };
        const lastChange = describeRosterChangeOutcome(readRosterChangeOutcome());
        return lastChange === undefined ? summary : { ...summary, lastChange };
      },
    },
    [agentId, turnEpoch],
  );

  useModelVisibleTool(
    {
      name: "find_swap_partners",
      agentId,
      description:
        "Find who can take one person's shifts on some dates without breaking any hard rule the " +
        "roster was made with (staffing, skill mix, rest between shifts, requests, leave, shift " +
        "counts). Returns the lowest step of the cover ladder that has an option (1 swap or " +
        "cover, 2 ask someone off or on leave, 3 a temporary nurse, 4 run one short), the best " +
        "options first, and why others are ruled out. Changes nothing.",
      parameters: swapPartnerParameters,
      handler: async (args, { token, signal }) => {
        const read = await readRosterForAssistant();
        const late = assertTurnAuthority(token, signal);
        if (late) return { guidance: late };
        const resolved = resolveSwap(read, args.person, args.dates);
        if (!resolved.ok) return { guidance: resolved.message };
        const { ctx, personIdx, dateIdxs } = resolved;
        const giving = givingProblem(ctx, personIdx, dateIdxs);
        if (giving !== null) return { guidance: `${giving} Ask the user which dates they mean.` };
        const ladder = findCoverLadder(ctx, personIdx, dateIdxs, args.reason, {
          noTemporaryNurse: args.noTemporaryNurse,
        });
        const iso = (d: number) => ctx.context.calendar[d].iso;
        const common = {
          step: ladder.step,
          stepLabel: STEP_LABEL[ladder.step],
          person: personName(ctx.context, personIdx),
          giving: dateIdxs.map((d) => ({ date: iso(d), shift: dayCode(ctx.days[personIdx][d]) })),
          shiftNames: Object.fromEntries(
            ctx.context.shiftTypes.map((s) => [String(s.id), s.description ?? String(s.id)]),
          ),
          ruledOutCount: ladder.ruledOut.length,
          ruledOutExamples: ladder.ruledOut.slice(0, 5).map((entry) => ({
            partner: personName(ctx.context, entry.partnerIdx),
            reason: entry.reason,
          })),
        };
        const partnerHasNow = (partnerIdx: number) =>
          dateIdxs.map((d) => ({ date: iso(d), shift: dayCode(ctx.days[partnerIdx][d]) }));
        if (ladder.step === 1) {
          return {
            ...common,
            candidates: ladder.candidates.map((c) => ({
              partner: personName(ctx.context, c.partnerIdx),
              kind: c.plan.kind,
              partnerHasNow: partnerHasNow(c.partnerIdx),
              worthKnowing: c.plan.soft.map((issue) => issue.message),
              notChecked: [...c.plan.unchecked],
            })),
            trades: [],
            guidance:
              "Step 1. If the user asked you to just do it, call prepare_roster_swap with the first " +
              "candidate. Otherwise offer at most three with offer_choices, best first. Say " +
              "'cover' when the partner is off, because the person then has those days off." +
              PLAIN_WORDS,
          };
        }
        if (ladder.step === 2) {
          return {
            ...common,
            candidates: [],
            overtime: ladder.overtime.map((c) => {
              const partner = personName(ctx.context, c.partnerIdx);
              const dates = dateIdxs.map((d) => plainDate(iso(d))).join(", ");
              return {
                partner,
                kind: "overtime",
                payBack: "overtime",
                agreement: `${partner} agreed to come in on ${dates} for overtime pay.`,
                worthKnowing: c.plan.soft.map((issue) => issue.message),
                notChecked: [...c.plan.unchecked],
              };
            }),
            trades: ladder.trades.map((t) => ({
              partner: personName(ctx.context, t.partnerIdx),
              kind: "trade",
              payBack: "off-in-lieu",
              variant: t.plan.variant,
              laterDates: t.plan.laterDateIdxs.map(iso),
              movesLeave: t.plan.leaveMoves.length > 0,
              later: t.plan.laterDateIdxs.map((d) => ({
                date: iso(d),
                partnerHasNow: dayCode(ctx.days[t.partnerIdx][d]),
                personGets:
                  t.plan.variant === "person-covers"
                    ? dayCode(ctx.days[t.partnerIdx][d])
                    : "nothing",
              })),
              agreement: tradeAgreement(ctx.context, personIdx, t.partnerIdx, t.plan),
              worthKnowing: t.plan.soft.map((issue) => issue.message),
              notChecked: [...t.plan.unchecked],
            })),
            guidance:
              "Step 2: nobody can swap or cover without extra hours. Ask as a REQUEST, never an " +
              "order, and name the pay-back: overtime pay, or off-in-lieu (the nurse's day off or " +
              "leave moves to the later dates). Offer overtime and off-day trades before leave " +
              "trades, at most three with offer_choices. Never blame the nurse who is on MC. When " +
              "the user picks an overtime request, call prepare_roster_swap with that partner; for " +
              "a trade, add its laterDates." +
              PLAIN_WORDS,
          };
        }
        const needs = ladder.borrow.map((n) => ({ date: iso(n.dateIdx), shift: n.shift }));
        const skillGroups = [
          ...new Set(ladder.borrow.flatMap((n) => (n.skillGroup ? [n.skillGroup] : []))),
        ];
        if (ladder.step === 3) {
          return {
            ...common,
            candidates: [],
            trades: [],
            temporary: { needs, skillGroups },
            guidance:
              "Step 3: ask the nursing supervisor for a nurse from the relief pool first; if none, " +
              `another ward or an agency. Tell the user to let their ${ROSTER_OWNER} know. Ask for ` +
              "the nurse's name and the lending ward, and ask in chat whether the lending ward " +
              "agreed; only once the user says yes, call prepare_borrowed_cover with " +
              "lenderConfirmed true. Never make up a name. If they have nobody, call " +
              "find_swap_partners again with noTemporaryNurse true." +
              (args.reason === "sick_or_emergency"
                ? " If they only want the absence recorded, call prepare_roster_swap without a partner."
                : " For a swap, say it takes effect after the next optimiser run.") +
              PLAIN_WORDS,
          };
        }
        if (nothingToCover(ladder)) {
          return {
            ...common,
            candidates: [],
            trades: [],
            nothingToCover: true,
            guidance:
              `${NOTHING_TO_COVER} Say so plainly; do not offer to run it short. ` +
              (args.reason === "sick_or_emergency"
                ? "To record the absence, call prepare_roster_swap without a partner."
                : "The user can give the nurse these shifts off by hand on the Roster screen.") +
              PLAIN_WORDS,
          };
        }
        const plan = ladder.short;
        return {
          ...common,
          candidates: [],
          trades: [],
          short:
            plan?.ok === true
              ? {
                  allowed: true,
                  shifts: plan.shortfalls.map((s) => ({
                    date: iso(s.dateIdx),
                    shift: s.label,
                    from: s.from,
                    to: s.to,
                  })),
                }
              : { allowed: false, refusal: plan?.reasons[0] ?? "" },
          guidance:
            `Step 4, last resort: only with the ${SIGN_OFF_ROLE}'s sign-off. If allowed, offer to run ` +
            "it one short with prepare_roster_swap (no partner, noTemporaryNurse true). If refused, " +
            `say so plainly and suggest talking to the ${ROSTER_OWNER} or the nursing supervisor. ` +
            "Never suggest this before steps 1-3." +
            PLAIN_WORDS,
        };
      },
    },
    [agentId, turnEpoch],
  );

  useModelVisibleTool(
    {
      name: "prepare_roster_swap",
      agentId,
      description:
        "Prepare a shift swap between two people on the saved roster for the user to review. This " +
        "does NOT change the roster: the app checks every hard rule and shows a card with the exact " +
        "shifts and an Apply button only the user can press. Use a partner from find_swap_partners; " +
        "a step 2 trade also needs its laterDates.",
      parameters: swapPrepareParameters,
      handler: async (args, { token, signal }) => {
        const read = await readRosterForAssistant();
        const late = assertTurnAuthority(token, signal);
        if (late) return { guidance: late };
        if (token === null) return { guidance: SUPERSEDED };
        const resolved = resolveSwap(read, args.person, args.dates);
        if (!resolved.ok) return { guidance: resolved.message };
        const { ctx, personIdx, dateIdxs, baselineId } = resolved;
        const giving = givingProblem(ctx, personIdx, dateIdxs);
        if (giving !== null) return { guidance: `${giving} Ask the user which dates they mean.` };
        const ladder = findCoverLadder(ctx, personIdx, dateIdxs, args.reason, {
          noTemporaryNurse: args.noTemporaryNurse,
        });
        const isos = dateIdxs.map((d) => ctx.context.calendar[d].iso);
        const partnerIdx =
          args.partner === undefined ? null : findPersonIdx(ctx.context, args.partner);
        if (partnerIdx === -1) {
          const choices = partnerChoices(ctx, personIdx, ladder);
          return {
            guidance: `No one called "${args.partner}" is on this roster. ${choices.guidance}`,
            partners: choices.partners,
          };
        }

        const show = async (
          cells: readonly RosterCellChange[],
          view: RosterChangeView,
          commands: AssistantCommandV1[],
          rationale = args.summary,
        ): Promise<{ guidance: string }> => {
          let linked: Linked | null = null;
          if (commands.length > 0) {
            const prepared = await prepareLinked(commands, rationale);
            const lateAgain = assertTurnAuthority(token, signal);
            if (lateAgain) {
              if (prepared.ok) void assistantProposalCommands.cancel(prepared.linked.proposalId);
              return { guidance: lateAgain };
            }
            if (!prepared.ok) return { guidance: prepared.message };
            linked = prepared.linked;
          }
          const shown = showCard(
            {
              request: { solvedBaselineId: baselineId, cells: [...cells] },
              view,
              linked: linked && {
                proposalId: linked.proposalId,
                assumptionIds: linked.assumptionIds,
                record: "leave",
              },
            },
            token.turnEpoch,
          );
          return { guidance: shown ? CARD_SHOWN : ROSTER_BUSY };
        };
        const sick = args.reason === "sick_or_emergency";
        const sickLeave = sick ? addLeave(ctx.context.people[personIdx].id, isos) : [];

        // No partner: run one short (step 4 only), or record the MC alone.
        if (partnerIdx === null) {
          const empty = nothingToCover(ladder);
          const short = ladder.step === 4 && !empty ? ladder.short : null;
          if (short?.ok) {
            return show(
              short.cells,
              buildShortView(ctx.context, personIdx, short, args.summary),
              sickLeave,
            );
          }
          if (sick) {
            const plan = planSickCover(ctx, personIdx, null, dateIdxs);
            if (!plan.ok) {
              return {
                guidance: `That cannot be recorded, so no card was shown: ${plan.reasons.join(" ")}`,
              };
            }
            const view = buildSickView(
              ctx.context,
              personIdx,
              null,
              plan,
              args.summary,
              ladder.step,
            );
            // A refused run-short (step 4) says why on the card, so the gap is plain.
            const refused = short && !short.ok ? [short.reasons[0]] : [];
            return show(
              plan.cells,
              { ...view, notes: [...view.notes, ...refused, "Keep looking for cover."] },
              sickLeave,
            );
          }
          if (empty) return { guidance: `${NOTHING_TO_COVER} No card was shown.` };
          // The refusal already says to talk to the roster owner or the nursing supervisor.
          if (short) return { guidance: short.reasons[0] };
          const options = stillHasOptions(ctx, ladder);
          return {
            guidance:
              `${options.guidance} Leaving the shift short is only for when steps 1-3 ` +
              `find nobody, and needs the ${SIGN_OFF_ROLE}'s sign-off.`,
            partners: options.partners,
          };
        }

        // Step 2: a trade with later dates. Never while a straight swap or cover exists.
        if (args.laterDates && args.laterDates.length > 0) {
          if (ladder.step === 1) {
            const options = stillHasOptions(ctx, ladder);
            return {
              guidance: `${options.guidance} No trade was prepared. Offer a swap or cover with one of them first.`,
              partners: options.partners,
            };
          }
          const later = args.laterDates.map((iso) => findDateIdx(ctx.context, iso));
          if (later.some((d) => d < 0)) {
            return { guidance: "Some of those later dates are outside this roster." };
          }
          const variants: TradeVariant[] = sick
            ? ["partner-off"]
            : ["person-covers", "partner-off"];
          let plan: ReturnType<typeof planTrade> = {
            ok: false,
            reasons: ["No trade fits those dates."],
          };
          for (const variant of variants) {
            plan = planTrade(ctx, personIdx, partnerIdx, dateIdxs, later, variant, args.reason);
            if (plan.ok) break;
          }
          if (!plan.ok) {
            return {
              guidance: `That trade breaks a rule, so no card was shown: ${plan.reasons.join(" ")}`,
            };
          }
          const moves: AssistantCommandV1[] = [];
          for (const move of plan.leaveMoves) {
            const fromDate = liveDateId(ctx.context.calendar[move.from].iso);
            const toDate = liveDateId(ctx.context.calendar[move.to].iso);
            if (fromDate === null || toDate === null) {
              return {
                guidance:
                  "Those dates are outside the schedule's period, so the leave cannot be moved. No card was shown.",
              };
            }
            moves.push({
              type: "move_leave",
              personId: ctx.context.people[move.personIdx].id,
              fromDate,
              toDate,
            });
          }
          return show(
            plan.cells,
            buildTradeView(ctx.context, personIdx, partnerIdx, plan, args.summary),
            [...moves, ...sickLeave],
          );
        }

        // Step 1 swap or cover; a cover by a nurse with no spare capacity is step 2 overtime.
        const plan: SwapPlan = sick
          ? planSickCover(ctx, personIdx, partnerIdx, dateIdxs)
          : planSwap(ctx, personIdx, partnerIdx, dateIdxs);
        if (!plan.ok) {
          const choices = partnerChoices(ctx, personIdx, ladder);
          return {
            guidance:
              `That ${sick ? "cover" : "swap"} breaks a rule, so no card was shown: ${plan.reasons.join(" ")} ` +
              `${choices.guidance} Explain this to the user in plain words.`,
            partners: choices.partners,
          };
        }
        const overtime = plan.kind === "cover" && !countHeadroom(ctx.model, ctx.days, partnerIdx);
        // Overtime is a step 2 request: never while a straight swap or cover exists.
        if (overtime && ladder.step === 1) {
          const options = stillHasOptions(ctx, ladder);
          return {
            guidance: `${options.guidance} No overtime request was prepared. Offer a swap or cover with one of them first.`,
            partners: options.partners,
          };
        }
        const view = overtime
          ? buildOvertimeView(ctx.context, personIdx, partnerIdx, plan, args.reason, args.summary)
          : sick
            ? buildSickView(ctx.context, personIdx, partnerIdx, plan, args.summary)
            : buildRosterChangeView(ctx.context, personIdx, partnerIdx, plan, args.summary);
        return show(plan.cells, view, sickLeave);
      },
    },
    [agentId, turnEpoch],
  );

  useModelVisibleTool(
    {
      name: "prepare_borrowed_cover",
      agentId,
      description:
        "Step 3 only, when find_swap_partners says step 3 and the user said in chat that the " +
        "lending ward agreed: prepare a temporary cover nurse from the relief pool, another " +
        "ward or an agency for the uncovered shifts. With no saved roster (after a run that " +
        "could not build one), it books one cover per name for the missing nurses on those dates, and a person on " +
        "sick_or_emergency leave gets that leave recorded in the same preview. The nurse is not added as staff: each cover " +
        "lowers that shift's staffing need by one. This does NOT change anything: the user " +
        "sees a card with an Apply button only they can press.",
      parameters: borrowParameters,
      handler: async (args, { token, signal }) => {
        if (!args.lenderConfirmed) {
          return {
            guidance:
              "Ask the user in chat whether the lending ward or agency agreed to lend this nurse, " +
              "and call prepare_borrowed_cover with lenderConfirmed true only after they say yes. " +
              "No card was shown and nothing was altered.",
          };
        }
        const read = await readRosterForAssistant();
        const late = assertTurnAuthority(token, signal);
        if (late) return { guidance: late };
        if (token === null) return { guidance: SUPERSEDED };
        const name = args.name.trim();
        if (read.status === "none" && !read.newerRunWaiting) {
          const names = [...new Set([name, ...(args.names ?? []).map((n) => n.trim())])].filter(
            Boolean,
          );
          const { covers, missing, leave, shortDates } = scenarioCovers(args, names);
          const commands = [...covers, ...leave];
          if (commands.length === 0) {
            if (shortDates.length === 0) return { guidance: noRoster() };
            return {
              guidance:
                `No shift on those dates is short, so nothing was prepared. The short dates are ` +
                `${shortDates.join(", ")}.`,
            };
          }
          const prepared = await prepareLinked(commands, args.summary);
          const lateAgain = assertTurnAuthority(token, signal);
          if (lateAgain) {
            if (prepared.ok) void assistantProposalCommands.cancel(prepared.linked.proposalId);
            return { guidance: lateAgain };
          }
          if (!prepared.ok) return { guidance: prepared.message };
          // A Preview it replaces goes with it, so none is left applicable.
          const replaced = useAssistantStore.getState().activeProposal;
          if (replaced) void assistantProposalCommands.cancel(replaced.proposalId);
          assistantActions.showProposal(
            prepared.linked.proposalId,
            token.turnEpoch,
            prepared.linked.baseDocumentRevision,
          );
          const sickPerson = leave.find((c) => c.type === "add_leave")?.personId;
          const leaveWords =
            sickPerson === undefined ? "" : `${sickPerson}'s leave on the Requests screen`;
          const shown =
            "is now shown to the user. Nothing has changed yet; only the user can apply it. " +
            'Say "I\'ve prepared ...; check it and press Apply" in one short sentence. ';
          if (covers.length === 0) {
            return {
              guidance:
                `A preview of ${leaveWords} ${shown}No cover is needed: every shift on those ` +
                "dates is still staffed with the leave. Then wait.",
            };
          }
          const booked = covers.map((c) => `${c.name} on ${coverSlot(c)}`).join("; ");
          return {
            guidance:
              `A preview ${shown}Apply books these temporary covers on the Staff screen: ` +
              `${booked}. Name each shift as written here.` +
              (leaveWords ? ` It also records ${leaveWords}.` : "") +
              (missing === 0
                ? " "
                : ` ${missing} more ${missing === 1 ? "nurse is" : "nurses are"} still missing: ` +
                  "ask the user for their names and whether the lending ward agreed, then call " +
                  "prepare_borrowed_cover again with every name. ") +
              `Remind the user to let their ${ROSTER_OWNER} know. Once they have applied ` +
              `it, offer a run with ${OPTIMIZE_RUN_TOOL} so a roster can be built with the cover; ` +
              "it starts only when the user says yes. Then wait.",
          };
        }
        const resolved = resolveSwap(read, args.person, args.dates);
        if (!resolved.ok) return { guidance: resolved.message };
        const { ctx, personIdx, dateIdxs } = resolved;
        const giving = givingProblem(ctx, personIdx, dateIdxs);
        if (giving !== null) return { guidance: `${giving} Ask the user which dates they mean.` };
        const ladder = findCoverLadder(ctx, personIdx, dateIdxs, args.reason);
        if (ladder.step !== 3) {
          const options = stillHasOptions(ctx, ladder);
          return {
            guidance: `${options.guidance} No temporary nurse should be asked for yet. Call find_swap_partners and offer those first.`,
            partners: options.partners,
          };
        }
        const sick = args.reason === "sick_or_emergency";
        const personId = ctx.context.people[personIdx].id;
        const personIsos = dateIdxs.map((d) => ctx.context.calendar[d].iso);
        const isos = ctx.context.calendar.map((day) => day.iso);
        const commands: AssistantCommandV1[] = [
          // One cover per need: it lowers that shift's need on that date (d582).
          ...ladder.borrow.map(
            (n): AssistantCommandV1 => ({
              type: "add_temporary_cover",
              name,
              date: isos[n.dateIdx],
              shiftType: n.shift,
              groups: [...new Set([...args.groups, ...(n.skillGroup ? [n.skillGroup] : [])])],
            }),
          ),
          // The asking nurse's leave (MC) or off request frees them at the next run.
          ...(sick
            ? addLeave(personId, personIsos)
            : personIsos.map(
                (iso): AssistantCommandV1 => ({
                  type: "set_off_request",
                  personId,
                  startDate: iso,
                  endDate: iso,
                  weight: "must",
                }),
              )),
        ];
        const prepared = await prepareLinked(commands, args.summary);
        const lateAgain = assertTurnAuthority(token, signal);
        if (lateAgain) {
          if (prepared.ok) void assistantProposalCommands.cancel(prepared.linked.proposalId);
          return { guidance: lateAgain };
        }
        if (!prepared.ok) return { guidance: prepared.message };
        const needs = ladder.borrow.map((n) => ({
          date: plainDate(isos[n.dateIdx]),
          shift: shiftName(ctx.context, n.shift),
        }));
        const groups = [
          ...new Set([...args.groups, ...ladder.borrow.flatMap((n) => n.skillGroup ?? [])]),
        ];
        const view = buildBorrowView(name, groups, needs, args.summary);
        const person = personName(ctx.context, personIdx);
        const swapNote = `The swap takes effect after the next run: ${person} keeps these shifts until then.`;
        const shown = showCard(
          {
            request: null,
            view: sick ? view : { ...view, notes: [...view.notes, swapNote] },
            linked: {
              proposalId: prepared.linked.proposalId,
              assumptionIds: prepared.linked.assumptionIds,
              record: "staff",
            },
          },
          token.turnEpoch,
        );
        if (!shown) return { guidance: ROSTER_BUSY };
        return {
          guidance:
            `${CARD_SHOWN} Tell the user Apply books ${name} as temporary cover on the Staff screen, ` +
            (sick
              ? ""
              : `the swap takes effect after the next optimiser run (${person} keeps these shifts until then), `) +
            `and to let their ${ROSTER_OWNER} know about the temporary nurse. Once they have ` +
            `applied it, offer a run with ${OPTIMIZE_RUN_TOOL} so the roster fits the cover; it ` +
            "starts only when the user says yes.",
        };
      },
    },
    [agentId, turnEpoch],
  );
}
