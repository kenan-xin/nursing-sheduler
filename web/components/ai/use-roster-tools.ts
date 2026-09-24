"use client";

// The assistant's roster tools (bead nursing-sheduler-73z, plan 2026-09-24-roster-aware-assistant).
//
// READ, SUGGEST, OFFER. `get_roster` reads the saved roster. `find_swap_partners` asks
// the HOST who can take someone's shifts without breaking a hard rule the roster was
// solved under. `prepare_roster_swap` shows a card with the exact cells. Only the
// user's Apply click changes the roster, through the Roster screen's own edit session
// (`lib/roster/change-request.ts`): one undo step, one autosave, the same export.
// No handler writes a roster, a scenario or a proposal row.

import { z } from "zod";
import { useModelVisibleTool } from "./register-model-visible-tool";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import {
  BORROW_SOURCE,
  buildBorrowView,
  buildOvertimeView,
  buildRosterChangeView,
  buildShortView,
  buildSickView,
  buildTradeView,
  describeRosterChangeOutcome,
  readRosterForAssistant,
  STEP_LABEL,
  summarizeRoster,
  tradeAgreement,
  type AssistantRosterRead,
  type RosterChangeView,
} from "@/lib/ai/assistant/roster-context";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { generateDateItems } from "@/lib/dates/date-id";
import type { AssistantCommandV1 } from "@/lib/proposal";
import { deriveCurrentDays } from "@/lib/roster";
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
  type SwapContext,
  type SwapPlan,
  type TradeVariant,
} from "@/lib/roster-viewer/swap";
import type { PersonRef } from "@/lib/scenario";
import { assistantProposalCommands, pickScenario, useScenarioStore } from "@/lib/store";
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
    .describe("The temporary nurse's name, exactly as the user gave it. Never invent one."),
  source: z
    .enum(["relief_pool", "other_ward", "agency"])
    .describe(
      "Where the temporary nurse comes from. Ask the nursing supervisor for the relief pool first.",
    ),
  groups: z
    .array(z.string())
    .max(5)
    .describe("Staff groups the nurse belongs to. The app adds the skill group the shift needs."),
  summary: z.string().min(1).describe("Why, in one plain sentence. Shown as your reasoning."),
});

const PLAIN_WORDS =
  " Name shifts as shiftNames gives them, never by code, and call each nurse by name rather than a pronoun.";

type Linked = { proposalId: string; assumptionIds: string[]; questions: string[] };

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
        assumptionIds: outcome.proposal.assumptions.map((a) => a.assumptionId),
        questions: outcome.proposal.assumptions.map((a) => a.question),
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

/** The valid choices for a refusal: the ranked partners, else everyone else on the roster. */
function partnerChoices(ctx: SwapContext, personIdx: number, ladder: CoverLadder): string {
  const ranked = rankedPartners(ctx, ladder);
  if (ranked.length > 0) return `Partners who can take these shifts: ${ranked.join(", ")}.`;
  const others = ctx.context.people.flatMap((p, i) => (i === personIdx ? [] : [String(p.id)]));
  return `Nobody can take these shifts as the roster stands. People on it: ${others.join(", ")}.`;
}

/** "Step 1 still has options: SN-Cara, SN-Eve." The lower step comes first. */
const stillHasOptions = (ctx: SwapContext, ladder: CoverLadder): string => {
  const ranked = rankedPartners(ctx, ladder);
  return `Step ${ladder.step} still has options${ranked.length > 0 ? `: ${ranked.join(", ")}` : ""}.`;
};

const CARD_SHOWN =
  "The user now sees a card with the exact change and every rule it was checked against. " +
  "Nothing has changed yet; only the user can apply it, on the card. Do not say the roster " +
  "has changed. In one short sentence, say which step this is and who does what. Then wait.";

const NO_ROSTER =
  "There is no saved roster yet. If the user wants one, offer a run with request_optimize_run.";
const UNREADABLE =
  "The saved roster cannot be read in this browser right now, and nothing was changed. Tell the " +
  "user, and suggest they open the Roster screen.";
const LOAD_FIRST =
  "A newer roster from the last optimiser run is waiting to be loaded, so no swap was prepared. " +
  "Ask the user to open the Roster screen and press Load first, so the swap is made on the roster they mean.";

type Resolved =
  | { ok: true; ctx: SwapContext; personIdx: number; dateIdxs: number[]; baselineId: string }
  | { ok: false; message: string };

