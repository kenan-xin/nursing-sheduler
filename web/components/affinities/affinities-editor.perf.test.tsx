// @vitest-environment jsdom
//
// Perf guard for the Shift Affinities editor's store subscription (zqu, the b8z
// follow-up). The editor used to read the WHOLE scenario store
// (`useScenarioStore((s) => s)`), so a mutation anywhere in the app re-rendered it
// and re-ran its derivations (the affinity card list, the shared people/shift-type
// option builders, the date scopes). It now reads exactly the slices it derives
// from, so an edit elsewhere must leave it alone.
//
// The observable is a `Profiler` commit on the editor's own subtree: a store write
// that re-renders the screen IS a commit here, and one that does not is not — no
// matter which descendant would have reprojected.

import "fake-indexeddb/auto";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { scenarioCommands, useScenarioStore } from "@/lib/store";
import { drainScenarioCommands, resetScenarioForTest } from "@/lib/store/test-authority";
import { AffinitiesEditor } from "./affinities-editor";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// Next router is pulled in transitively by GuardedLink's navigation guard.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/affinities",
}));

let commits = 0;

/** Renders the real editor and counts commits inside its subtree. */
function Tracked() {
  return (
    <Profiler
      id="affinities-editor"
      onRender={() => {
        commits += 1;
      }}
    >
      <AffinitiesEditor />
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

describe("AffinitiesEditor — narrowed store subscription", () => {
  it("does not re-render on a mutation to a slice the screen never reads", async () => {
    render(<Tracked />);
    const before = commits;

    // `meta` belongs to the shell's scenario name; Affinities never reads it.
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

    await mutate((s) => ({ staff: [...s.staff, { id: "Aisha", history: [] }] }));
    expect(useScenarioStore.getState().staff).toHaveLength(1);

    expect(commits).toBeGreaterThan(before);
  });
});
