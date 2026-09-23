// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHotStore } from "@/lib/store";
import { INITIAL_OPTIMIZE_RUN_VIEW, type OptimizeRunView } from "@/lib/optimize/run-view";
import { SCENARIOS } from "@/lib/rules/ward-fixtures.test-support";
import type { ScenarioUiState } from "@/lib/scenario";
import { readSetupProgress } from "./use-context-tools";

const fixture = vi.hoisted(() => ({
  scenario: null as unknown as ScenarioUiState,
  capture: "idle",
}));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return { ...actual, pickScenario: () => fixture.scenario };
});
vi.mock("@/lib/optimize/roster-capture-app", () => ({
  getRosterCaptureGate: () => ({ getState: () => ({ status: fixture.capture }) }),
}));

const setView = (overrides: Partial<OptimizeRunView>) =>
  useHotStore.getState().setRunView({ ...INITIAL_OPTIMIZE_RUN_VIEW, ...overrides });
const runStep = () => readSetupProgress().steps.find((s) => s.id === "run");

beforeEach(() => {
  fixture.scenario = SCENARIOS.onlyRnOnLeave();
  fixture.capture = "idle";
  useHotStore.getState().resetRunView();
});
afterEach(() => useHotStore.getState().resetRunView());

describe("get_setup_progress reads the run the Optimise screen shows", () => {
  it("counts the run done once a feasible run's roster is saved, and moves on to review", () => {
    setView({ lifecycle: "completed", outcome: "feasible", jobId: "job-1" });
    fixture.capture = "committed";
    expect(runStep()?.done).toBe(true);
    expect(readSetupProgress().steps.find((s) => s.id === "review")?.done).toBe(false);
  });

  it("does not count a run whose roster was not saved, or an infeasible one", () => {
    setView({ lifecycle: "completed", outcome: "optimal", jobId: "job-1" });
    expect(runStep()?.done).toBe(false);
    setView({ lifecycle: "completed", outcome: "infeasible", jobId: "job-1" });
    fixture.capture = "committed";
    expect(runStep()?.done).toBe(false);
  });
});
