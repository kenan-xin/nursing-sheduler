// @vitest-environment jsdom

// Roster editing UI component tests (F5). Verifies the load-bearing editing
// interactions against the real Grid + edit-bar + viewer composition with a
// mock editing surface: cell selection shows the edit bar, choosing an option
// fires setCell, undo is wired and disabled when empty, and a lens switch
// cancels the open selection (no edit lost).

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RosterViewer, type RosterViewerEditing } from "./roster-viewer";
import type { EditCoordinate, RosterDayState, RosterDocument } from "@/lib/roster";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";

afterEach(cleanup);

async function freshDocument(): Promise<RosterDocument> {
  return fixtureRosterDocument();
}

/** A controllable editing surface that records calls for assertions. */
function makeEditing(overrides: Partial<RosterViewerEditing> = {}): RosterViewerEditing & {
  calls: {
    setCell: Array<[EditCoordinate, RosterDayState]>;
    swap: Array<[EditCoordinate, EditCoordinate]>;
    undo: number;
    select: (EditCoordinate | null)[];
  };
} {
  const calls = { setCell: [], swap: [], undo: 0, select: [] } as {
    setCell: Array<[EditCoordinate, RosterDayState]>;
    swap: Array<[EditCoordinate, EditCoordinate]>;
    undo: number;
    select: (EditCoordinate | null)[];
  };
  return {
    selectedCell: null,
    selectCell: (coord) => {
      calls.select.push(coord);
    },
    setCell: (coord, day) => calls.setCell.push([coord, day]),
    swapCells: (a, b) => calls.swap.push([a, b]),
    undo: () => {
      calls.undo += 1;
    },
    canUndo: false,
    ...overrides,
    get calls() {
      return calls;
    },
  };
}

