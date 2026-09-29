// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import type { ScenarioUiState } from "@/lib/scenario";
import { useScenarioStore, scenarioCommands } from "@/lib/store";
import type { ShiftRequestDelta } from "./requests-csv";
import { useRequests } from "./use-requests";
import { resetScenarioForTest, drainScenarioCommands, undoDepth } from "@/lib/store/test-authority";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const BASE_SEED: Partial<ScenarioUiState> = {
  rangeStart: "2026-01-01",
  rangeEnd: "2026-01-03",
  staff: [{ id: "Aisha", history: [] }],
  shifts: [{ id: "AM" }, { id: "PM" }],
  shiftGroups: [{ id: "AnyDay", members: ["AM", "PM"] }],
};

async function seed(patch: Partial<ScenarioUiState>) {
  await act(async () => {
    await scenarioCommands.mutate(patch);
  });
}

async function staffHistory(personId: string): Promise<string[]> {
  await drainScenarioCommands();
  return useScenarioStore.getState().staff.find((p) => p.id === personId)?.history ?? [];
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetScenarioForTest();
  await drainScenarioCommands();
  await seed(BASE_SEED);
});

afterEach(() => cleanup());

describe("useRequests — quick-paint history gesture", () => {
  it("flushes a deferred CLEAR against LIVE staff, not the mount-time snapshot (P1)", async () => {
    // Mount while history is EMPTY — the mouse-up listener is registered by an
    // empty-dep effect and closes over this first render.
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: [], quickPaintWeightText: "0" }),
    );
    // History is written AFTER mount (simulating any post-mount edit).
    await seed({ staff: [{ id: "Aisha", history: ["AM", "PM"] }] });

    // historyCount = 2 + 1 = 3; Aisha's offset = 1, so rendered column 1 maps to
    // real position 0 (the NEWEST entry — a NON-deepest slot). A stale flush
    // would compute [].slice(1) and erase the surviving older entry.
    act(() => result.current.onHistoryPointerDown("Aisha", 1));
    fireEvent.mouseUp(window);

    expect(await staffHistory("Aisha")).toEqual(["PM"]);
  });

  it("accepts the reserved OFF and LEAVE as history values", async () => {
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) =>
        useRequests({ quickPaintSelectedIds: ids, quickPaintWeightText: "0" }),
      { initialProps: { ids: ["OFF"] } },
    );

    // Column 0 is the clickable append-padding slot (historyCount = 1, offset = 1).
    act(() => result.current.onHistoryPointerDown("Aisha", 0));
    fireEvent.mouseUp(window);
    expect(await staffHistory("Aisha")).toEqual(["OFF"]);

    rerender({ ids: ["LEAVE"] });
    act(() => result.current.onHistoryPointerDown("Aisha", 0));
    fireEvent.mouseUp(window);
    expect(await staffHistory("Aisha")).toEqual(["LEAVE", "OFF"]);
  });

  it("refuses a shift-type GROUP or ALL with one toast (a history slot cannot hold a group)", async () => {
    for (const id of ["AnyDay", "ALL"]) {
      vi.mocked(toast.error).mockClear();
      const { result } = renderHook(() =>
        useRequests({ quickPaintSelectedIds: [id], quickPaintWeightText: "0" }),
      );
      act(() => result.current.onHistoryPointerDown("Aisha", 0));
      fireEvent.mouseUp(window);
      expect(await staffHistory("Aisha")).toEqual([]);
      expect(toast.error).toHaveBeenCalledWith("History needs one shift type, not a group.", {
        id: "History needs one shift type, not a group.",
      });
    }
  });

  it("surfaces the verbatim multi-select error as a toast (and mutates nothing)", async () => {
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: ["AM", "PM"], quickPaintWeightText: "0" }),
    );
    act(() => result.current.onHistoryPointerDown("Aisha", 0));
    expect(toast.error).toHaveBeenCalledWith("Cannot set history to multiple shift types.", {
      id: "Cannot set history to multiple shift types.",
    });
    fireEvent.mouseUp(window);
    expect(await staffHistory("Aisha")).toEqual([]);
  });

  it("a set-drag across two slots still commits exactly once", async () => {
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: ["AM"], quickPaintWeightText: "0" }),
    );
    const before = await undoDepth();
    act(() => result.current.onHistoryPointerDown("Aisha", 0));
    act(() => result.current.onHistoryPointerEnter("Aisha", 1));
    fireEvent.mouseUp(window);
    expect(await staffHistory("Aisha")).toEqual(["AM"]);
    expect((await undoDepth()) - before).toBe(1);
  });
});

