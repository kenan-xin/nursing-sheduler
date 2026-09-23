// Quick-paint gesture protocol (T04 behaviour, T03 authority).
//
// The behavioural assertions are unchanged — staging is free, one drag is one
// atomic commit, and coordinate reconciliation follows the XOR/precedence rules.
// What changed is what "one write" is MEASURED against. The pre-T03 suite spied
// on the persist middleware's `setItem`; it now counts durable content commits in
// the repository, which is the thing the product actually promises: one drag
// yields one Undo step and one revision, no matter how many cells were crossed.

import { beforeEach, describe, expect, it } from "vitest";
import type { UiRequestCell } from "@/lib/scenario";
import { commitPaintGesture } from "./paint";
import { scenarioCommands, drainScenarioCommands } from "./commands";
import { useAuthorityStore } from "./authority";
import { stateSpine } from "./spine";
import { installTestAuthority, type TestAuthority } from "./test-authority";

const { scenario, hot } = stateSpine;

let harness: TestAuthority;

beforeEach(async () => {
  harness = await installTestAuthority();
});

/** Durable CONTENT commits for the selected scenario — i.e. Undo steps. */
async function contentCommits(): Promise<number> {
  const scenarioId = useAuthorityStore.getState().scenarioId!;
  const commits = await harness.db.scenarioCommits.where("scenarioId").equals(scenarioId).toArray();
  return commits.filter((commit) => commit.isContent).length;
}

/** Seed the matrix through the command bus (the only way to write it now). */
async function seedMatrix(cells: UiRequestCell[]): Promise<void> {
  await scenarioCommands.setReqData(cells);
}

function leaveCell(person: string, date: string, uid?: string): UiRequestCell {
  return { kind: "leave", person, date, uid };
}

function offCell(person: string, date: string, weight: number, uid?: string): UiRequestCell {
  return { kind: "off", person, date, weight, uid };
}

function requestCell(
  person: string,
  date: string,
  shiftType: string,
  weight: number,
  uid?: string,
): UiRequestCell {
  return { kind: "request", person, date, shiftType, weight, uid };
}

/** The cells at one coordinate, in the projection's current order. */
function coordCells(person: string, date: string): UiRequestCell[] {
  return scenario.getState().reqData.filter((cell) => cell.person === person && cell.date === date);
}

describe("quick-paint gesture protocol", () => {
  it("staging during a drag makes 0 durable commits", async () => {
    hot.getState().beginPaint();
    for (let day = 1; day <= 5; day++) {
      hot.getState().stagePaintDayState("p1", `2026-01-0${day}`, { kind: "leave" });
    }
    await drainScenarioCommands();

    expect(hot.getState().paint?.size).toBe(5);
    expect(scenario.getState().reqData).toEqual([]);
    expect(await contentCommits()).toBe(0);
    expect(useAuthorityStore.getState().canUndo).toBe(false);
  });

  it("one drag over N cells commits as exactly 1 durable commit and 1 Undo step", async () => {
    hot.getState().beginPaint();
    for (const date of ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]) {
      hot.getState().stagePaintDayState("p1", date, { kind: "leave" });
    }
    await drainScenarioCommands();
    expect(await contentCommits()).toBe(0); // nothing committed during the drag

    await commitPaintGesture(hot);

    expect(await contentCommits()).toBe(1);
    expect(useAuthorityStore.getState().canUndo).toBe(true);
    expect(scenario.getState().reqData).toHaveLength(4);
    expect(hot.getState().paint).toBeNull();
  });

  it("a staged erase removes the existing cell on commit", async () => {
    await seedMatrix([leaveCell("p1", "2026-01-01"), leaveCell("p2", "2026-01-01")]);

    hot.getState().beginPaint();
    hot.getState().stagePaintErase("p1", "2026-01-01"); // erase
    hot.getState().stagePaintDayState("p3", "2026-01-01", { kind: "leave" }); // add
    await commitPaintGesture(hot);

    const persons = scenario
      .getState()
      .reqData.map((cell) => cell.person)
      .sort();
    expect(persons).toEqual(["p2", "p3"]);
  });

  it("committing an empty gesture is a no-op with no commit", async () => {
    hot.getState().beginPaint();
    await commitPaintGesture(hot);
    await drainScenarioCommands();

    expect(await contentCommits()).toBe(0);
    expect(useAuthorityStore.getState().canUndo).toBe(false);
  });
});

