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
import type { EntityId } from "@/components/entity-editor/core";
import { PeopleTable } from "./people-table";

// The bespoke Staff table drives the SAME pure core + scenario store as the retired
// generic editor: every action is ONE `mutateScenario` (one zundo entry). These tests
// assert the durable read model (staff / staffGroups) and the temporal depth directly,
// plus the load-bearing DR-2 rules — inline name→id with description PRESERVED, the
// reserved-`ALL` rejection, typed-id identity, reorder gating, and the empty state.

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Next router is pulled in transitively by GuardedLink's navigation guard.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/people",
}));

function seed(patch: Partial<ScenarioUiState>) {
  act(() => {
    useScenarioStore.getState().mutateScenario(patch);
  });
}
function staff() {
  return useScenarioStore.getState().staff;
}
function staffGroups() {
  return useScenarioStore.getState().staffGroups;
}
function membersOf(id: string): EntityId[] {
  return staffGroups().find((g) => g.id === id)?.members ?? [];
}
function historyLength() {
  return useScenarioStore.temporal.getState().pastStates.length;
}

const sk = (id: string) => `string:${id}`;
const nk = (n: number) => `number:${n}`;

beforeEach(async () => {
  vi.clearAllMocks();
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
});
afterEach(() => cleanup());

describe("PeopleTable — read + toolbar", () => {
  it("renders a nurse row with ordinal, avatar initials, name, and group chips", () => {
    seed({
      staff: [{ id: "Aisha Rahman", history: [] }],
      staffGroups: [{ id: "Seniors", members: ["Aisha Rahman"] }],
    });
    render(<PeopleTable />);

    const row = screen.getByTestId(`people-row-${sk("Aisha Rahman")}`);
    expect(within(row).getByText("AR")).toBeInTheDocument(); // avatar initials
    expect(within(row).getByTestId(`people-name-${sk("Aisha Rahman")}`)).toHaveTextContent(
      "Aisha Rahman",
    );
    expect(within(row).getByText("Seniors")).toBeInTheDocument();
  });

  it("shows a live result count that reflects the search filter", () => {
    seed({
      staff: [
        { id: "Alice", history: [] },
        { id: "Bob", history: [] },
      ],
      staffGroups: [],
    });
    render(<PeopleTable />);

    expect(screen.getByTestId("people-count")).toHaveTextContent("2 nurses");
    fireEvent.change(screen.getByTestId("people-search"), { target: { value: "ali" } });
    expect(screen.getByTestId("people-count")).toHaveTextContent("1 of 2 nurses match");
  });

  it("renders a No-matches empty state with a working Clear search", () => {
    seed({ staff: [{ id: "Alice", history: [] }], staffGroups: [] });
    render(<PeopleTable />);

    fireEvent.change(screen.getByTestId("people-search"), { target: { value: "zzz" } });
    expect(screen.getByTestId("people-empty")).toHaveTextContent("No matches");
    fireEvent.click(screen.getByTestId("people-empty-clear"));
    expect(screen.getByTestId(`people-row-${sk("Alice")}`)).toBeInTheDocument();
  });

  it("opens the upload dialog from the toolbar", () => {
    seed({ staff: [], staffGroups: [] });
    render(<PeopleTable />);
    fireEvent.click(screen.getByTestId("people-upload"));
    expect(screen.getByTestId("upload-dialog")).toBeInTheDocument();
  });

  it("has an accessible table: caption, column headers, named actions column", () => {
    seed({ staff: [{ id: "Alice", history: [] }], staffGroups: [] });
    render(<PeopleTable />);
    const table = screen.getByTestId("people-table");
    expect(within(table).getByText(/Ward staff/i)).toBeInTheDocument(); // caption
    expect(within(table).getByRole("columnheader", { name: "Nurse" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });
});

describe("PeopleTable — add / duplicate / delete", () => {
  it("adds a nurse via the inline draft row (history stamped, one undo entry)", () => {
    seed({ staff: [], staffGroups: [] });
    render(<PeopleTable />);

    fireEvent.click(screen.getByTestId("people-add"));
    fireEvent.change(screen.getByTestId("people-name-input-__new__"), {
      target: { value: "Priya" },
    });
    const before = historyLength();
    fireEvent.click(screen.getByTestId("people-save-__new__"));

    expect(staff().map((p) => p.id)).toEqual(["Priya"]);
    expect(staff()[0].history).toEqual([]);
    expect(historyLength()).toBe(before + 1);
  });

  it("rejects the reserved keyword ALL (case-insensitive): Save disabled + invalid", () => {
    seed({ staff: [], staffGroups: [] });
    render(<PeopleTable />);

    fireEvent.click(screen.getByTestId("people-add"));
    const input = screen.getByTestId("people-name-input-__new__");
    fireEvent.change(input, { target: { value: "ALL" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("people-save-__new__")).toBeDisabled();
    fireEvent.change(input, { target: { value: "all" } });
    expect(screen.getByTestId("people-save-__new__")).toBeDisabled();
  });

  it("duplicates a nurse (copy inserted right after the source)", () => {
    seed({
      staff: [
        { id: "Alice", history: [] },
        { id: "Bob", history: [] },
      ],
      staffGroups: [],
    });
    render(<PeopleTable />);
    fireEvent.click(screen.getByTestId(`people-dup-${sk("Alice")}`));
    expect(staff().map((p) => p.id)).toEqual(["Alice", "Alice copy", "Bob"]);
  });

  it("deletes a nurse immediately (no confirm dialog)", () => {
    seed({
      staff: [
        { id: "Alice", history: [] },
        { id: "Bob", history: [] },
      ],
      staffGroups: [],
    });
    render(<PeopleTable />);
    fireEvent.click(screen.getByTestId(`people-delete-${sk("Alice")}`));
    expect(staff().map((p) => p.id)).toEqual(["Bob"]);
  });
});

describe("PeopleTable — inline edit (name→id + description preservation)", () => {
  it("renames via the inline name input and PRESERVES the existing description", () => {
    seed({
      staff: [{ id: "P1", description: "Charge nurse", history: ["h"] }],
      staffGroups: [{ id: "G", members: ["P1"] }],
    });
    render(<PeopleTable />);

    fireEvent.click(screen.getByTestId(`people-edit-${sk("P1")}`));
    fireEvent.change(screen.getByTestId(`people-name-input-${sk("P1")}`), {
      target: { value: "Alice" },
    });
    fireEvent.click(screen.getByTestId(`people-save-${sk("P1")}`));

    const p = staff()[0];
    expect(p.id).toBe("Alice");
    expect(p.description).toBe("Charge nurse"); // preserved through the rename
    expect(p.history).toEqual(["h"]);
    // Rename cascade rewrote the group member ref.
    expect(membersOf("G")).toEqual(["Alice"]);
  });

  it("assigns a group via inline toggle chips as one commit / one undo entry; preserves description", () => {
    seed({
      staff: [{ id: "P1", description: "note", history: [] }],
      staffGroups: [{ id: "G", members: [] }],
    });
    render(<PeopleTable />);

    fireEvent.click(screen.getByTestId(`people-edit-${sk("P1")}`));
    fireEvent.click(screen.getByTestId(`people-group-${sk("P1")}-G`));
    const before = historyLength();
    fireEvent.click(screen.getByTestId(`people-save-${sk("P1")}`));

    expect(membersOf("G")).toEqual(["P1"]);
    expect(staff()[0].description).toBe("note");
    expect(historyLength()).toBe(before + 1);

    act(() => {
      useScenarioStore.temporal.getState().undo();
    });
    expect(membersOf("G")).toEqual([]);
  });

  it("an external change while editing closes the form with no stale write (stale-draft)", () => {
    seed({
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
      ],
      staffGroups: [{ id: "G", members: [] }],
    });
    render(<PeopleTable />);

    fireEvent.click(screen.getByTestId(`people-edit-${sk("P1")}`));
    fireEvent.click(screen.getByTestId(`people-group-${sk("P1")}-G`)); // local draft, uncommitted

    // External change to the group slice (undo/redo or cascade elsewhere).
    seed({
      staffGroups: [
        { id: "G", members: [] },
        { id: "H", members: [] },
      ],
    });

    expect(screen.queryByTestId(`people-edit-row-${sk("P1")}`)).not.toBeInTheDocument();
    expect(membersOf("G")).toEqual([]); // draft was never written
  });
});

describe("PeopleTable — typed-id identity + reorder", () => {
  it('keeps numeric 1 and string "1" distinct; editing numeric leaves the string sibling', () => {
    seed({
      staff: [
        { id: 1, history: [] },
        { id: "1", history: [] },
      ],
      staffGroups: [],
    });
    render(<PeopleTable />);

    expect(screen.getByTestId(`people-row-${nk(1)}`)).toBeInTheDocument();
    expect(screen.getByTestId(`people-row-${sk("1")}`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`people-edit-${nk(1)}`));
    fireEvent.change(screen.getByTestId(`people-name-input-${nk(1)}`), {
      target: { value: "one" },
    });
    fireEvent.click(screen.getByTestId(`people-save-${nk(1)}`));

    expect(staff().map((p) => p.id)).toEqual(["one", "1"]);
  });

  it("reorders via the Up/Down keyboard fallback (one undo entry); gated off while searching", () => {
    seed({
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
        { id: "P3", history: [] },
      ],
      staffGroups: [],
    });
    render(<PeopleTable />);

    expect(screen.getByTestId(`people-move-up-${sk("P1")}`)).toBeDisabled();
    const before = historyLength();
    fireEvent.click(screen.getByTestId(`people-move-down-${sk("P1")}`));
    expect(staff().map((p) => p.id)).toEqual(["P2", "P1", "P3"]);
    expect(historyLength()).toBe(before + 1);

    // Searching hides the reorder controls (drag + keyboard both gated off).
    fireEvent.change(screen.getByTestId("people-search"), { target: { value: "P" } });
    expect(screen.queryByTestId(`people-move-down-${sk("P1")}`)).not.toBeInTheDocument();
  });
});
