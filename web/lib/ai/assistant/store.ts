"use client";

// The assistant's live UI state (T04).
//
// Small on purpose. Durable truth is Dexie: the settings row, the thread, the
// messages, the turns. This store holds only what a re-render needs and what has
// no meaning across a reload -- the hydrated settings projection, whether the panel
// is open, and the current turn's epoch.
//
// TURN EPOCH is the one non-obvious member. It is monotonic per page lifetime and
// is captured on every turn and every tool invocation, so anything that arrives
// after an interruption can be recognised as belonging to a superseded turn and
// discarded. It lives here rather than in Dexie because its whole job is to fence
// IN-FLIGHT work: a reload has no in-flight work to fence, and T01's runtime
// detaches such a turn anyway.

import { create } from "zustand";
import {
  activateProbedConfiguration,
  readAssistantSettings,
  removeAssistantKey,
  setAssistantEnabled,
} from "./settings-repo";
import { detachStaleTurns } from "./history-repo";
import {
  emptyAssistantSettings,
  isAssistantReady,
  type AssistantModelSource,
  type AssistantSettingsV1,
} from "./records";
import type { SendRefusal } from "./send-gate";

export interface AssistantUiState {
  /** False until the durable settings row has been read at least once. */
  hydrated: boolean;
  settings: AssistantSettingsV1;
  panelOpen: boolean;
  /** Monotonic per page lifetime; see the module note. */
  turnEpoch: number;
  activeTurnId: string | null;
  streaming: boolean;
  /** Set when a turn was settled locally without a terminal provider result. */
  detachedReason: string | null;
  /** The most recent refused send, so the panel can explain the refusal. */
  lastRefusal: SendRefusal | null;
}

const INITIAL: AssistantUiState = {
  hydrated: false,
  // A never-read store must look OFF, not "unknown": every surface gates on
  // readiness, and defaulting to anything else would flash the assistant into
  // existence for a user who has not enabled it.
  settings: emptyAssistantSettings(new Date(0)),
  panelOpen: false,
  turnEpoch: 0,
  activeTurnId: null,
  streaming: false,
  detachedReason: null,
  lastRefusal: null,
};

export const useAssistantStore = create<AssistantUiState>()(() => ({ ...INITIAL }));

/** Whether every gate for a live assistant surface is currently satisfied. */
export function selectReady(state: AssistantUiState): boolean {
  return state.hydrated && isAssistantReady(state.settings);
}

/**
 * Read the durable settings row into the projection, and settle any turn stranded
 * by a previous page lifetime.
 *
 * Called once at app bring-up. The stranded-turn sweep belongs here rather than in
 * the panel because a turn left at `streaming` must be settled even if the user
 * never opens the panel again -- otherwise the record claims live work that no
 * process is doing.
 */
export async function hydrateAssistant(): Promise<AssistantSettingsV1> {
  const settings = await readAssistantSettings();
  await detachStaleTurns("runtime_lost_on_reload");
  useAssistantStore.setState({ settings, hydrated: true });
  return settings;
}

export const assistantActions = {
  openPanel(): void {
    useAssistantStore.setState({ panelOpen: true, lastRefusal: null });
  },

  closePanel(): void {
    useAssistantStore.setState({ panelOpen: false });
  },

  togglePanel(): void {
    const open = useAssistantStore.getState().panelOpen;
    useAssistantStore.setState({ panelOpen: !open, lastRefusal: null });
  },

  async setEnabled(enabled: boolean): Promise<void> {
    const settings = await setAssistantEnabled(enabled);
    // Disabling closes the panel in the same update: the discoverability rule is
    // that no assistant surface exists while AI is off, and leaving an open panel
    // mounted would keep the credential headers on a mounted provider.
    useAssistantStore.setState({
      settings,
      ...(enabled ? {} : { panelOpen: false, lastRefusal: null }),
    });
  },

  /** Promote a probe-passed draft. Only ever called from a successful probe. */
  async activate(draft: {
    apiKey: string;
    modelId: string;
    modelSource: AssistantModelSource;
  }): Promise<void> {
    const settings = await activateProbedConfiguration(draft);
    useAssistantStore.setState({ settings });
  },

  async removeKey(): Promise<void> {
    const settings = await removeAssistantKey();
    useAssistantStore.setState({ settings, panelOpen: false });
  },

  /** Claim the next turn epoch. Callers must use the returned value, not read it. */
  nextTurnEpoch(): number {
    const turnEpoch = useAssistantStore.getState().turnEpoch + 1;
    useAssistantStore.setState({ turnEpoch });
    return turnEpoch;
  },

  beginTurn(turnId: string): void {
    useAssistantStore.setState({
      activeTurnId: turnId,
      streaming: true,
      detachedReason: null,
      lastRefusal: null,
    });
  },

  endTurn(detachedReason: string | null = null): void {
    useAssistantStore.setState({ activeTurnId: null, streaming: false, detachedReason });
  },

  refuse(reason: SendRefusal): void {
    useAssistantStore.setState({ lastRefusal: reason });
  },

  /** Test seam: return the store to its never-hydrated state. */
  resetForTest(): void {
    useAssistantStore.setState({ ...INITIAL });
  },
} as const;
