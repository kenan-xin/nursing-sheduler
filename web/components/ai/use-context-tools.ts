"use client";

// The assistant's tool surface (T04 reads, T06 help, T07 prepare).
//
// THE AUTHORITY TABLE, in registration order: scenario/context read (below),
// capability/help lookup (`use-help-tools`), and prepare-proposal
// (`use-proposal-tools`). All three are non-mutating. There is deliberately no Apply
// tool and no diagnostic submit: Apply is a HOST action the user takes on a rendered
// card, and diagnostics arrive with T10 behind their own gate. Registering a
// placeholder for either would let a model announce a capability the app cannot
// honour.
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
import { useHelpTools } from "./use-help-tools";
import { useProposalTools } from "./use-proposal-tools";
import { useDiagnosticTools } from "./use-diagnostic-tools";

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
  // T06's read-only help/rule-guidance group, registered against the same agent and
  // the same authorized turn epoch. Kept in its own module so the capability registry,
  // its resolver and the host navigation action stay out of this file entirely; these
  // two lines are the whole integration.
  useHelpTools(agentId, turnEpoch);
  // T07's prepare-proposal tool -- the third authority class in the technical
  // plan's table, and the only one that writes anything. It writes a PROPOSAL, never
  // the scenario: there is still no Apply tool, and there never will be one.
  useProposalTools(agentId, turnEpoch);
  // T10's bounded diagnostics tool. It reads no scenario state the read tools do not
  // already expose and writes no scenario state at all: its only durable effects are
  // a diagnostic-search row and — when a candidate genuinely tested feasible — the
  // same T07 proposal row `useProposalTools` writes, under the same fences.
  useDiagnosticTools(agentId, turnEpoch);

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
