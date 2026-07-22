// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import type { ScenarioUiState } from "@/lib/scenario";
import {
  drainScenarioPersist,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import type { ShiftRequestDelta } from "./requests-csv";
import { useRequests } from "./use-requests";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const BASE_SEED: Partial<ScenarioUiState> = {
  rangeStart: "2026-01-01",
  rangeEnd: "2026-01-03",
  staff: [{ id: "Aisha", history: [] }],
  shifts: [{ id: "AM" }, { id: "PM" }],
  shiftGroups: [{ id: "AnyDay", members: ["AM", "PM"] }],
};

function seed(patch: Partial<ScenarioUiState>) {
  act(() => {
    useScenarioStore.getState().mutateScenario(patch);
  });
}

function staffHistory(personId: string): string[] {
  return useScenarioStore.getState().staff.find((p) => p.id === personId)?.history ?? [];
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
  seed(BASE_SEED);
});

afterEach(() => cleanup());

describe("useRequests — quick-paint history gesture", () => {
  it("flushes a deferred CLEAR against LIVE staff, not the mount-time snapshot (P1)", () => {
    // Mount while history is EMPTY — the mouse-up listener is registered by an
    // empty-dep effect and closes over this first render.
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: [], quickPaintWeightText: "0" }),
    );
    // History is written AFTER mount (simulating any post-mount edit).
    seed({ staff: [{ id: "Aisha", history: ["AM", "PM"] }] });

    // historyCount = 2 + 1 = 3; Aisha's offset = 1, so rendered column 1 maps to
    // real position 0 (the NEWEST entry — a NON-deepest slot). A stale flush
    // would compute [].slice(1) and erase the surviving older entry.
    act(() => result.current.onHistoryPointerDown("Aisha", 1));
    fireEvent.mouseUp(window);

    expect(staffHistory("Aisha")).toEqual(["PM"]);
  });

  it("accepts the reserved OFF and LEAVE as history values", () => {
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) =>
        useRequests({ quickPaintSelectedIds: ids, quickPaintWeightText: "0" }),
      { initialProps: { ids: ["OFF"] } },
    );

    // Column 0 is the clickable append-padding slot (historyCount = 1, offset = 1).
    act(() => result.current.onHistoryPointerDown("Aisha", 0));
    fireEvent.mouseUp(window);
    expect(staffHistory("Aisha")).toEqual(["OFF"]);

    rerender({ ids: ["LEAVE"] });
    act(() => result.current.onHistoryPointerDown("Aisha", 0));
    fireEvent.mouseUp(window);
    expect(staffHistory("Aisha")).toEqual(["LEAVE", "OFF"]);
  });

  it("skips a shift-type GROUP silently (a history slot cannot hold a group)", () => {
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: ["AnyDay"], quickPaintWeightText: "0" }),
    );
    act(() => result.current.onHistoryPointerDown("Aisha", 0));
    fireEvent.mouseUp(window);
    expect(staffHistory("Aisha")).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("surfaces the verbatim multi-select error as a toast (and mutates nothing)", () => {
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: ["AM", "PM"], quickPaintWeightText: "0" }),
    );
    act(() => result.current.onHistoryPointerDown("Aisha", 0));
    expect(toast.error).toHaveBeenCalledWith("Cannot set history to multiple shift types.");
    fireEvent.mouseUp(window);
    expect(staffHistory("Aisha")).toEqual([]);
  });

  it("a set-drag across two slots still commits exactly once", () => {
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: ["AM"], quickPaintWeightText: "0" }),
    );
    const before = useScenarioStore.temporal.getState().pastStates.length;
    act(() => result.current.onHistoryPointerDown("Aisha", 0));
    act(() => result.current.onHistoryPointerEnter("Aisha", 1));
    fireEvent.mouseUp(window);
    expect(staffHistory("Aisha")).toEqual(["AM"]);
    expect(useScenarioStore.temporal.getState().pastStates.length - before).toBe(1);
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

  beforeEach(() => {
    seed({ staff: [{ id: NUMERIC_ID, history: [] }] });
  });

  function reqCellsAt(person: number, date: string) {
    return useScenarioStore
      .getState()
      .reqData.filter((c) => c.person === person && c.date === date);
  }

  it("stages the imported cell under the TYPED numeric id, so it resolves in the matrix", () => {
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: [], quickPaintWeightText: "0" }),
    );
    act(() => result.current.applyRequestsCsv(csvDeltas, 5));

    // The bug staged the STRING "0" (a coordinate the matrix, keyed by the typed
    // number 0 under `===`, never resolves). Assert both the strict identity and
    // the runtime type so a regression to the stringified id is caught.
    const cells = reqCellsAt(NUMERIC_ID, "01");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: "request", shiftType: "AM", weight: 5 });
    expect(typeof cells[0].person).toBe("number");
    // No phantom string-keyed row survives.
    expect(useScenarioStore.getState().reqData.some((c) => (c.person as unknown) === "0")).toBe(
      false,
    );
  });

  it("merges the imported cell with a later manual quick-paint on the same person/date", () => {
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

    const cells = reqCellsAt(NUMERIC_ID, "01");
    expect(cells.map((c) => (c.kind === "request" ? c.shiftType : c.kind)).sort()).toEqual([
      "AM",
      "PM",
    ]);
  });

  it("removes the imported cell via an INDIVIDUAL-scoped clear (not only a group clear)", () => {
    const { result } = renderHook(() =>
      useRequests({ quickPaintSelectedIds: [], quickPaintWeightText: "0" }),
    );
    act(() => result.current.applyRequestsCsv(csvDeltas, 5));
    expect(reqCellsAt(NUMERIC_ID, "01")).toHaveLength(1);

    // individual-person + individual-date is the scope that classifies the cell by
    // typed-id membership. Under the bug the string "0" was absent from the typed
    // `individualPersonIds` set, so the cell was misread as a group and survived.
    act(() => result.current.clearRequestsByShape("individual", "individual"));
    expect(reqCellsAt(NUMERIC_ID, "01")).toHaveLength(0);
  });
});
