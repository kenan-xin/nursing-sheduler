// Durable-store lifecycle controller (T04, tech-plan §4). Owns every transition
// that must keep rehydration/replacement OUT of undo history, via one shared
// paused-replace protocol:
//
//   pause zundo → rehydrate/migrate or replace state → clear temporal history →
//   restore/compute the baseline fingerprint → resume.
//
// The whole protocol is wrapped so zundo always resumes and the status always
// settles (`ready` | `recoverable-error`) even if any step throws — a malformed
// restored payload can make fingerprinting throw, and that must not strand the
// store `hydrating` with tracking paused. Hydration is client-only (IndexedDB);
// Load / New / user-reset replace state and clear history the same way, and also
// reset the hot store so scenario A's transient state can't leak into B.

import {
  createEmptyScenarioUiState,
  type ImportNormalizationTarget,
  type ScenarioUiState,
} from "@/lib/scenario";
import { computeScenarioFingerprint, pickScenario } from "./fingerprint";
import type { HotStore } from "./hot-store";
import { SCENARIO_PERSIST_KEY } from "./persistence";
import {
  consumeHydrationError,
  getScenarioStorage,
  isScenarioReady,
  type ScenarioStore,
} from "./scenario-store";

/**
 * Replace the durable scenario slice + baseline through the privileged
 * `store.setState` path (bypassing the mutation gate). Merge (not replace) so the
 * store's action functions are preserved.
 */
function replaceScenarioState(
  scenario: ScenarioStore,
  next: ScenarioUiState,
  baselineFingerprint: string | null,
): void {
  scenario.setState({ ...pickScenario(next), baselineFingerprint }, false);
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

/** Assign store identity (a `uid`) to a keyless imported card body. */
function assignUid<T extends object>(body: T): T & { uid: string } {
  return { ...body, uid: crypto.randomUUID() };
}

/**
 * Hydrate a keyless import target (T05 output) into durable UI state by assigning
 * card identity. Entity/request/export `uid`s are already optional, so only cards
 * need hydrating. `guidedRulePins` has no import-boundary counterpart yet (T17
 * owns the Workspace `guidedRules` contract), so every Load starts pin-free.
 */
function hydrateImportTarget(target: ImportNormalizationTarget): ScenarioUiState {
  return {
    ...target,
    guidedRulePins: [],
    cardsByKind: {
      requirements: target.cardsByKind.requirements.map(assignUid),
      successions: target.cardsByKind.successions.map(assignUid),
      counts: target.cardsByKind.counts.map(assignUid),
      affinities: target.cardsByKind.affinities.map(assignUid),
      coverings: target.cardsByKind.coverings.map(assignUid),
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
    const state = scenario.getState();
    if (state.baselineFingerprint === null) {
      scenario.setState(
        { baselineFingerprint: computeScenarioFingerprint(pickScenario(state)) },
        false,
      );
    }
    hot.getState().setHydrationStatus("ready");
  } catch {
    hot.getState().setHydrationStatus("recoverable-error");
  } finally {
    scenario.temporal.getState().resume();
  }
}

/**
 * Load a scenario from a keyless import target: assign card identity, replace
 * durable state, clear history, set the fresh baseline (loaded state is clean),
 * and reset the hot store. Same paused-replace protocol as hydration.
 */
export function loadScenario(
  scenario: ScenarioStore,
  hot: HotStore,
  target: ImportNormalizationTarget,
): void {
  const hydrated = hydrateImportTarget(target);
  const baseline = computeScenarioFingerprint(hydrated);
  withPausedReplace(scenario, () => replaceScenarioState(scenario, hydrated, baseline));
  hot.getState().resetEphemeral();
  hot.getState().setHydrationStatus("ready");
}

/**
 * New scenario: reset every scenario slice to empty, clear history, set the empty
 * baseline (a fresh scenario is clean), and reset the hot store. Same protocol.
 */
export function newScenario(scenario: ScenarioStore, hot: HotStore, apiVersion?: string): void {
  const empty = createEmptyScenarioUiState(apiVersion);
  const baseline = computeScenarioFingerprint(empty);
  withPausedReplace(scenario, () => replaceScenarioState(scenario, empty, baseline));
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
