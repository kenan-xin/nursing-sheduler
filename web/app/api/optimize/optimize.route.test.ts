import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as submit } from "@/app/api/optimize/route";
import { DELETE as deleteJob, GET as poll } from "@/app/api/optimize/[id]/route";
import { POST as cancel } from "@/app/api/optimize/[id]/cancel/route";
import { POST as finishNow } from "@/app/api/optimize/[id]/finish-now/route";
import { GET as downloadXlsx } from "@/app/api/optimize/[id]/xlsx/route";
import { GET as events } from "@/app/api/optimize/[id]/events/route";

type FetchArgs = { url: string; init: (RequestInit & { duplex?: string }) | undefined };

const originalFetch = globalThis.fetch;
let calls: FetchArgs[];

// The readiness gate probes `/ready` before every business route. Tests assert on
// BUSINESS calls (everything but the probe) so the extra hop stays invisible.
const businessCalls = () => calls.filter((c) => !c.url.endsWith("/ready"));
const READY = () => new Response(JSON.stringify({ status: "ready" }), { status: 200 });
const UNREADY = () => new Response(JSON.stringify({ status: "unavailable" }), { status: 503 });

// Answer `/ready` as ready, and delegate every business URL to `business`.
function mockUpstream(business: (args: FetchArgs) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const args: FetchArgs = { url: String(input), init };
    calls.push(args);
    if (args.url.endsWith("/ready")) return READY();
    return business(args);
  }) as typeof fetch;
}

// Answer `/ready` as unready; any business call is a bug (the gate must fail closed).
function mockUnready() {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const args: FetchArgs = { url: String(input), init };
    calls.push(args);
    if (args.url.endsWith("/ready")) return UNREADY();
    throw new Error(`business request forwarded to an unready backend: ${args.url}`);
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
        "nurse_scheduling_client_id=new; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800",
      );
      return new Response(JSON.stringify({ id: "opt_1", state: "queued" }), {
        status: 202,
        headers,
      });
    });

    const request = new Request("http://localhost/api/optimize", {
      method: "POST",
      body: '--b\r\nContent-Disposition: form-data; name="file"; filename="s.yaml"\r\n\r\nx\r\n--b--\r\n',
      headers: {
        "content-type": "multipart/form-data; boundary=b",
        cookie: "theme=dark; nurse_scheduling_client_id=abc; noise=1",
      },
    });

    const response = await submit(request);

    expect(response.status).toBe(202);
    expect(businessCalls()).toHaveLength(1);
    const { url, init } = businessCalls()[0];
    expect(url).toBe("http://backend:8000/optimize");
    expect(init?.duplex).toBe("half");
    expect(init?.method).toBe("POST");
    const upstreamHeaders = init?.headers as Headers;
    expect(upstreamHeaders.get("content-type")).toBe("multipart/form-data; boundary=b");
    // Only the single client-id cookie is forwarded — never the whole jar.
    expect(upstreamHeaders.get("cookie")).toBe("nurse_scheduling_client_id=abc");
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
        "nurse_scheduling_client_id=new; HttpOnly; SameSite=Lax; Path=/",
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

  it("preserves a structured pre-job 422 envelope verbatim (no reinterpretation)", async () => {
    const body = {
      error: {
        code: "unsupported_solver",
        message: "Unsupported solver. Only ortools/cp-sat is available.",
        issues: [{ path: ["solver"], code: "unsupported_value", message: "x" }],
      },
    };
    mockUpstream(
      () =>
        new Response(JSON.stringify(body), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
    );

    const request = new Request("http://localhost/api/optimize", {
      method: "POST",
      body: "x",
      headers: { "content-type": "multipart/form-data; boundary=b" },
    });
    const response = await submit(request);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(body);
  });

  it("returns 400 when the Content-Type is missing (before reaching upstream)", async () => {
    mockUpstream(() => new Response("{}", { status: 202 }));
    const request = new Request("http://localhost/api/optimize", { method: "POST", body: "x" });
    request.headers.delete("content-type");
    const response = await submit(request);
    expect(response.status).toBe(400);
    expect(businessCalls()).toHaveLength(0);
  });
});

