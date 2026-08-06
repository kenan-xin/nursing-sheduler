"use client";

// The assistant's tool surface (T04) -- READ-ONLY, and that is the whole design.
//
// The authority table in the technical plan admits exactly one tool class at this
// stage: scenario/context READ. There is deliberately no prepare-proposal tool, no
// Apply, no help-target lookup and no diagnostic submit -- those arrive with T06,
// T07 and T10, each behind its own gate. Registering a placeholder now would let a
// model announce a capability the app cannot honour.
//
// TOOL EXECUTION IS UNTRUSTED INPUT, not authorization. Even for reads that change
// nothing, a handler that completes after its turn was superseded must return
// NOTHING to the model: a result computed against a document the user has since
// replaced, or under a lease another tab has taken over, is a stale fact that would
// then be quoted back as current. So every handler re-checks the turn epoch and the
// abort signal before it answers.

import { useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { useScenarioStore, useAuthorityStore } from "@/lib/store";
import { pickScenario } from "@/lib/store";
import { summarizeScenario } from "@/lib/ai/assistant/scenario-context";
import { useAssistantStore } from "@/lib/ai/assistant/store";

/**
 * What a handler answers when its turn is no longer the current one. A refusal
 * string rather than a throw: a thrown tool error is reported to the model as a
 * failure it may retry, while this states plainly that there is nothing to say.
 */
const SUPERSEDED = "superseded: this request belongs to an interrupted turn and was not answered.";

const DOMAINS = ["dates", "staff", "shifts", "rules", "requests"] as const;
type Domain = (typeof DOMAINS)[number];

const sliceParameters = z.object({
  domain: z
    .enum(DOMAINS)
    .describe(
      "Which part of the schedule to read: dates (roster period, holidays, date groups), " +
        "staff (people and people groups), shifts (shift types and groups), " +
        "rules (staffing requirements, successions, counts, affinities, coverings), " +
        "requests (per-person leave and shift preferences).",
    ),
});

/**
 * Register the read-only tools against ONE agent instance.
 *
 * `agentId` scopes them: the tools belong to this panel's private thread-scoped
 * agent, so another agent mounted in the same page could never invoke them.
 */
export function useContextTools(agentId: string, turnEpoch: number): void {
  const guard = (signal: AbortSignal | undefined): string | null => {
    if (signal?.aborted) return SUPERSEDED;
    // Compared against the LIVE epoch rather than a captured copy: the point is to
    // notice that something superseded this turn while the handler was running.
    if (useAssistantStore.getState().turnEpoch !== turnEpoch) return SUPERSEDED;
    return null;
  };

  useFrontendTool(
    {
      name: "get_schedule_overview",
      agentId,
      description:
        "Read a compact overview of the schedule the user is working on: its roster period, " +
        "how many people, shift types, groups and rules exist, and its current revision. " +
        "Use this before answering anything about size, completeness or scope.",
      handler: async (_args, context) => {
        const refusal = guard(context.signal);
        if (refusal) return refusal;
        const authority = useAuthorityStore.getState();
        return summarizeScenario(pickScenario(useScenarioStore.getState()), {
          scenarioId: authority.scenarioId ?? "unknown",
          documentRevision: authority.documentRevision,
        });
      },
    },
    [agentId, turnEpoch],
  );

  useFrontendTool(
    {
      name: "get_schedule_section",
      agentId,
      description:
        "Read one section of the schedule in full. The complete schedule is already in your " +
        "context; use this only to re-read a section after the user says they changed something.",
      parameters: sliceParameters,
      handler: async (args, context) => {
        const refusal = guard(context.signal);
        if (refusal) return refusal;
        return readSection(args.domain);
      },
    },
    [agentId, turnEpoch],
  );
}

/** Project one domain out of the live committed projection. Never mutates. */
function readSection(domain: Domain): unknown {
  const scenario = pickScenario(useScenarioStore.getState());
  switch (domain) {
    case "dates":
      return {
        rangeStart: scenario.rangeStart,
        rangeEnd: scenario.rangeEnd,
        dateGroups: scenario.dateGroups,
        country: scenario.meta.country ?? null,
      };
    case "staff":
      return { people: scenario.staff, peopleGroups: scenario.staffGroups };
    case "shifts":
      return { shiftTypes: scenario.shifts, shiftTypeGroups: scenario.shiftGroups };
    case "rules":
      return scenario.cardsByKind;
    case "requests":
      return { cells: scenario.reqData };
  }
}
