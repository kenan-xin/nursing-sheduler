// The live scenario PROJECTION (T03).
//
// Before the cutover this store was the durable authority: `persist(temporal(...))`
// wrote behind every `set`, and components mutated it directly. It is now a plain
// read model. It holds exactly the committed scenario slice plus its backup
// fingerprint, it has NO mutating actions, and the only writer is the repository
// projection adapter (`authority.ts`), which publishes a snapshot only after the
// durable transaction that produced it has committed.
//
// That inversion is the point: a persistence failure can no longer leave the view
// showing a change that was never saved, because the view is written from the
// commit rather than ahead of it.
//
// The non-finite-number codec that used to live here moved to `persistence.ts`,
// beside the legacy record it now exists solely to decode.

import { create } from "zustand";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { computeScenarioFingerprint, pickScenario } from "./fingerprint";

/**
 * Backup currentness of the live scenario relative to the last recorded Workspace
 * backup. A display-only tri-state (No backup / Backup current / Backup out of
 * date); never blocks navigation or unload. See {@link selectBackupStatus}.
 */
export type BackupStatus = "none" | "current" | "stale";

/**
 * The projected state: the committed scenario slice and the persisted
 * Workspace-backup fingerprint. Deliberately actions-free — a component that
 * wants to change a scenario issues a repository command (`scenarioCommands`),
 * and there is no setter here for it to reach for instead.
 */
export interface ScenarioStoreState extends ScenarioUiState {
  /**
   * Fingerprint of the Workspace document at the last successful plain Download —
   * the emitted local backup. `null` means "no backup recorded" (unknown): a fresh
   * store, a loaded/replaced scenario, or a migrated legacy record. Only a real
   * plain Download sets it (DL12/T17r review P0); hydration/New/Load never do.
   */
  backupFingerprint: string | null;
}

/**
 * The READ face of the projection: the hook, plus the three non-mutating members of
 * the zustand api. This is what every consumer receives.
 *
 * It is a distinct interface rather than a `Pick<>` of zustand's `StoreApi` because
 * the guarantee is about what the value DOES NOT HAVE. A type that merely hides
 * `setState` is recoverable — `store["setState"]`, `const { setState } = store`, or
 * an alias with a wider annotation all reach it again, and every one of those was a
 * documented evasion of the source scan this replaces.
 */
export interface ScenarioProjection {
  (): ScenarioStoreState;
  <T>(selector: (state: ScenarioStoreState) => T): T;
  getState(): ScenarioStoreState;
  getInitialState(): ScenarioStoreState;
  subscribe(
    listener: (state: ScenarioStoreState, previous: ScenarioStoreState) => void,
  ): () => void;
}

/**
 * The WRITE face — one named command, not a general mutator.
 *
 * `replace` is the whole write vocabulary of the projection because the projection
 * only ever receives whole committed documents: the adapter publishes a snapshot
 * AFTER its durable transaction returned. There is deliberately no partial patch,
 * because a partial patch is how a component would express "change this one field
 * in the view", which is the operation the command bus exists to own.
 */
export interface ScenarioProjectionWriter {
  replace(next: ScenarioStoreState): void;
}

/**
 * A projection and its writer. Handed out ONLY by {@link createScenarioProjection},
 * so the writer for a given projection is unforgeable: a module that wants to write
 * the app's projection cannot construct this handle for it, and constructing its own
 * gets a different, unwired store.
 */
export interface ScenarioProjectionHandle {
  readonly read: ScenarioProjection;
  readonly write: ScenarioProjectionWriter;
}

/**
 * Create a scenario projection instance. A factory so tests can hold an isolated
 * projection; the app singleton lives in `spine.ts`, which keeps its writer in
 * module scope and never exports it.
 */
export function createScenarioProjection(): ScenarioProjectionHandle {
  const store = create<ScenarioStoreState>()(() => ({
    ...createEmptyScenarioUiState(),
    backupFingerprint: null,
  }));

  // A WRAPPER, not the api. Narrowing the exported type alone would leave the real
  // `setState` sitting on the value at runtime, one `Reflect.get` away; this copies
  // across exactly the three read members, so the mutator is absent rather than
  // merely unmentioned. `scenario-projection.test.ts` proves that at runtime and
  // `scenario-projection.negative.test-d.ts` proves it at compile time.
  const read = ((selector?: (state: ScenarioStoreState) => unknown) =>
    selector ? store(selector) : store()) as unknown as ScenarioProjection;
  read.getState = () => store.getState();
  read.getInitialState = () => store.getInitialState();
  read.subscribe = (listener) => store.subscribe(listener);
  Object.freeze(read);

  const write: ScenarioProjectionWriter = Object.freeze({
    replace(next: ScenarioStoreState): void {
      store.setState(next, true);
    },
  });

  return Object.freeze({ read, write });
}

/**
 * Backup currentness of the live scenario against the last recorded Workspace
 * backup — a nonblocking display state, never a guard input:
 *
 *   • `"none"`    — no backup recorded (`backupFingerprint === null`): a fresh,
 *                   loaded, replaced, or migrated-legacy workspace.
 *   • `"current"` — the live scenario matches the last downloaded backup.
 *   • `"stale"`   — the live scenario has diverged from the last downloaded backup.
 *
 * Computed from the canonical Workspace V1 fingerprint (see `fingerprint.ts`), so
 * disabled/incomplete records and export layout all count — a strict-projection
 * edit can never be misreported as a current backup.
 */
export function selectBackupStatus(state: ScenarioStoreState): BackupStatus {
  if (state.backupFingerprint === null) return "none";
  return computeScenarioFingerprint(pickScenario(state)) === state.backupFingerprint
    ? "current"
    : "stale";
}
