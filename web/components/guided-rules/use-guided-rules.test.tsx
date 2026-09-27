// @vitest-environment jsdom
//
// Perf guard for the Rules screen's store subscription (b8z). The screen used to
// read the WHOLE scenario store (`useScenarioStore((s) => s)`), so a mutation
// anywhere in the app re-rendered it and reprojected the entire rule library. It
// now reads exactly the two slices it derives from, so an edit elsewhere must
// leave it alone. The render counter is the observable: a re-render here IS a
// reprojection of every row on a keystroke somewhere else.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { scenarioCommands, useScenarioStore } from "@/lib/store";
import { drainScenarioCommands, resetScenarioForTest } from "@/lib/store/test-authority";
import { useGuidedRules } from "./use-guided-rules";

let renders = 0;

/** Renders what the Rules screen reads through the hook, and counts its renders. */
function Probe() {
  const { state, rows } = useGuidedRules();
  renders += 1;
  return (
    <div data-testid="probe">
      {state.cardsByKind.requirements.length}/{rows.length}
    </div>
  );
}

/** Fire one durable command and let the committed projection settle. */
async function mutate(patch: Parameters<typeof scenarioCommands.mutate>[0]): Promise<void> {
  await act(async () => {
    await scenarioCommands.mutate(patch);
    await drainScenarioCommands();
  });
}

beforeEach(async () => {
  renders = 0;
  await resetScenarioForTest();
});

afterEach(() => {
  cleanup();
});

describe("useGuidedRules — narrowed store subscription", () => {
  it("does not re-render on a mutation to a slice the Rules screen never reads", async () => {
    render(<Probe />);
    const before = renders;

    // `meta` belongs to the shell's scenario name; Rules never reads it.
    await mutate((s) => ({ meta: { ...s.meta, description: "Ward A" } }));
    expect(useScenarioStore.getState().meta.description).toBe("Ward A");

    expect(renders).toBe(before);
  });

  it("does not re-render when an unread slice changes, however deep the edit", async () => {
    render(<Probe />);
    const before = renders;

    await mutate(() => ({ staff: [{ id: "p1", description: "Ana" }] }));
    expect(useScenarioStore.getState().staff).toHaveLength(1);

    expect(renders).toBe(before);
  });

  it("still re-renders — and reprojects — when a slice it DOES read changes", async () => {
    render(<Probe />);
    const before = renders;

    await mutate((s) => ({
      cardsByKind: {
        ...s.cardsByKind,
        requirements: [
          { uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1, description: "Day cap" },
        ],
      },
    }));

    expect(renders).toBeGreaterThan(before);
    // The built-in row plus the new requirement's row.
    expect(screen.getByTestId("probe").textContent).toBe("1/2");
  });
});
