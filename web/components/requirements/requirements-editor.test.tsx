// @vitest-environment jsdom
//
// Perf guard for the Staffing Requirements editor (b8z). Two changes are pinned
// here, both from the same whole-store-subscription finding:
//
//   • the editor's scenario read is NARROWED, so an edit to a slice it does not
//     read (the scenario name, a card of another kind) no longer re-renders it;
//   • `computeCoverageWarnings` is MEMOIZED on its real inputs, so that read is no
//     longer an `O(requirements × dates × shiftTypes)` recompute on every store
//     write.
//
// The observable is the derivation's OWN call count, not the banner it renders: on
// a large roster one spurious run is the entire cost this ticket removes.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { scenarioCommands, useScenarioStore } from "@/lib/store";
import { drainScenarioCommands, resetScenarioForTest } from "@/lib/store/test-authority";
import { computeCoverageWarnings } from "./requirements-model";
import { RequirementsEditor } from "./requirements-editor";

vi.mock("./requirements-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./requirements-model")>();
  return { ...actual, computeCoverageWarnings: vi.fn(actual.computeCoverageWarnings) };
});

const coverage = vi.mocked(computeCoverageWarnings);

/** Fire one durable command and let the committed projection settle. */
async function mutate(patch: Parameters<typeof scenarioCommands.mutate>[0]): Promise<void> {
  await act(async () => {
    await scenarioCommands.mutate(patch);
    await drainScenarioCommands();
  });
}

beforeEach(async () => {
  coverage.mockClear();
  await resetScenarioForTest();
});

afterEach(() => {
  cleanup();
});

describe("RequirementsEditor — narrowed subscription, memoized coverage", () => {
  it("recomputes the coverage banner only when one of its real inputs changes", async () => {
    render(<RequirementsEditor />);
    const initialRuns = coverage.mock.calls.length;
    expect(initialRuns).toBeGreaterThanOrEqual(1);

    coverage.mockClear();

    // The scenario name is the shell's, not this screen's.
    await mutate((s) => ({ meta: { ...s.meta, description: "Ward A" } }));
    expect(useScenarioStore.getState().meta.description).toBe("Ward A");
    expect(coverage).not.toHaveBeenCalled();

    // Neither is a card of another kind — the very edit the finding names.
    await mutate((s) => ({
      cardsByKind: {
        ...s.cardsByKind,
        successions: [{ uid: "s1", person: "p1", pattern: ["D", "N"], weight: -1 }],
      },
    }));
    expect(useScenarioStore.getState().cardsByKind.successions).toHaveLength(1);
    expect(coverage).not.toHaveBeenCalled();

    // The worked shift types ARE an input: coverage is computed against them.
    await mutate(() => ({ shifts: [{ id: "D", description: "Day" }] }));
    expect(useScenarioStore.getState().shifts).toHaveLength(1);
    expect(coverage).toHaveBeenCalledTimes(1);

    coverage.mockClear();

    // And so is the requirement list itself.
    await mutate((s) => ({
      cardsByKind: {
        ...s.cardsByKind,
        requirements: [
          { uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1, description: "Day cap" },
        ],
      },
    }));
    expect(coverage).toHaveBeenCalledTimes(1);
  });
});
