"use client";

// Store binding for the Shift Requests editor (T11). Reads the durable scenario
// slice, derives the matrix inputs (rows/columns/history layout/order index) via
// `requests-model`, and wires the quick-paint gesture reducer
// (`requests-gestures`) onto the store: reqData painting stages through the hot
// store's coordinate-transaction buffer and commits with `commitPaintGesture`
// (one `setReqData` per drag); history painting accumulates into an in-memory
// draft here and commits with exactly one `mutateScenario` per drag — the T11
// replacement for the old app's `replaceLatestHistoryEntry` chaining hack.
//
// Render-loop safety (zustand v5): every `useScenarioStore` selector here either
// returns the raw state object (`(s) => s`, a stable reference until the store
// itself changes) or a primitive/array slice already stored on that object —
// never a freshly-constructed object literal — so no selector needs `useShallow`.
// Derived data (rows/columns/history/order index) is computed with `useMemo`,
// not inside a selector.

import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { commitPaintGesture, useHotStore, useScenarioStore } from "@/lib/store";
import { generateDateItems, hasCompleteRange, type DateRange } from "@/lib/dates";
import {
  RESERVED_SHIFT_TYPE,
  type DateRef,
  type PersonId,
  type PersonRef,
  type UiPerson,
  type UiRequestCell,
} from "@/lib/scenario";
import {
  buildColumns,
  buildRows,
  buildShiftTypeOrderIndex,
  historyColumnCount,
  historyLayout,
  type RequestColumn,
  type RequestRow,
  type ShiftTypeOrderIndex,
} from "./requests-model";
import type { CellEditorResult } from "./cell-preference-editor";
import { parseQuickPaintWeight } from "./quick-paint-status";
import type { ShiftRequestDelta, PeopleHistoryEntry } from "./requests-csv";
import {
  accumulateDeepestClear,
  computeHistoryApplyPosition,
  computeHistoryClearPosition,
  computeQuickPaintCellIntent,
  markCellVisited,
  prependHistoryEntry,
  resolveHistoryPaintSelection,
  truncateHistoryThroughPosition,
  updateHistoryAtPosition,
  type PaintCellIntent,
  type PaintCellType,
} from "./requests-gestures";

export type ClearScope =
  | "requests"
  | "history"
  | "individual-individual"
  | "group-individual"
  | "individual-group"
  | "group-group";

export interface RequestsController {
  rows: RequestRow[];
  columns: RequestColumn[];
  people: UiPerson[];
  reqData: UiRequestCell[];
  historyCount: number;
  historyLabels: string[];
  shiftTypeOrderIndex: ShiftTypeOrderIndex;
  hasRequiredData: boolean;
  missingRequirement: "dates" | "people" | "shiftTypes" | null;
  /** `JSON.stringify([person, colRef])` keys currently staged (drag highlight). */
  stagedKeys: Set<string>;

  onCellPointerDown(person: PersonRef, colRef: DateRef): void;
  onCellPointerEnter(person: PersonRef, colRef: DateRef): void;
  onHistoryPointerDown(person: PersonRef, columnIndex: number): void;
  onHistoryPointerEnter(person: PersonRef, columnIndex: number): void;

  /** Normal-mode cell editor Save — one coordinate rebuild, one `setReqData`. */
  commitCellEdit(person: PersonRef, date: DateRef, result: CellEditorResult): void;
  /** Normal-mode cell editor "Clear cell". */
  clearCell(person: PersonRef, date: DateRef): void;
  /** Normal-mode history editor "set" (append/update). */
  commitHistorySet(personId: PersonRef, historyIndex: number, shiftType: string): void;
  /** Normal-mode history editor "-- Clear --" (truncate through position). */
  commitHistoryClear(personId: PersonRef, historyIndex: number): void;

  applyRequestsCsv(deltas: ShiftRequestDelta[], weight: number): void;
  applyHistoryCsv(entries: PeopleHistoryEntry[]): void;

