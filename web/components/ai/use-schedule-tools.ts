"use client";

// The assistant's past-schedule tools (plq5 P3): "based on my September schedule,
// create November".
//
// Two reads and a card. `list_recent_schedules` and `get_past_schedule_summary` read
// what Recent schedules keeps in this browser; they open nothing and write nothing.
// `prepare_new_period_from_schedule` derives the new period with the host's pure
// transform and shows a card. The schedule is created only when the user presses
// Create on it, and that Apply re-derives and refuses a source that changed.
//
// The model never sees a scenario id: a schedule is named by an opaque ref.

import { z } from "zod";
import {
  useModelVisibleTool,
  useParameterlessModelVisibleTool,
  type ModelVisibleToolContext,
} from "./register-model-visible-tool";
import { deriveNewPeriod, historyDaysFor, nextDay } from "@/lib/proposal";
import { disambiguateScheduleNames, scheduleAutoName, schedulePeriod } from "@/lib/scenario";
import { assistantProposalCommands, useAuthorityStore, type ScheduleSummary } from "@/lib/store";
import { NEW_PERIOD_INSTRUCTIONS } from "@/lib/ai/assistant/playbook";
import { summarizeScenario } from "@/lib/ai/assistant/scenario-context";
import {
  buildNewPeriodView,
  scheduleRef,
  summarizePastRoster,
} from "@/lib/ai/assistant/new-period";
import { assistantActions } from "@/lib/ai/assistant/store";
import { assertTurnAuthority, SUPERSEDED } from "./turn-authority";

const refField = z
  .string()
  .min(1)
  .describe("The schedule's ref from list_recent_schedules, e.g. sch-1a2b3c4d.");

export const scheduleRefParameters = z.object({ scheduleRef: refField });

export const newPeriodParameters = z.object({
  scheduleRef: refField.describe("The past schedule to start from, by its ref."),
  rangeStart: z.string().describe("First day of the new period, YYYY-MM-DD."),
  rangeEnd: z.string().describe("Last day of the new period, YYYY-MM-DD."),
  continueWithoutHistory: z
    .boolean()
    .default(false)
    .describe("true only after the user agreed to continue when no rest history can be carried."),
});

const GUIDANCE = NEW_PERIOD_INSTRUCTIONS.join(" ");

/** The listed schedules (blank ones left out), each with the name the list shows. */
async function listed(): Promise<(ScheduleSummary & { name: string })[]> {
  const rows = (await assistantProposalCommands.listSchedules()).filter((row) => !row.blank);
  const names = disambiguateScheduleNames(
    rows.map((row) => ({ name: row.title ?? row.autoName, createdAt: row.createdAt })),
  );
  return rows.map((row, index) => ({ ...row, name: names[index]! }));
}

const UNKNOWN_REF =
  "No schedule has that ref. Call list_recent_schedules and use a ref from it; never guess one.";

/** The schedule a ref names, or the refusal to return. */
async function resolveRef(ref: string): Promise<(ScheduleSummary & { name: string }) | string> {
  return (await listed()).find((row) => scheduleRef(row.scenarioId) === ref) ?? UNKNOWN_REF;
}

/** A late answer for a turn the user has since replaced says nothing. */
function late(context: ModelVisibleToolContext) {
  return assertTurnAuthority(context.token, context.signal);
}

/**
 * The body of `prepare_new_period_from_schedule`: derive, then show the card stamped
 * with `turnEpoch`. `stale` is asked after every await; a non-null answer is returned
 * as is. Exported for the assistant test bridge, which drives this same body.
 */
