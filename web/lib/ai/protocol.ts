// The browser-safe half of the AI wire protocol (T04).
//
// WHY THIS IS NOT JUST AN IMPORT OF `runtime/containment.ts`. That module is
// deliberately a SERVER module with an import-time side effect: it writes the
// telemetry opt-out into `process.env` before `@copilotkit/runtime` is evaluated.
// The browser provider needs the same header NAMES, and pulling containment into a
// client bundle to get them would ship a `process.env` mutation into the browser
// for no benefit.
//
// So the constants are restated here, dependency-free -- and `protocol.test.ts`
// asserts they are IDENTICAL to the runtime's own, so the two cannot drift. A
// mismatch is a failing test, not a silently unauthenticated request.

/** Same-origin mount of the CopilotKit v2 runtime. */
export const COPILOT_RUNTIME_URL = "/api/copilotkit";

/** The single Phase-1 agent id. */
export const AI_AGENT_ID = "scheduler";

/** Transient BYO OpenRouter credential header. Request-scoped, never persisted. */
export const AI_KEY_HEADER = "x-nurse-ai-key";

/** Selected OpenRouter model slug for this request. */
export const AI_MODEL_HEADER = "x-nurse-ai-model";

/** Launch-scoped runtime instance id, echoed back on connect/stop. */
export const AI_RUNTIME_INSTANCE_HEADER = "x-nurse-ai-runtime-instance";

/** OpenRouter's OpenAI-compatible base URL. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Same-origin setup routes, deliberately separate from the chat runtime. */
export const AI_MODEL_CATALOG_URL = "/api/ai/openrouter/models";
export const AI_PROBE_URL = "/api/ai/openrouter/test";

/**
 * Stable app error codes. These strings are the ONLY failure detail that crosses
 * a response boundary: an upstream body could carry prompt fragments, account
 * detail, or the credential itself, so it is classified here and discarded.
 */
export const AI_SETUP_CODES = {
  /** The request reached this app without both a key and a model. */
  credentialsRequired: "ai_credentials_required",
  /** OpenRouter did not accept the key. */
  credentialsRejected: "ai_credentials_rejected",
  /** The account's spend or rate limit declined the request. */
  providerDeclined: "ai_provider_declined",
  /** The slug is unknown to OpenRouter, or unavailable to this account. */
  modelUnavailable: "ai_model_unavailable",
  /** The model answered, but cannot honour the tool contract. */
  modelLacksTools: "ai_model_lacks_tools",
  /** OpenRouter or the network could not be reached. */
  providerUnreachable: "ai_provider_unreachable",
  /** Anything else. Deliberately opaque rather than a forwarded body. */
  probeFailed: "ai_probe_failed",
} as const;

export type AiSetupCode = (typeof AI_SETUP_CODES)[keyof typeof AI_SETUP_CODES];
