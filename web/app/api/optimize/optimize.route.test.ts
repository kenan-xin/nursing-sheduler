import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as submit } from "@/app/api/optimize/route";
import { GET as poll } from "@/app/api/optimize/[id]/route";
import { GET as downloadXlsx } from "@/app/api/optimize/[id]/xlsx/route";
import { GET as events } from "@/app/api/optimize/[id]/events/route";

type FetchArgs = { url: string; init: (RequestInit & { duplex?: string }) | undefined };

const originalFetch = globalThis.fetch;
let calls: FetchArgs[];

function mockUpstream(handler: (args: FetchArgs) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const args: FetchArgs = { url: String(input), init };
    calls.push(args);
    return handler(args);
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.BACKEND_API_URL = "http://backend:8000";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BACKEND_API_URL;
  delete process.env.PUBLIC_ORIGIN;
  vi.restoreAllMocks();
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/optimize (multipart submit)", () => {
  it("pipes the body with duplex:'half', forwards the exact Content-Type + synthesized cookie", async () => {
    process.env.PUBLIC_ORIGIN = "https://nursescheduling.org";
    mockUpstream(() => {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append(
        "set-cookie",
        "nurse_scheduling_client_uuid=new; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000",
      );
      return new Response(JSON.stringify({ jobId: "opt_1", status: "queued" }), {
        status: 202,
        headers,
      });
    });

    const request = new Request("http://localhost/api/optimize", {
      method: "POST",
      body: '--b\r\nContent-Disposition: form-data; name="file"; filename="s.yaml"\r\n\r\nx\r\n--b--\r\n',
      headers: {
        "content-type": "multipart/form-data; boundary=b",
        cookie: "theme=dark; nurse_scheduling_client_uuid=abc; noise=1",
      },
    });

    const response = await submit(request);

    expect(response.status).toBe(202);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("http://backend:8000/optimize");
    expect(init?.duplex).toBe("half");
    expect(init?.method).toBe("POST");
    const upstreamHeaders = init?.headers as Headers;
    expect(upstreamHeaders.get("content-type")).toBe("multipart/form-data; boundary=b");
    // Only the single client-uuid cookie is forwarded — never the whole jar.
    expect(upstreamHeaders.get("cookie")).toBe("nurse_scheduling_client_uuid=abc");
    // The body is the untouched request stream.
    expect(init?.body).toBe(request.body);

    // HTTPS public origin ⇒ Secure added, other attributes preserved.
    const setCookie = response.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toMatch(/Secure/);
    expect(setCookie[0]).toMatch(/HttpOnly/);
    expect(setCookie[0]).toMatch(/SameSite=Lax/);
  });

  it("omits Secure on an http://localhost public origin (dev works)", async () => {
    process.env.PUBLIC_ORIGIN = "http://localhost:3000";
    mockUpstream(() => {
      const headers = new Headers();
      headers.append(
        "set-cookie",
        "nurse_scheduling_client_uuid=new; HttpOnly; SameSite=Lax; Path=/",
      );
      return new Response("{}", { status: 202, headers });
    });

    const request = new Request("http://localhost/api/optimize", {
      method: "POST",
      body: "x",
      headers: { "content-type": "multipart/form-data; boundary=b" },
    });
    const response = await submit(request);

    const setCookie = response.headers.getSetCookie();
    expect(setCookie[0]).not.toMatch(/Secure/i);
  });

  it("preserves the exact 413 (Scheduling YAML is too large)", async () => {
    mockUpstream(
      () =>
        new Response(JSON.stringify({ detail: "Scheduling YAML is too large" }), { status: 413 }),
    );

    const request = new Request("http://localhost/api/optimize", {
      method: "POST",
      body: "x",
      headers: { "content-type": "multipart/form-data; boundary=b" },
    });
    const response = await submit(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ detail: "Scheduling YAML is too large" });
  });

  it("returns 400 when the Content-Type is missing (before reaching upstream)", async () => {
    mockUpstream(() => new Response("{}", { status: 202 }));
    const request = new Request("http://localhost/api/optimize", { method: "POST", body: "x" });
    // Node infers a text content-type from a string body, so drop it explicitly.
    request.headers.delete("content-type");
    const response = await submit(request);
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("GET /api/optimize/{id} (poll)", () => {
  it("relays a plain 404 verbatim for the client to classify as expired", async () => {
    mockUpstream(
      () => new Response(JSON.stringify({ detail: "Optimization job not found" }), { status: 404 }),
    );
    const response = await poll(
      new Request("http://localhost/api/optimize/opt_x"),
      params("opt_x"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "Optimization job not found" });
    expect(calls[0].url).toBe("http://backend:8000/optimize/opt_x");
  });

  it("relays a 200 job body", async () => {
    mockUpstream(
      () => new Response(JSON.stringify({ jobId: "opt_x", status: "running" }), { status: 200 }),
    );
    const response = await poll(
      new Request("http://localhost/api/optimize/opt_x"),
      params("opt_x"),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("running");
  });

  it("returns 502 (never the upstream URL) when the backend is unreachable", async () => {
    mockUpstream(() => {
      throw new TypeError("fetch failed");
    });
    const response = await poll(
      new Request("http://localhost/api/optimize/opt_x"),
      params("opt_x"),
    );
    expect(response.status).toBe(502);
  });
});

describe("GET /api/optimize/{id}/xlsx", () => {
  it("preserves the schedule headers end-to-end on success", async () => {
    mockUpstream(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content-disposition": "attachment; filename=schedule.xlsx",
            "x-schedule-score": "42",
            "x-schedule-status": "OPTIMAL",
          },
        }),
    );

    const response = await downloadXlsx(
      new Request("http://localhost/api/optimize/opt_x/xlsx"),
      params("opt_x"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=schedule.xlsx");
    expect(response.headers.get("x-schedule-score")).toBe("42");
    expect(response.headers.get("x-schedule-status")).toBe("OPTIMAL");
  });

  it("relays the structured 404 (no feasible solution) verbatim", async () => {
    mockUpstream(
      () =>
        new Response(
          JSON.stringify({
            detail: { message: "No feasible solution is available.", status: "infeasible" },
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const response = await downloadXlsx(
      new Request("http://localhost/api/optimize/opt_x/xlsx"),
      params("opt_x"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).detail.message).toBe("No feasible solution is available.");
  });
});

describe("GET /api/optimize/{id}/events (SSE passthrough + cancel)", () => {
  function streamResponse(onCancel: () => void): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: status\ndata: {"status":"running"}\n\n'),
        );
      },
      cancel() {
        onCancel();
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }

  it("preserves SSE headers", async () => {
    mockUpstream(() => streamResponse(() => {}));
    const response = await events(
      new Request("http://localhost/api/optimize/opt_x/events"),
      params("opt_x"),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await response.body?.cancel();
  });

  it("cancels the upstream body when the downstream response is cancelled", async () => {
    let upstreamCancelled = false;
    mockUpstream(() => streamResponse(() => (upstreamCancelled = true)));

    const response = await events(
      new Request("http://localhost/api/optimize/opt_x/events"),
      params("opt_x"),
    );
    // Simulate Next tearing down the downstream stream on client disconnect.
    await response.body?.cancel();
    expect(upstreamCancelled).toBe(true);
  });

  it("aborts the upstream fetch when the inbound request signal aborts", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockUpstream(({ init }) => {
      capturedSignal = init?.signal ?? undefined;
      return streamResponse(() => {});
    });

    const controller = new AbortController();
    const request = new Request("http://localhost/api/optimize/opt_x/events", {
      signal: controller.signal,
    });
    const response = await events(request, params("opt_x"));
    expect(capturedSignal?.aborted).toBe(false);

    controller.abort();
    expect(capturedSignal?.aborted).toBe(true);
    await response.body?.cancel().catch(() => {});
  });

  it("relays a non-2xx (expired job) as a JSON error, not a stream", async () => {
    mockUpstream(
      () =>
        new Response(JSON.stringify({ detail: "Optimization job not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await events(
      new Request("http://localhost/api/optimize/opt_x/events"),
      params("opt_x"),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ detail: "Optimization job not found" });
  });
});
