"use client";

// The assistant's tool surface (T04 reads, T06 help, T07 prepare).
//
// THE AUTHORITY TABLE, in registration order: scenario/context read (below),
// capability/help lookup (`use-help-tools`), and prepare-proposal
// (`use-proposal-tools`). All of them are non-mutating. There is deliberately no Apply
// tool and no run-start tool: a run starts only from the user's click on a host card.
// Registering a placeholder for either would let a model announce a capability the
// app cannot honour.
//
// TOOL EXECUTION IS UNTRUSTED INPUT, not authorization. Even for reads that change
// nothing, a handler that completes after its turn was superseded must return
// NOTHING to the model: a result computed against a document the user has since
// replaced, or under a lease another tab has taken over, is a stale fact that would
// then be quoted back as current. So every handler re-checks the turn epoch and the
// abort signal before it answers.

import {
  useModelVisibleTool,
  useParameterlessModelVisibleTool,
} from "./register-model-visible-tool";
import { z } from "zod";
import { useScenarioStore, useAuthorityStore, useHotStore, pickScenario } from "@/lib/store";
import { summarizeScenario } from "@/lib/ai/assistant/scenario-context";
import { useHelpTools } from "./use-help-tools";
import { useProposalTools } from "./use-proposal-tools";
import { useDiagnosticTools } from "./use-diagnostic-tools";
import { useOptimizeTools } from "./use-optimize-tools";
import { useChoiceTools } from "./use-choice-tools";
import { useFeasibilityTools } from "./use-feasibility-tools";
import { computeScenarioSummary } from "@/components/home/scenario-summary";
import { computeCoverageWarnings } from "@/components/requirements/requirements-model";
import { findStaffingShortfalls } from "@/lib/rules/shortfalls";
import { deriveSetupProgress, type SetupProgress } from "@/lib/ai/assistant/setup-progress";
import { isRosterGenerated } from "@/lib/optimize/roster-generated";

const DOMAINS = ["dates", "staff", "shifts", "rules", "requests"] as const;
type Domain = (typeof DOMAINS)[number];

export const sliceParameters = z.object({
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
 * THE REGISTRATION ROOT: every model-visible tool the assistant mounts, in one call.
 *
 * `useAssistantSession` invokes exactly this and nothing else, so "what the shipped
 * session registers" is a single named thing rather than a set of call sites a test has
 * to go looking for. `session-real-core.test.tsx` proves it by rendering the SESSION
 * under a real provider and enumerating the core's own tool registry -- removing this
 * one invocation empties that registry, which is the whole point of naming it.
 *
 * `agentId` scopes the tools: they belong to this panel's private thread-scoped agent,
 * so another agent mounted in the same page could never invoke them.
 */
export function useModelVisibleTools(agentId: string, turnEpoch: number): void {
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
  // Read-only: the static staffing check plus the ranked playbook options.
  useFeasibilityTools(agentId, turnEpoch);
  // The optimiser pair (plan 2026-09-24): offer a run the USER starts from a host
  // card, and read the run view the Optimise screen renders. Neither starts a run.
  useOptimizeTools(agentId, turnEpoch);
  // Clickable options when the model asks the user to pick. Sends a message; no write.
  useChoiceTools(agentId, turnEpoch);

  useParameterlessModelVisibleTool(
    {
      name: "get_schedule_overview",
      agentId,
      description:
        "Read a compact overview of the schedule the user is working on: its roster period, " +
        "how many people, shift types, groups and rules exist, and its current revision. " +
        "Use this before answering anything about size, completeness or scope.",
      handler: async () => {
        const authority = useAuthorityStore.getState();
        return summarizeScenario(pickScenario(useScenarioStore.getState()), {
          scenarioId: authority.scenarioId ?? "unknown",
          documentRevision: authority.documentRevision,
        });
      },
    },
    [agentId, turnEpoch],
  );

  useParameterlessModelVisibleTool(
    {
      name: "get_setup_progress",
      agentId,
      description:
        "Check which set-up steps of this schedule are finished and what to do next. Call it " +
        "when the user wants to set up a schedule, asks what is left, or after they apply a " +
        "set-up change. Follow nextStep: ask only its questions, prepare that one step as one " +
        "change, and wait for the user to apply it before moving on.",
      handler: async () => readSetupProgress(),
    },
    [agentId, turnEpoch],
  );

  useModelVisibleTool(
    {
      name: "get_schedule_section",
      agentId,
      description:
        "Read one section of the schedule in full. The complete schedule is already in your " +
        "context; call this to get the exact ids of people, staff groups, shifts or rules " +
        "before a change that names them, or to re-read a section after the user says they " +
        "changed something.",
      parameters: sliceParameters,
      // `domain` feeds an exhaustive switch. It arrives validated: a missing or
      // wrong-typed one is refused by the wrapper, where it used to fall through the
      // switch and return `undefined` -- which the locked core turns into an EMPTY tool
      // result, and the model reads an empty result as an answer.
      handler: async (args) => readSection(args.domain),
    },
    [agentId, turnEpoch],
  );
}

/** Setup progress over the live committed projection. Never mutates. */
export function readSetupProgress(): SetupProgress {
  const scenario = pickScenario(useScenarioStore.getState());
  const coverage = computeCoverageWarnings(scenario, scenario.cardsByKind.requirements);
  return deriveSetupProgress({
    summary: computeScenarioSummary(scenario),
    runComplete: isRosterGenerated(useHotStore.getState().runView),
    uncoveredShifts: coverage.undefinedSection?.items ?? [],
    knownGaps: findStaffingShortfalls(scenario).length,
  });
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
