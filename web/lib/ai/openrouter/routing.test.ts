import { describe, expect, it, vi } from "vitest";

import { RECOMMENDED_MODEL_ID } from "./catalog";
import { FALLBACK_MODEL_ID, NITRO_VARIANT, routeModel, withModelFallbacks } from "./routing";

describe("default model routing (46g)", () => {
  it("routes the default model for throughput and names the fallback, in order", () => {
    const routing = routeModel(RECOMMENDED_MODEL_ID);

    expect(routing.model).toBe(`${RECOMMENDED_MODEL_ID}${NITRO_VARIANT}`);
    expect(routing.fallbacks).toEqual([FALLBACK_MODEL_ID]);
  });

  it("sends a user-chosen model exactly as chosen", () => {
    for (const modelId of ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1", "vendor/custom"]) {
      expect(routeModel(modelId)).toEqual({ model: modelId, fallbacks: [] });
    }
  });

  it("keeps the recommended catalog id a real slug -- :nitro is not a models-API entry", () => {
    expect(NITRO_VARIANT).toBe(":nitro");
    expect(RECOMMENDED_MODEL_ID).not.toContain(":");
  });
});

describe("withModelFallbacks", () => {
  it("adds the fallback list to the outgoing JSON body", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const fetchImpl = withModelFallbacks(inner as unknown as typeof fetch, [FALLBACK_MODEL_ID]);

    await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: `${RECOMMENDED_MODEL_ID}${NITRO_VARIANT}`, messages: [] }),
    });

    const [, init] = inner.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.models).toEqual([FALLBACK_MODEL_ID]);
    // Everything the AI SDK already put in the body is preserved.
    expect(body.model).toBe(`${RECOMMENDED_MODEL_ID}${NITRO_VARIANT}`);
    expect(body.messages).toEqual([]);
  });

  it("is a no-op when there are no fallbacks", () => {
    const inner = vi.fn(async () => new Response("ok"));
    expect(withModelFallbacks(inner as unknown as typeof fetch, [])).toBe(inner);
  });

  it("leaves a body that is not a JSON object untouched", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const fetchImpl = withModelFallbacks(inner as unknown as typeof fetch, [FALLBACK_MODEL_ID]);

    await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: "raw",
    });
    await fetchImpl("https://openrouter.ai/api/v1/chat/completions", { method: "GET" });

    expect((inner.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBe("raw");
    expect((inner.mock.calls[1] as unknown as [string, RequestInit])[1].body).toBeUndefined();
  });
});
