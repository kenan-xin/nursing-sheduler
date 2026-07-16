// State-spine shared types (T04). The store split is firm (tech-plan §4):
//
//   • the DURABLE scenario store holds `ScenarioUiState` (T18) + the persisted
//     dirty baseline; it is the only store that writes to IndexedDB.
//   • the HOT store holds everything ephemeral — run state, SSE progress, UI
//     scratch, editor drafts, and the in-flight paint gesture — and never
//     triggers a scenario persist write.
//
// This module carries only the hot-store value shapes and the persistence
// lifecycle enum; the durable store's shape lives in `scenario-store.ts`.

import type { DateRef, PersonRef, UiRequestCell } from "@/lib/scenario";

// ---------------------------------------------------------------------------
// Persistence lifecycle
// ---------------------------------------------------------------------------

/**
 * The durable store's Dexie hydration state machine (tech-plan §4):
 * `unhydrated → hydrating → ready | recoverable-error`. Editors block mutations
 * until `ready`; `recoverable-error` offers a user reset without crashing.
 */
export type HydrationStatus = "unhydrated" | "hydrating" | "ready" | "recoverable-error";

// ---------------------------------------------------------------------------
// Run state (hot) — the SSE/optimize transport is T06's; this is only the shape
// the hot store holds. Kept intentionally lean so T06 owns the wiring.
// ---------------------------------------------------------------------------

/** Coarse run lifecycle phase surfaced to the UI. */
export type RunPhase =
  | "idle"
  | "submitting"
  | "queued"
  | "running"
  | "complete"
  | "error"
  | "cancelled";

/** A single progress frame applied from the SSE stream (see T06). */
export interface RunProgressEvent {
  phase?: string;
  progress?: number;
  score?: number;
  message?: string;
}

/** Current optimize-run snapshot. Ephemeral: lost on reload, never persisted. */
export interface RunState {
  phase: RunPhase;
  jobId: string | null;
  progress: number | null;
  score: number | null;
  error: string | null;
}

/** The zero-value run snapshot. */
export const INITIAL_RUN_STATE: RunState = {
  phase: "idle",
  jobId: null,
  progress: null,
  score: null,
  error: null,
};

// ---------------------------------------------------------------------------
// Paint gesture staging (hot) — see `paint.ts` for the commit protocol.
// ---------------------------------------------------------------------------

/** A person×date matrix coordinate key for de-duping staged paint cells. */
export type PaintCellKey = string;

/**
 * A staged paint mutation: an upserted matrix cell, or `null` to erase whatever
 * cell currently occupies that person/date coordinate.
 */
export type StagedPaintCell = UiRequestCell | null;

/**
 * Deterministic paint-cell key. JSON-encoding the `[person, date]` pair is
 * collision-free for any id content (numeric vs string, embedded separators),
 * unlike a delimiter join.
 */
export function paintCellKey(person: PersonRef, date: DateRef): PaintCellKey {
  return JSON.stringify([person, date]);
}
