import { describe, expect, it } from "vitest";
import { computeScenarioSummary } from "@/components/home/scenario-summary";
import { SCENARIOS } from "@/lib/rules/ward-fixtures.test-support";
import { deriveSetupProgress } from "./setup-progress";

const input = (scenario = SCENARIOS.empty()) => ({
  summary: computeScenarioSummary(scenario),
  runComplete: false,
  uncoveredShifts: [] as string[],
  knownGaps: 0,
});

describe("deriveSetupProgress", () => {
  it("starts an empty scenario at the dates step with its questions", () => {
    const progress = deriveSetupProgress(input());
    expect(progress.nextStep?.id).toBe("dates");
    expect(progress.nextStep?.ask.length).toBeGreaterThan(0);
    expect(progress.nextStep?.proposeWith).toContain("set_roster_range");
    expect(progress.readyToRun).toBe(false);
    expect(progress.steps.map((s) => s.id)).toEqual([
      "dates",
      "people",
      "shiftTypes",
      "rules",
      "requests",
      "run",
      "review",
    ]);
  });

  it("does not count rules as done while a shift has no staffing requirement", () => {
    const progress = deriveSetupProgress({
      ...input(SCENARIOS.onlyRnOnLeave()),
      uncoveredShifts: ["E: ALL"],
    });
    const rules = progress.steps.find((s) => s.id === "rules");
    expect(rules?.done).toBe(false);
    expect(rules?.detail).toContain("E: ALL");
    expect(progress.nextStep?.id).toBe("rules");
  });

  it("is ready to run without any requests, because requests are optional", () => {
    const progress = deriveSetupProgress(input(SCENARIOS.ruleTooStrict()));
    expect(progress.steps.find((s) => s.id === "requests")).toMatchObject({
      done: false,
      optional: true,
    });
    expect(progress.readyToRun).toBe(true);
    expect(progress.nextStep?.id).toBe("requests");
  });

  it("reports known gaps so the assistant can warn before running", () => {
    expect(
      deriveSetupProgress({ ...input(SCENARIOS.onlyRnOnLeave()), knownGaps: 1 }).knownGaps,
    ).toBe(1);
  });

  it("moves to review only after a roster has been generated", () => {
    const progress = deriveSetupProgress({
      ...input(SCENARIOS.onlyRnOnLeave()),
      runComplete: true,
    });
    expect(progress.steps.find((s) => s.id === "run")?.done).toBe(true);
    expect(progress.nextStep?.id).toBe("review");
  });

  it("carries the playbook version and instructions", () => {
    const progress = deriveSetupProgress(input());
    expect(progress.playbookVersion).toMatch(/^\d{4}-/);
    expect(progress.instructions.join(" ")).toMatch(/get_setup_progress/);
  });
});