describe("useRequests — quick paint over leave/OFF cells (F4)", () => {
  it("warns how many cells a request drag skipped because they hold leave or OFF", async () => {
    await seed({
      reqData: [
        { kind: "leave", person: "Aisha", date: "01" },
        { kind: "off", person: "Aisha", date: "02", weight: 5 },
      ],
    });
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: ["AM"], quickPaintWeightText: "5" }),
    );
    act(() => result.current.onCellPointerDown("Aisha", "01"));
    act(() => result.current.onCellPointerEnter("Aisha", "02"));
    act(() => result.current.onCellPointerEnter("Aisha", "03"));
    fireEvent.mouseUp(window);
    expect(toast.warning).toHaveBeenCalledWith(
      "2 cells skipped: they hold leave or OFF. Clear them first.",
    );
  });

  it("stays quiet when nothing was skipped", async () => {
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: ["AM"], quickPaintWeightText: "5" }),
    );
    act(() => result.current.onCellPointerDown("Aisha", "01"));
    fireEvent.mouseUp(window);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe("useRequests — clear counts name every kind of cell (F5)", () => {
  it("counts requests, OFF days and leave pins, overall and per shape", async () => {
    await seed({
      reqData: [
        { kind: "request", person: "Aisha", date: "01", shiftType: "AM", weight: 5 },
        { kind: "request", person: "Aisha", date: "02", shiftType: "PM", weight: 5 },
        { kind: "off", person: "Aisha", date: "03", weight: 5 },
        { kind: "leave", person: "Aisha", date: "WEEKEND" },
      ],
    });
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: [], quickPaintWeightText: "0" }),
    );
    expect(result.current.countClearable()).toEqual({ requests: 2, off: 1, leave: 1 });
    expect(
      result.current.countClearable({ personScope: "individual", dateScope: "individual" }),
    ).toEqual({ requests: 2, off: 1, leave: 0 });
    expect(
      result.current.countClearable({ personScope: "individual", dateScope: "group" }),
    ).toEqual({ requests: 0, off: 0, leave: 1 });
  });
});

describe("useRequests — Requests-CSV import preserves typed person identity (P1)", () => {
  // An imported scenario can carry a NUMERIC person id (UI-created ids are
  // strings, so only imported/loaded scenarios hit this). The CSV delta always
  // carries a STRINGIFIED person id; the matrix, quick-paint, and clear all key
  // by the real typed `PersonRef` under strict `===`. `applyRequestsCsv` must
  // resolve the stringified id back to the typed id before staging so the cell
  // lands on the coordinate it renders / merges / clears at (id 0, date "01").
  const NUMERIC_ID = 0;
  // Range 2026-01-01..03 is a single month, so date ids are DD-formatted ("01").
  const csvDeltas: ShiftRequestDelta[] = [
    { personId: String(NUMERIC_ID), dateId: "01", shiftType: "AM" },
  ];

  beforeEach(async () => {
    await seed({ staff: [{ id: NUMERIC_ID, history: [] }] });
  });

  /**
   * The committed cells at one coordinate. Drains first: T03 routes the staged
   * write through a queued repository command, so the projection carries it only
   * once that command has settled.
   */
  async function reqCellsAt(person: number, date: string) {
    await drainScenarioCommands();
    return useScenarioStore
      .getState()
      .reqData.filter((c) => c.person === person && c.date === date);
  }

  it("stages the imported cell under the TYPED numeric id, so it resolves in the matrix", async () => {
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: [], quickPaintWeightText: "0" }),
    );
    act(() => result.current.applyRequestsCsv(csvDeltas, 5));

    // The bug staged the STRING "0" (a coordinate the matrix, keyed by the typed
    // number 0 under `===`, never resolves). Assert both the strict identity and
    // the runtime type so a regression to the stringified id is caught.
    const cells = await reqCellsAt(NUMERIC_ID, "01");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: "request", shiftType: "AM", weight: 5 });
    expect(typeof cells[0].person).toBe("number");
    // No phantom string-keyed row survives.
    expect(useScenarioStore.getState().reqData.some((c) => (c.person as unknown) === "0")).toBe(
      false,
    );
  });

  it("merges the imported cell with a later manual quick-paint on the same person/date", async () => {
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) =>
        useRequests({ quickPaintSelectedIds: ids, quickPaintWeightText: "3" }),
      { initialProps: { ids: [] as string[] } },
    );
    act(() => result.current.applyRequestsCsv(csvDeltas, 5));

    // A manual quick-paint of PM at the SAME typed coordinate must merge onto the
    // imported AM cell (commitPaintGesture folds by coordinate key). Under the bug
    // the import sat at the string "0" key, so this landed at a separate coordinate
    // and never merged.
    rerender({ ids: ["PM"] });
    act(() => result.current.onCellPointerDown(NUMERIC_ID, "01"));
    fireEvent.mouseUp(window);

    const cells = await reqCellsAt(NUMERIC_ID, "01");
    expect(cells.map((c) => (c.kind === "request" ? c.shiftType : c.kind)).sort()).toEqual([
      "AM",
      "PM",
    ]);
  });

  it("removes the imported cell via an INDIVIDUAL-scoped clear (not only a group clear)", async () => {
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: [], quickPaintWeightText: "0" }),
    );
    act(() => result.current.applyRequestsCsv(csvDeltas, 5));
    expect(await reqCellsAt(NUMERIC_ID, "01")).toHaveLength(1);

    // individual-person + individual-date is the scope that classifies the cell by
    // typed-id membership. Under the bug the string "0" was absent from the typed
    // `individualPersonIds` set, so the cell was misread as a group and survived.
    act(() => result.current.clearRequestsByShape("individual", "individual"));
    expect(await reqCellsAt(NUMERIC_ID, "01")).toHaveLength(0);
  });
});

