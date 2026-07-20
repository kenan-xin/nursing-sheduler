// The hot ephemeral store (T04): run state, SSE progress, UI scratch, editor
// drafts, and the in-flight paint gesture. It has NO persist middleware, so
// nothing here ever writes to IndexedDB — 100 SSE progress frames cause zero
// scenario persist writes (a required acceptance). It also holds the durable
// store's hydration status, since that is transient UI, not scenario data;
// setting it never triggers a durable write (important during the pre-read
// window). The durable store's mutation gate reads this status via the spine.

import { create } from "zustand";
import {
  INITIAL_RUN_STATE,
  paintCellKey,
  type HydrationStatus,
  type PaintCellKey,
  type RunProgressEvent,
  type RunState,
  type StagedCoordinate,
  type StagedDayState,
} from "./types";
import type { DateRef, PersonRef, ShiftTypeRef, Weight } from "@/lib/scenario";
import { INITIAL_OPTIMIZE_RUN_VIEW, type OptimizeRunView } from "@/lib/optimize/run-view";

export interface HotStoreState {
  /** The durable store's Dexie hydration lifecycle status (drives the ready gate). */
  hydrationStatus: HydrationStatus;
  /** Current optimize-run snapshot (lean placeholder; see `runView` for T16). */
  run: RunState;
  /**
   * The typed feature-local Optimize run view (T16a). The controller replaces this
   * whole projection through `setRunView`; the reducer that computes it lives in
   * `@/lib/optimize/run-view`. Ephemeral like every other hot slice — never persisted.
   */
  runView: OptimizeRunView;
  /**
   * Monotonic generation counter for the run controller's attachment authority
   * (T16a P1). Every reset path (`resetRun`/`resetRunView`/`resetEphemeral`) bumps
   * it, so the canonical New/Load path (which calls `resetEphemeral`) automatically
   * revokes any in-flight controller attachment. The controller captures the
   * generation when it attaches a job and refuses to dispatch signals from a prior
   * generation — late frames/poll/snapshots/controls from scenario A's run can never
   * repopulate scenario B's view. Ephemeral: starts at 0, never persisted.
   */
  runGeneration: number;
  /** Ordered SSE progress frames for the current run. */
  progress: RunProgressEvent[];
  /**
   * Transient editor UI scratch (selection, hovered cell, panel open state…).
   * T04 provides the slot; the concrete shape is owned by the editor tickets.
   */
  ui: Record<string, unknown>;
  /** In-progress editor form drafts, keyed by an editor-defined draft id. */
  drafts: Record<string, unknown>;
  /**
   * Staged paint intents during a drag, keyed by person×date. Each value is a
   * per-coordinate transaction (`erase` / `day-state` / `requests`), not a
   * single cell. `null` while no gesture is active. Committed atomically to the
   * durable store on pointer-up.
   */
  paint: Map<PaintCellKey, StagedCoordinate> | null;

  setHydrationStatus(status: HydrationStatus): void;
  setRun(patch: Partial<RunState>): void;
  pushProgress(event: RunProgressEvent): void;
  resetRun(): void;
  /** Replace the whole typed run view (the T16a controller owns the reducer). */
  setRunView(next: OptimizeRunView): void;
  /** Reset the run view to its zero value (New / Load / explicit clear). */
  resetRunView(): void;
  setUi(patch: Record<string, unknown>): void;
  setDraft(id: string, draft: unknown): void;
  clearDraft(id: string): void;

  /** Start a paint gesture (fresh empty staging buffer). */
  beginPaint(): void;
  /**
   * Stage a day-state (`leave`/`off`) at the coordinate. XOR: drops any staged
   * request deltas — the coordinate becomes `mode:"day-state"`.
   */
  stagePaintDayState(person: PersonRef, date: DateRef, dayState: StagedDayState): void;
  /**
   * Stage one request-selector delta at the coordinate (weight `0` removes that
   * selector on commit). XOR: if the coordinate was staged as a day-state it
   * switches to `mode:"requests"`; otherwise deltas for other selectors merge.
   */
  stagePaintRequestDelta(
    person: PersonRef,
    date: DateRef,
    selector: ShiftTypeRef,
    weight: Weight,
  ): void;
  /** Stage a coordinate-wide erase (drops any staged day-state / deltas). */
  stagePaintErase(person: PersonRef, date: DateRef): void;
  /** Discard the staging buffer without committing (also used post-commit). */
  cancelPaint(): void;

