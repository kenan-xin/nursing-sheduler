// Durable-store lifecycle controller (T04, tech-plan §4; T17r review P0). Two
// distinct replacement disciplines, by whether the transition is a user-visible
// edit:
//
//   • Initialization (hydration / New / user-reset) is NOT an authoring action,
//     so it must stay OUT of undo history. It uses the paused-replace protocol:
//       pause zundo → rehydrate/migrate or replace state → clear temporal history
//       → resume. It never invents a backup baseline (only a real plain Download
//       does that — DL12/T17r review P0); the baseline stays whatever was
//       persisted, or `null` (unknown) for a fresh store.
//
//   • A confirmed Load IS a durable authoring action (DL12): it is one TRACKED
//     full-slice transaction, so Undo restores the complete prior workspace, Redo
//     restores the imported one, and older history is preserved. It resets the hot
//     store after the commit and sets the backup baseline to `null` (unknown) —
//     the imported file is not a fresh local backup.
//
// The paused protocol is wrapped so zundo always resumes and the status always
// settles (`ready` | `recoverable-error`) even if any step throws — a malformed
// restored payload can make fingerprinting throw, and that must not strand the
// store `hydrating` with tracking paused. Hydration is client-only (IndexedDB).

import {
  createEmptyScenarioUiState,
  type ImportNormalizationTarget,
  type ScenarioUiState,
  type UiRequestCell,
} from "@/lib/scenario";
import { pickScenario } from "./fingerprint";
import type { HotStore } from "./hot-store";
import { SCENARIO_PERSIST_KEY } from "./persistence";
import {
  consumeHydrationError,
  getScenarioStorage,
  isScenarioReady,
  type ScenarioStore,
} from "./scenario-store";

/**
 * Replace the durable scenario slice + backup fingerprint through the privileged
 * `store.setState` path (bypassing the mutation gate). Merge (not replace) so the
 * store's action functions are preserved.
 */
function replaceScenarioState(
  scenario: ScenarioStore,
  next: ScenarioUiState,
  backupFingerprint: string | null,
): void {
  scenario.setState({ ...pickScenario(next), backupFingerprint }, false);
}

/**
 * Run `apply` (which sets durable state) with zundo tracking paused, then clear
 * history — so the replacement never lands in undo/redo. `resume` runs in
 * `finally` so a throwing `apply` cannot leave tracking permanently paused.
 */
function withPausedReplace(scenario: ScenarioStore, apply: () => void): void {
  scenario.temporal.getState().pause();
  try {
    apply();
    scenario.temporal.getState().clear();
  } finally {
    scenario.temporal.getState().resume();
  }
}

/**
 * Give an imported card body durable store identity. A legacy import body has no
 * `uid`, so a fresh one is minted; a Workspace V1 body already carries its restored
 * `uid` (and `disabled` flag), which is preserved so Guided pins that reference it
 * still resolve.
 */
function hydrateCard<T extends { uid?: string }>(body: T): T & { uid: string } {
  return { ...body, uid: body.uid ?? crypto.randomUUID() };
}

/** Ensure a matrix cell carries a durable `uid` (a legacy import cell has none). */
function ensureCellUid(cell: UiRequestCell): UiRequestCell {
  return cell.uid ? cell : { ...cell, uid: crypto.randomUUID() };
}

/**
 * Hydrate an import target into durable UI state. Card and matrix-cell identity is
 * assigned where missing and preserved where restored; Workspace `guidedRulePins`
 * are carried through verbatim (a legacy import supplies `[]`). Every durable
 * card/cell ends up with a stable `uid`, so Workspace serialization never has to
 * fall back to a positional id.
 */
function hydrateImportTarget(target: ImportNormalizationTarget): ScenarioUiState {
  return {
    ...target,
    guidedRulePins: target.guidedRulePins,
    reqData: target.reqData.map(ensureCellUid),
    cardsByKind: {
      requirements: target.cardsByKind.requirements.map(hydrateCard),
      successions: target.cardsByKind.successions.map(hydrateCard),
      counts: target.cardsByKind.counts.map(hydrateCard),
      affinities: target.cardsByKind.affinities.map(hydrateCard),
      coverings: target.cardsByKind.coverings.map(hydrateCard),
    },
  };
}