  clearAllRequests(): void;
  clearAllHistory(): void;
  clearRequestsByShape(
    personScope: "individual" | "group",
    dateScope: "individual" | "group",
  ): void;
}

export interface UseRequestsOptions {
  /** Currently selected quick-paint targets (shift items/groups + OFF/LEAVE/ALL). */
  quickPaintSelectedIds: string[];
  /** Raw quick-paint weight input text (parsed here via `parseQuickPaintWeight`). */
  quickPaintWeightText: string;
}

/**
 * The per-coordinate identity key of a request cell: a `request` cell is keyed by
 * its worked selector, a day-state cell by its `kind`. Two edits that re-emit the
 * same selector at a coordinate resolve to the same key, so identity is preserved
 * across the edit rather than reallocated.
 */
function cellSelectorKey(cell: UiRequestCell): string {
  return cell.kind === "request" ? `request:${cell.shiftType}` : cell.kind;
}

function stageCellIntent(
  hot: ReturnType<typeof useHotStore.getState>,
  person: PersonRef,
  date: DateRef,
  intent: PaintCellIntent | null,
): void {
  if (!intent) return;
  if (intent.mode === "erase") {
    hot.stagePaintErase(person, date);
    return;
  }
  if (intent.mode === "day-state") {
    hot.stagePaintDayState(person, date, intent.dayState);
    return;
  }
  for (const [selector, weight] of intent.deltas) {
    hot.stagePaintRequestDelta(person, date, selector, weight);
  }
}

