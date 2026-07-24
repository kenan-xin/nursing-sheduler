// @vitest-environment jsdom
import "fake-indexeddb/auto";
import * as React from "react";
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
import { GroupsSection, type GroupsSectionConfig } from "./groups-section";

// The extracted GroupsSection is behavior-preserving: it commits every change through
// the same `mutateScenario` path (one composed state ⇒ one zundo entry) and relies on
// the parent's stale-token guard. This harness mirrors EntityEditor's group-scoped
// selection + form-open token + close-on-external effect exactly, so the extraction
// contract is tested against the real scenario store. The suite runs in BOTH configs
// (member-search on/off, both count nouns, both pane labels).

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

type GroupSel = null | { t: "add-group" } | { t: "edit-group"; id: string };

function GroupsHarness({ config }: { config?: GroupsSectionConfig }) {
  const descriptor = peopleDescriptor;
  const items = useScenarioStore(descriptor.readItems);
  const groups = useScenarioStore(descriptor.readGroups);
  const commit = React.useCallback((next: ScenarioUiState) => {
    useScenarioStore.getState().mutateScenario(next);
  }, []);
  const currentState = React.useCallback(() => useScenarioStore.getState() as ScenarioUiState, []);

  const [sel, setSel] = React.useState<GroupSel>(null);
  const editing = sel !== null;

  const openToken = React.useRef<{ items: typeof items; groups: typeof groups } | null>(null);
  const wasEditing = React.useRef(false);
  if (editing !== wasEditing.current) {
    wasEditing.current = editing;
    openToken.current = editing ? { items, groups } : null;
  }
  const isStale = React.useCallback(() => {
    const token = openToken.current;
    if (token === null) return false;
    const live = useScenarioStore.getState() as ScenarioUiState;
    return (
      descriptor.readItems(live) !== token.items || descriptor.readGroups(live) !== token.groups
    );
  }, [descriptor]);
  React.useEffect(() => {
    if (editing && isStale()) setSel(null);
  });

  return (
    <GroupsSection
      descriptor={descriptor}
      items={items}
      groups={groups}
      commit={commit}
      currentState={currentState}
      isStale={isStale}
      editing={editing}
      addOpen={sel?.t === "add-group"}
      editingGroupId={sel?.t === "edit-group" ? sel.id : null}
      onToggleAdd={() => setSel((cur) => (cur?.t === "add-group" ? null : { t: "add-group" }))}
      onEditGroup={(id) => setSel({ t: "edit-group", id })}
      onCloseForm={() => setSel(null)}
      config={config}
    />
  );
}

function seed(patch: Partial<ScenarioUiState>) {
  act(() => {
    useScenarioStore.getState().mutateScenario(patch);
  });
}

function membersOf(groupId: string): EntityId[] {
  return useScenarioStore.getState().staffGroups.find((g) => g.id === groupId)?.members ?? [];
}

