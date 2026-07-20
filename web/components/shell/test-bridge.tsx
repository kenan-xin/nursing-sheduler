"use client";

// E2E driving seam (T08). The acceptance rows for the dirty-nav guard (row 2),
// New-schedule reset (row 3), and undo/redo (row 4) all need the scenario store to
// be mutable from a browser test — but the editor screens that produce those
// mutations are owned by later tickets (T07/T14/T15) and don't exist yet. This
// component exposes the app's store singletons on `window.__nsStore` so the
// Playwright specs can drive a real tracked mutation (`mutateScenario`), read the
// Workspace-backup currentness (`backupStatus`), and inspect slice state,
// exercising the genuine T04 wiring rather than a mock. It renders nothing and is
// safe to leave mounted (references only — no secrets live in the store for this
// local tool).

import { useEffect } from "react";
import { selectBackupStatus, useHotStore, useScenarioStore, type BackupStatus } from "@/lib/store";
import { useNavGuardStore } from "./nav-guard-store";
import { getPersistenceStatus, type PersistenceStatus } from "./persistence-status";

declare global {
  interface Window {
    /**
     * Explicit opt-in for the store seam. The e2e harness sets this via
     * `page.addInitScript` before the page loads; nothing in the product sets it.
     */
    __NS_ENABLE_TEST_BRIDGE?: boolean;
    __nsStore?: {
      scenario: typeof useScenarioStore;
      hot: typeof useHotStore;
      backupStatus: () => BackupStatus;
      // Synchronous read of the shell's persistence status, so specs can wait
      // for a durable write to settle (`saved`) with a deterministic seam
      // instead of an arbitrary timeout before asserting the unload guard is
      // disarmed. A tracked write (incl. recordBackup's fingerprint write) flips
      // this to `saving` synchronously, arming the guard until the queue drains.
      persistenceStatus: () => PersistenceStatus;
      // The nav-guard store, so specs can drive the losable-draft nav/unload guard
      // (FR-PR-06) via `registerDraft` without mounting a real card editor.
      navGuard: typeof useNavGuardStore;
    };
  }
}

export function TestBridge() {
  useEffect(() => {
    // Prod-safety gate. Playwright runs against a PRODUCTION build, so we cannot
    // simply strip this on `NODE_ENV === "production"` — that would remove the
    // seam the e2e suite needs. Instead: always available in dev; in a production
    // build the store is exposed ONLY when a caller has explicitly opted in via
    // `window.__NS_ENABLE_TEST_BRIDGE` (the e2e harness, before load). A real
    // production deployment never sets that flag, so store internals are never
    // placed on `window` there.
    const enabled =
      process.env.NODE_ENV !== "production" || window.__NS_ENABLE_TEST_BRIDGE === true;
    if (!enabled) return;

    window.__nsStore = {
      scenario: useScenarioStore,
      hot: useHotStore,
      backupStatus: () => selectBackupStatus(useScenarioStore.getState()),
      persistenceStatus: () => getPersistenceStatus(),
      navGuard: useNavGuardStore,
    };
    return () => {
      delete window.__nsStore;
    };
  }, []);

  return null;
}
