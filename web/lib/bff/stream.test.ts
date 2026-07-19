import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { proxyEventStream, relayEventErrorResponse } from "@/lib/bff/stream";

// Post-header body-consumption failure in the SSE non-2xx error branch (T06r4,
// discovered while repairing the equivalent JSON relay boundary in T06r3):
// `fetch()` resolving only proves headers arrived — the error body stream itself
// can still reset or truncate mid-read. Without a boundary around
// `arrayBuffer()`, that rejection escapes as an uncaught rejection (a framework
// 500) instead of the code-first `backend_unreachable` envelope every other
// upstream failure maps to.

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.BACKEND_API_URL = "http://backend:8000";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BACKEND_API_URL;
  vi.restoreAllMocks();
});

function mockFetch(handler: () => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async () => handler()) as typeof fetch;
}

function responseWithBrokenBody(status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("body reset"));
    },
  });
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

async function expectBackendUnreachable(response: Response) {
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: { code: "backend_unreachable", message: "The scheduling service is unreachable." },
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("proxyEventStream — non-2xx error-body-consumption failure", () => {
  it("maps an arrayBuffer() rejection on a 404 error body to a code-first 502", async () => {
    mockFetch(() => responseWithBrokenBody(404));
    const response = await proxyEventStream(
      new Request("http://localhost/api/optimize/opt_1/events"),
      "/optimize/opt_1/events",
    );
    await expectBackendUnreachable(response);
  });

  it("maps an arrayBuffer() rejection on a 5xx error body to a code-first 502", async () => {
    mockFetch(() => responseWithBrokenBody(503));
    const response = await proxyEventStream(
      new Request("http://localhost/api/optimize/opt_1/events"),
      "/optimize/opt_1/events",
    );
    await expectBackendUnreachable(response);
  });

  it("logs only the safe relative path, never a URL", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch(() => responseWithBrokenBody(404));
    await proxyEventStream(
      new Request("http://localhost/api/optimize/opt_1/events"),
      "/optimize/opt_1/events",
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("/optimize/opt_1/events"),
      expect.anything(),
    );
    for (const call of consoleError.mock.calls) {
      for (const arg of call) {
        if (typeof arg === "string") expect(arg).not.toContain("backend:8000");
      }
    }
    consoleError.mockRestore();
  });
});

describe("proxyEventStream — regressions (unchanged behavior)", () => {
  it("still relays a successfully consumed non-2xx error body verbatim", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: { code: "job_not_found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await proxyEventStream(
      new Request("http://localhost/api/optimize/opt_1/events"),
      "/optimize/opt_1/events",
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "job_not_found" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("still streams a successful 2xx SSE response through verbatim", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: job.state_changed\ndata: {}\n\n"));
        controller.close();
      },
    });
    mockFetch(
      () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        }),
    );
    const response = await proxyEventStream(
      new Request("http://localhost/api/optimize/opt_1/events"),
      "/optimize/opt_1/events",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain("job.state_changed");
  });

  it("forwards Last-Event-ID upstream on reconnect", async () => {
    let seenHeader: string | null = null;
    globalThis.fetch = vi.fn(async (_input, init?: RequestInit) => {
      seenHeader = new Headers(init?.headers).get("last-event-id");
      throw new Error("connection failed");
    }) as typeof fetch;

    await proxyEventStream(
      new Request("http://localhost/api/optimize/opt_1/events", {
        headers: { "last-event-id": "cursor-42" },
      }),
      "/optimize/opt_1/events",
    );
    expect(seenHeader).toBe("cursor-42");
  });
});

// Real-transport isolation proof (T06r4 fixup, single-phase seam): the
// route-level reset fixture in `optimize.integration.test.ts` asserts only the
// final 502 — a result the pre-existing outer `fetch()` catch would ALSO
// produce if the connection failed before headers arrived. `relayEventErrorResponse`
// (extracted from `proxyEventStream`'s non-2xx branch specifically so this seam
// exists) takes an already-resolved `Response`, so this proof hands it the SAME
// object a real `fetch()` just resolved — no ambiguity about which catch ran.
describe("relayEventErrorResponse — real-transport proof that arrayBuffer() (not fetch()) is what fails", () => {
  let server: Server;
  let origin: string;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  beforeAll(async () => {
    server = createServer((_req, res) => {
      // Declare a body far longer than what's actually sent, flush a short
      // fragment plus headers, then destroy the socket after a bounded delay —
      // long enough for Undici to have already resolved `fetch()` with a parsed
      // 404 status, short enough to stay well under any test timeout.
      const payload = JSON.stringify({ error: { code: "job_not_found" } });
      const fragment = payload.slice(0, 5);
      res.writeHead(404, {
        "content-type": "application/json",
        "content-length": String(payload.length + 100),
      });
      res.write(fragment);
      res.flushHeaders?.();
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        res.socket?.destroy();
      }, 50);
      pendingTimers.add(timer);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("proves fetch() resolved (404) before relayEventErrorResponse's own arrayBuffer() catch maps the reset to 502", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const upstream = await fetch(origin);
      // If this were the outer fetch() catch firing instead, we would never reach
      // this assertion — fetch() would have rejected, not resolved.
      expect(upstream.status).toBe(404);

      const response = await relayEventErrorResponse(upstream, "/optimize/opt_1/events");

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: { code: "backend_unreachable", message: "The scheduling service is unreachable." },
      });
      expect(response.headers.get("cache-control")).toBe("no-store");

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("/optimize/opt_1/events"),
        expect.anything(),
      );
      for (const call of consoleError.mock.calls) {
        for (const arg of call) {
          if (typeof arg === "string") expect(arg).not.toContain(origin);
        }
      }
    } finally {
      consoleError.mockRestore();
    }
  });
});

// End-to-end integration regression (not the sole proof — see the single-phase
// helper-level proof above): the full route function, pointed at a real server
// with the same reset behavior, must still map the failure to the exact 502.
describe("proxyEventStream — end-to-end real-transport reset regression", () => {
  let server: Server;
  let origin: string;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  beforeAll(async () => {
    server = createServer((_req, res) => {
      const payload = JSON.stringify({ error: { code: "job_not_found" } });
      const fragment = payload.slice(0, 5);
      res.writeHead(404, {
        "content-type": "application/json",
        "content-length": String(payload.length + 100),
      });
      res.write(fragment);
      res.flushHeaders?.();
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        res.socket?.destroy();
      }, 50);
      pendingTimers.add(timer);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    delete process.env.BACKEND_API_URL;
  });

  it("maps a real reset/truncated non-2xx error body to a code-first 502 end-to-end", async () => {
    process.env.BACKEND_API_URL = origin;
    const response = await proxyEventStream(
      new Request("http://localhost/api/optimize/opt_1/events"),
      "/optimize/opt_1/events",
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "backend_unreachable", message: "The scheduling service is unreachable." },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
