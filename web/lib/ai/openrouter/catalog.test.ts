import { describe, expect, it, vi } from "vitest";

import {
  FALLBACK_CATALOG_VERSION,
  FALLBACK_MODELS,
  RECOMMENDED_MODEL_ID,
  fallbackCatalog,
  fetchModelCatalog,
  pickRecommended,
  selectToolCapableModels,
} from "./catalog";

function catalogPayload(rows: unknown[]): unknown {
  return { data: rows };
}

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

describe("tool-capability filter", () => {
  it("keeps only rows that declare tool support", () => {
    const models = selectToolCapableModels(
      catalogPayload([
        { id: "a/with-tools", name: "With tools", supported_parameters: ["tools", "temperature"] },
        { id: "b/no-tools", name: "No tools", supported_parameters: ["temperature"] },
      ]),
    );
    expect(models.map((m) => m.id)).toEqual(["a/with-tools"]);
  });

  it("drops structurally unusable rows instead of offering them optimistically", () => {
    const models = selectToolCapableModels(
      catalogPayload([
        { name: "no id", supported_parameters: ["tools"] },
        { id: "", supported_parameters: ["tools"] },
        { id: "c/params-not-a-list", supported_parameters: "tools" },
        { id: "d/no-params" },
        { id: "e/fine", supported_parameters: ["tools"] },
      ]),
    );
    expect(models.map((m) => m.id)).toEqual(["e/fine"]);
  });

  it("yields an empty list for an unrecognised payload, never a permissive one", () => {
    for (const payload of [null, undefined, {}, { data: "nope" }, [{ id: "x" }]]) {
      expect(selectToolCapableModels(payload)).toEqual([]);
    }
  });

  it("falls back to the slug when a row has no usable display name", () => {
    const [model] = selectToolCapableModels(
      catalogPayload([{ id: "vendor/slug", name: "", supported_parameters: ["tools"] }]),
    );
    expect(model).toEqual({ id: "vendor/slug", name: "vendor/slug", contextLength: null });
  });
});

describe("recommended default", () => {
  it("prefers the recommended slug when the live catalog offers it", () => {
    const models = selectToolCapableModels(
      catalogPayload([
        { id: "zzz/other", supported_parameters: ["tools"] },
        { id: RECOMMENDED_MODEL_ID, supported_parameters: ["tools"] },
      ]),
    );
    expect(pickRecommended(models)).toBe(RECOMMENDED_MODEL_ID);
  });

  it("falls back to the first row when the recommended slug is absent", () => {
    expect(pickRecommended([{ id: "only/one", name: "Only", contextLength: null }])).toBe(
      "only/one",
    );
  });

  it("has nothing to recommend from an empty list", () => {
    expect(pickRecommended([])).toBeNull();
  });
});

describe("fallback catalog", () => {
  it("is versioned, non-empty, and offers the recommended default", () => {
    const catalog = fallbackCatalog();
    expect(catalog.source).toBe("fallback");
    expect(catalog.fallbackVersion).toBe(FALLBACK_CATALOG_VERSION);
    expect(catalog.models.length).toBe(FALLBACK_MODELS.length);
    expect(catalog.recommendedId).toBe(RECOMMENDED_MODEL_ID);
  });

  it("cannot be mutated through the returned list", () => {
    fallbackCatalog().models.push({ id: "x", name: "x", contextLength: null });
    expect(fallbackCatalog().models.length).toBe(FALLBACK_MODELS.length);
  });
});

describe("fetching the live catalog", () => {
  it("sends no credential -- Settings must show models before a key exists", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse(catalogPayload([{ id: "a/x", supported_parameters: ["tools"] }])),
    );

    await fetchModelCatalog(fetchImpl as unknown as typeof fetch);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.stringify(init.headers ?? {}).toLowerCase()).not.toContain("authorization");
  });

  it.each([
    ["a non-OK status", async () => new Response("nope", { status: 503 })],
    ["unparseable JSON", async () => new Response("<html>", { status: 200 })],
    [
      "a catalog with no tool-capable model",
      async () => okResponse(catalogPayload([{ id: "a/x", supported_parameters: [] }])),
    ],
    [
      "a thrown transport error",
      async () => {
        throw new Error("network down");
      },
    ],
  ])("falls back on %s", async (_label, impl) => {
    const catalog = await fetchModelCatalog(impl as unknown as typeof fetch);
    expect(catalog.source).toBe("fallback");
    expect(catalog.models.length).toBeGreaterThan(0);
  });

  it("reports a usable live catalog as such", async () => {
    const catalog = await fetchModelCatalog((async () =>
      okResponse(
        catalogPayload([
          { id: "a/x", name: "X", supported_parameters: ["tools"], context_length: 1234 },
        ]),
      )) as unknown as typeof fetch);

    expect(catalog.source).toBe("catalog");
    expect(catalog.models).toEqual([{ id: "a/x", name: "X", contextLength: 1234 }]);
  });
});