/**
 * Client-only durable-store hydration. Marks `hydrating`, then runs the manual
 * protocol under one try/catch/finally: pause → rehydrate (persistence `migrate`
 * + sanitizing `merge` run inside) → on a corrupt/failed read OR any throw
 * (including a fingerprint throw on a malformed restored payload), settle to
 * `recoverable-error` without crashing; otherwise clear history, restore or
 * compute the baseline fingerprint (a persisted baseline survives the rehydrate; a
 * fresh store gets the clean current fingerprint), and settle `ready`. zundo is
 * always resumed in `finally`.
 */
export async function hydrateScenarioStore(scenario: ScenarioStore, hot: HotStore): Promise<void> {
  hot.getState().setHydrationStatus("hydrating");
  scenario.temporal.getState().pause();

  try {
    await scenario.persist.rehydrate();
    const error = consumeHydrationError(scenario);
    if (error !== null) throw error;

    scenario.temporal.getState().clear();
    // Hydration does NOT invent a backup baseline: a persisted baseline survives
    // the rehydrate, and a fresh store keeps `null` (unknown). Only a real plain
    // Download marks a backup fresh (DL12/T17r review P0).
    hot.getState().setHydrationStatus("ready");
  } catch {
    hot.getState().setHydrationStatus("recoverable-error");
  } finally {
    scenario.temporal.getState().resume();
  }
}

/**
 * Load a scenario from a keyless import target as ONE tracked full-slice
 * transaction (DL12/T17r review P0): assign card/cell identity, then replace the
 * durable scenario slice through the privileged `setState` WITHOUT pausing zundo,
 * so the replacement lands as a single undo entry — Undo restores the complete
 * prior workspace, Redo restores this import, and older history is preserved. The
 * backup baseline is set to `null` (unknown): an imported file is not a fresh
 * local backup. The hot store is reset AFTER the durable commit so scenario A's
 * transient state cannot leak into B.
 */
export function loadScenario(
  scenario: ScenarioStore,
  hot: HotStore,
  target: ImportNormalizationTarget,
): void {
  const hydrated = hydrateImportTarget(target);
  // Tracked (un-paused) full-slice set → exactly one zundo entry. Baseline is not
  // part of the temporal slice, so Undo/Redo never touch it.
  scenario.setState({ ...pickScenario(hydrated), backupFingerprint: null }, false);
  hot.getState().resetEphemeral();
  hot.getState().setHydrationStatus("ready");
}

/**
 * New scenario: reset every scenario slice to empty, clear history, and reset the
 * hot store. Uses the paused-replace protocol (initialization, not an authoring
 * edit) and does NOT invent a backup baseline — the empty workspace has no fresh
 * local backup, so the baseline is `null` (unknown) (DL12/T17r review P0).
 */
export function newScenario(scenario: ScenarioStore, hot: HotStore, apiVersion?: string): void {
  const empty = createEmptyScenarioUiState(apiVersion);
  withPausedReplace(scenario, () => replaceScenarioState(scenario, empty, null));
  hot.getState().resetEphemeral();
  hot.getState().setHydrationStatus("ready");
}

/**
 * User-reset recovery path (offered on `recoverable-error`): drop the corrupt
 * persisted record through the awaitable storage queue (so the remove is
 * serialized with any pending write and actually lands), then start a clean new
 * scenario without crashing.
 */
export async function resetToNewScenario(
  scenario: ScenarioStore,
  hot: HotStore,
  apiVersion?: string,
): Promise<void> {
  const storage = getScenarioStorage(scenario);
  if (storage) {
    await storage.removeItem(SCENARIO_PERSIST_KEY);
    await storage.drain();
  }
  newScenario(scenario, hot, apiVersion);
}

/**
 * Force `persist` to write the current durable state (a content-neutral set the
 * middleware still serializes; zundo skips it via the equality guard). No-op
 * unless the spine is `ready` — a pre-hydration or recoverable-error flush must
 * not serialize the empty/error store over a not-yet-read or deliberately
 * preserved saved record.
 */
export function flushScenarioPersist(scenario: ScenarioStore): void {
  if (!isScenarioReady(scenario)) return;
  scenario.setState({}, false);
}

/** Resolve once the durable store's pending writes/removes have settled. */
export async function drainScenarioPersist(scenario: ScenarioStore): Promise<void> {
  await getScenarioStorage(scenario)?.drain();
}

/**
 * Register a `pagehide` flush + drain of the durable store, returning an
 * unsubscribe. No-op (and returns a no-op cleanup) outside the browser.
 */
export function registerPagehideFlush(scenario: ScenarioStore): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => {
    flushScenarioPersist(scenario);
    void drainScenarioPersist(scenario);
  };
  window.addEventListener("pagehide", handler);
  return () => window.removeEventListener("pagehide", handler);
}
