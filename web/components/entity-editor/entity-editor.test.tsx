// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ScenarioUiState } from "@/lib/scenario";
import {
  drainScenarioPersist,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { peopleDescriptor } from "@/components/people/people-descriptor";
import type { EntityId } from "./core";
import { EntityEditor } from "./entity-editor";

// The generic editor commits every membership toggle through the same
// `mutateScenario` path as the rest of the surface (one patch ⇒ one zundo entry),
// so these tests drive the restored inline ×-remove against the real scenario
// store and assert the read model — the staff/staffGroups slices — directly.

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function seed(patch: Partial<ScenarioUiState>) {
  act(() => {
    useScenarioStore.getState().mutateScenario(patch);
  });
}

function membersOf(groupId: string): EntityId[] {
  return useScenarioStore.getState().staffGroups.find((g) => g.id === groupId)?.members ?? [];
}

function historyLength(): number {
  return useScenarioStore.temporal.getState().pastStates.length;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
});

afterEach(() => {
  cleanup();
});

describe("EntityEditor — inline membership ×-remove (AC-ED-11 / FR-ED-17/18)", () => {
  it("removes exactly one (item, group) membership from an item row", () => {
    seed({
      staff: [
        { id: "Aisha", history: [] },
        { id: "Chloe", history: [] },
      ],
      staffGroups: [
        { id: "Nurses", members: ["Aisha", "Chloe"] },
        { id: "Seniors", members: ["Aisha"] },
      ],
    });
    render(<EntityEditor descriptor={peopleDescriptor} />);

    fireEvent.click(screen.getByTestId("item-group-remove-string:Aisha-Nurses"));

    // Only Aisha's Nurses membership is gone.
    expect(membersOf("Nurses")).toEqual(["Chloe"]);
    // Aisha's other membership and the other item's membership are untouched.
    expect(membersOf("Seniors")).toEqual(["Aisha"]);
    // The removed badge no longer renders on Aisha's row; the surviving one does.
    const aishaGroups = screen.getByTestId("item-groups-string:Aisha");
    expect(within(aishaGroups).queryByText("Nurses")).not.toBeInTheDocument();
    expect(within(aishaGroups).getByText("Seniors")).toBeInTheDocument();
  });

  it("removes exactly one member from a group row", () => {
    seed({
      staff: [
        { id: "Aisha", history: [] },
        { id: "Chloe", history: [] },
      ],
      staffGroups: [
        { id: "Nurses", members: ["Aisha", "Chloe"] },
        { id: "Seniors", members: ["Aisha"] },
      ],
    });
    render(<EntityEditor descriptor={peopleDescriptor} />);

    fireEvent.click(screen.getByTestId("group-member-remove-Nurses-string:Chloe"));

    expect(membersOf("Nurses")).toEqual(["Aisha"]);
    expect(membersOf("Seniors")).toEqual(["Aisha"]);
  });

  it("commits the remove as a single tracked mutation that undo reverses", () => {
    seed({
      staff: [{ id: "Aisha", history: [] }],
      staffGroups: [{ id: "Nurses", members: ["Aisha"] }],
    });
    render(<EntityEditor descriptor={peopleDescriptor} />);

    const before = historyLength();
    fireEvent.click(screen.getByTestId("item-group-remove-string:Aisha-Nurses"));

    expect(membersOf("Nurses")).toEqual([]);
    expect(historyLength()).toBe(before + 1);

    act(() => {
      useScenarioStore.temporal.getState().undo();
    });
    expect(membersOf("Nurses")).toEqual(["Aisha"]);
  });

  it("preserves the group's unknown/nested members when removing one real member", () => {
    seed({
      staff: [{ id: "Aisha", history: [] }],
      // "ghost" is not a live item — the SET writer must carry it through untouched.
      staffGroups: [{ id: "Nurses", members: ["Aisha", "ghost"] }],
    });
    render(<EntityEditor descriptor={peopleDescriptor} />);

    fireEvent.click(screen.getByTestId("group-member-remove-Nurses-string:Aisha"));

    expect(membersOf("Nurses")).toEqual(["ghost"]);
  });

  it('respects exact typed identity — removing string "1" leaves numeric 1', () => {
    seed({
      staff: [{ id: 1, history: [] }],
      // Numeric 1 and string "1" are DISTINCT ids (sameEntityId / Object.is).
      staffGroups: [{ id: "Nums", members: [1, "1"] }],
    });
    render(<EntityEditor descriptor={peopleDescriptor} />);

    fireEvent.click(screen.getByTestId("group-member-remove-Nums-string:1"));

    expect(membersOf("Nums")).toEqual([1]);
  });
});
