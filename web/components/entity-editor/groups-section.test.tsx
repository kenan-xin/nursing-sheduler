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

describe("GroupsSection — drag-over is its own state, not selection", () => {
  function seedThree() {
    seed({
      staff: [],
      staffGroups: [
        { id: "A", members: [] },
        { id: "B", members: [] },
      ],
    });
  }

  it("marks the row under the pointer as a drop target, never as selected", () => {
    seedThree();
    render(<GroupsHarness />);
    const target = screen.getByTestId("group-row-B");
    expect(target.className).not.toContain("border-dashed");

    fireEvent.dragStart(screen.getByTestId("group-row-A"));
    fireEvent.dragOver(target);

    // The drop candidate takes the dashed brand edge over the hover tone...
    expect(target.className).toContain("border-dashed");
    expect(target.className).toContain("border-brand");
    expect(target.className).toContain("bg-panel-alt");
    // ...and specifically NOT the selection language reserved for "current".
    expect(target.className).not.toContain("bg-brandtint");
    // The dragged source row is dimmed by the same recipe, not by a local class.
    expect(screen.getByTestId("group-row-A").className).toContain("opacity-50");
  });

  it("uses the selected role for the open editor, which the drop state never borrows", () => {
    seedThree();
    render(<GroupsHarness />);
    fireEvent.click(screen.getByTestId("group-edit-A"));
    const form = screen.getByTestId("group-edit-form-A");
    expect(form.className).toContain("border-brand");
    expect(form.className).not.toContain("border-dashed");
  });

  it("still reorders on drop, unchanged", () => {
    seedThree();
    render(<GroupsHarness />);
    const before = historyLength();

    fireEvent.dragStart(screen.getByTestId("group-row-A"));
    fireEvent.dragOver(screen.getByTestId("group-row-B"));
    fireEvent.drop(screen.getByTestId("group-row-B"));

    expect(groupOrder()).toEqual(["B", "A"]);
    expect(historyLength()).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// ii7.8.5 — the prototype's containing card / header band / nested well hierarchy.
//
// These pin the SHAPE of the surface tree (which role each node takes, and that
// the containing card and its band exist at all). The resolved PAINT — real
// computed background, border, radius, shadow — cannot be measured in jsdom, so it
// is proven in Chromium by the narrow route assertions in `e2e/people.spec.ts` and
// `e2e/shift-types.spec.ts`. Neither layer is sufficient alone: this one would pass
// on a class name that resolved to nothing, and that one cannot run in both configs
// as cheaply.
// ---------------------------------------------------------------------------

describe.each([
  ["Staff config (defaults)", undefined],
  ["Shift config", shiftConfig],
])("GroupsSection surface hierarchy — %s", (_name, config) => {
  function seedTwo() {
    seed({
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
      ],
      staffGroups: [
        { id: "Team", members: ["P1"] },
        { id: "Squad", members: ["P2"] },
      ],
    });
  }

  it("the section IS the single L1 containing card — not a transparent wrapper", () => {
    seedTwo();
    render(<GroupsHarness config={config} />);

    const section = screen.getByTestId("groups-section");
    // L1: --surface fill, --line hairline, --sh-1, card radius (DESIGN.md §5
    // Cards; measured on the prototype as rgb(252,254,253) / 1px --line / 16px).
    expect(section.className).toContain("bg-surface");
    expect(section.className).toContain("border-line");
    expect(section.className).toContain("shadow-1");
    expect(section.className).toContain("rounded-card");
    // The card itself carries no padding: the band and the body own the insets so
    // the band's hairline reaches the card edge.
    expect(section.className).not.toMatch(/(?:^|\s)p-\d/);
  });

  it("carries a full-bleed header band with a single bottom hairline, and stays square", () => {
    seedTwo();
    render(<GroupsHarness config={config} />);

    const header = screen.getByTestId("groups-header");
    expect(header.className).toContain("border-b");
    expect(header.className).toContain("border-line2");
    // DESIGN.md §5: a container whose border is a single edge rather than a box
    // stays square, and never takes a box border or a well shadow.
    expect(header.className).not.toMatch(/rounded-(?!none)/);
    expect(header.className).not.toMatch(/(?:^|\s)shadow-/);
    expect(header.className).not.toMatch(/(?:^|\s)border(?:$|\s)/);

    // The heading and the add control both live in the band.
    expect(within(header).getByRole("heading", { level: 2 })).toBeInTheDocument();
    expect(within(header).getByTestId("add-group-toggle")).toBeInTheDocument();
  });

  it("nests every group row as a WELL inside that card, never as a second L1 card", () => {
    seedTwo();
    render(<GroupsHarness config={config} />);

    for (const id of ["Team", "Squad"]) {
      const row = screen.getByTestId(`group-row-${id}`);
      // The prototype measures --panel / 12px / --sh-well on these rows, and
      // DESIGN.md §4 rule 5 forbids an L1 card inside an L1 card.
      expect(row.className).toContain("bg-panel");
      expect(row.className).toContain("shadow-well");
      expect(row.className).toContain("rounded-control");
      expect(row.className).not.toContain("bg-surface");
      expect(row.className).not.toContain("shadow-1");
      expect(row.className).not.toContain("rounded-card");
    }

    // The locked auto group sits on the SAME plane as the authorable rows — it is
    // distinguished by its lock and copy, not by being a different surface.
    const auto = screen.getByTestId("synthetic-ALL");
    expect(auto.className).toContain("bg-panel");
    expect(auto.className).toContain("shadow-well");
    expect(auto.className).toContain("rounded-control");
  });

  it("gives BOTH the add and the edit form the active-editor `selected` role", () => {
    seedTwo();
    render(<GroupsHarness config={config} />);

    fireEvent.click(screen.getByTestId("add-group-toggle"));
    const add = screen.getByTestId("add-group-form");
    expect(add.className).toContain("border-brand");
    expect(add.className).toContain("shadow-2");
    // A plain L1 form inside the L1 card would be the same-tone stack §4 rule 5
    // forbids, with no brand edge to tell it apart.
    expect(add.className).toContain("bg-surface");
    expect(add.className).not.toContain("border-line");
    fireEvent.click(screen.getByTestId("group-cancel-__new__"));

    fireEvent.click(screen.getByTestId("group-edit-Team"));
    const edit = screen.getByTestId("group-edit-form-Team");
    expect(edit.className).toContain("border-brand");
    expect(edit.className).toContain("shadow-2");

    // The add and edit forms are ONE visual state, as they are in the prototype
    // ("add group" there opens a new row already in the editing state).
    expect(edit.className).toBe(add.className);
  });

  it("shows the empty state beside the auto group whenever no CUSTOM group exists", () => {
    seed({ staff: [{ id: "P1", history: [] }], staffGroups: [] });
    render(<GroupsHarness config={config} />);

    // Both live routes always publish a synthetic group, so gating the empty
    // state on `syntheticGroups.length === 0` made every route's authored
    // `emptyText` unreachable. The prototypes' own `noGroups` counts custom
    // groups only and renders the empty state next to the auto row.
    expect(screen.getByTestId("synthetic-ALL")).toBeInTheDocument();
    const empty = screen.getByTestId("groups-empty");
    expect(empty).toBeInTheDocument();
    expect(empty.className).toContain("border-dashed");
    expect(empty.className).toContain("rounded-control");

    // ...and it goes away as soon as one exists.
    act(() => {
      useScenarioStore.getState().mutateScenario({ staffGroups: [{ id: "Team", members: [] }] });
    });
    expect(screen.queryByTestId("groups-empty")).not.toBeInTheDocument();
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

  it("renders the optional header description inside the band, and omits it by default", () => {
    seed({ staff: [], staffGroups: [] });
    const { unmount } = render(<GroupsHarness />);
    // Default: a single-line band, exactly as before this prop existed.
    expect(within(screen.getByTestId("groups-header")).queryByText(/Bundle nurses/)).toBeNull();
    unmount();

    render(<GroupsHarness config={{ description: "Bundle nurses into a team." }} />);
    expect(
      within(screen.getByTestId("groups-header")).getByText("Bundle nurses into a team."),
    ).toBeInTheDocument();
  });

  it("renders the reserved auto-group locked with an accessible note", () => {
    seed({ staff: [], staffGroups: [] });
    render(<GroupsHarness />);

    const auto = screen.getByTestId("synthetic-ALL");
    expect(auto).toHaveAttribute("title", "Everyone");
    expect(within(auto).getByText("Everyone")).toBeInTheDocument();
  });
});
