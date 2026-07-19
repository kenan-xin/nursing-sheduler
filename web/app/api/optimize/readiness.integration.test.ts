import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as submit } from "@/app/api/optimize/route";
import { GET as poll } from "@/app/api/optimize/[id]/route";
import { POST as cancel } from "@/app/api/optimize/[id]/cancel/route";
import { POST as finishNow } from "@/app/api/optimize/[id]/finish-now/route";
import { GET as downloadXlsx } from "@/app/api/optimize/[id]/xlsx/route";
import { GET as events } from "@/app/api/optimize/[id]/events/route";

// Real-transport readiness sensitivity (ticket verification): over real sockets,
// prove the runtime readiness gate forwards ZERO business requests while the backend
// is unready / timing out / unreachable, and forwards EXACTLY ONE when ready. This
// is the guarantee T02r handed to the BFF: `depends_on` orders startup only; nothing
// but this gate stops a business request reaching an unready backend.

type ReadyMode =
  | "ready"
  | "unready"
  | "hang"
  | "no-content"
  | "wrong-status-value"
  | "extra-field"
  | "not-json"
  | "body-reset";

let server: Server;
let realOrigin: string;
let deadOrigin: string; // a guaranteed-refused origin for the connection-failure case
let businessHits = 0;
let readyMode: ReadyMode = "ready";

function handleReady(res: ServerResponse) {
  switch (readyMode) {
    case "hang":
      return; // never respond ⇒ the gate's bounded deadline must fire
    case "unready":
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "unavailable", reason: "job_store_unavailable" }));
      return;
    case "no-content":
      // A 204 is a 2xx but must still fail closed — no body carries "ready".
      res.writeHead(204);
      res.end();
      return;
    case "wrong-status-value":
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "unavailable" }));
      return;
    case "extra-field":
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ready", reason: "extra" }));
      return;
    case "not-json":
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json");
      return;
    case "body-reset": {
      // Declare a body longer than what's actually sent, write a truncated
      // fragment, flush the headers, then destroy the socket shortly after —
      // long enough for Undici to have parsed/resolved the response headers,
      // short enough to stay well under the gate's bound.
      const fragment = JSON.stringify({ status: "ready" }).slice(0, 5);
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(JSON.stringify({ status: "ready" }).length + 100),
      });
      res.write(fragment);
      res.flushHeaders?.();
      setTimeout(() => res.socket?.destroy(), 50);
      return;
    }
    default:
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ready" }));
  }
}

function handleBusiness(req: IncomingMessage, res: ServerResponse) {
  businessHits += 1;
  req.on("data", () => {});
  req.on("end", () => {
    if (req.url?.endsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write('event: job.state_changed\ndata: {"state":"running"}\n\n');
      return; // caller cancels
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "opt_int", state: "queued" }));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ready") return handleReady(res);
    return handleBusiness(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  realOrigin = `http://127.0.0.1:${port}`;

  // A dead origin: bind a throwaway port, then close it so connections are refused.
  const throwaway = createServer();
  await new Promise<void>((resolve) => throwaway.listen(0, "127.0.0.1", resolve));
  const deadPort = (throwaway.address() as AddressInfo).port;
  await new Promise<void>((resolve) => throwaway.close(() => resolve()));
  deadOrigin = `http://127.0.0.1:${deadPort}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.BACKEND_API_URL;
});

afterEach(() => {
  businessHits = 0;
  readyMode = "ready";
  process.env.BACKEND_API_URL = realOrigin;
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

// Every optimization business route, invoked once.
const routes: Array<[string, () => Promise<Response>]> = [
  [
    "submit",
    () =>
      submit(
        new Request("http://localhost/api/optimize", {
          method: "POST",
          body: "x",
          headers: { "content-type": "multipart/form-data; boundary=b" },
        }),
      ),
  ],
  ["poll", () => poll(new Request("http://localhost/api/optimize/opt_int"), params("opt_int"))],
  [
    "cancel",
    () =>
      cancel(
        new Request("http://localhost/api/optimize/opt_int/cancel", { method: "POST" }),
        params("opt_int"),
      ),
  ],
  [
    "finish-now",
    () =>
      finishNow(
        new Request("http://localhost/api/optimize/opt_int/finish-now", { method: "POST" }),
        params("opt_int"),
      ),
  ],
  [
    "events",
    () => events(new Request("http://localhost/api/optimize/opt_int/events"), params("opt_int")),
  ],
  [
    "xlsx",
    () =>
      downloadXlsx(new Request("http://localhost/api/optimize/opt_int/xlsx"), params("opt_int")),
  ],
];

describe("readiness gate over real transport", () => {
  beforeAll(() => {
    process.env.BACKEND_API_URL = realOrigin;
  });

  it.each(routes)(
    "%s forwards ZERO business requests when the backend is unready (503)",
    async (_name, run) => {
      process.env.BACKEND_API_URL = realOrigin;
      readyMode = "unready";
      const response = await run();
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("backend_unready");
      expect(businessHits).toBe(0);
    },
  );

  it.each(routes)("%s forwards EXACTLY ONE business request when ready", async (name, run) => {
    process.env.BACKEND_API_URL = realOrigin;
    readyMode = "ready";
    const response = await run();
    expect(response.status).toBe(200);
    expect(businessHits).toBe(1);
    if (name === "events") await response.body?.cancel().catch(() => {});
  });

  it("fails closed (bounded) when the readiness probe times out, forwarding nothing", async () => {
    process.env.BACKEND_API_URL = realOrigin;
    readyMode = "hang";
    const response = await submit(
      new Request("http://localhost/api/optimize", {
        method: "POST",
        body: "x",
        headers: { "content-type": "multipart/form-data; boundary=b" },
      }),
    );
    expect(response.status).toBe(503);
    expect(businessHits).toBe(0);
  });

  it("fails closed when the backend is unreachable, forwarding nothing", async () => {
    process.env.BACKEND_API_URL = deadOrigin;
    const response = await poll(
      new Request("http://localhost/api/optimize/opt_int"),
      params("opt_int"),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("backend_unready");
    expect(businessHits).toBe(0);
  });
});

// Strict-ready-response sensitivity (this ticket): a malformed 2xx or a body-read
// failure on `/ready` must fail closed identically to an explicit 503/unready,
// across every one of the six gated business routes.
const malformedModes: Array<[ReadyMode, string]> = [
  ["no-content", "204 (no ready body)"],
  ["wrong-status-value", '200 { status: "unavailable" }'],
  ["extra-field", "200 with an extra/unknown key"],
  ["not-json", "200 with a non-JSON body"],
  ["body-reset", "200 whose body resets/truncates after headers"],
];

describe("readiness gate — strict ready-response sensitivity over real transport", () => {
  it.each(
    routes.flatMap(([routeName, run]) =>
      malformedModes.map((mode) => [routeName, run, mode[0], mode[1]] as const),
    ),
  )(
    "%s forwards ZERO business requests when /ready responds %s",
    async (_routeName, run, mode, _description) => {
      process.env.BACKEND_API_URL = realOrigin;
      readyMode = mode;
      const response = await run();
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("backend_unready");
      expect(businessHits).toBe(0);
    },
  );

  it.each(routes)(
    "%s forwards EXACTLY ONE business request for the canonical exact ready body",
    async (name, run) => {
      process.env.BACKEND_API_URL = realOrigin;
      readyMode = "ready";
      const response = await run();
      expect(response.status).toBe(200);
      expect(businessHits).toBe(1);
      if (name === "events") await response.body?.cancel().catch(() => {});
    },
  );
});
