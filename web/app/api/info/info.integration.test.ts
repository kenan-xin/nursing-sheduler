import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/info/route";

// Real-transport coverage (ticket verification): the mocked-fetch unit tests prove
// the route's own validation logic in isolation, but the bounded-timeout,
// connection-refused, and real-socket header/body plumbing only get exercised
// over an actual Node/undici fetch against a real HTTP server.

type InfoMode =
  | "ready"
  | "unavailable"
  | "hang"
  | "not-json"
  | "html-invalid"
  | "html-valid-json"
  | "no-content-type"
  | "extra-field"
  | "unknown-status"
  | "mismatch-ready-503"
  | "mismatch-unavailable-200"
  | "valid-json-500"
  | "body-reset";

let server: Server;
let realOrigin: string;
let deadOrigin: string; // a bound-then-closed port: connections are refused
let infoMode: InfoMode = "ready";

const READY_IDENTITY = {
  status: "ready",
  service_name: "nurse-scheduling-api",
  api_version: "alpha",
  app_version: "v1.2.3-int",
  deployment_id: "dep-int",
  instance_id: "inst-int",
  started_at: "2026-07-19T00:00:00+00:00",
  job_backend: "memory",
  job_store_id: "inst-int",
};

const UNAVAILABLE_IDENTITY = {
  status: "unavailable",
  reason: "job_store_unavailable",
  service_name: "nurse-scheduling-api",
  api_version: "alpha",
  app_version: "v1.2.3-int",
  deployment_id: "dep-int",
  instance_id: "inst-int",
  started_at: "2026-07-19T00:00:00+00:00",
  job_backend: "memory",
  job_store_id: "inst-int",
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url !== "/info") {
      res.writeHead(404).end();
      return;
    }
    switch (infoMode) {
      case "hang":
        return; // never respond ⇒ the bounded deadline must fire
      case "unavailable":
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify(UNAVAILABLE_IDENTITY));
        return;
      case "not-json":
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{not valid json");
        return;
      case "html-invalid":
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>service down</html>");
        return;
      case "html-valid-json":
        // Hostile media type, but the bytes ARE the valid ready payload — must
        // still be accepted, with the outbound content-type forced to JSON.
        res.writeHead(200, { "content-type": "text/html" });
        res.end(JSON.stringify(READY_IDENTITY));
        return;
      case "no-content-type":
        res.writeHead(200);
        res.end(JSON.stringify(READY_IDENTITY));
        return;
      case "extra-field":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...READY_IDENTITY, backend_url: "http://backend:8000" }));
        return;
      case "unknown-status":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...READY_IDENTITY, status: "warming" }));
        return;
      case "mismatch-ready-503":
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify(READY_IDENTITY));
        return;
      case "mismatch-unavailable-200":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(UNAVAILABLE_IDENTITY));
        return;
      case "valid-json-500":
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify(READY_IDENTITY));
        return;
      case "body-reset": {
        // Declare a body longer than what's actually sent, write a truncated
        // fragment, flush the headers, then destroy the socket shortly after —
        // long enough for Undici to have already parsed/resolved the response
        // headers, short enough to stay well under the route's bound. The
        // declared content-length is never satisfied and the connection closes
        // mid-stream, so `fetch()` resolves but `response.text()` rejects
        // (proven directly against Undici before wiring this fixture).
        const fragment = JSON.stringify(READY_IDENTITY).slice(0, 10);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(JSON.stringify(READY_IDENTITY).length + 100),
        });
        res.write(fragment);
        res.flushHeaders?.();
        setTimeout(() => res.socket?.destroy(), 50);
        return;
      }
      default:
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(READY_IDENTITY));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  realOrigin = `http://127.0.0.1:${port}`;

  const throwaway = createServer();
  await new Promise<void>((resolve) => throwaway.listen(0, "127.0.0.1", resolve));
  const deadPort = (throwaway.address() as AddressInfo).port;
  await new Promise<void>((resolve) => throwaway.close(() => resolve()));
  deadOrigin = `http://127.0.0.1:${deadPort}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  infoMode = "ready";
  delete process.env.BACKEND_API_URL;
});

async function expectInvalidUpstream(response: Response) {
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    status: "unavailable",
    reason: "invalid_upstream_response",
  });
}

describe("GET /api/info over real transport — valid variants", () => {
  it("accepts a real 200 ready identity response, no-store, forced application/json", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "ready";

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(READY_IDENTITY);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("accepts a real 503 unavailable identity response", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "unavailable";

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(UNAVAILABLE_IDENTITY);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("accepts a valid JSON body mislabelled text/html and forces the outbound content-type", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "html-valid-json";

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(READY_IDENTITY);
  });

  it("accepts a valid JSON body with no upstream content-type header at all", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "no-content-type";

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(READY_IDENTITY);
  });
});

describe("GET /api/info over real transport — connection/timeout failures", () => {
  it("fails closed (502, backend_unreachable) when the backend is unreachable (connection refused)", async () => {
    process.env.BACKEND_API_URL = deadOrigin;

    const response = await GET();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ status: "unavailable", reason: "backend_unreachable" });
  });

  it("fails closed (502, backend_unreachable) within the bounded deadline when the backend hangs", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "hang";
    const startedAt = Date.now();

    const response = await GET();
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ status: "unavailable", reason: "backend_unreachable" });
    // Bounded: must not wait indefinitely for a backend that never answers.
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it("fails closed (502, backend_unreachable) when the connection resets/truncates mid-body after headers arrive", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "body-reset";
    const startedAt = Date.now();

    const response = await GET();
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ status: "unavailable", reason: "backend_unreachable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Deterministic: the socket destroy triggers an immediate stream error, not
    // a wait for the bounded deadline.
    expect(elapsedMs).toBeLessThan(10_000);
    // Confirms this took the body-read failure path (fetch() itself resolved),
    // not the outer fetch()-rejection path exercised by the other two tests.
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("upstream response body failed to read"),
      expect.anything(),
    );
    consoleError.mockRestore();
  });
});

describe("GET /api/info over real transport — closed-contract rejections", () => {
  it("rejects a real non-JSON body", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "not-json";
    await expectInvalidUpstream(await GET());
  });

  it("rejects a hostile text/html body that is not valid JSON either", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "html-invalid";
    await expectInvalidUpstream(await GET());
  });

  it("rejects a body carrying an extra/private field (e.g. a leaked backend_url)", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "extra-field";
    await expectInvalidUpstream(await GET());
  });

  it("rejects an unknown status value", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "unknown-status";
    await expectInvalidUpstream(await GET());
  });

  it("rejects status:ready paired with HTTP 503 (status/body mismatch)", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "mismatch-ready-503";
    await expectInvalidUpstream(await GET());
  });

  it("rejects status:unavailable paired with HTTP 200 (status/body mismatch)", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "mismatch-unavailable-200";
    await expectInvalidUpstream(await GET());
  });

  it("rejects a valid-looking ready body wrapped in an unexpected HTTP 500", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    infoMode = "valid-json-500";
    await expectInvalidUpstream(await GET());
  });
});
