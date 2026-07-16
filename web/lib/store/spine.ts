// The wired state spine (T04): a durable scenario store paired with a hot store,
// with the durable mutation gate wired to the hot store's hydration status. This
// pairing is what makes the ready gate real — durable edits are refused until the
// paired hot store reports `ready`, so an edit before manual rehydrate cannot
// clobber the not-yet-read saved record.

import { createHotStore, type HotStore } from "./hot-store";
import { createScenarioStore, type ScenarioStore } from "./scenario-store";
import type { StateStorage } from "zustand/middleware";

export interface StateSpine {
  scenario: ScenarioStore;
  hot: HotStore;
}

export interface StateSpineConfig {
  /** Lazy raw-`StateStorage` factory (omit for the browser Dexie default). */
  createStorage?: () => StateStorage;
}

/**
 * Create a durable + hot store pair with the durable mutation gate bound to the
 * hot store's `hydrationStatus`. Use for the app singletons and for isolated test
 * spines.
 */
export function createStateSpine(config: StateSpineConfig = {}): StateSpine {
  const hot = createHotStore();
  const scenario = createScenarioStore({
    createStorage: config.createStorage,
    isReady: () => hot.getState().hydrationStatus === "ready",
  });
  return { scenario, hot };
}

/** The app-wide state spine singleton. */
export const stateSpine = createStateSpine();

/** The app-wide durable scenario store (hook + vanilla api). */
export const useScenarioStore = stateSpine.scenario;

/** The app-wide hot ephemeral store (hook + vanilla api). */
export const useHotStore = stateSpine.hot;
