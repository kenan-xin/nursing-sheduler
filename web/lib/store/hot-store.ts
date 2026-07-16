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
  type StagedPaintCell,
} from "./types";
import type { DateRef, PersonRef, UiRequestCell } from "@/lib/scenario";

export interface HotStoreState {
  /** The durable store's Dexie hydration lifecycle status (drives the ready gate). */
  hydrationStatus: HydrationStatus;
  /** Current optimize-run snapshot. */
  run: RunState;
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
   * Staged paint mutations during a drag, keyed by person×date. `null` while no
   * gesture is active. Committed atomically to the durable store on pointer-up.
   */
  paint: Map<PaintCellKey, StagedPaintCell> | null;

  setHydrationStatus(status: HydrationStatus): void;
  setRun(patch: Partial<RunState>): void;
  pushProgress(event: RunProgressEvent): void;
  resetRun(): void;
  setUi(patch: Record<string, unknown>): void;
  setDraft(id: string, draft: unknown): void;
  clearDraft(id: string): void;

  /** Start a paint gesture (fresh empty staging buffer). */
  beginPaint(): void;
  /** Stage an upserted cell (or `null` to erase) at the given coordinate. */
  stagePaintCell(person: PersonRef, date: DateRef, cell: StagedPaintCell): void;
  /** Discard the staging buffer without committing (also used post-commit). */
  cancelPaint(): void;

  /**
   * Reset all ephemeral slices — run, progress, ui, drafts, and any in-flight
   * paint — WITHOUT touching `hydrationStatus`. Load / New call this so scenario
   * A's transient state (a staged paint especially) cannot leak into scenario B.
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
    progress: [],
    ui: {},
    drafts: {},
    paint: null,

    setHydrationStatus: (hydrationStatus) => set({ hydrationStatus }),

    setRun: (patch) => set((state) => ({ run: { ...state.run, ...patch } })),

    pushProgress: (event) => set((state) => ({ progress: [...state.progress, event] })),

    resetRun: () => set({ run: INITIAL_RUN_STATE, progress: [] }),

    setUi: (patch) => set((state) => ({ ui: { ...state.ui, ...patch } })),

    setDraft: (id, draft) => set((state) => ({ drafts: { ...state.drafts, [id]: draft } })),

    clearDraft: (id) =>
      set((state) => {
        if (!(id in state.drafts)) return state;
        const { [id]: _removed, ...rest } = state.drafts;
        return { drafts: rest };
      }),

    beginPaint: () => set({ paint: new Map<PaintCellKey, StagedPaintCell>() }),

    stagePaintCell: (person, date, cell) =>
      set((state) => {
        // Ignore staging outside an active gesture — `beginPaint` opens the buffer.
        if (!state.paint) return state;
        const next = new Map(state.paint);
        next.set(paintCellKey(person, date), cell);
        return { paint: next };
      }),

    cancelPaint: () => set({ paint: null }),

    resetEphemeral: () =>
      set({ run: INITIAL_RUN_STATE, progress: [], ui: {}, drafts: {}, paint: null }),
  }));
}

/** Re-exported so callers building a `UiRequestCell` to stage keep one import site. */
export type { UiRequestCell };