describe("RosterViewer editing — cell selection + edit bar", () => {
  it("does not render an edit bar or undo when editing is absent (read-only F4 contract preserved)", async () => {
    const document = await freshDocument();
    render(<RosterViewer document={document} />);
    expect(screen.queryByTestId("roster-edit-bar")).toBeNull();
    expect(screen.queryByTestId("roster-undo")).toBeNull();
    // Grid cells are NOT clickable (no cursor-pointer).
    const grid = screen.getByTestId("roster-grid");
    expect(grid).toBeTruthy();
  });

  it("clicking a grid cell fires selectCell, and a selected cell shows the edit bar", async () => {
    const document = await freshDocument();
    // First render: editing with no selection. Clicking a cell fires selectCell.
    const clickEditing = makeEditing();
    render(<RosterViewer document={document} editing={clickEditing} />);
    const grid = screen.getByTestId("roster-grid");
    const firstCell = within(grid).getAllByRole("button")[0];
    fireEvent.click(firstCell);
    expect(clickEditing.calls.select).toContainEqual({ personIdx: 0, dateIdx: 0 });

    cleanup();

    // Second render: editing WITH a selected cell — the edit bar appears.
    const editing = makeEditing({ selectedCell: { personIdx: 0, dateIdx: 0 } });
    render(<RosterViewer document={document} editing={editing} />);
    const bar = screen.getByTestId("roster-edit-bar");
    // The bar names the first person + date.
    const personName = String(document.context.people[0].id);
    expect(bar.textContent).toContain(personName);
  });

  it("choosing a shift option from the edit bar fires setCell with the right day-state", async () => {
    const document = await freshDocument();
    const editing = makeEditing({ selectedCell: { personIdx: 0, dateIdx: 0 } });
    render(<RosterViewer document={document} editing={editing} />);
    const bar = screen.getByTestId("roster-edit-bar");
    // The fixture has shift types D and N.
    const optionD = within(bar).getByTestId("roster-edit-option-D");
    fireEvent.click(optionD);
    expect(editing.calls.setCell).toEqual([
      [
        { personIdx: 0, dateIdx: 0 },
        { kind: "shift", shiftId: "D" },
      ],
    ]);
  });

  it("keyboard activation (Enter) on a focused cell fires selectCell — the universal non-pointer path", async () => {
    // P2 fix: editable cells are keyboard-operable (tabIndex + role + Enter/Space
    // handler) so a keyboard/AT user can open the edit bar without a pointer.
    const document = await freshDocument();
    const editing = makeEditing();
    render(<RosterViewer document={document} editing={editing} />);
    const grid = screen.getByTestId("roster-grid");
    const firstCell = within(grid).getAllByRole("button")[0];
    // The editable cell is focusable.
    expect(firstCell).toHaveAttribute("tabindex", "0");
    expect(firstCell).toHaveAttribute("role", "button");
    // Enter activates it (selects) — the keyboard equivalent of a click.
    fireEvent.keyDown(firstCell, { key: "Enter" });
    expect(editing.calls.select).toContainEqual({ personIdx: 0, dateIdx: 0 });
    // Space also activates.
    fireEvent.keyDown(firstCell, { key: " " });
    cleanup();
  });

  it("edit options meet the 44px coarse-pointer minimum width and height", async () => {
    // P2 fix: DESIGN §touch/coarse-pointer — actual buttons grow to ≥44px in both
    // dimensions. The edit option is the primary touch path for setting a cell.
    const document = await freshDocument();
    const editing = makeEditing({ selectedCell: { personIdx: 0, dateIdx: 0 } });
    render(<RosterViewer document={document} editing={editing} />);
    const option = screen.getByTestId("roster-edit-option-D");
    expect(option.className).toContain("min-h-[44px]");
    expect(option.className).toContain("min-w-[44px]");
  });

  it("OFF and LV options fire setCell with off/leave day-states", async () => {
    const document = await freshDocument();
    const editing = makeEditing({ selectedCell: { personIdx: 0, dateIdx: 0 } });
    render(<RosterViewer document={document} editing={editing} />);
    const bar = screen.getByTestId("roster-edit-bar");
    fireEvent.click(within(bar).getByTestId("roster-edit-option-OFF"));
    fireEvent.click(within(bar).getByTestId("roster-edit-option-LV"));
    expect(editing.calls.setCell).toContainEqual([{ personIdx: 0, dateIdx: 0 }, { kind: "off" }]);
    expect(editing.calls.setCell).toContainEqual([{ personIdx: 0, dateIdx: 0 }, { kind: "leave" }]);
  });

  it("Cancel clears the selection", async () => {
    const document = await freshDocument();
    const editing = makeEditing({ selectedCell: { personIdx: 0, dateIdx: 0 } });
    render(<RosterViewer document={document} editing={editing} />);
    fireEvent.click(screen.getByTestId("roster-edit-bar-cancel"));
    expect(editing.calls.select).toContainEqual(null);
  });
});

describe("RosterViewer editing — undo + lens switch", () => {
  it("renders an undo button that is disabled when canUndo is false", async () => {
    const document = await freshDocument();
    const editing = makeEditing({ canUndo: false });
    render(<RosterViewer document={document} editing={editing} />);
    const undo = screen.getByTestId("roster-undo") as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
  });

  it("undo is enabled and fires the undo callback when canUndo is true", async () => {
    const document = await freshDocument();
    const editing = makeEditing({ canUndo: true });
    render(<RosterViewer document={document} editing={editing} />);
    const undo = screen.getByTestId("roster-undo") as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    expect(editing.calls.undo).toBe(1);
  });

  it("switching lenses cancels an open cell selection (no edit lost)", async () => {
    const document = await freshDocument();
    const editing = makeEditing({ selectedCell: { personIdx: 0, dateIdx: 0 } });
    render(<RosterViewer document={document} editing={editing} />);
    // Switch to the Coverage lens.
    fireEvent.click(screen.getByTestId("roster-lens-coverage"));
    expect(editing.calls.select).toContainEqual(null);
  });
});

describe("RosterViewer editing — blend-in", () => {
  it("an edited cell renders identically to a solved cell (no per-cell marker)", async () => {
    const document = await freshDocument();
    const editing = makeEditing({ selectedCell: null });
    const { container } = render(<RosterViewer document={document} editing={editing} />);
    // No element carries an "edited" marker class or data attribute.
    const marked = container.querySelectorAll("[data-edited], .roster-cell-edited");
    expect(marked.length).toBe(0);
  });
});
