"use client";

// E2E driving seam (T08). The acceptance rows for the dirty-nav guard (row 2),
// New-schedule reset (row 3), and undo/redo (row 4) all need the scenario store to
// be mutable from a browser test — but the editor screens that produce those
// mutations are owned by later tickets (T07/T14/T15) and don't exist yet. This
// component exposes the app's store singletons on `window.__nsStore` so the
// Playwright specs can drive a real repository command (`commands.mutate`), read
// the Workspace-backup currentness (`backupStatus`), inspect the committed
// projection, and observe writer ownership — exercising the genuine wiring rather
// than a mock. It renders nothing and is safe to leave mounted (references only —
// no secrets live in the store for this local tool).
//
// T03 note: the bridge exposes COMMANDS, not setters, for the same reason the app
// does. A spec that could poke the projection directly would be able to assert a
// state the repository never committed.
//
// T03F1 — COMPILED OUT OF ORDINARY PRODUCTION. The bridge used to ship in every
// production bundle behind a runtime `window` flag, which made "is the seam
// available?" a property of whoever ran first on the page rather than of the build.
// It is now gated on a BUILD-TIME constant: `NEXT_PUBLIC_NS_TEST_BRIDGE` is set only
// by the e2e harness's webServer, so an ordinary `pnpm build` inlines `false`, the
// branch is dead, and the store references are tree-shaken away — there is nothing
// on `window` to find and no flag that can resurrect it. The runtime opt-in is kept
// INSIDE that gate so an e2e build still requires the harness's explicit
// `addInitScript`, i.e. both conditions must hold.

import { useEffect } from "react";
import {
  computeScenarioFingerprint,
  drainScenarioCommands,
  pickScenario,
  readScenarioHistoryDepth,
  scenarioCommands,
  selectBackupStatus,
  useAuthorityStore,
  useHotStore,
  useScenarioStore,
  type AuthorityState,
  type BackupStatus,
  type HotStoreState,
  type ScenarioStoreState,
} from "@/lib/store";
import { useNavGuardStore } from "./nav-guard-store";
import { getPersistenceStatus, type PersistenceStatus } from "./persistence-status";

declare global {
  interface Window {
    /**
     * Explicit opt-in for the store seam. The e2e harness sets this via
     * `page.addInitScript` before the page loads; nothing in the product sets it.
     *
     * It is only consulted in a build where the bridge was COMPILED IN at all — see
     * the module note above.
     */
    __NS_ENABLE_TEST_BRIDGE?: boolean;
    __nsStore?: {
      /**
       * A read-only SNAPSHOT of committed scenario content.
       *
       * Previously this was the Zustand store api itself, which carries `.setState`.
       * Calling it "read-only" did not make it so: any same-origin script that set
       * the opt-in flag could publish arbitrary scenario state with no repository
       * commit behind it — precisely the bypass the whole cutover removes. A
       * function returning a snapshot has no writer to reach.
       */
      scenario: () => Readonly<ScenarioStoreState>;
      hot: () => Readonly<HotStoreState>;
      /**
       * The repository command bus — the only way to change durable scenario
       * state, in a spec exactly as in the product. A spec awaits the returned
       * promise, which resolves after the durable commit, so an assertion never
       * has to guess when a write landed.
       */
      commands: typeof scenarioCommands;
      /** Resolve once every queued command has settled. */
      drain: () => Promise<void>;
      /**
       * Durable Undo depth. A spec asserting "this action added exactly one Undo
       * step" needs a count, which the boolean availability flags cannot give it.
       */
      historyDepth: () => Promise<number>;
      /** Session authority snapshot: identity, revision, ownership, Undo availability. */
      authority: () => Readonly<AuthorityState>;
      backupStatus: () => BackupStatus;
      /**
       * The fingerprint of the CURRENT committed document — what a plain Download of
       * this state would record as its backup. A read, so a spec can simulate the
       * Download's `recordBackup(fingerprint)` without a file dialog. Recording is
       * still a command; this only computes the value the command needs.
       */
      backupFingerprint: () => string;
      // Synchronous read of the shell's persistence status, so specs can wait
      // for a durable write to settle (`saved`) with a deterministic seam
      // instead of an arbitrary timeout before asserting the unload guard is
      // disarmed. A tracked write (incl. recordBackup's fingerprint write) flips
      // this to `saving` synchronously, arming the guard until the queue drains.
      persistenceStatus: () => PersistenceStatus;
      // The nav-guard store, so specs can drive the losable-draft nav/unload guard
      // (FR-PR-06) via `registerDraft` without mounting a real card editor. This one
      // IS an action surface, deliberately: registering a draft is UI state with no
      // durable authority behind it, and there is no repository command for it to
      // bypass.
      navGuard: typeof useNavGuardStore;
    };
  }
}

/**
 * Whether this BUILD contains the bridge at all.
 *
 * A literal comparison against an inlined `process.env` value, so a production build
 * compiles the whole effect below to dead code. Dev keeps it for convenience.
 */
const BRIDGE_COMPILED_IN =
  process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_NS_TEST_BRIDGE === "1";

export function TestBridge() {
  useEffect(() => {
    if (!BRIDGE_COMPILED_IN) return;
    // Present in this build, but still opt-in per page: the e2e harness sets the flag
    // in `addInitScript` before any application script runs. Dev needs no flag.
    const enabled =
      process.env.NODE_ENV !== "production" || window.__NS_ENABLE_TEST_BRIDGE === true;
    if (!enabled) return;

    window.__nsStore = {
      // Snapshot FUNCTIONS, not store handles: nothing here carries `.setState`, so
      // the seam cannot publish scenario state the repository never committed.
      scenario: () => useScenarioStore.getState(),
      hot: () => useHotStore.getState(),
      commands: scenarioCommands,
      drain: drainScenarioCommands,
      historyDepth: readScenarioHistoryDepth,
      authority: () => useAuthorityStore.getState(),
      backupStatus: () => selectBackupStatus(useScenarioStore.getState()),
      backupFingerprint: () =>
        computeScenarioFingerprint(pickScenario(useScenarioStore.getState())),
      persistenceStatus: () => getPersistenceStatus(),
      navGuard: useNavGuardStore,
    };
    return () => {
      delete window.__nsStore;
    };
  }, []);

  return null;
}