  /**
   * Reset all ephemeral slices — run, run view, progress, ui, drafts, and any
   * in-flight paint — WITHOUT touching `hydrationStatus`. Load / New call this so
   * scenario A's transient state (a staged paint especially) cannot leak into
   * scenario B.
   */
  resetEphemeral(): void;
}

/** Zustand store api for the hot ephemeral store. */
export type HotStore = ReturnType<typeof createHotStore>;

/** Create a hot store instance (factory for test isolation and the spine). */
export function createHotStore() {
  return create<HotStoreState>()((set) => ({
    hydrationStatus: "unhydrated",
    run: INITIAL_RUN_STATE,
    runView: INITIAL_OPTIMIZE_RUN_VIEW,
    runGeneration: 0,
    progress: [],
    ui: {},
    drafts: {},
    paint: null,

    setHydrationStatus: (hydrationStatus) => set({ hydrationStatus }),

    setRun: (patch) => set((state) => ({ run: { ...state.run, ...patch } })),

    pushProgress: (event) => set((state) => ({ progress: [...state.progress, event] })),

    resetRun: () =>
      set((state) => ({
        run: INITIAL_RUN_STATE,
        runView: INITIAL_OPTIMIZE_RUN_VIEW,
        progress: [],
        runGeneration: state.runGeneration + 1,
      })),

    setRunView: (runView) => set({ runView }),

    resetRunView: () =>
      set((state) => ({
        runView: INITIAL_OPTIMIZE_RUN_VIEW,
        runGeneration: state.runGeneration + 1,
      })),

    setUi: (patch) => set((state) => ({ ui: { ...state.ui, ...patch } })),

    setDraft: (id, draft) => set((state) => ({ drafts: { ...state.drafts, [id]: draft } })),

    clearDraft: (id) =>
      set((state) => {
        if (!(id in state.drafts)) return state;
        const { [id]: _removed, ...rest } = state.drafts;
        return { drafts: rest };
      }),

    beginPaint: () => set({ paint: new Map<PaintCellKey, StagedCoordinate>() }),

    stagePaintDayState: (person, date, dayState) =>
      set((state) => {
        // Ignore staging outside an active gesture — `beginPaint` opens the buffer.
        if (!state.paint) return state;
        const next = new Map(state.paint);
        next.set(paintCellKey(person, date), { mode: "day-state", dayState });
        return { paint: next };
      }),

    stagePaintRequestDelta: (person, date, selector, weight) =>
      set((state) => {
        if (!state.paint) return state;
        const next = new Map(state.paint);
        const key = paintCellKey(person, date);
        const existing = next.get(key);
        // Merge onto an existing request-set; a day-state/erase intent is dropped (XOR).
        const deltas =
          existing?.mode === "requests"
            ? new Map(existing.deltas)
            : new Map<ShiftTypeRef, Weight>();
        deltas.set(selector, weight);
        next.set(key, { mode: "requests", deltas });
        return { paint: next };
      }),

    stagePaintErase: (person, date) =>
      set((state) => {
        if (!state.paint) return state;
        const next = new Map(state.paint);
        next.set(paintCellKey(person, date), { mode: "erase" });
        return { paint: next };
      }),

    cancelPaint: () => set({ paint: null }),

    resetEphemeral: () =>
      set((state) => ({
        run: INITIAL_RUN_STATE,
        runView: INITIAL_OPTIMIZE_RUN_VIEW,
        progress: [],
        ui: {},
        drafts: {},
        paint: null,
        runGeneration: state.runGeneration + 1,
      })),
  }));
}
