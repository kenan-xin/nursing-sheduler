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

/** Zustand store api for the scenario projection. */
export type ScenarioStore = ReturnType<typeof createScenarioStore>;

/**
 * Create a scenario projection instance. A factory so tests can hold an isolated
 * projection; the app uses the {@link createStateSpine} singletons.
 */
export function createScenarioStore() {
  return create<ScenarioStoreState>()(() => ({
    ...createEmptyScenarioUiState(),
    backupFingerprint: null,
  }));
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
