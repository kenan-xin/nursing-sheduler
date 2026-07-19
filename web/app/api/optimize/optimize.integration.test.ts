import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DELETE as deleteJob, GET as poll } from "@/app/api/optimize/[id]/route";
import { GET as events } from "@/app/api/optimize/[id]/events/route";
import { POST as submit } from "@/app/api/optimize/route";

// Real-transport integration: the actual Route Handlers run against a real local
// upstream over real sockets (no mocked fetch), permanently protecting the two
// hazards the cold review flagged — piping actual 2 MiB / 2 MiB+1 multipart bodies
// with the exact 413 relayed, and a real downstream abort closing the real upstream
// socket.

const MIB = 1024 * 1024;

let server: Server;
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {};

beforeAll(async () => {
  server = createServer((req, res) => {
    // The readiness gate probes `/ready` before every business route; answer it as
    // ready so the real business path is exercised.
    if (req.url === "/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ready" }));
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.BACKEND_API_URL = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.BACKEND_API_URL;
});

afterEach(() => {
  handler = () => {};
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function multipart(fileSize: number): { body: Blob; contentType: string } {
  const boundary = "----integration-boundary";
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s.yaml"\r\n` +
    "Content-Type: application/x-yaml\r\n\r\n";
  const tail = `\r\n--${boundary}--\r\n`;
  const content = new Uint8Array(fileSize).fill(0x61); // 'a' × fileSize — no CRLF inside
  // A Blob is an unambiguous BodyInit; `request.body` becomes a ReadableStream the
  // handler pipes upstream with duplex:"half".
  return {
    body: new Blob([head, content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// Mirror serve.py: measure the FILE PART content and 413 past 2 MiB, else 202.
function upstreamSubmit(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk as Buffer));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const start = body.indexOf("\r\n\r\n") + 4;
    const end = body.lastIndexOf("\r\n--");
    const content = body.subarray(start, end);
    if (content.length > 2 * MIB) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Scheduling YAML is too large" }));
      return;
    }
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ jobId: "opt_int", status: "queued", receivedBytes: content.length }));
  });
}

describe("multipart submit over real transport", () => {
  it("pipes a real 2 MiB file through and returns 202", async () => {
    handler = upstreamSubmit;
    const { body, contentType } = multipart(2 * MIB);

    const response = await submit(
      new Request("http://localhost/api/optimize", {
        method: "POST",
        body,
        headers: { "content-type": contentType },
      }),
    );

    expect(response.status).toBe(202);
    expect((await response.json()).receivedBytes).toBe(2 * MIB);
  });

  it("relays the exact 413 for a 2 MiB + 1 file", async () => {
    handler = upstreamSubmit;
    const { body, contentType } = multipart(2 * MIB + 1);

    const response = await submit(
      new Request("http://localhost/api/optimize", {
        method: "POST",
        body,
        headers: { "content-type": contentType },
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ detail: "Scheduling YAML is too large" });
  });
});

describe("DELETE over real transport", () => {
  it("relays a real upstream 204 as a bodyless 204 (never constructs a body for a null-body status)", async () => {
    handler = (req, res) => {
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(500);
      res.end();
    };

    const response = await deleteJob(
      new Request("http://localhost/api/optimize/opt_int", { method: "DELETE" }),
      params("opt_int"),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});

// Post-header body-consumption failure over a real socket (this ticket): declare
// a body longer than what's actually sent, write a truncated fragment, flush the
// headers, then destroy the socket shortly after — long enough for Undici to have
// parsed/resolved the response headers (so `fetch()` itself resolves), short
// enough that `response.arrayBuffer()` rejects well before any test timeout. The
// same technique proves `web/app/api/info/info.integration.test.ts`'s equivalent
// `response.text()` fixture.
function writeResetBody(res: ServerResponse, status: number, payload: unknown) {
  const fragment = JSON.stringify(payload).slice(0, 5);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(JSON.stringify(payload).length + 100),
  });
  res.write(fragment);
  res.flushHeaders?.();
  setTimeout(() => res.socket?.destroy(), 50);
}

describe("post-header body reset over real transport", () => {
  it("maps a reset/truncated body to a code-first 502 for a generic JSON proxy (poll)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    handler = (req, res) => {
      if (req.method === "GET") return writeResetBody(res, 200, { id: "opt_int", state: "queued" });
      res.writeHead(500);
      res.end();
    };

    const response = await poll(
      new Request("http://localhost/api/optimize/opt_int"),
      params("opt_int"),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "backend_unreachable", message: "The scheduling service is unreachable." },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    for (const call of consoleError.mock.calls) {
      for (const arg of call) {
        if (typeof arg === "string") expect(arg).not.toContain(process.env.BACKEND_API_URL ?? "\0");
      }
    }
    consoleError.mockRestore();
  });

  it("maps a reset/truncated non-204 DELETE body (e.g. a 409 conflict) to a code-first 502", async () => {
    handler = (req, res) => {
      if (req.method === "DELETE") {
        return writeResetBody(res, 409, {
          error: { code: "job_not_terminal", message: "Job is still running." },
        });
      }
      res.writeHead(500);
      res.end();
    };

    const response = await deleteJob(
      new Request("http://localhost/api/optimize/opt_int", { method: "DELETE" }),
      params("opt_int"),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "backend_unreachable", message: "The scheduling service is unreachable." },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("still relays the bodyless 204 DELETE special case unchanged", async () => {
    handler = (req, res) => {
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(500);
      res.end();
    };

    const response = await deleteJob(
      new Request("http://localhost/api/optimize/opt_int", { method: "DELETE" }),
      params("opt_int"),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});

describe("SSE over real transport", () => {
  it("closes the real upstream socket when the downstream request aborts", async () => {
    let upstreamClosed = false;
    handler = (req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });
      res.write('event: status\ndata: {"status":"running"}\n\n');
      req.on("close", () => {
        upstreamClosed = true;
      });
    };

    const ac = new AbortController();
    const response = await events(
      new Request("http://localhost/api/optimize/opt_int/events", { signal: ac.signal }),
      params("opt_int"),
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const reader = response.body!.getReader();
    await reader.read(); // ensure the upstream connection is live

    ac.abort(); // downstream disconnect

    await vi.waitFor(() => expect(upstreamClosed).toBe(true), { timeout: 3_000 });

    await reader.cancel().catch(() => {});
  });

  it("relays a successfully-read non-2xx error body verbatim (regression)", async () => {
    handler = (req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "job_not_found" } }));
    };

    const response = await events(
      new Request("http://localhost/api/optimize/opt_int/events"),
      params("opt_int"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "job_not_found" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("maps a reset/truncated non-2xx error body to a code-first 502 (T06r4)", async () => {
    handler = (req, res) => writeResetBody(res, 404, { error: { code: "job_not_found" } });

    const response = await events(
      new Request("http://localhost/api/optimize/opt_int/events"),
      params("opt_int"),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "backend_unreachable", message: "The scheduling service is unreachable." },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
