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
import {
  resolveTabId,
  resolveTabIdentity,
  ScenarioAuthority,
  useAuthorityStore,
  type OwnershipHint,
} from "./authority";
import { createHotStore, type HotStore } from "./hot-store";
import { createScenarioStore, type ScenarioStore } from "./scenario-store";

export interface StateSpine {
  scenario: ScenarioStore;
  hot: HotStore;
}

/** Create a projection + hot store pair (the app singletons, or a test spine). */
export function createStateSpine(): StateSpine {
  return { scenario: createScenarioStore(), hot: createHotStore() };
}

/** The app-wide state spine singleton. */
export const stateSpine = createStateSpine();

/** The app-wide scenario projection (hook + vanilla api). Read-only by contract. */
export const useScenarioStore = stateSpine.scenario;

/** The app-wide hot ephemeral store (hook + vanilla api). */
export const useHotStore = stateSpine.hot;

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
  controller ??= new ScenarioAuthority({
    db: new NurseSchedulerDb(),
    scenario: stateSpine.scenario,
    hot: stateSpine.hot,
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