describe("GET /api/optimize/{id} (poll)", () => {
  it("relays a code-first job_not_found verbatim for the client to classify", async () => {
    const body = { error: { code: "job_not_found", message: "Optimization job not found" } };
    mockUpstream(() => new Response(JSON.stringify(body), { status: 404 }));
    const response = await poll(
      new Request("http://localhost/api/optimize/opt_x"),
      params("opt_x"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(body);
    expect(businessCalls()[0].url).toBe("http://backend:8000/optimize/opt_x");
  });

  it("relays a 200 snake_case job body", async () => {
    mockUpstream(
      () => new Response(JSON.stringify({ id: "opt_x", state: "running" }), { status: 200 }),
    );
    const response = await poll(
      new Request("http://localhost/api/optimize/opt_x"),
      params("opt_x"),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).state).toBe("running");
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
    expect((await response.json()).error.code).toBe("backend_unreachable");
  });
});

describe("DELETE /api/optimize/{id} (cleanup)", () => {
  it("relays a 204 with no body and forwards DELETE + only the client-id cookie", async () => {
    mockUpstream(() => new Response(null, { status: 204 }));
    const response = await deleteJob(
      new Request("http://localhost/api/optimize/opt_x", {
        method: "DELETE",
        headers: { cookie: "theme=dark; nurse_scheduling_client_id=abc; noise=1" },
      }),
      params("opt_x"),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { url, init } = businessCalls()[0];
    expect(url).toBe("http://backend:8000/optimize/opt_x");
    expect(init?.method).toBe("DELETE");
    const upstreamHeaders = init?.headers as Headers;
    expect(upstreamHeaders.get("cookie")).toBe("nurse_scheduling_client_id=abc");
  });

  it("relays a code-first 409 (job not terminal) verbatim for the client to classify", async () => {
    const body = {
      error: { code: "job_not_terminal", message: "Only a terminal job can be deleted" },
    };
    mockUpstream(
      () =>
        new Response(JSON.stringify(body), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await deleteJob(
      new Request("http://localhost/api/optimize/opt_x", { method: "DELETE" }),
      params("opt_x"),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(body);
  });

  it("returns 502 (never the upstream URL) when the backend is unreachable", async () => {
    mockUpstream(() => {
      throw new TypeError("fetch failed");
    });
    const response = await deleteJob(
      new Request("http://localhost/api/optimize/opt_x", { method: "DELETE" }),
      params("opt_x"),
    );

    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("backend_unreachable");
  });
});

describe("POST /api/optimize/{id}/finish-now", () => {
  it("proxies to the backend finish-now route", async () => {
    mockUpstream(
      () => new Response(JSON.stringify({ id: "opt_x", state: "cancelling" }), { status: 202 }),
    );
    const response = await finishNow(
      new Request("http://localhost/api/optimize/opt_x/finish-now", { method: "POST" }),
      params("opt_x"),
    );
    expect(response.status).toBe(202);
    expect(businessCalls()[0].url).toBe("http://backend:8000/optimize/opt_x/finish-now");
    expect(businessCalls()[0].init?.method).toBe("POST");
  });
});

describe("POST /api/optimize/{id}/cancel", () => {
  it("proxies to the backend cancel route", async () => {
    mockUpstream(
      () => new Response(JSON.stringify({ id: "opt_x", state: "cancelling" }), { status: 202 }),
    );
    const response = await cancel(
      new Request("http://localhost/api/optimize/opt_x/cancel", { method: "POST" }),
      params("opt_x"),
    );
    expect(response.status).toBe(202);
    expect(businessCalls()[0].url).toBe("http://backend:8000/optimize/opt_x/cancel");
  });
});

describe("GET /api/optimize/{id}/xlsx", () => {
  it("preserves only Content-Disposition on success (score/status come from JobResponse.result)", async () => {
    mockUpstream(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content-disposition": 'attachment; filename="schedule.xlsx"',
          },
        }),
    );

    const response = await downloadXlsx(
      new Request("http://localhost/api/optimize/opt_x/xlsx"),
      params("opt_x"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="schedule.xlsx"',
    );
    // The old score/status headers are gone from the contract.
    expect(response.headers.get("x-schedule-score")).toBeNull();
    expect(response.headers.get("x-schedule-status")).toBeNull();
  });

  it("relays a code-first no-artifact error verbatim", async () => {
    const body = {
      error: { code: "job_artifact_not_found", message: "No schedule is available." },
    };
    mockUpstream(
      () =>
        new Response(JSON.stringify(body), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await downloadXlsx(
      new Request("http://localhost/api/optimize/opt_x/xlsx"),
      params("opt_x"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(body);
  });
});

describe("GET /api/optimize/{id}/events (SSE passthrough + cancel + reconnect)", () => {
  function streamResponse(onCancel: () => void): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'id: v1.a.b\nevent: job.state_changed\ndata: {"state":"running"}\n\n',
          ),
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

  it("forwards the Last-Event-ID reconnect header upstream", async () => {
    let forwarded: string | null = null;
    mockUpstream(({ init }) => {
      const headers = init?.headers as Headers;
      forwarded = headers.get("last-event-id");
      return streamResponse(() => {});
    });
    const response = await events(
      new Request("http://localhost/api/optimize/opt_x/events", {
        headers: { "last-event-id": "v1.job.cursor" },
      }),
      params("opt_x"),
    );
    expect(forwarded).toBe("v1.job.cursor");
    await response.body?.cancel();
  });

  it("does not set Last-Event-ID upstream when the client has no cursor", async () => {
    let hasHeader = true;
    mockUpstream(({ init }) => {
      const headers = init?.headers as Headers;
      hasHeader = headers.has("last-event-id");
      return streamResponse(() => {});
    });
    const response = await events(
      new Request("http://localhost/api/optimize/opt_x/events"),
      params("opt_x"),
    );
    expect(hasHeader).toBe(false);
    await response.body?.cancel();
  });

  it("cancels the upstream body when the downstream response is cancelled", async () => {
    let upstreamCancelled = false;
    mockUpstream(() => streamResponse(() => (upstreamCancelled = true)));

    const response = await events(
      new Request("http://localhost/api/optimize/opt_x/events"),
      params("opt_x"),
    );
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

  it("relays a non-2xx (code-first expired cursor) as JSON, not a stream", async () => {
    const body = {
      error: {
        code: "event_cursor_expired",
        message: "Requested event history is no longer retained.",
        oldest_event_id: "v1.a.b",
      },
    };
    mockUpstream(
      () =>
        new Response(JSON.stringify(body), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await events(
      new Request("http://localhost/api/optimize/opt_x/events"),
      params("opt_x"),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(body);
  });
});

describe("readiness gate fails closed on every business route", () => {
  const cases: Array<[string, () => Promise<Response>]> = [
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
    ["poll", () => poll(new Request("http://localhost/api/optimize/opt_x"), params("opt_x"))],
    [
      "delete",
      () =>
        deleteJob(
          new Request("http://localhost/api/optimize/opt_x", { method: "DELETE" }),
          params("opt_x"),
        ),
    ],
    [
      "cancel",
      () =>
        cancel(
          new Request("http://localhost/api/optimize/opt_x/cancel", { method: "POST" }),
          params("opt_x"),
        ),
    ],
    [
      "finish-now",
      () =>
        finishNow(
          new Request("http://localhost/api/optimize/opt_x/finish-now", { method: "POST" }),
          params("opt_x"),
        ),
    ],
    [
      "events",
      () => events(new Request("http://localhost/api/optimize/opt_x/events"), params("opt_x")),
    ],
    [
      "xlsx",
      () => downloadXlsx(new Request("http://localhost/api/optimize/opt_x/xlsx"), params("opt_x")),
    ],
  ];

  it.each(cases)(
    "%s returns 503 and forwards no business request when unready",
    async (_name, run) => {
      mockUnready();
      const response = await run();
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("backend_unready");
      expect(businessCalls()).toHaveLength(0);
    },
  );
});
