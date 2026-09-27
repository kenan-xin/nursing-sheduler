import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOptimizeTimeoutOptions, LEGACY_OPTIMIZE_TIMEOUT } from "@/lib/query/optimize-options";

const originalFetch = globalThis.fetch;

function respond(status: number, body: unknown) {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const signal = new AbortController().signal;

describe("fetchOptimizeTimeoutOptions", () => {
  it("returns the backend's timeout default and bounds", async () => {
    respond(200, { timeout: { default: 120, minimum: 10, maximum: 600 } });
    expect(await fetchOptimizeTimeoutOptions(signal)).toEqual({
      source: "backend",
      timeout: { default: 120, minimum: 10, maximum: 600 },
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/optimize/options",
      expect.objectContaining({ cache: "no-store", signal }),
    );
  });

  it("keeps the legacy defaults for a backend without the endpoint", async () => {
    respond(404, { error: { code: "backend_route_unsupported", message: "x" } });
    expect(await fetchOptimizeTimeoutOptions(signal)).toEqual({
      source: "legacy",
      timeout: LEGACY_OPTIMIZE_TIMEOUT,
    });
    expect(LEGACY_OPTIMIZE_TIMEOUT).toEqual({ default: 300, minimum: 1, maximum: 3600 });
  });

  it.each([
    ["an unreachable backend", 502, { error: { code: "backend_unreachable" } }],
    ["a malformed body", 200, { timeout: { default: 700, minimum: 1, maximum: 600 } }],
    ["an extra key", 200, { timeout: { default: 1, minimum: 1, maximum: 2 }, solver: {} }],
  ])("falls back to the legacy defaults on %s", async (_name, status, body) => {
    respond(status, body);
    expect((await fetchOptimizeTimeoutOptions(signal)).source).toBe("legacy");
  });

  it("falls back when the request itself fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    expect((await fetchOptimizeTimeoutOptions(signal)).source).toBe("legacy");
  });
});