function resolveSwap(
  read: AssistantRosterRead,
  person: string,
  dates: readonly string[],
): Resolved {
  if (read.status === "unavailable") return { ok: false, message: UNREADABLE };
  if (read.status === "none") {
    return { ok: false, message: read.newerRunWaiting ? LOAD_FIRST : NO_ROSTER };
  }
  if (read.newerRunWaiting) return { ok: false, message: LOAD_FIRST };
  const { document } = read;
  const model = deriveRuleModel(document.submission);
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
        if (late) return late;
        if (read.status === "unavailable") return UNREADABLE;
        if (read.status === "none") return read.newerRunWaiting ? LOAD_FIRST : NO_ROSTER;
        const summary = summarizeRoster(read.document, args, read.newerRunWaiting);
        if (typeof summary === "string") return summary;
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
        if (late) return late;
        const resolved = resolveSwap(read, args.person, args.dates);
        if (!resolved.ok) return resolved.message;
        const { ctx, personIdx, dateIdxs } = resolved;
        const giving = givingProblem(ctx, personIdx, dateIdxs);
        if (giving !== null) return `${giving} Ask the user which dates they mean.`;
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
            temporary: { needs, skillGroups, sources: ["relief_pool", "other_ward", "agency"] },
            guidance:
              "Step 3: ask the nursing supervisor for a nurse from the relief pool first; if none, " +
              "another ward or an agency. Tell the user to let their nurse manager know. Ask for " +
              "the nurse's name and where the nurse comes from, then call prepare_borrowed_cover. " +
              "Never make up a name. If they have nobody, call find_swap_partners again with " +
              "noTemporaryNurse true." +
              (args.reason === "sick_or_emergency"
                ? " If they only want the absence recorded, call prepare_roster_swap without a partner."
                : "") +
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
            "Step 4, last resort: only with the nurse manager's sign-off. If allowed, offer to run " +
            "it one short with prepare_roster_swap (no partner, noTemporaryNurse true). If refused, " +
            "say so plainly and suggest talking to the nurse manager or the nursing supervisor. " +
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
        if (late) return late;
        if (token === null) return SUPERSEDED;
        const resolved = resolveSwap(read, args.person, args.dates);
        if (!resolved.ok) return resolved.message;
        const { ctx, personIdx, dateIdxs, baselineId } = resolved;
        const giving = givingProblem(ctx, personIdx, dateIdxs);
        if (giving !== null) return `${giving} Ask the user which dates they mean.`;
        const ladder = findCoverLadder(ctx, personIdx, dateIdxs, args.reason, {
          noTemporaryNurse: args.noTemporaryNurse,
        });
        const isos = dateIdxs.map((d) => ctx.context.calendar[d].iso);
        const partnerIdx =
          args.partner === undefined ? null : findPersonIdx(ctx.context, args.partner);
        if (partnerIdx === -1) {
          return `No one called "${args.partner}" is on this roster. ${partnerChoices(ctx, personIdx, ladder)}`;
        }

        const show = async (
          cells: readonly RosterCellChange[],
          view: RosterChangeView,
          commands: AssistantCommandV1[],
          rationale = args.summary,
        ): Promise<string> => {
          let linked: Linked | null = null;
          if (commands.length > 0) {
            const prepared = await prepareLinked(commands, rationale);
            const lateAgain = assertTurnAuthority(token, signal);
            if (lateAgain) return lateAgain;
            if (!prepared.ok) return prepared.message;
            linked = prepared.linked;
          }
          assistantActions.showRosterChange(
            {
              request: { solvedBaselineId: baselineId, cells: [...cells] },
              view,
              linked: linked && {
                proposalId: linked.proposalId,
                assumptionIds: linked.assumptionIds,
              },
            },
            token.turnEpoch,
          );
          return CARD_SHOWN;
        };
        const sick = args.reason === "sick_or_emergency";
        const sickLeave = sick ? addLeave(ctx.context.people[personIdx].id, isos) : [];

        // No partner: run one short (step 4 only), or record the MC alone.
        if (partnerIdx === null) {
          const short = ladder.step === 4 ? ladder.short : null;
          if (short?.ok) {
            return show(
              short.cells,
              buildShortView(ctx.context, personIdx, short, args.summary),
              sickLeave,
            );
          }
          if (sick) {
            const plan = planSickCover(ctx, personIdx, null, dateIdxs);
            if (!plan.ok)
              return `That cannot be recorded, so no card was shown: ${plan.reasons.join(" ")}`;
            const view = buildSickView(ctx.context, personIdx, null, plan, args.summary);
            return show(
              plan.cells,
              { ...view, notes: [...view.notes, "Keep looking for cover."] },
              sickLeave,
            );
          }
          if (short) return short.reasons[0];
          return (
            `${stillHasOptions(ctx, ladder)} Leaving the shift short is only for when steps 1-3 ` +
            "find nobody, and needs the nurse manager's sign-off."
          );
        }

        // Step 2: a trade with later dates. Never while a straight swap or cover exists.
        if (args.laterDates && args.laterDates.length > 0) {
          if (ladder.step === 1) {
            return `${stillHasOptions(ctx, ladder)} No trade was prepared. Offer a swap or cover with one of them first.`;
          }
          const later = args.laterDates.map((iso) => findDateIdx(ctx.context, iso));
          if (later.some((d) => d < 0)) return "Some of those later dates are outside this roster.";
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
          if (!plan.ok)
            return `That trade breaks a rule, so no card was shown: ${plan.reasons.join(" ")}`;
          const moves: AssistantCommandV1[] = [];
          for (const move of plan.leaveMoves) {
            const fromDate = liveDateId(ctx.context.calendar[move.from].iso);
            const toDate = liveDateId(ctx.context.calendar[move.to].iso);
            if (fromDate === null || toDate === null) {
              return "Those dates are outside the schedule's period, so the leave cannot be moved. No card was shown.";
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
          return (
            `That ${sick ? "cover" : "swap"} breaks a rule, so no card was shown: ${plan.reasons.join(" ")} ` +
            `${partnerChoices(ctx, personIdx, ladder)} Explain this to the user in plain words.`
          );
        }
        const view =
          plan.kind === "cover" && !countHeadroom(ctx.model, ctx.days, partnerIdx)
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
        "Step 3 only, when find_swap_partners says step 3: prepare adding a temporary nurse " +
        "from the relief pool, another ward or an agency to cover the uncovered shifts. Use the " +
        "name the user gave. This does NOT change anything: the user sees a card with the " +
        "lending-ward question and an Apply button only they can press.",
      parameters: borrowParameters,
      handler: async (args, { token, signal }) => {
        const read = await readRosterForAssistant();
        const late = assertTurnAuthority(token, signal);
        if (late) return late;
        if (token === null) return SUPERSEDED;
        const resolved = resolveSwap(read, args.person, args.dates);
        if (!resolved.ok) return resolved.message;
        const { ctx, personIdx, dateIdxs, baselineId } = resolved;
        const giving = givingProblem(ctx, personIdx, dateIdxs);
        if (giving !== null) return `${giving} Ask the user which dates they mean.`;
        const ladder = findCoverLadder(ctx, personIdx, dateIdxs, args.reason);
        if (ladder.step !== 3) {
          return `${stillHasOptions(ctx, ladder)} No temporary nurse should be asked for yet. Call find_swap_partners and offer those first.`;
        }
        const name = args.name.trim();
        const skill = ladder.borrow.flatMap((n) => (n.skillGroup ? [n.skillGroup] : []));
        const groups = [...new Set([...args.groups, ...skill])];
        const isos = ctx.context.calendar.map((day) => day.iso);
        const needDates = new Set(ladder.borrow.map((n) => isos[n.dateIdx]));
        const commands: AssistantCommandV1[] = [
          { type: "add_person", name, groups, temporary: true },
          // ponytail: one "must be off" per other date; merge into runs if proposals get long.
          ...isos
            .filter((iso) => !needDates.has(iso))
            .map(
              (iso): AssistantCommandV1 => ({
                type: "set_off_request",
                personId: name,
                startDate: iso,
                endDate: iso,
                weight: "must",
              }),
            ),
          ...ladder.borrow.map(
            (n): AssistantCommandV1 => ({
              type: "set_shift_request",
              personId: name,
              shiftType: n.shift,
              startDate: isos[n.dateIdx],
              endDate: isos[n.dateIdx],
              weight: "must",
            }),
          ),
          ...(args.reason === "sick_or_emergency"
            ? addLeave(
                ctx.context.people[personIdx].id,
                dateIdxs.map((d) => isos[d]),
              )
            : []),
        ];
        const prepared = await prepareLinked(
          commands,
          `${args.summary} (${BORROW_SOURCE[args.source]})`,
        );
        const lateAgain = assertTurnAuthority(token, signal);
        if (lateAgain) return lateAgain;
        if (!prepared.ok) return prepared.message;
        // C1: the roster only records the absence (sick reason). The nurse's row needs
        // roster-file/2 (Task 12), so it appears after the next run.
        const cells: RosterCellChange[] =
          args.reason === "sick_or_emergency"
            ? dateIdxs.map((d) => ({
                personIdx,
                dateIdx: d,
                before: ctx.days[personIdx][d],
                after: { kind: "leave" },
              }))
            : [];
        const needs = ladder.borrow.map((n) => ({
          date: plainDate(isos[n.dateIdx]),
          shift: n.shift,
        }));
        assistantActions.showRosterChange(
          {
            request: cells.length > 0 ? { solvedBaselineId: baselineId, cells } : null,
            view: buildBorrowView(
              name,
              args.source,
              groups,
              needs,
              prepared.linked.questions[0] ?? null,
              args.summary,
            ),
            linked: {
              proposalId: prepared.linked.proposalId,
              assumptionIds: prepared.linked.assumptionIds,
            },
          },
          token.turnEpoch,
        );
        return (
          `${CARD_SHOWN} Tell the user ${name}'s roster row appears after the next optimiser run, ` +
          "and to let their nurse manager know about the temporary nurse. Offer " +
          "request_optimize_run once they have applied it."
        );
      },
    },
    [agentId, turnEpoch],
  );
}
