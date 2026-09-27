// OpenRouter request routing for the default assistant model (bead 46g).
//
// THE SHIPPED DEFAULT IS A ROUTING DECISION, NOT JUST A SLUG. DeepSeek V4.1 Flash is
// fast on its own, but OpenRouter's default load balancing picks providers weighted
// by inverse price, which for DeepSeek often means an 11-30 tok/s endpoint. The 46g
// eval measured the difference: throughput routing halved the default's first-token
// and turn times (TTFT p50 1.6 s against 3.0 s) for about $0.002 more per turn.
//
// RULING (2026-09-27, docs checked against openrouter.ai/docs). `provider:
// { sort: "throughput" }` is NOT the equivalent of `:nitro`. The provider-selection
// docs call `:nitro` a SUPERSET of that sort -- it also makes priority service-tier
// endpoints eligible -- and `:nitro` is a ROUTING VARIANT: a suffix accepted on any
// model ID at request time, deliberately absent from `GET /api/v1/models`. So the
// variant is used rather than the sort object, and it is applied HERE, at the
// request, which is what lets the catalog and `RECOMMENDED_MODEL_ID` stay real slugs.
//
// APPLIED TO THE DEFAULT MODEL ONLY. Every other model is one the user chose in
// Settings; silently re-routing their choice, or giving it a fallback they did not
// ask for, would be a behaviour change nobody consented to. The docs present `:nitro`
// as a per-request opt-in, not a global default.

import { RECOMMENDED_MODEL_ID } from "./catalog";

/** OpenRouter's throughput routing variant (a superset of `provider.sort`). */
export const NITRO_VARIANT = ":nitro";

/**
 * The model tried when the default fails. OpenRouter's `models` array is its own
 * fallback mechanism: the primary `model` is tried first and each `models` entry in
 * turn when a provider is down, rate-limited, or refuses. Sonnet 4.5 is from a
 * different vendor and has the steadiest latency of the models the 46g eval ran.
 */
export const FALLBACK_MODEL_ID = "anthropic/claude-sonnet-4.5";

export interface ModelRouting {
  /** The request's `model` field: the configured slug, plus the variant for the default. */
  model: string;
  /** The request's `models` fallback list, in priority order. Empty for a user's own choice. */
  fallbacks: readonly string[];
}

/**
 * The OpenRouter request routing for one configured model.
 *
 * The default model gets throughput routing and the Sonnet fallback; every other
 * model is sent exactly as the user chose it.
 */
export function routeModel(modelId: string): ModelRouting {
  if (modelId !== RECOMMENDED_MODEL_ID) return { model: modelId, fallbacks: [] };
  return { model: `${modelId}${NITRO_VARIANT}`, fallbacks: [FALLBACK_MODEL_ID] };
}

/**
 * Adds OpenRouter's `models` fallback list to an outgoing Chat Completions body.
 *
 * `@ai-sdk/openai` builds its request body from a CLOSED set of options and parses
 * `providerOptions` against a schema that strips anything unknown, so OpenRouter's
 * `models` field cannot travel through it. `createOpenAI` documents `fetch` as "a
 * middleware to intercept requests" -- which is the seam this uses. The provider
 * sends a JSON-string body, so the field is merged in there; a request whose body is
 * not a JSON object (or a request with no fallbacks) is passed through untouched.
 */
export function withModelFallbacks(
  inner: typeof globalThis.fetch,
  fallbacks: readonly string[],
): typeof globalThis.fetch {
  if (fallbacks.length === 0) return inner;
  return async (input, init) => {
    const body = asJsonObject(init?.body);
    if (!body) return inner(input, init);
    return inner(input, { ...init, body: JSON.stringify({ ...body, models: [...fallbacks] }) });
  };
}

/** The parsed body when it is a JSON object, else null. */
function asJsonObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
