// Durable assistant DTOs (T04, tech-plan "Browser durable model").
//
// These are versioned APPLICATION shapes. Nothing here is a CopilotKit, AG-UI,
// Dexie or Zustand instance, so a library upgrade has exactly ONE adapter
// boundary (`./messages`) rather than a migration spread across the panel.
//
// WHY THESE LIVE HERE AND NOT IN `lib/repository/types.ts`. The repository's DTO
// module is the scenario authority's own contract, and T04/T08 run in parallel
// over it. The assistant tables are T04-owned, so their shapes live beside the
// assistant and `repository/schema.ts` imports them type-only -- the one file that
// declares the database's versions stays the single schema authority without the
// two tickets contending for one type module.

import type { GenerationScopeKey } from "@/lib/repository";

/** The assistant-settings table holds exactly one row, under this key. */
export const ASSISTANT_SETTINGS_KEY = "local" as const;

/** Where a stored model slug came from -- a curated catalog row or the escape hatch. */
export type AssistantModelSource = "catalog" | "custom";

/**
 * The browser-local assistant configuration.
 *
 * INVARIANT: `apiKey`/`modelId` are only ever written together, and only AFTER a
 * successful credential+tool probe. A draft configuration lives in component
 * state and never reaches this row, which is what makes readiness derivable from
 * the row alone (see {@link isAssistantReady}) instead of needing a stored probe
 * fingerprint to decide whether the persisted pair is still the probed pair. A
 * failed probe therefore leaves the previously stored configuration untouched.
 *
 * The key is NOT encrypted and must never be described as such: anyone with this
 * browser profile can read it and use the provider account.
 */
export interface AssistantSettingsV1 {
  key: typeof ASSISTANT_SETTINGS_KEY;
  schemaVersion: 1;
  /** The off-by-default master switch. Off hides every assistant surface. */
  enabled: boolean;
  /** The probe-passed OpenRouter credential, or `null` once removed. */
  apiKey: string | null;
  /** The probe-passed model slug, or `null`. */
  modelId: string | null;
  modelSource: AssistantModelSource | null;
  /** When the stored pair last passed a probe. Never a promise of availability. */
  probedAt: string | null;
  updatedAt: string;
}

/** The default row: AI off, no credential, nothing ready. */
export function emptyAssistantSettings(now: Date): AssistantSettingsV1 {
  return {
    key: ASSISTANT_SETTINGS_KEY,
    schemaVersion: 1,
    enabled: false,
    apiKey: null,
    modelId: null,
    modelSource: null,
    probedAt: null,
    updatedAt: now.toISOString(),
  };
}

/**
 * Readiness -- the ONE gate every assistant surface and every send checks.
 *
 * Deliberately a pure function of the stored row rather than a stored status
 * field: a status column can drift from the values it describes (a removed key
 * with a stale `"ready"` would mount the panel and offer a send), while a
 * derivation cannot.
 */
export function isAssistantReady(
  settings: AssistantSettingsV1 | null | undefined,
): settings is AssistantSettingsV1 & { apiKey: string; modelId: string } {
  return Boolean(settings?.enabled && settings.apiKey && settings.modelId);
}

/** What Settings may display about a stored credential. Never the credential. */
export function maskCredential(apiKey: string | null): string | null {
  if (!apiKey) return null;
  return `••••••••${apiKey.slice(-4)}`;
}

/**
 * A conversation bound to ONE scenario identity.
 *
 * `active` is the live thread for its scenario (at most one). `historical` is a
 * thread whose scenario was replaced or reloaded away: it renders read-only and
 * never regains live tool or action handlers. `cleared` is reserved for T05's
 * clear paths so a cleared thread stays distinguishable from a suspended one.
 */
export interface AssistantThreadV1 {
  threadId: string;
  schemaVersion: 1;
  scenarioId: string;
  state: "active" | "historical" | "cleared";
  /** Generation fences captured at creation; T05 checks them on every write. */
  globalGeneration: number;
  scenarioGeneration: number;
  createdAt: string;
  updatedAt: string;
}

/** Lifecycle of one provider turn. `detached` is a terminal LOCAL settlement. */
export type AssistantTurnState =
  | "preparing"
  | "streaming"
  | "stopping"
  | "settling"
  | "terminal"
  | "detached";

/**
 * One provider turn, persisted BEFORE the run starts.
 *
 * Everything the settlement and staleness rules need is captured at prepare time
 * -- the scenario identity and document revision the turn was prepared against,
 * the lease epoch that authorised it, the model actually used, and the
 * launch-scoped runtime instance the run belongs to. A reload that cannot
 * reattach reads `runtimeInstanceId`, marks the turn `detached`, and keeps only
 * the output already accepted locally; it never synthesises a terminal provider
 * result.
 */
export interface AssistantTurnV1 {
  turnId: string;
  schemaVersion: 1;
  threadId: string;
  scenarioId: string;
  basisDocumentRevision: number;
  leaseEpoch: number;
  modelId: string;
  runId: string;
  /** Monotonic per thread; a superseded epoch may not publish results. */
  turnEpoch: number;
  runtimeInstanceId: string | null;
  state: AssistantTurnState;
  terminalReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A model tool call, as canonical app data rather than a library object. */
export interface AssistantToolCallV1 {
  toolCallId: string;
  name: string;
  /** Raw JSON argument string, exactly as streamed. Never re-serialized. */
  args: string;
}

export type AssistantMessageRole = "user" | "assistant" | "tool" | "reasoning";

/**
 * A canonical conversation message. This -- not a CopilotKit instance -- is what
 * survives a reload, and `./messages` is the only place that knows how to turn it
 * into the transport's message type.
 */
export interface AssistantMessageV1 {
  messageId: string;
  schemaVersion: 1;
  threadId: string;
  scenarioId: string;
  /** Monotonic within the thread; the only ordering authority. */
  seq: number;
  role: AssistantMessageRole;
  content: string;
  toolCalls: AssistantToolCallV1[] | null;
  /** Set on `tool` results only. */
  toolCallId: string | null;
  /** The model that produced this message, recorded per provider turn. */
  modelId: string | null;
  turnId: string | null;
  createdAt: string;
}

/** The generation pair an interruptible assistant write captures. */
export interface AssistantGenerations {
  scopes: readonly { scopeKey: GenerationScopeKey; generation: number }[];
}
