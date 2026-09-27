// @vitest-environment jsdom
//
// Perf guard for the requirements card list's cover subscription (the d582 follow-up
// to the b8z/zqu sweep). The list reads the covers that land on each card so its
// Exceptions field can report them, and that read must stay NARROW: a store write the
// cover arithmetic never walks — the scenario name, a count/succession/affinity/
// covering card — must not commit the list's subtree.
//
// The observable is a `Profiler` commit on the list's own subtree, the same form as
// `people-table.perf.test.tsx`: a store write that re-renders the screen IS a commit
// here, and one that does not is not.

import "fake-indexeddb/auto";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { RequirementCard } from "@/lib/scenario";
import { scenarioCommands, useScenarioStore } from "@/lib/store";
import { drainScenarioCommands, resetScenarioForTest } from "@/lib/store/test-authority";
import { RequirementCardList } from "./requirement-card-list";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// Next router is pulled in transitively by GuardedLink's navigation guard.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/shift-type-requirements",
}));

const CARD = {
  uid: "r-all",
  description: "All nurses",
  shiftType: "N",
  requiredNumPeople: 3,
  qualifiedPeople: "ALL",
  date: "ALL",
  weight: -1,
} as unknown as RequirementCard;

const noop = () => undefined;

let commits = 0;

/** Renders the real list and counts commits inside its subtree. */
function Tracked() {
  return (
    <Profiler
      id="requirement-card-list"
      onRender={() => {
        commits += 1;
      }}
    >
      <RequirementCardList
        requirements={[CARD]}
        onEdit={noop}
        onDuplicate={noop}
        onDelete={noop}
        onSetDisabled={noop}
        onReorder={noop}
      />
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
afterEach(() => cleanup());

describe("RequirementCardList — narrowed store subscription", () => {
  it("does not re-render on a mutation to a slice the list never reads", async () => {
    render(<Tracked />);
    const before = commits;

    // `meta` belongs to the shell's scenario name; the list never reads it.
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

  it("still re-renders when the covers it DOES read change", async () => {
    render(<Tracked />);
    const before = commits;

    await mutate(() => ({
      temporaryCover: [
        { name: "Haseena (Ward 3)", date: "2026-10-14", shiftType: "N", groups: [] },
      ],
    }));
    expect(useScenarioStore.getState().temporaryCover).toHaveLength(1);

    expect(commits).toBeGreaterThan(before);
  });

  it("still re-renders when the staff groups a cover resolves against change", async () => {
    render(<Tracked />);
    const before = commits;

    await mutate((s) => ({
      staffGroups: [...s.staffGroups, { id: "Nights", members: [] }],
    }));
    expect(useScenarioStore.getState().staffGroups).toHaveLength(1);

    expect(commits).toBeGreaterThan(before);
  });
});
