import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  server = createServer((req, res) => handler(req, res));
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
});
