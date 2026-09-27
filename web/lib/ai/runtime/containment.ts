// T01 — CopilotKit runtime containment constants and process-level containment env.
//
// LOAD-BEARING IMPORT ORDER: `@copilotkit/runtime`'s telemetry client is a module
// singleton that snapshots `COPILOTKIT_TELEMETRY_DISABLED` at module-evaluation
// time (node_modules/@copilotkit/runtime/dist/v2/runtime/telemetry/telemetry-client.mjs).
// So the containment env has to be in place BEFORE that module is first evaluated.
// This module imports nothing and applies the env as an import-time side effect.
//
// Exactly ONE module depends on that ordering: `copilotkit-runtime.ts`, the single
// production entry to the runtime package, which imports this module before it
// re-exports anything. The old arrangement — every runtime module importing this one
// first, with a source scan checking the order — is gone; there is nothing left to
// order. The `/info` route reports `telemetryDisabled` back so the wiring is proven,
// and `instrumentation.ts` applies the same env at server start so a future import
// path that skips this module still boots contained.

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
/** t0c9: a message carried a part other than text (the server would download its URL). */
export const AI_ERROR_MESSAGE_PART_REJECTED = "ai_message_part_rejected";
/** t0c9: a run request over `MAX_RUN_REQUEST_BYTES`; refused before it is buffered. */
export const AI_ERROR_REQUEST_TOO_LARGE = "ai_request_too_large";

/**
 * t0c9: the run request ceiling. Measured 2026-09-27 on main: a 12-person month ward's
 * whole run body is ~0.1-0.3 MiB even at 40 turns; a synthetic 60-person, 31-day ward
 * with a request on every cell, 40 turns and 10 full request-grid tool reads is 2.4 MiB
 * (~700K tokens, past most models' context). 4 MiB is roughly the largest body any
 * common model could accept at all.
 */
export const MAX_RUN_REQUEST_BYTES = 4 * 1024 * 1024;
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
