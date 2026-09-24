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
import { assistantActions } from "@/lib/ai/assistant/store";
import {
  buildRosterChangeView,
  describeRosterChangeOutcome,
  readRosterForAssistant,
  summarizeRoster,
  type AssistantRosterRead,
} from "@/lib/ai/assistant/roster-context";
import { deriveCurrentDays } from "@/lib/roster";
import { readRosterChangeOutcome } from "@/lib/roster/change-request";
import { dayCode, deriveRuleModel } from "@/lib/roster-viewer/rule-check";
import {
  findDateIdx,
  findPersonIdx,
  findSwapPartners,
  givingProblem,
  personName,
  planSwap,
  type SwapContext,
} from "@/lib/roster-viewer/swap";
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
        "counts). Returns the best partners first and why others are ruled out. Changes nothing.",
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
        const search = findSwapPartners(ctx, personIdx, dateIdxs);
        const iso = (d: number) => ctx.context.calendar[d].iso;
        return {
          person: personName(ctx.context, personIdx),
          giving: dateIdxs.map((d) => ({ date: iso(d), shift: dayCode(ctx.days[personIdx][d]) })),
          candidates: search.candidates.map((candidate) => ({
            partner: personName(ctx.context, candidate.partnerIdx),
            kind: candidate.plan.kind,
            partnerHasNow: dateIdxs.map((d) => ({
              date: iso(d),
              shift: dayCode(ctx.days[candidate.partnerIdx][d]),
            })),
            worthKnowing: candidate.plan.soft.map((issue) => issue.message),
            notChecked: [...candidate.plan.unchecked],
          })),
          ruledOutCount: search.ruledOut.length,
          ruledOutExamples: search.ruledOut.slice(0, 5).map((entry) => ({
            partner: personName(ctx.context, entry.partnerIdx),
            reason: entry.reason,
          })),
          guidance:
            search.candidates.length > 0
              ? "If the user asked you to just do it, call prepare_roster_swap with the first " +
                "candidate. Otherwise offer at most three with offer_choices, best first. Say " +
                "'cover' when the partner is off, because the person then has those days off."
              : "No one can take these shifts without breaking a rule. Say so plainly with one or " +
                "two of the reasons, and suggest one date instead, or a new optimiser run.",
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
        "shifts and an Apply button only the user can press. Use a partner from find_swap_partners.",
      parameters: swapPrepareParameters,
      handler: async (args, { token, signal }) => {
        const read = await readRosterForAssistant();
        const late = assertTurnAuthority(token, signal);
        if (late) return late;
        if (token === null) return SUPERSEDED;
        const resolved = resolveSwap(read, args.person, args.dates);
        if (!resolved.ok) return resolved.message;
        const { ctx, personIdx, dateIdxs, baselineId } = resolved;
        // (Task 8A replaces this handler with the ladder-aware one.)
        if (args.partner === undefined) return "Name who takes the shifts.";
        const partnerIdx = findPersonIdx(ctx.context, args.partner);
        if (partnerIdx < 0) {
          return `No one called "${args.partner}" is on this roster. Use a partner from find_swap_partners.`;
        }
        const plan = planSwap(ctx, personIdx, partnerIdx, dateIdxs);
        if (!plan.ok) {
          return (
            `That swap breaks a rule, so no card was shown: ${plan.reasons.join(" ")} ` +
            "Use find_swap_partners to see who can take these shifts, and explain this to the user in plain words."
          );
        }
        assistantActions.showRosterChange(
          {
            request: { solvedBaselineId: baselineId, cells: plan.cells },
            view: buildRosterChangeView(ctx.context, personIdx, partnerIdx, plan, args.summary),
          },
          token.turnEpoch,
        );
        return (
          "The user now sees a card with the exact swap and every rule it was checked against. " +
          "Nothing has changed yet; only the user can apply it, on the card. Do not say the roster " +
          "has changed. In one short sentence, say who swaps which shifts and that they can undo it " +
          "on the Roster screen. Then wait."
        );
      },
    },
    [agentId, turnEpoch],
  );
}
