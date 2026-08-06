// Durable assistant settings (T04).
//
// THE INVARIANT THIS FILE EXISTS TO HOLD: the stored row only ever contains a
// configuration that PASSED a probe. There is no "draft" state on disk. A draft
// lives in the Settings card's own component state; `activateProbedConfiguration`
// is the single write that promotes it, and it is called only from a successful
// probe result. That is why `isAssistantReady` can be a pure derivation over the
// row (see `records.ts`) instead of a stored status that could disagree with the
// values beside it.
//
// Consequences that fall out of the invariant rather than needing their own rules:
//   * a FAILED probe writes nothing, so the previously working configuration keeps
//     working;
//   * REPLACE is the same write as first-time save, so a replacement that fails
//     its probe cannot half-apply;
//   * REMOVE KEY clears the credential immediately and independently of stopping
//     any work -- the runtime's info/connect/stop routes are keyless by design
//     (T01), so the credential can be gone before settlement completes.

import type { NurseSchedulerDb } from "@/lib/repository";
import { getAssistantDb } from "./db";
import {
  ASSISTANT_SETTINGS_KEY,
  emptyAssistantSettings,
  type AssistantModelSource,
  type AssistantSettingsV1,
} from "./records";

export interface SettingsRepoConfig {
  db?: NurseSchedulerDb;
  now?: () => Date;
}

function resolve(config: SettingsRepoConfig = {}) {
  return { db: config.db ?? getAssistantDb(), now: config.now ?? (() => new Date()) };
}

/** Read the row, or the off-by-default shape when none has been written yet. */
export async function readAssistantSettings(
  config: SettingsRepoConfig = {},
): Promise<AssistantSettingsV1> {
  const { db, now } = resolve(config);
  const stored = await db.assistantSettings.get(ASSISTANT_SETTINGS_KEY);
  return stored ?? emptyAssistantSettings(now());
}

async function update(
  config: SettingsRepoConfig,
  change: (current: AssistantSettingsV1, at: Date) => AssistantSettingsV1,
): Promise<AssistantSettingsV1> {
  const { db, now } = resolve(config);
  // One transaction over the single row: a concurrent "remove key" and "disable"
  // from two surfaces cannot interleave into a row that has neither change.
  return db.transaction("rw", "assistantSettings", async () => {
    const at = now();
    const current = (await db.assistantSettings.get(ASSISTANT_SETTINGS_KEY)) ?? {
      ...emptyAssistantSettings(at),
    };
    const next = { ...change(current, at), updatedAt: at.toISOString() };
    await db.assistantSettings.put(next);
    return next;
  });
}

/**
 * Flip the master switch. Enabling does NOT make the assistant ready: without a
 * probe-passed credential and model the panel stays hidden and every send is
 * refused, which is exactly the Configuring state the enablement flow describes.
 */
export function setAssistantEnabled(
  enabled: boolean,
  config: SettingsRepoConfig = {},
): Promise<AssistantSettingsV1> {
  return update(config, (current) => ({ ...current, enabled }));
}

/**
 * Promote a probe-passed draft to the active configuration. The ONLY writer of
 * `apiKey`/`modelId`, and they are always written together -- a row with a key
 * from one probe and a model from another is unrepresentable.
 */
export function activateProbedConfiguration(
  draft: { apiKey: string; modelId: string; modelSource: AssistantModelSource },
  config: SettingsRepoConfig = {},
): Promise<AssistantSettingsV1> {
  return update(config, (current, at) => ({
    ...current,
    apiKey: draft.apiKey,
    modelId: draft.modelId,
    modelSource: draft.modelSource,
    probedAt: at.toISOString(),
  }));
}

/**
 * Delete the credential immediately.
 *
 * The model selection is retained deliberately: the flow's Remove-key state keeps
 * preferences and history and only makes the assistant unavailable, so re-entering
 * a key returns the user to the model they had chosen rather than an empty field.
 * `probedAt` is cleared with the key, because what was probed no longer exists.
 */
export function removeAssistantKey(config: SettingsRepoConfig = {}): Promise<AssistantSettingsV1> {
  return update(config, (current) => ({ ...current, apiKey: null, probedAt: null }));
}