describe("useRequests — Requests-CSV import routes day-state labels (export round-trip)", () => {
  async function reqCellsAt(person: string, date: string) {
    await drainScenarioCommands();
    return useScenarioStore
      .getState()
      .reqData.filter((c) => c.person === person && c.date === date);
  }

  it("stages OFF/LEAVE deltas as off/leave cells (not request cells named OFF/LEAVE)", async () => {
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: [], quickPaintWeightText: "0" }),
    );
    const deltas: ShiftRequestDelta[] = [
      { personId: "Aisha", dateId: "01", shiftType: "LEAVE" },
      { personId: "Aisha", dateId: "02", shiftType: "OFF" },
      { personId: "Aisha", dateId: "03", shiftType: "AM" },
    ];
    act(() => result.current.applyRequestsCsv(deltas, 5));

    const leave = await reqCellsAt("Aisha", "01");
    expect(leave).toHaveLength(1);
    expect(leave[0]).toMatchObject({ kind: "leave" });

    const off = await reqCellsAt("Aisha", "02");
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ kind: "off", weight: 5 });

    const request = await reqCellsAt("Aisha", "03");
    expect(request).toHaveLength(1);
    expect(request[0]).toMatchObject({ kind: "request", shiftType: "AM", weight: 5 });
  });
});

describe("useRequests — Requests-CSV weights and change counts (F1)", () => {
  async function reqData() {
    await drainScenarioCommands();
    return useScenarioStore.getState().reqData;
  }

  it("a delta's own weight wins over the quick-paint weight; bare deltas take it", async () => {
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: [], quickPaintWeightText: "0" }),
    );
    const deltas: ShiftRequestDelta[] = [
      { personId: "Aisha", dateId: "01", shiftType: "AM", weight: -4 },
      { personId: "Aisha", dateId: "02", shiftType: "OFF", weight: 3 },
      { personId: "Aisha", dateId: "03", shiftType: "PM" },
    ];
    act(() => result.current.applyRequestsCsv(deltas, 7));
    const cells = await reqData();
    expect(cells.find((c) => c.date === "01")).toMatchObject({ kind: "request", weight: -4 });
    expect(cells.find((c) => c.date === "02")).toMatchObject({ kind: "off", weight: 3 });
    expect(cells.find((c) => c.date === "03")).toMatchObject({ kind: "request", weight: 7 });
    expect((await undoDepth()) > 0).toBe(true);
  });

  it("previews added / changed / removed cells without writing", async () => {
    await seed({
      reqData: [
        { kind: "request", person: "Aisha", date: "01", shiftType: "AM", weight: 5 },
        { kind: "request", person: "Aisha", date: "02", shiftType: "AM", weight: 5 },
        { kind: "request", person: "Aisha", date: "03", shiftType: "PM", weight: 2 },
      ],
    });
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: [], quickPaintWeightText: "0" }),
    );
    const deltas: ShiftRequestDelta[] = [
      { personId: "Aisha", dateId: "01", shiftType: "AM", weight: 5 }, // unchanged
      { personId: "Aisha", dateId: "02", shiftType: "AM", weight: -1 }, // changed
      { personId: "Aisha", dateId: "03", shiftType: "PM" }, // bare at 0 -> removed
      { personId: "Aisha", dateId: "03", shiftType: "AM", weight: 1 }, // added
    ];
    const before = await reqData();
    expect(result.current.previewRequestsCsv(deltas, 0)).toEqual({
      added: 1,
      changed: 1,
      removed: 1,
    });
    expect(await reqData()).toBe(before);
  });
});
