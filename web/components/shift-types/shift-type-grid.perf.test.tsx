// @vitest-environment jsdom
//
// Perf guard for the Shifts card-grid's store subscription (zqu, the b8z follow-up).
// The grid used to read the WHOLE scenario store (`useScenarioStore((s) => s)`), so a
// mutation anywhere in the app re-rendered it — and, because every card resolves its
// staffing summary on render, re-ran `requirementsForShiftType` per card. It now
// reads the five scope slices plus the REQUIREMENT card list alone (`cardsByKind` is
// narrowed a level deeper on purpose: that object changes identity on an edit to any
// card kind, including the ones this screen never reads).
//
// The observable is a `Profiler` commit on the grid's own subtree: a store write that
// re-renders the screen IS a commit here, and one that does not is not — no matter
// which card would have reprojected.

import "fake-indexeddb/auto";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { scenarioCommands, useScenarioStore } from "@/lib/store";
import { drainScenarioCommands, resetScenarioForTest } from "@/lib/store/test-authority";
import { ShiftTypeGrid } from "./shift-type-grid";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/shift-types",
}));

let commits = 0;

/** Renders the real grid and counts commits inside its subtree. */
function Tracked() {
  return (
    <Profiler
      id="shift-type-grid"
      onRender={() => {
        commits += 1;
      }}
    >
      <ShiftTypeGrid />
    </Profiler>
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
  commits = 0;
  await resetScenarioForTest();
  await drainScenarioCommands();
});

afterEach(() => {
  cleanup();
});

describe("ShiftTypeGrid — narrowed store subscription", () => {
  it("does not re-render on a mutation to a slice the screen never reads", async () => {
    render(<Tracked />);
    const before = commits;

    // `meta` belongs to the shell's scenario name; Shifts never reads it.
    await mutate((s) => ({ meta: { ...s.meta, description: "Ward A" } }));
    expect(useScenarioStore.getState().meta.description).toBe("Ward A");

    expect(commits).toBe(before);
  });

  it("does not re-render when a card of a kind it does not read changes", async () => {
    render(<Tracked />);
    const before = commits;

    await mutate((s) => ({
      cardsByKind: {
        ...s.cardsByKind,
        counts: [
          {
            uid: "c1",
            person: "Aisha",
            countDates: ["ALL"],
            countShiftTypes: ["D"],
            expression: "x = T",
            target: 5,
            weight: -1,
          },
        ],
      },
    }));
    expect(useScenarioStore.getState().cardsByKind.counts).toHaveLength(1);

    expect(commits).toBe(before);
  });

  it("still re-renders when a slice it DOES read changes", async () => {
    render(<Tracked />);
    const before = commits;

    await mutate((s) => ({ shifts: [...s.shifts, { id: "D", description: "Day" }] }));
    expect(useScenarioStore.getState().shifts).toHaveLength(1);

    expect(commits).toBeGreaterThan(before);
  });

  it("still re-renders when a requirement card changes — the staffing summaries read them", async () => {
    render(<Tracked />);
    const before = commits;

    await mutate((s) => ({
      cardsByKind: {
        ...s.cardsByKind,
        requirements: [
          { uid: "r1", shiftType: ["D"], requiredNumPeople: 2, weight: -50, date: ["ALL"] },
        ],
      },
    }));
    expect(useScenarioStore.getState().cardsByKind.requirements).toHaveLength(1);

    expect(commits).toBeGreaterThan(before);
  });
});
