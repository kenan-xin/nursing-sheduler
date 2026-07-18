import { describe, expect, it, vi } from "vitest";
import type { StateStorage } from "zustand/middleware";
import type { UiRequestCell } from "@/lib/scenario";
import { createMemoryStorage } from "./persistence";
import { createStateSpine, type StateSpine } from "./spine";
import { commitPaintGesture } from "./paint";
import { drainScenarioPersist, hydrateScenarioStore } from "./lifecycle";

/** A spy over in-memory storage, so persist writes can be counted. */
function spyStorage() {
  const mem = createMemoryStorage();
  const setItem = vi.fn((name: string, value: string) => mem.setItem(name, value));
  const storage: StateStorage = {
    getItem: (name) => mem.getItem(name),
    setItem,
    removeItem: (name) => mem.removeItem(name),
  };
  return { storage, setItem };
}

/** A ready spine plus its write spy, with the write count reset after hydration. */
async function readySpineWithSpy(): Promise<{ spine: StateSpine; writes: () => number }> {
  const spy = spyStorage();
  const spine = createStateSpine({ createStorage: () => spy.storage });
  await hydrateScenarioStore(spine.scenario, spine.hot);
  await drainScenarioPersist(spine.scenario);
  spy.setItem.mockClear(); // ignore the hydration baseline write
  return { spine, writes: () => spy.setItem.mock.calls.length };
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

/** The cells staged at one coordinate, in the durable store's current order. */
function coordCells(spine: StateSpine, person: string, date: string): UiRequestCell[] {
  return spine.scenario
    .getState()
    .reqData.filter((cell) => cell.person === person && cell.date === date);
}

describe("quick-paint gesture protocol", () => {
  it("staging during a drag makes 0 durable writes and no history entry", async () => {
    const { spine, writes } = await readySpineWithSpy();
    const { scenario, hot } = spine;

    hot.getState().beginPaint();
    for (let day = 1; day <= 5; day++) {
      hot.getState().stagePaintDayState("p1", `2026-01-0${day}`, { kind: "leave" });
    }
    await drainScenarioPersist(scenario);

    expect(hot.getState().paint?.size).toBe(5);
    expect(scenario.getState().reqData).toEqual([]);
    expect(scenario.temporal.getState().pastStates.length).toBe(0);
    expect(writes()).toBe(0);
  });

  it("one drag over N cells commits as 1 write + 1 zundo entry + 1 revision", async () => {
    const { spine, writes } = await readySpineWithSpy();
    const { scenario, hot } = spine;

    hot.getState().beginPaint();
    for (const date of ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]) {
      hot.getState().stagePaintDayState("p1", date, { kind: "leave" });
    }
    await drainScenarioPersist(scenario);
    expect(writes()).toBe(0); // nothing written during the drag

    commitPaintGesture(scenario, hot);
    await drainScenarioPersist(scenario);

    expect(writes()).toBe(1);
    expect(scenario.temporal.getState().pastStates.length).toBe(1);
    expect(scenario.getState().reqData).toHaveLength(4);
    expect(hot.getState().paint).toBeNull();
  });

  it("a staged erase removes the existing cell on commit", async () => {
    const { spine } = await readySpineWithSpy();
    const { scenario, hot } = spine;

    scenario.getState().setReqData([leaveCell("p1", "2026-01-01"), leaveCell("p2", "2026-01-01")]);

    hot.getState().beginPaint();
    hot.getState().stagePaintErase("p1", "2026-01-01"); // erase
    hot.getState().stagePaintDayState("p3", "2026-01-01", { kind: "leave" }); // add
    commitPaintGesture(scenario, hot);
    await drainScenarioPersist(scenario);

    const persons = scenario
      .getState()
      .reqData.map((cell) => cell.person)
      .sort();
    expect(persons).toEqual(["p2", "p3"]);
  });

  it("committing an empty gesture is a no-op with no write", async () => {
    const { spine, writes } = await readySpineWithSpy();
    const { scenario, hot } = spine;

    hot.getState().beginPaint();
    commitPaintGesture(scenario, hot);
    await drainScenarioPersist(scenario);

    expect(writes()).toBe(0);
    expect(scenario.temporal.getState().pastStates.length).toBe(0);
  });
});