export async function prepareNewPeriod(
  args: z.infer<typeof newPeriodParameters>,
  turnEpoch: number,
  stale: () => unknown = () => null,
): Promise<unknown> {
  const row = await resolveRef(args.scheduleRef);
  if (typeof row === "string") return stale() ?? row;
  const past = await assistantProposalCommands.readPastSchedule(row.scenarioId);
  const refusal = stale();
  if (refusal) return refusal;
  if (!past) return "That schedule no longer exists. List the schedules again.";

  const derived = deriveNewPeriod(past.scenario, past.roster, {
    start: args.rangeStart,
    end: args.rangeEnd,
  });
  if (!derived.ok) {
    return `The app refused those dates: ${derived.message} Nothing was prepared. Ask the user for the period they want.`;
  }
  const { plan } = derived;
  if (plan.history.status !== "carried" && !args.continueWithoutHistory) {
    const why =
      plan.history.status === "gap"
        ? `the new period does not start the day after “${row.name}”'s roster ends (${plan.history.rosterEnd})`
        : `“${row.name}” has no saved roster`;
    return (
      `No rest history can be carried, because ${why}. Nothing was prepared. Tell the user ` +
      "in one sentence, and ask with offer_choices whether to continue without rest " +
      "history. If they agree, call prepare_new_period_from_schedule again with " +
      "continueWithoutHistory true."
    );
  }
  const newName = scheduleAutoName(plan.scenario);
  assistantActions.showNewPeriod(
    {
      request: {
        sourceScenarioId: past.scenarioId,
        rangeStart: args.rangeStart,
        rangeEnd: args.rangeEnd,
        expectedSourceRevision: past.documentRevision,
        expectedDigest: plan.digest,
      },
      view: buildNewPeriodView({ name: row.name, scenario: past.scenario }, plan, newName),
    },
    turnEpoch,
  );
  return (
    `The user now sees a card to create “${newName}” from “${row.name}”. Nothing has ` +
    "been created, and you cannot create it: only the user can, by pressing Create. Say " +
    'in one short sentence: "I\'ve prepared it; check the card and press Create". Do not ' +
    "list what it copies, the card shows that. When they press Create, the new schedule " +
    "opens and the chat moves to it. Then wait."
  );
}

export function useScheduleTools(agentId: string, turnEpoch: number): void {
  useParameterlessModelVisibleTool(
    {
      name: "list_recent_schedules",
      agentId,
      description:
        "List the schedules kept in this browser (Recent schedules on Save & Load), newest " +
        "first: each one's ref, name, ward, period, whether it has a saved roster, and which " +
        "one is open now. Use it when the user mentions another month's or an earlier " +
        "schedule. Reading changes nothing and opens nothing.",
      handler: async (context) => {
        const rows = await listed();
        const refusal = late(context);
        if (refusal) return refusal;
        const current = useAuthorityStore.getState().scenarioId;
        return {
          schedules: rows.map((row) => ({
            ref: scheduleRef(row.scenarioId),
            name: row.name,
            ward: row.ward,
            period: schedulePeriod(row.rangeStart, row.rangeEnd),
            rangeStart: row.rangeStart,
            rangeEnd: row.rangeEnd,
            hasRoster: row.hasRoster,
            current: row.scenarioId === current,
            lastEdited: row.updatedAt.slice(0, 10),
          })),
          guidance: GUIDANCE,
        };
      },
    },
    [agentId, turnEpoch],
  );

  useModelVisibleTool(
    {
      name: "get_past_schedule_summary",
      agentId,
      description:
        "Read a schedule from list_recent_schedules without opening it: its overview, and, " +
        "when it has a saved roster, each person's shift totals and last 7 days. Also says " +
        "how many days of rest history a new period would need and the day a new period " +
        "must start on to get it. Changes nothing.",
      parameters: scheduleRefParameters,
      handler: async (args, context) => {
        const row = await resolveRef(args.scheduleRef);
        if (typeof row === "string") return late(context) ?? row;
        const past = await assistantProposalCommands.readPastSchedule(row.scenarioId);
        const refusal = late(context);
        if (refusal) return refusal;
        if (!past) return "That schedule no longer exists. List the schedules again.";
        const roster = past.roster ? summarizePastRoster(past.roster) : null;
        const lastDay = roster?.period.end || past.scenario.rangeEnd;
        return {
          ref: args.scheduleRef,
          name: row.name,
          overview: summarizeScenario(past.scenario, {
            scenarioId: args.scheduleRef,
            documentRevision: past.documentRevision,
          }),
          roster,
          historyDays: historyDaysFor(past.scenario),
          nextPeriodStart: lastDay ? nextDay(lastDay) : null,
          guidance:
            (roster
              ? ""
              : "This schedule has no saved roster, so a new period from it gets no rest history. ") +
            GUIDANCE,
        };
      },
    },
    [agentId, turnEpoch],
  );

  useModelVisibleTool(
    {
      name: "prepare_new_period_from_schedule",
      agentId,
      description:
        "Prepare a new schedule for a new period from a past one (for example November " +
        "from September), for the user to review. This does NOT create anything: it shows " +
        "a card, and only the user's Create makes the new schedule and opens it. It copies " +
        "people, groups, shift types and rules, marks Singapore public holidays, and takes " +
        "each person's rest history from the past roster's last days. Requests, leave and " +
        "temporary covers are not copied.",
      parameters: newPeriodParameters,
      handler: async (args, context) => {
        // Narrowing only; the wrapper already refused a null token.
        if (context.token === null) return SUPERSEDED;
        return prepareNewPeriod(args, context.token.turnEpoch, () => late(context));
      },
    },
    [agentId, turnEpoch],
  );
}