describe("coordinate-transaction reconciliation", () => {
  it("additive requests preserve other shift types at the coordinate", async () => {
    await seedMatrix([requestCell("p1", "d1", "N", 3)]);

    hot.getState().beginPaint();
    hot.getState().stagePaintRequestDelta("p1", "d1", "D", 5);
    await commitPaintGesture(hot);

    const cells = coordCells("p1", "d1");
    expect(cells).toHaveLength(2);
    expect(
      cells
        .map((c) => [(c as { shiftType: string }).shiftType, (c as { weight: number }).weight])
        .sort(),
    ).toEqual([
      ["D", 5],
      ["N", 3],
    ]);
  });

  it("a weight-0 delta removes just that shift type", async () => {
    await seedMatrix([requestCell("p1", "d1", "N", 3), requestCell("p1", "d1", "D", 5)]);

    hot.getState().beginPaint();
    hot.getState().stagePaintRequestDelta("p1", "d1", "D", 0);
    await commitPaintGesture(hot);

    const cells = coordCells("p1", "d1");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: "request", shiftType: "N", weight: 3 });
  });

  it("a day-state paint replaces a request-set (XOR)", async () => {
    await seedMatrix([requestCell("p1", "d1", "D", 5)]);

    hot.getState().beginPaint();
    hot.getState().stagePaintDayState("p1", "d1", { kind: "leave" });
    await commitPaintGesture(hot);

    // A brand-new cell is allocated a durable uid at creation (T17r review P1).
    expect(coordCells("p1", "d1")).toEqual([
      { kind: "leave", person: "p1", date: "d1", uid: expect.any(String) },
    ]);
  });

  it("a request paint onto a coordinate holding a leave is skipped (precedence)", async () => {
    await seedMatrix([leaveCell("p1", "d1", "leave-uid")]);

    hot.getState().beginPaint();
    hot.getState().stagePaintRequestDelta("p1", "d1", "D", 5);
    await commitPaintGesture(hot);

    expect(coordCells("p1", "d1")).toEqual([
      { kind: "leave", person: "p1", date: "d1", uid: "leave-uid" },
    ]);
  });

  it("within one gesture, a request delta after a day-state commits as requests (last-op)", async () => {
    // No durable day-state at the coordinate — the staged day-state is dropped by XOR.
    await seedMatrix([]);

    hot.getState().beginPaint();
    hot.getState().stagePaintDayState("p1", "d1", { kind: "leave" });
    hot.getState().stagePaintRequestDelta("p1", "d1", "D", 5);
    await commitPaintGesture(hot);

    expect(coordCells("p1", "d1")).toEqual([
      {
        kind: "request",
        person: "p1",
        date: "d1",
        shiftType: "D",
        weight: 5,
        uid: expect.any(String),
      },
    ]);
  });

  it("an erase drops a coexisting leave + request coordinate entirely", async () => {
    await seedMatrix([
      leaveCell("p1", "d1"),
      requestCell("p1", "d1", "D", 5),
      leaveCell("p2", "d1"),
    ]);

    hot.getState().beginPaint();
    hot.getState().stagePaintErase("p1", "d1");
    await commitPaintGesture(hot);

    expect(coordCells("p1", "d1")).toEqual([]);
    // The untouched p2 coordinate survives verbatim.
    expect(coordCells("p2", "d1")).toEqual([leaveCell("p2", "d1")]);
  });

  it("preserves uid on an updated request cell (F2 stability)", async () => {
    await seedMatrix([requestCell("p1", "d1", "D", 5, "req-uid")]);

    hot.getState().beginPaint();
    hot.getState().stagePaintRequestDelta("p1", "d1", "D", 9);
    await commitPaintGesture(hot);

    expect(coordCells("p1", "d1")).toEqual([
      { kind: "request", person: "p1", date: "d1", shiftType: "D", weight: 9, uid: "req-uid" },
    ]);
  });

  it("preserves uid on a day-state that replaces an existing day-state", async () => {
    await seedMatrix([offCell("p1", "d1", 2, "off-uid")]);

    hot.getState().beginPaint();
    hot.getState().stagePaintDayState("p1", "d1", { kind: "off", weight: 7 });
    await commitPaintGesture(hot);

    expect(coordCells("p1", "d1")).toEqual([
      { kind: "off", person: "p1", date: "d1", weight: 7, uid: "off-uid" },
    ]);
  });

  it("a multi-cell, multi-selector gesture commits as ONE durable commit", async () => {
    hot.getState().beginPaint();
    for (const date of ["d1", "d2", "d3"]) {
      hot.getState().stagePaintRequestDelta("p1", date, "D", 5);
      hot.getState().stagePaintRequestDelta("p1", date, "N", -2);
    }
    await commitPaintGesture(hot);

    expect(await contentCommits()).toBe(1);
    expect(scenario.getState().reqData).toHaveLength(6); // 3 dates × 2 selectors
  });
});
