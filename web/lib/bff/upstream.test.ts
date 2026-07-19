import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { proxyJsonRequest, relayJsonResponse } from "@/lib/bff/upstream";

// Post-header body-consumption failure (this ticket): `fetch()` resolving only
// proves headers arrived — the body stream itself can still reset or truncate
// mid-read. Without a boundary around `arrayBuffer()`, that rejection escapes as
// an uncaught rejection (a framework 500) instead of the code-first
// `backend_unreachable` envelope every other upstream failure maps to.

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.BACKEND_API_URL = "http://backend:8000";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BACKEND_API_URL;
  vi.restoreAllMocks();
});

function responseWithBrokenBody(status = 200): Response {
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

describe("relayJsonResponse — body-consumption failure", () => {
  it("maps an arrayBuffer() rejection to a code-first 502, not an uncaught throw", async () => {
    await expectBackendUnreachable(
      await relayJsonResponse(responseWithBrokenBody(), "/optimize/opt_1"),
    );
  });

  it("logs only the safe relative path, never a URL", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await relayJsonResponse(responseWithBrokenBody(), "/optimize/opt_1");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("/optimize/opt_1"),
      expect.anything(),
    );
    for (const call of consoleError.mock.calls) {
      for (const arg of call) {
        if (typeof arg === "string") expect(arg).not.toContain("backend:8000");
      }
    }
    consoleError.mockRestore();
  });

  it("still relays a successfully consumed body verbatim (no regression)", async () => {
    const upstream = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const response = await relayJsonResponse(upstream, "/optimize/opt_1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("proxyJsonRequest — body-consumption failure", () => {
  it("maps a post-header body reset to a code-first 502 for a generic JSON proxy route", async () => {
    globalThis.fetch = vi.fn(async () => responseWithBrokenBody()) as typeof fetch;
    const response = await proxyJsonRequest(new Request("http://localhost/api/optimize/opt_1"), {
      method: "GET",
      path: "/optimize/opt_1",
    });
    await expectBackendUnreachable(response);
  });
});

// Real-transport isolation proof (T06r3 fixup): the route-level reset fixtures in
// `optimize.integration.test.ts` assert only the final 502 — a result the
// pre-existing outer `fetch()` catch would ALSO produce if the connection failed
// before headers arrived. That leaves it ambiguous whether the reset actually
// reached the new `arrayBuffer()` catch inside `relayJsonResponse`. This proof
// closes that gap: it awaits a REAL `fetch()` against a real socket and asserts
// the upstream status resolved (409) BEFORE ever calling `relayJsonResponse`,
// which is only possible if `fetch()` itself succeeded — headers were parsed and
// the promise settled. Only then does it feed that already-resolved `Response`
// into `relayJsonResponse` and prove the reset (which happens on the *next* read)
// is caught there and mapped to the exact 502 envelope.
describe("relayJsonResponse — real-transport proof that arrayBuffer() (not fetch()) is what fails", () => {
  let server: Server;
  let origin: string;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      // Declare a body far longer than what's actually sent, flush a short
      // fragment plus headers, then destroy the socket after a bounded delay —
      // long enough for Undici to have already resolved `fetch()` with a parsed
      // 409 status, short enough to stay well under any test timeout.
      const payload = JSON.stringify({ error: { code: "job_not_terminal" } });
      const fragment = payload.slice(0, 5);
      res.writeHead(409, {
        "content-type": "application/json",
        "content-length": String(payload.length + 100),
      });
      res.write(fragment);
      res.flushHeaders?.();
      resetTimer = setTimeout(() => res.socket?.destroy(), 50);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    clearTimeout(resetTimer);
    resetTimer = undefined;
  });

  it("proves fetch() resolved (409) before relayJsonResponse's own arrayBuffer() catch maps the reset to 502", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const upstream = await fetch(origin, { method: "GET" });
      // If this were the outer fetch() catch firing instead, we would never reach
      // this assertion — fetch() would have rejected, not resolved.
      expect(upstream.status).toBe(409);

      const response = await relayJsonResponse(upstream, "/optimize/opt_1");
      await expectBackendUnreachable(response);

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("/optimize/opt_1"),
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