export function useRequests({
  quickPaintSelectedIds,
  quickPaintWeightText,
}: UseRequestsOptions): RequestsController {
  // Whole-state selector — a stable reference until the store itself replaces it,
  // never a freshly-constructed object — so this never trips the zustand v5
  // render-loop trap (mirrors `use-counts.ts` / `use-successions.ts`).
  const state = useScenarioStore((s) => s);
  const stagedPaint = useHotStore((s) => s.paint);

  const range: DateRange = { start: state.rangeStart, end: state.rangeEnd };
  const hasRange = hasCompleteRange(range);

  const rows = useMemo(
    () => buildRows(state.staffGroups, state.staff),
    [state.staffGroups, state.staff],
  );
  const columns = useMemo(
    () => (hasRange ? buildColumns(range, state.dateGroups) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasRange, range.start, range.end, state.dateGroups],
  );
  const history = useMemo(() => historyLayout(state.staff), [state.staff]);
  const shiftTypeOrderIndex = useMemo(
    () =>
      buildShiftTypeOrderIndex([
        ...state.shifts.map((s) => String(s.id)),
        ...state.shiftGroups.map((g) => g.id),
      ]),
    [state.shifts, state.shiftGroups],
  );
  // The valid quick-paint HISTORY item set: worked shift items + the reserved
  // OFF/LEAVE (history may hold OFF/LEAVE — parity with the old app, whose
  // `shiftTypeData.items` includes the AUTO_GENERATED_ITEMS OFF/LEAVE), but
  // never shift-type groups.
  const historyItemIds = useMemo(
    () =>
      new Set([
        ...state.shifts.map((s) => String(s.id)),
        RESERVED_SHIFT_TYPE.off,
        RESERVED_SHIFT_TYPE.leave,
      ]),
    [state.shifts],
  );

  const missingRequirement: RequestsController["missingRequirement"] = !hasRange
    ? "dates"
    : state.staff.length === 0
      ? "people"
      : state.shifts.length === 0 && state.shiftGroups.length === 0
        ? "shiftTypes"
        : null;
  const hasRequiredData = missingRequirement === null;

  const stagedKeys = useMemo(
    () => (stagedPaint ? new Set(stagedPaint.keys()) : new Set<string>()),
    [stagedPaint],
  );

  // --- Gesture-scoped mutable state (never triggers a render by itself) -------
  const dragCellTypeRef = useRef<PaintCellType | null>(null);
  const visitedRef = useRef<Set<string>>(new Set());
  const historyDraftRef = useRef<Map<PersonId, string[]>>(new Map());
  const historyClearPendingRef = useRef<Map<PersonId, number>>(new Map());
  const dragHistoryColumnsCountRef = useRef(0);

  function draftedStaff(): UiPerson[] {
    // Read LIVE staff, never the closed-over render snapshot (see the note on
    // `flushHistoryGesture`): a gesture's closures can predate the latest commit.
    const liveStaff = useScenarioStore.getState().staff;
    if (historyDraftRef.current.size === 0) return liveStaff;
    return liveStaff.map((p) =>
      historyDraftRef.current.has(p.id) ? { ...p, history: historyDraftRef.current.get(p.id) } : p,
    );
  }

  function applyHistoryPaintCell(personId: PersonRef, columnIndex: number): void {
    const selection = resolveHistoryPaintSelection(quickPaintSelectedIds, historyItemIds);
    if (selection.kind === "error") {
      // FR-SR-32's verbatim multi-select error must be VISIBLE — the reducer
      // produces it; surface it (previously swallowed silently).
      toast.error(selection.message);
      return;
    }
    if (selection.kind === "skip") return;
    const liveStaff = useScenarioStore.getState().staff;
    const person = liveStaff.find((p) => p.id === personId);
    if (!person) return;

    if (selection.kind === "clear") {
      const baseline = person.history ?? [];
      const clearPos = computeHistoryClearPosition(
        columnIndex,
        baseline.length,
        dragHistoryColumnsCountRef.current,
      );
      if (clearPos === null) return;
      accumulateDeepestClear(historyClearPendingRef.current, person.id, clearPos);
      return;
    }

    const current = historyDraftRef.current.get(person.id) ?? person.history ?? [];
    const liveCount = historyColumnCount(draftedStaff());
    const position = computeHistoryApplyPosition(columnIndex, current.length, liveCount);
    const next =
      position.action === "append"
        ? prependHistoryEntry(current, selection.shiftType)
        : updateHistoryAtPosition(current, position.position, selection.shiftType);
    historyDraftRef.current.set(person.id, next);
  }

  function flushHistoryGesture(): void {
    // Read LIVE staff via `getState()` — NEVER the closed-over `state.staff`.
    // This function is invoked from the global mouse-up listener, which is
    // registered once by an empty-dep effect and therefore closes over the
    // FIRST render's snapshot; a deferred clear truncation computed from that
    // stale staff erases history entries written after mount.
    const liveStaff = useScenarioStore.getState().staff;
    for (const [personId, clearPos] of historyClearPendingRef.current) {
      const current =
        historyDraftRef.current.get(personId) ??
        liveStaff.find((p) => p.id === personId)?.history ??
        [];
      historyDraftRef.current.set(personId, truncateHistoryThroughPosition(current, clearPos));
    }
    historyClearPendingRef.current = new Map();

    if (historyDraftRef.current.size === 0) return;
    const drafts = historyDraftRef.current;
    historyDraftRef.current = new Map();
    useScenarioStore.getState().mutateScenario((s) => ({
      staff: s.staff.map((p) => (drafts.has(p.id) ? { ...p, history: drafts.get(p.id)! } : p)),
    }));
  }

  // One global mouse-up commits whichever gesture is active — the atomic-commit
  // boundary (one `setReqData`/`mutateScenario` per drag, regardless of how many
  // cells were crossed) — and resets the per-gesture scratch state.
  useEffect(() => {
    function handleMouseUp() {
      if (dragCellTypeRef.current === "preference") {
        commitPaintGesture(useScenarioStore, useHotStore);
      } else if (dragCellTypeRef.current === "history") {
        flushHistoryGesture();
      }
      dragCellTypeRef.current = null;
      visitedRef.current.clear();
    }
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onCellPointerDown(person: PersonRef, colRef: DateRef): void {
    dragCellTypeRef.current = "preference";
    visitedRef.current.clear();
    useHotStore.getState().beginPaint();
    markCellVisited(visitedRef.current, "preference", person, colRef);
    const weight = parseQuickPaintWeight(quickPaintWeightText);
    const intent = computeQuickPaintCellIntent(quickPaintSelectedIds, weight);
    stageCellIntent(useHotStore.getState(), person, colRef, intent);
  }

  function onCellPointerEnter(person: PersonRef, colRef: DateRef): void {
    if (dragCellTypeRef.current !== "preference") return;
    if (!markCellVisited(visitedRef.current, "preference", person, colRef)) return;
    const weight = parseQuickPaintWeight(quickPaintWeightText);
    const intent = computeQuickPaintCellIntent(quickPaintSelectedIds, weight);
    stageCellIntent(useHotStore.getState(), person, colRef, intent);
  }

  function onHistoryPointerDown(person: PersonRef, columnIndex: number): void {
    dragCellTypeRef.current = "history";
    visitedRef.current.clear();
    historyClearPendingRef.current = new Map();
    historyDraftRef.current = new Map();
    dragHistoryColumnsCountRef.current = historyColumnCount(useScenarioStore.getState().staff);
    markCellVisited(visitedRef.current, "history", person, columnIndex);
    applyHistoryPaintCell(person, columnIndex);
  }

  function onHistoryPointerEnter(person: PersonRef, columnIndex: number): void {
    if (dragCellTypeRef.current !== "history") return;
    if (!markCellVisited(visitedRef.current, "history", person, columnIndex)) return;
    applyHistoryPaintCell(person, columnIndex);
  }

  function commitCellEdit(person: PersonRef, date: DateRef, result: CellEditorResult): void {
    const scenario = useScenarioStore.getState();
    const atCoordinate = scenario.reqData.filter((c) => c.person === person && c.date === date);
    const others = scenario.reqData.filter((c) => !(c.person === person && c.date === date));
    // Preserve durable identity per selector/day-state so an edit re-using an
    // existing selector keeps its `uid` (Workspace identity never depends on array
    // position); a genuinely new cell is minted a fresh `uid` at creation (T17r
    // review P1 — every manual create path allocates identity).
    const uidBySelector = new Map<string, string>();
    for (const cell of atCoordinate) {
      if (cell.uid) uidBySelector.set(cellSelectorKey(cell), cell.uid);
    }
    const uidFor = (selector: string): string => uidBySelector.get(selector) ?? crypto.randomUUID();

    let cells: UiRequestCell[] = [];
    if (result.kind === "leave") cells = [{ kind: "leave", person, date, uid: uidFor("leave") }];
    else if (result.kind === "off")
      cells = [{ kind: "off", person, date, weight: result.weight ?? 0, uid: uidFor("off") }];
    else if (result.kind === "requests") {
      // Empty prefs is an erase (parity note): `cells` stays `[]`.
      cells = result.prefs.map((p) => ({
        kind: "request",
        person,
        date,
        shiftType: p.shiftType,
        weight: p.weight,
        uid: uidFor(`request:${p.shiftType}`),
      }));
    }
    scenario.setReqData([...others, ...cells]);
  }

  function clearCell(person: PersonRef, date: DateRef): void {
    const scenario = useScenarioStore.getState();
    scenario.setReqData(scenario.reqData.filter((c) => !(c.person === person && c.date === date)));
  }

  function commitHistorySet(personId: PersonRef, historyIndex: number, shiftType: string): void {
    const scenario = useScenarioStore.getState();
    const person = scenario.staff.find((p) => p.id === personId);
    if (!person) return;
    const currentHistory = person.history ?? [];
    const count = historyColumnCount(scenario.staff);
    const position = computeHistoryApplyPosition(historyIndex, currentHistory.length, count);
    const next =
      position.action === "append"
        ? prependHistoryEntry(currentHistory, shiftType)
        : updateHistoryAtPosition(currentHistory, position.position, shiftType);
    scenario.mutateScenario((s) => ({
      staff: s.staff.map((p) => (p.id === personId ? { ...p, history: next } : p)),
    }));
  }

  function commitHistoryClear(personId: PersonRef, historyIndex: number): void {
    const scenario = useScenarioStore.getState();
    const person = scenario.staff.find((p) => p.id === personId);
    if (!person) return;
    const currentHistory = person.history ?? [];
    const count = historyColumnCount(scenario.staff);
    const clearPos = computeHistoryClearPosition(historyIndex, currentHistory.length, count);
    if (clearPos === null) return;
    const next = truncateHistoryThroughPosition(currentHistory, clearPos);
    scenario.mutateScenario((s) => ({
      staff: s.staff.map((p) => (p.id === personId ? { ...p, history: next } : p)),
    }));
  }

  function applyRequestsCsv(deltas: ShiftRequestDelta[], weight: number): void {
    if (deltas.length === 0) return;
    const hot = useHotStore.getState();
    hot.beginPaint();
    for (const d of deltas) hot.stagePaintRequestDelta(d.personId, d.dateId, d.shiftType, weight);
    commitPaintGesture(useScenarioStore, useHotStore);
  }

  function applyHistoryCsv(entries: PeopleHistoryEntry[]): void {
    if (entries.length === 0) return;
    const byPerson = new Map(entries.map((e) => [e.personId, e]));
    useScenarioStore.getState().mutateScenario((s) => ({
      staff: s.staff.map((p) => {
        const entry = byPerson.get(String(p.id));
        if (!entry) return p;
        const nextHistory = entry.shiftType
          ? Array.from({ length: entry.repetitionCount }, () => entry.shiftType)
          : [];
        return { ...p, history: nextHistory };
      }),
    }));
  }

  function clearAllRequests(): void {
    useScenarioStore.getState().setReqData([]);
  }

  function clearAllHistory(): void {
    useScenarioStore.getState().mutateScenario((s) => ({
      staff: s.staff.map((p) => ({ ...p, history: [] })),
    }));
  }

  function clearRequestsByShape(
    personScope: "individual" | "group",
    dateScope: "individual" | "group",
  ): void {
    const scenario = useScenarioStore.getState();
    const individualPersonIds = new Set(scenario.staff.map((p) => p.id));
    const scopeRange: DateRange = { start: scenario.rangeStart, end: scenario.rangeEnd };
    const individualDateIds = hasCompleteRange(scopeRange)
      ? new Set<DateRef>(generateDateItems(scopeRange).map((d) => d.id))
      : new Set<DateRef>();
    const next = scenario.reqData.filter((cell) => {
      const personIsIndividual = individualPersonIds.has(cell.person);
      const dateIsIndividual = individualDateIds.has(cell.date);
      const matchesPerson = personScope === "individual" ? personIsIndividual : !personIsIndividual;
      const matchesDate = dateScope === "individual" ? dateIsIndividual : !dateIsIndividual;
      return !(matchesPerson && matchesDate);
    });
    scenario.setReqData(next);
  }

  return {
    rows,
    columns,
    people: state.staff,
    reqData: state.reqData,
    historyCount: history.count,
    historyLabels: history.labels,
    shiftTypeOrderIndex,
    hasRequiredData,
    missingRequirement,
    stagedKeys,
    onCellPointerDown,
    onCellPointerEnter,
    onHistoryPointerDown,
    onHistoryPointerEnter,
    commitCellEdit,
    clearCell,
    commitHistorySet,
    commitHistoryClear,
    applyRequestsCsv,
    applyHistoryCsv,
    clearAllRequests,
    clearAllHistory,
    clearRequestsByShape,
  };
}
