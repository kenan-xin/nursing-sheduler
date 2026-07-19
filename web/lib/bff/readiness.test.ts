import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkBackendReady, withReadinessGate } from "@/lib/bff/readiness";

const originalFetch = globalThis.fetch;
let readyCalls: string[];

function mockReady(handler: (url: string) => Response | Promise<Response>) {
  readyCalls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    readyCalls.push(url);
    return handler(url);
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.BACKEND_API_URL = "http://backend:8000";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BACKEND_API_URL;
  vi.restoreAllMocks();
});

async function expectBackendUnready(response: Response | null) {
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    error: { code: "backend_unready", message: "The scheduling service is not ready." },
  });
  expect(response?.headers.get("cache-control")).toBe("no-store");
}

describe("checkBackendReady", () => {
  it('returns null (proceed) when /ready returns exactly HTTP 200 { status: "ready" }', async () => {
    mockReady(() => new Response(JSON.stringify({ status: "ready" }), { status: 200 }));
    expect(await checkBackendReady()).toBeNull();
    expect(readyCalls).toEqual(["http://backend:8000/ready"]);
  });

  it("fails closed with a code-first 503 when /ready is unready (503)", async () => {
    mockReady(
      () =>
        new Response(JSON.stringify({ status: "unavailable", reason: "job_store_unavailable" }), {
          status: 503,
        }),
    );
    await expectBackendUnready(await checkBackendReady());
  });

  it("fails closed when the probe times out / connection fails", async () => {
    mockReady(() => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    await expectBackendUnready(await checkBackendReady());
  });

  it("rejects HTTP 204 (no body) even though it is a 2xx", async () => {
    mockReady(() => new Response(null, { status: 204 }));
    await expectBackendUnready(await checkBackendReady());
  });

  it("rejects another 2xx status (201) carrying the exact ready body", async () => {
    mockReady(() => new Response(JSON.stringify({ status: "ready" }), { status: 201 }));
    await expectBackendUnready(await checkBackendReady());
  });

  it('rejects HTTP 200 { status: "unavailable" } (status/body mismatch)', async () => {
    mockReady(() => new Response(JSON.stringify({ status: "unavailable" }), { status: 200 }));
    await expectBackendUnready(await checkBackendReady());
  });

  it("rejects an unknown status value at HTTP 200", async () => {
    mockReady(() => new Response(JSON.stringify({ status: "warming" }), { status: 200 }));
    await expectBackendUnready(await checkBackendReady());
  });

  it("rejects a mistyped status value at HTTP 200", async () => {
    mockReady(() => new Response(JSON.stringify({ status: 1 }), { status: 200 }));
    await expectBackendUnready(await checkBackendReady());
  });

  it("rejects a missing status key at HTTP 200", async () => {
    mockReady(() => new Response(JSON.stringify({}), { status: 200 }));
    await expectBackendUnready(await checkBackendReady());
  });

  it("rejects an extra/unknown key alongside the exact ready status", async () => {
    mockReady(
      () => new Response(JSON.stringify({ status: "ready", reason: "extra" }), { status: 200 }),
    );
    await expectBackendUnready(await checkBackendReady());
  });

  it("rejects a non-JSON body at HTTP 200", async () => {
    mockReady(() => new Response("not json", { status: 200 }));
    await expectBackendUnready(await checkBackendReady());
  });

  it("rejects a JSON array body at HTTP 200", async () => {
    mockReady(() => new Response(JSON.stringify(["ready"]), { status: 200 }));
    await expectBackendUnready(await checkBackendReady());
  });

  it("fails closed when the body stream fails to read after headers arrive", async () => {
    mockReady(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("body reset"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    await expectBackendUnready(await checkBackendReady());
  });
});

describe("withReadinessGate", () => {
  it("runs the handler only when the backend is ready", async () => {
    mockReady(() => new Response(JSON.stringify({ status: "ready" }), { status: 200 }));
    const handler = vi.fn(async () => new Response("ok", { status: 200 }));
    const gated = withReadinessGate(handler);

    const response = await gated(new Request("http://localhost/api/optimize/x"));
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("short-circuits without invoking the handler when unready", async () => {
    mockReady(() => new Response(JSON.stringify({ status: "unavailable" }), { status: 503 }));
    const handler = vi.fn(async () => new Response("ok", { status: 200 }));
    const gated = withReadinessGate(handler);

    const response = await gated(new Request("http://localhost/api/optimize/x"));
    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes the route context (params) through to the handler", async () => {
    mockReady(() => new Response(JSON.stringify({ status: "ready" }), { status: 200 }));
    const handler = vi.fn(
      async (_request: Request, ctx: { params: Promise<{ id: string }> }) =>
        new Response(JSON.stringify(await ctx.params), { status: 200 }),
    );
    const gated = withReadinessGate(handler);

    const response = await gated(new Request("http://localhost/api/optimize/opt_1"), {
      params: Promise.resolve({ id: "opt_1" }),
    });
    expect(await response.json()).toEqual({ id: "opt_1" });
  });
});