describe("coordinate-transaction reconciliation", () => {
  it("additive requests preserve other shift types at the coordinate", async () => {
    const { spine } = await readySpineWithSpy();
    const { scenario, hot } = spine;
    scenario.getState().setReqData([requestCell("p1", "d1", "N", 3)]);

    hot.getState().beginPaint();
    hot.getState().stagePaintRequestDelta("p1", "d1", "D", 5);
    commitPaintGesture(scenario, hot);

    const cells = coordCells(spine, "p1", "d1");
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
    const { spine } = await readySpineWithSpy();
    const { scenario, hot } = spine;
    scenario
      .getState()
      .setReqData([requestCell("p1", "d1", "N", 3), requestCell("p1", "d1", "D", 5)]);

    hot.getState().beginPaint();
    hot.getState().stagePaintRequestDelta("p1", "d1", "D", 0);
    commitPaintGesture(scenario, hot);

    const cells = coordCells(spine, "p1", "d1");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: "request", shiftType: "N", weight: 3 });
  });

  it("a day-state paint replaces a request-set (XOR)", async () => {
    const { spine } = await readySpineWithSpy();
    const { scenario, hot } = spine;
    scenario.getState().setReqData([requestCell("p1", "d1", "D", 5)]);

    hot.getState().beginPaint();
    hot.getState().stagePaintDayState("p1", "d1", { kind: "leave" });
    commitPaintGesture(scenario, hot);

    const cells = coordCells(spine, "p1", "d1");
    expect(cells).toEqual([{ kind: "leave", person: "p1", date: "d1", uid: undefined }]);
  });

  it("a request paint onto a coordinate holding a leave is skipped (precedence)", async () => {
    const { spine } = await readySpineWithSpy();
    const { scenario, hot } = spine;
    scenario.getState().setReqData([leaveCell("p1", "d1", "leave-uid")]);

    hot.getState().beginPaint();
    hot.getState().stagePaintRequestDelta("p1", "d1", "D", 5);
    commitPaintGesture(scenario, hot);

    const cells = coordCells(spine, "p1", "d1");
    expect(cells).toEqual([{ kind: "leave", person: "p1", date: "d1", uid: "leave-uid" }]);
  });

  it("within one gesture, a request delta after a day-state commits as requests (last-op)", async () => {
    const { spine } = await readySpineWithSpy();
    const { scenario, hot } = spine;
    // No durable day-state at the coordinate — the staged day-state is dropped by XOR.
    scenario.getState().setReqData([]);

    hot.getState().beginPaint();
    hot.getState().stagePaintDayState("p1", "d1", { kind: "leave" });
    hot.getState().stagePaintRequestDelta("p1", "d1", "D", 5);
    commitPaintGesture(scenario, hot);

    const cells = coordCells(spine, "p1", "d1");
    expect(cells).toEqual([
      { kind: "request", person: "p1", date: "d1", shiftType: "D", weight: 5, uid: undefined },
    ]);
  });

  it("an erase drops a coexisting leave + request coordinate entirely", async () => {
    const { spine } = await readySpineWithSpy();
    const { scenario, hot } = spine;
    scenario
      .getState()
      .setReqData([leaveCell("p1", "d1"), requestCell("p1", "d1", "D", 5), leaveCell("p2", "d1")]);

    hot.getState().beginPaint();
    hot.getState().stagePaintErase("p1", "d1");
    commitPaintGesture(scenario, hot);

    expect(coordCells(spine, "p1", "d1")).toEqual([]);
    // The untouched p2 coordinate survives verbatim.
    expect(coordCells(spine, "p2", "d1")).toEqual([leaveCell("p2", "d1")]);
  });

  it("preserves uid on an updated request cell (F2 stability)", async () => {
    const { spine } = await readySpineWithSpy();
    const { scenario, hot } = spine;
    scenario.getState().setReqData([requestCell("p1", "d1", "D", 5, "req-uid")]);

    hot.getState().beginPaint();
    hot.getState().stagePaintRequestDelta("p1", "d1", "D", 9);
    commitPaintGesture(scenario, hot);

    expect(coordCells(spine, "p1", "d1")).toEqual([
      { kind: "request", person: "p1", date: "d1", shiftType: "D", weight: 9, uid: "req-uid" },
    ]);
  });

  it("preserves uid on a day-state that replaces an existing day-state", async () => {
    const { spine } = await readySpineWithSpy();
    const { scenario, hot } = spine;
    scenario.getState().setReqData([offCell("p1", "d1", 2, "off-uid")]);

    hot.getState().beginPaint();
    hot.getState().stagePaintDayState("p1", "d1", { kind: "off", weight: 7 });
    commitPaintGesture(scenario, hot);

    expect(coordCells(spine, "p1", "d1")).toEqual([
      { kind: "off", person: "p1", date: "d1", weight: 7, uid: "off-uid" },
    ]);
  });

  it("a multi-cell, multi-selector gesture commits as ONE write / ONE zundo entry", async () => {
    const { spine, writes } = await readySpineWithSpy();
    const { scenario, hot } = spine;

    hot.getState().beginPaint();
    for (const date of ["d1", "d2", "d3"]) {
      hot.getState().stagePaintRequestDelta("p1", date, "D", 5);
      hot.getState().stagePaintRequestDelta("p1", date, "N", -2);
    }
    commitPaintGesture(scenario, hot);
    await drainScenarioPersist(scenario);

    expect(writes()).toBe(1);
    expect(scenario.temporal.getState().pastStates.length).toBe(1);
    expect(scenario.getState().reqData).toHaveLength(6); // 3 dates × 2 selectors
  });
});