function groupOrder(): string[] {
  return useScenarioStore.getState().staffGroups.map((g) => g.id);
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

// Two configs: `undefined` = today's Staff defaults (search on, "N members", MEMBERS);
// the Shift-style config (search off, "N TYPES", IN GROUP).
const shiftConfig: GroupsSectionConfig = {
  showMemberSearch: false,
  selectedPaneLabel: "IN GROUP",
  selectedTestKey: "in-group",
  formatCount: (n) => `${n} TYPES`,
};

describe.each([
  ["Staff config (defaults)", undefined],
  ["Shift config", shiftConfig],
])("GroupsSection extraction contract — %s", (_name, config) => {
  it("atomic Save composes one commit / one undo entry", () => {
    seed({
      staff: [
        { id: "Aisha", history: [] },
        { id: "Chloe", history: [] },
      ],
      staffGroups: [],
    });
    render(<GroupsHarness config={config} />);

    fireEvent.click(screen.getByTestId("add-group-toggle"));
    fireEvent.change(screen.getByTestId("add-group-id"), { target: { value: "Nurses" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Aisha to group" }));

    const before = historyLength();
    fireEvent.click(screen.getByTestId("group-save-__new__"));

    expect(membersOf("Nurses")).toEqual(["Aisha"]);
    expect(historyLength()).toBe(before + 1);

    act(() => {
      useScenarioStore.temporal.getState().undo();
    });
    expect(groupOrder()).not.toContain("Nurses");
  });

  it("Cancel discards the draft with no commit", () => {
    seed({ staff: [{ id: "Aisha", history: [] }], staffGroups: [] });
    render(<GroupsHarness config={config} />);

    fireEvent.click(screen.getByTestId("add-group-toggle"));
    fireEvent.change(screen.getByTestId("add-group-id"), { target: { value: "Nurses" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Aisha to group" }));

    const before = historyLength();
    fireEvent.click(screen.getByTestId("group-cancel-__new__"));

    expect(groupOrder()).not.toContain("Nurses");
    expect(historyLength()).toBe(before);
  });

  it("rejects a stale Save — an external change closes the draft with no write-back", () => {
    seed({
      staff: [
        { id: "Aisha", history: [] },
        { id: "Chloe", history: [] },
      ],
      staffGroups: [{ id: "G", members: ["Aisha"] }],
    });
    render(<GroupsHarness config={config} />);

    fireEvent.click(screen.getByTestId("group-edit-G"));
    // Stage a draft membership change (Chloe) that must NOT be written.
    fireEvent.click(screen.getByRole("button", { name: "Add Chloe to group" }));

    // An external change to the group slice while editing (undo/redo or a cascade).
    seed({
      staffGroups: [
        { id: "G", members: ["Aisha"] },
        { id: "H", members: [] },
      ],
    });

    // The form closes and the draft's Chloe is never committed.
    expect(screen.queryByTestId("group-edit-form-G")).not.toBeInTheDocument();
    expect(membersOf("G")).toEqual(["Aisha"]);
    expect(groupOrder()).toContain("H");
  });

  it("preserves unknown / nested members through an edit Save", () => {
    seed({
      staff: [{ id: "Aisha", history: [] }],
      // "ghost" is not a live item — the SET writer carries it through untouched.
      staffGroups: [{ id: "G", members: ["Aisha", "ghost"] }],
    });
    render(<GroupsHarness config={config} />);

    fireEvent.click(screen.getByTestId("group-edit-G"));
    fireEvent.click(screen.getByTestId("group-save-G"));

    expect(membersOf("G")).toEqual(["Aisha", "ghost"]);
  });

  it('respects exact typed identity — removing numeric 1 in the draft leaves string "1"', () => {
    seed({
      staff: [{ id: 1, history: [] }],
      // Numeric 1 is a live item; string "1" is a distinct unknown/nested member.
      staffGroups: [{ id: "Nums", members: [1, "1"] }],
    });
    render(<GroupsHarness config={config} />);

    fireEvent.click(screen.getByTestId("group-edit-Nums"));
    // Only numeric 1 is in the draft (string "1" is not a live item); remove it.
    fireEvent.click(screen.getByRole("button", { name: "Remove 1 from group" }));
    fireEvent.click(screen.getByTestId("group-save-Nums"));

    expect(membersOf("Nums")).toEqual(["1"]);
  });

  it("removes exactly one member via the row ×-remove (one tracked mutation)", () => {
    seed({
      staff: [
        { id: "Aisha", history: [] },
        { id: "Chloe", history: [] },
      ],
      staffGroups: [{ id: "Nurses", members: ["Aisha", "Chloe"] }],
    });
    render(<GroupsHarness config={config} />);

    const before = historyLength();
    fireEvent.click(screen.getByTestId("group-member-remove-Nurses-string:Chloe"));

    expect(membersOf("Nurses")).toEqual(["Aisha"]);
    expect(historyLength()).toBe(before + 1);
  });

  it("reorders groups by keyboard (Up/Down) — one commit / one undo entry", () => {
    seed({
      staff: [],
      staffGroups: [
        { id: "A", members: [] },
        { id: "B", members: [] },
        { id: "C", members: [] },
      ],
    });
    render(<GroupsHarness config={config} />);

    // Boundary controls are disabled (self-explanatory, never write).
    expect(screen.getByTestId("group-move-up-A")).toBeDisabled();
    expect(screen.getByTestId("group-move-down-C")).toBeDisabled();

    const before = historyLength();
    fireEvent.click(screen.getByTestId("group-move-down-A"));

    expect(groupOrder()).toEqual(["B", "A", "C"]);
    expect(historyLength()).toBe(before + 1);

    act(() => {
      useScenarioStore.temporal.getState().undo();
    });
    expect(groupOrder()).toEqual(["A", "B", "C"]);
  });
});

describe("GroupsSection parameterization — copy + flags", () => {
  it("Staff config shows the member search, MEMBERS pane, and 'N members' count", () => {
    seed({
      staff: [
        { id: "Aisha", history: [] },
        { id: "Chloe", history: [] },
      ],
      staffGroups: [{ id: "Nurses", members: ["Aisha", "Chloe"] }],
    });
    render(<GroupsHarness />);

    // Row count noun.
    expect(
      within(screen.getByTestId("group-row-Nurses")).getByText("2 members"),
    ).toBeInTheDocument();

    // Open add form: search box present, selected pane titled MEMBERS.
    fireEvent.click(screen.getByTestId("add-group-toggle"));
    expect(screen.getByTestId("transfer-search-__new__")).toBeInTheDocument();
    expect(screen.getByText("MEMBERS")).toBeInTheDocument();
  });

  it("Shift config hides the member search, uses IN GROUP pane, and 'N TYPES' count", () => {
    seed({
      staff: [
        { id: "Aisha", history: [] },
        { id: "Chloe", history: [] },
      ],
      staffGroups: [{ id: "Nurses", members: ["Aisha", "Chloe"] }],
    });
    render(<GroupsHarness config={shiftConfig} />);

    expect(within(screen.getByTestId("group-row-Nurses")).getByText("2 TYPES")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("add-group-toggle"));
    expect(screen.queryByTestId("transfer-search-__new__")).not.toBeInTheDocument();
    expect(screen.getByText("IN GROUP")).toBeInTheDocument();
  });

  it("renders the reserved auto-group locked with an accessible note", () => {
    seed({ staff: [], staffGroups: [] });
    render(<GroupsHarness />);

    const auto = screen.getByTestId("synthetic-ALL");
    expect(auto).toHaveAttribute("title", "Everyone");
    expect(within(auto).getByText("Everyone")).toBeInTheDocument();
  });
});
