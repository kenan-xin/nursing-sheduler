// What is set up, what is missing, and what the assistant should do next.
//
// Derived from the SAME summary the Home "Build Your Roster" cards use
// (computeScenarioSummary), so the assistant and Home never disagree about a step.
// Two differences, both deliberate: Rules counts as done only when every worked shift
// has a staffing requirement on every date (one rule is not a finished setup), and
// Requests is optional ("nobody has leave" is a real answer).

import type { ScenarioSummary } from "@/components/home/scenario-summary";
import {
  PLAYBOOK_VERSION,
  SETUP_INSTRUCTIONS,
  SETUP_STEPS,
  type SetupStepGuide,
  type SetupStepId,
} from "./playbook";

export interface SetupProgressInput {
  summary: Pick<
    ScenarioSummary,
    | "ready"
    | "rosterMonthLabel"
    | "durationDays"
    | "peopleCount"
    | "staffGroupsCount"
    | "shiftTypesCount"
    | "rulesTotal"
    | "shiftRequestsCount"
  >;
  /** A roster has been generated (Home's own Generate rule: run.phase === "complete"). */
  runComplete: boolean;
  /** Shift/date pairs with no staffing requirement (computeCoverageWarnings items). */
  uncoveredShifts: readonly string[];
  /** How many static-check findings the scenario has now. */
  knownGaps: number;
}

export interface SetupStepStatus {
  id: SetupStepId;
  label: string;
  optional: boolean;
  done: boolean;
  detail: string;
}

export interface SetupProgress {
  playbookVersion: string;
  steps: SetupStepStatus[];
  nextStep: (SetupStepStatus & Pick<SetupStepGuide, "ask" | "proposeWith" | "capabilityId">) | null;
  readyToRun: boolean;
  knownGaps: number;
  instructions: readonly string[];
}

export function deriveSetupProgress(input: SetupProgressInput): SetupProgress {
  const s = input.summary;
  const uncovered = input.uncoveredShifts;
  const status: Record<SetupStepId, { done: boolean; detail: string }> = {
    dates: {
      done: s.ready.dates,
      detail: s.ready.dates
        ? `${s.rosterMonthLabel ?? "Range set"}, ${s.durationDays} days`
        : "No valid roster period yet",
    },
    people: {
      done: s.ready.people,
      detail: `${s.peopleCount} people, ${s.staffGroupsCount} groups`,
    },
    shiftTypes: { done: s.ready.shiftTypes, detail: `${s.shiftTypesCount} shift types` },
    rules: {
      done: s.ready.rules && uncovered.length === 0,
      detail:
        uncovered.length > 0
          ? `No staffing requirement for: ${uncovered.join("; ")}`
          : `${s.rulesTotal} rules`,
    },
    requests: {
      done: s.ready.requests,
      detail: `${s.shiftRequestsCount} requests or leave entered (optional)`,
    },
    run: {
      done: input.runComplete,
      detail: input.runComplete ? "A roster has been generated" : "Not run yet",
    },
    review: { done: false, detail: "Go through the generated roster with the user" },
  };

  const steps = SETUP_STEPS.map((guide) => ({
    id: guide.id,
    label: guide.label,
    optional: guide.optional,
    ...status[guide.id],
  }));
  const readyToRun = steps
    .filter((step) => !step.optional && step.id !== "run" && step.id !== "review")
    .every((step) => step.done);
  const next = steps.find((step) => !step.done && (step.id !== "review" || input.runComplete));
  const guide = next ? SETUP_STEPS.find((g) => g.id === next.id) : undefined;

  return {
    playbookVersion: PLAYBOOK_VERSION,
    steps,
    nextStep:
      next && guide
        ? {
            ...next,
            ask: guide.ask,
            proposeWith: guide.proposeWith,
            capabilityId: guide.capabilityId,
          }
        : null,
    readyToRun,
    knownGaps: input.knownGaps,
    instructions: SETUP_INSTRUCTIONS,
  };
}
