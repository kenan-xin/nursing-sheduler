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

function leaveCell(person: string, date: string): UiRequestCell {
  return { kind: "leave", person, date };
}

describe("quick-paint gesture protocol", () => {
  it("staging during a drag makes 0 durable writes and no history entry", async () => {
    const { spine, writes } = await readySpineWithSpy();
    const { scenario, hot } = spine;

    hot.getState().beginPaint();
    for (let day = 1; day <= 5; day++) {
      hot.getState().stagePaintCell("p1", `2026-01-0${day}`, leaveCell("p1", `2026-01-0${day}`));
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
      hot.getState().stagePaintCell("p1", date, leaveCell("p1", date));
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

  it("a staged erase (null) removes the existing cell on commit", async () => {
    const { spine } = await readySpineWithSpy();
    const { scenario, hot } = spine;

    scenario.getState().setReqData([leaveCell("p1", "2026-01-01"), leaveCell("p2", "2026-01-01")]);

    hot.getState().beginPaint();
    hot.getState().stagePaintCell("p1", "2026-01-01", null); // erase
    hot.getState().stagePaintCell("p3", "2026-01-01", leaveCell("p3", "2026-01-01")); // add
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
