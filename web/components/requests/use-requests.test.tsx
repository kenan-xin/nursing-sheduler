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
