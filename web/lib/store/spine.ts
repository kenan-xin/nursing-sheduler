// The wired state spine (T03). Three pieces, and the wiring between them is the
// whole cutover:
//
//   • the scenario PROJECTION — committed content, written only by the adapter;
//   • the HOT store — ephemeral run/UI/paint state, never durable;
//   • the AUTHORITY controller — the repository-backed command bus, the writer
//     lease, and the session-authority projection.
//
// Before T03 this module paired two stores and bound a "ready gate" so an edit
// could not clobber a not-yet-read persisted record. That gate existed because
// `persist` wrote behind every `set`. There is no write-behind any more: a command
// that arrives before authority is initialized simply has no lease to present and
// is refused by the repository, which is a stronger guarantee than a local
// boolean and cannot be bypassed by a component holding a setter.
//
// The controller is created LAZILY. Constructing it opens IndexedDB, which does
// not exist during SSR — and the app renders the shell on the server.

import { NurseSchedulerDb } from "@/lib/repository";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import {
  resolveTabId,
  resolveTabIdentity,
  ScenarioAuthority,
  useAuthorityStore,
  type OwnershipHint,
  type ScenarioAuthorityConfig,
} from "./authority";
import { createHotStore, type HotStore } from "./hot-store";
import {
  createScenarioProjection,
  type ScenarioProjection,
  type ScenarioProjectionHandle,
  type ScenarioProjectionWriter,
  type ScenarioStoreState,
} from "./scenario-store";

export interface StateSpine {
  scenario: ScenarioProjection;
  hot: HotStore;
}

// THE APP PROJECTION AND ITS WRITER. The handle is a module-local `const` and is
// never exported, in any shape, so the write capability for the projection every
// component reads is unforgeable outside this file: `createScenarioProjection()`
// hands a caller a different, unwired store. What leaves this module is the read
// face, plus the two NAMED commands below — not a mutator anyone can alias.
const appScenario = createScenarioProjection();
const appHot = createHotStore();

let publishFault: Error | null = null;

// The handle the authority actually receives. Identical to `appScenario` except for
// the fault gate, which exists because "the durable commit landed and the view never
// showed it" is a real, tested branch (`reloadRequired`) that cannot otherwise be
// reached without a real IndexedDB failure.
const appHandle: ScenarioProjectionHandle = Object.freeze({
  read: appScenario.read,
  write: Object.freeze({
    replace(next: ScenarioStoreState): void {
      if (publishFault) throw publishFault;
      appScenario.write.replace(next);
    },
  }) satisfies ScenarioProjectionWriter,
});

/** The app-wide state spine singleton. */
export const stateSpine: StateSpine = Object.freeze({
  scenario: appScenario.read,
  hot: appHot,
});

/** The app-wide scenario projection (hook + vanilla api). Read-only by construction. */
export const useScenarioStore = appScenario.read;

/** The app-wide hot ephemeral store (hook + vanilla api). */
export const useHotStore = appHot;

/**
 * Build an authority bound to the APP projection.
 *
 * This is the seam that lets the writer stay private: `ScenarioAuthority` is the one
 * legitimate writer of scenario content, and it receives the handle here rather than
 * from its caller. The test harness comes through the same door, so nothing needs a
 * back channel that ordinary code could also walk through.
 */
export function createAppScenarioAuthority(
  config: Omit<ScenarioAuthorityConfig, "scenario" | "hot">,
): ScenarioAuthority {
  return new ScenarioAuthority({ ...config, scenario: appHandle, hot: appHot });
}

/**
 * Make every publish into the app projection throw until the returned restore runs.
 *
 * Test-only fault injection for the "committed durably, never shown" path. Note what
 * it is NOT: it grants no ability to write the projection, only to make a write fail,
 * so it is not a way back to the mutator this module exists to withhold.
 */
export function failScenarioPublish(error: Error): () => void {
  publishFault = error;
  return () => {
    publishFault = null;
  };
}

/**
 * Empty the app projection. A named command with a fixed effect — the only write the
 * test harness needs, and not a general setter it could aim anywhere else.
 */
export function resetScenarioProjection(): void {
  appScenario.write.replace({ ...createEmptyScenarioUiState(), backupFingerprint: null });
}

// ---------------------------------------------------------------------------
// Authority singleton
// ---------------------------------------------------------------------------

let controller: ScenarioAuthority | null = null;
let broadcastSink: (hint: OwnershipHint) => void = () => {};

/**
 * Install the cross-tab hint sink. Hints are advisory notifications only — the
 * persisted lease is the authority — so the sink is optional and its absence
 * changes correctness not at all, only how quickly a peer notices.
 */
export function setOwnershipBroadcast(sink: (hint: OwnershipHint) => void): void {
  broadcastSink = sink;
}

/** The app-wide authority controller, constructed on first use (client-only). */
export function getScenarioAuthority(): ScenarioAuthority {
  controller ??= createAppScenarioAuthority({
    db: new NurseSchedulerDb(),
    authority: useAuthorityStore,
    // The synchronous stored id is PROVISIONAL. `initialize()` settles it through the
    // collision probe below before presenting it to the repository — a duplicated tab
    // starts with a copy of its opener's id, and two controllers under one id would
    // renew each other's lease in place instead of contending for it.
    tabId: resolveTabId(),
    resolveTabIdentity,
    broadcast: (hint) => broadcastSink(hint),
  });
  return controller;
}

/**
 * Replace the singleton controller. Tests use this to bind the app stores to an
 * isolated database and a controlled clock; passing `null` drops the instance so
 * the next call reconstructs it.
 */
export function setScenarioAuthority(next: ScenarioAuthority | null): void {
  controller = next;
}
