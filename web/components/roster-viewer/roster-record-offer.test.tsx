// @vitest-environment jsdom
import "fake-indexeddb/auto";

// kyh3: after an LV/OFF roster edit the viewer offers "Also record as leave /
// day off"; only a click writes Requests, as one undoable store command.

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { generateDateItems } from "@/lib/dates";
import type { EditCoordinate, RosterDocument } from "@/lib/roster";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import type { UiRequestCell } from "@/lib/scenario";
import { useScenarioStore } from "@/lib/store";
import {
  drainScenarioCommands,
  resetScenarioForTest,
  scenarioCommands,
  undoDepth,
} from "@/lib/store/test-authority";
import { RosterViewer, type RosterViewerEditing } from "./roster-viewer";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const range = { start: "2026-07-03", end: "2026-07-06" };
const [d0] = generateDateItems(range).map((d) => d.id);

/** A real-overlay editing surface: setCell writes into the document's edits. */
function Harness({ initial }: { initial: RosterDocument }) {
  const [doc, setDoc] = useState(initial);
  const [selected, setSelected] = useState<EditCoordinate | null>({ personIdx: 0, dateIdx: 0 });
  const editing: RosterViewerEditing = {
    selectedCell: selected,
    selectCell: setSelected,
    setCell: (c, day) =>
      setDoc((d) => ({
        ...d,
        edits: [
          ...d.edits.filter((e) => e.personIdx !== c.personIdx || e.dateIdx !== c.dateIdx),
          { ...c, day },
        ],
      })),
    swapCells: () => {},
    undo: () => {},
    canUndo: false,
  };
  return (
    <>
      <button type="button" onClick={() => setSelected({ personIdx: 1, dateIdx: 0 })}>
        pick-second
      </button>
      <RosterViewer document={doc} editing={editing} />
    </>
  );
}

async function seed(reqData: UiRequestCell[] = []) {
  await act(async () => {
    await scenarioCommands.mutate({
      rangeStart: range.start,
      rangeEnd: range.end,
      staff: [{ id: "Alice Ng", history: [] }, { id: 7 }],
      shifts: [{ id: "D" }, { id: "N" }],
      reqData,
    });
  });
  await drainScenarioCommands();
}

async function mount() {
  render(<Harness initial={await fixtureRosterDocument()} />);
}

const reqData = () => useScenarioStore.getState().reqData;

beforeEach(async () => {
  vi.clearAllMocks();
  await resetScenarioForTest();
  await drainScenarioCommands();
});
afterEach(cleanup);

describe("Roster: also record LV/OFF edits in Requests (kyh3)", () => {
  it("offers nothing for a shift edit, and records nothing without a click", async () => {
    await seed();
    await mount();
    expect(screen.queryByTestId("roster-record-offer")).toBeNull();
    fireEvent.click(screen.getByTestId("roster-edit-option-LV"));
    const offer = await screen.findByTestId("roster-record-offer");
    expect(offer.textContent).toContain("Alice Ng");
    expect(screen.getByTestId("roster-record-action").textContent).toBe("Also record as leave");
    await drainScenarioCommands();
    expect(reqData()).toEqual([]);

    fireEvent.click(screen.getByTestId("roster-record-dismiss"));
    expect(screen.queryByTestId("roster-record-offer")).toBeNull();
    await drainScenarioCommands();
    expect(reqData()).toEqual([]);
  });

  it("a click records LV as a leave pin, in one undoable step", async () => {
    await seed();
    await mount();
    fireEvent.click(screen.getByTestId("roster-edit-option-LV"));
    const before = await undoDepth();
    fireEvent.click(await screen.findByTestId("roster-record-action"));
    await waitFor(() => expect(screen.queryByTestId("roster-record-offer")).toBeNull());
    await drainScenarioCommands();
    expect(reqData()).toEqual([
      expect.objectContaining({ kind: "leave", person: "Alice Ng", date: d0 }),
    ]);
    expect(await undoDepth()).toBe(before + 1);
  });

  it("an OFF edit records a day-off wish at weight 20", async () => {
    await seed();
    await mount();
    fireEvent.click(screen.getByTestId("roster-edit-option-OFF"));
    const action = await screen.findByTestId("roster-record-action");
    expect(action.textContent).toBe("Also record as day off");
    fireEvent.click(action);
    await waitFor(() => expect(reqData()).toHaveLength(1));
    expect(reqData()[0]).toMatchObject({ kind: "off", person: "Alice Ng", date: d0, weight: 20 });
  });

  it("says so instead when Requests already has the leave", async () => {
    await seed([{ kind: "leave", person: "Alice Ng", date: d0, uid: "L" }]);
    await mount();
    fireEvent.click(screen.getByTestId("roster-edit-option-OFF"));
    const message = await screen.findByTestId("roster-record-message");
    expect(message.textContent).toContain("already has");
    expect(screen.queryByTestId("roster-record-action")).toBeNull();
  });

  it("records several pending edits with one action and one undo step", async () => {
    await seed();
    await mount();
    fireEvent.click(screen.getByTestId("roster-edit-option-LV"));
    fireEvent.click(screen.getByText("pick-second"));
    fireEvent.click(screen.getByTestId("roster-edit-option-OFF"));
    const action = await screen.findByTestId("roster-record-action");
    expect(action.textContent).toBe("Record 2 edits");
    const before = await undoDepth();
    fireEvent.click(action);
    await waitFor(() => expect(reqData()).toHaveLength(2));
    await drainScenarioCommands();
    expect(await undoDepth()).toBe(before + 1);
    expect(reqData()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "leave", person: "Alice Ng" }),
        expect.objectContaining({ kind: "off", person: 7, weight: 20 }),
      ]),
    );
  });

  it("a second edit to the same cell replaces its candidate rather than adding one", async () => {
    await seed();
    await mount();
    fireEvent.click(screen.getByTestId("roster-edit-option-LV"));
    await screen.findByTestId("roster-record-offer");
    fireEvent.click(screen.getByTestId("roster-edit-option-OFF"));
    expect(screen.getByTestId("roster-record-action").textContent).toBe("Also record as day off");
  });
});
