// T01 — CopilotKit runtime containment constants and process-level containment env.
//
// LOAD-BEARING IMPORT ORDER: `@copilotkit/runtime`'s telemetry client is a module
// singleton that snapshots `COPILOTKIT_TELEMETRY_DISABLED` at module-evaluation
// time (node_modules/@copilotkit/runtime/dist/v2/runtime/telemetry/telemetry-client.mjs).
// So the containment env has to be in place BEFORE that module is first evaluated.
// This module imports nothing, applies the env as an import-time side effect, and
// every module in this directory that touches `@copilotkit/runtime` imports it
// FIRST. `containment.test.ts` pins that ordering at the source level, and the
// `/info` route reports `telemetryDisabled` back so the wiring is proven, not
// assumed. `instrumentation.ts` applies the same env at server start so a future
// import path that skips this module still boots contained.

/** Same-origin catch-all mount for the CopilotKit v2 multi-route runtime. */
export const COPILOT_RUNTIME_BASE_PATH = "/api/copilotkit";

/** The single Phase-1 agent id. Multi-agent routing is out of scope. */
export const COPILOT_AGENT_ID = "scheduler";

/**
 * Transient BYO OpenRouter credential header. Consumed by application code in the
 * request-scoped agent factory and NEVER forwarded onto the agent (see
 * `forwardHeaders.deny` in `handler.ts`), so it cannot reach messages, tools,
 * forwarded properties, or model-visible state.
 */
export const AI_KEY_HEADER = "x-nurse-ai-key";

/** Selected OpenRouter model slug for this request. */
export const AI_MODEL_HEADER = "x-nurse-ai-model";

/**
 * Launch-scoped runtime instance id. The runtime stamps it on every response; the
 * browser records it on the turn and echoes it on connect/stop so a restarted or
 * mismatched instance detaches instead of replaying.
 */
export const RUNTIME_INSTANCE_HEADER = "x-nurse-ai-runtime-instance";

/** OpenRouter's OpenAI-compatible Chat Completions base URL. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Stable app error codes. These are the ONLY strings that reach a client body. */
export const AI_ERROR_CREDENTIALS_REQUIRED = "ai_credentials_required";
export const AI_DETACH_REASON_INSTANCE_MISMATCH = "runtime_instance_mismatch";

/**
 * Env applied before `@copilotkit/runtime` loads.
 *
 * - `COPILOTKIT_TELEMETRY_DISABLED` / `DO_NOT_TRACK` — the documented, complete
 *   opt-out for CopilotKit runtime + Inspector telemetry.
 * - `SCARF_ANALYTICS` — `@scarf/scarf` arrives transitively; its install script is
 *   already refused by `.npmrc` `allowBuilds`, and this closes the runtime path.
 */
export const CONTAINMENT_ENV: Readonly<Record<string, string>> = Object.freeze({
  COPILOTKIT_TELEMETRY_DISABLED: "true",
  DO_NOT_TRACK: "1",
  SCARF_ANALYTICS: "false",
});

/**
 * Force the containment env. Deliberately unconditional: an operator cannot
 * re-enable CopilotKit telemetry for this deployment by setting the env to
 * "false", because Phase-1 containment is a correctness contract, not a
 * preference. Idempotent, so calling it from both this module and
 * `instrumentation.ts` is safe.
 */
export function applyRuntimeContainmentEnv(): void {
  for (const [name, value] of Object.entries(CONTAINMENT_ENV)) {
    process.env[name] = value;
  }
}

applyRuntimeContainmentEnv();
