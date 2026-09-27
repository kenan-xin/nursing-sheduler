import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/info/route";

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  ) as typeof fetch;
}

beforeEach(() => {
  process.env.BACKEND_API_URL = "http://backend:8000";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BACKEND_API_URL;
  vi.restoreAllMocks();
});

// The backend's SCHEDULING-SEMANTICS profile (T08), a sibling of the identity
// rather than more identity keys: `runtime_identity` is embedded verbatim in job
// events under a closed key set, so the profile must not live inside it.
const SEMANTIC_PROFILE = {
  submission_contract_version: "optimize-yaml-v1",
  solver_semantic_version: "ortools/cp-sat@1",
  backend_capability_version: "nurse-scheduling-backend@1",
};

const READY_IDENTITY = {
  status: "ready",
  service_name: "nurse-scheduling-api",
  api_version: "0.2.0",
  app_version: "v1.2.3",
  deployment_id: "dep-1",
  instance_id: "inst-1",
  started_at: "2026-07-19T00:00:00+00:00",
  job_backend: "memory",
  job_store_id: "inst-1",
  semantic_profile: SEMANTIC_PROFILE,
};

const UNAVAILABLE_IDENTITY = {
  status: "unavailable",
  reason: "job_store_unavailable",
  service_name: "nurse-scheduling-api",
  api_version: "0.2.0",
  app_version: "v1.2.3",
  deployment_id: "dep-1",
  instance_id: "inst-1",
  started_at: "2026-07-19T00:00:00+00:00",
  job_backend: "memory",
  job_store_id: "inst-1",
  semantic_profile: SEMANTIC_PROFILE,
};

// Core-owned `/info` keys (v1 sync X8). The BFF checks them strictly but never
// relays them, so the browser body stays exactly READY_IDENTITY / UNAVAILABLE_IDENTITY.
const CORE_AUTH = { required: false, scheme: "bearer" };
const READY_UPSTREAM = {
  ...READY_IDENTITY,
  auth: CORE_AUTH,
  claimed_performance: null,
  jobs: { running: 0, queued: 1, cancelling: 0 },
  workers: { online: 1 },
};
const UNAVAILABLE_UPSTREAM = {
  ...UNAVAILABLE_IDENTITY,
  auth: CORE_AUTH,
  claimed_performance: null,
};

async function expectRejectedAsInvalidUpstream(response: Response) {
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    status: "unavailable",
    reason: "invalid_upstream_response",
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
}

describe("GET /api/info — valid contract variants", () => {
  it("accepts the complete ready identity payload at HTTP 200", async () => {
    mockFetch((url) => {
      expect(url).toBe("http://backend:8000/info");
      return new Response(JSON.stringify(READY_UPSTREAM), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(READY_IDENTITY);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("accepts the complete unavailable identity payload with a string reason at HTTP 503", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify(UNAVAILABLE_UPSTREAM), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(UNAVAILABLE_IDENTITY);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("checks but never relays the core-owned activity, auth and benchmark keys", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            ...READY_UPSTREAM,
            claimed_performance: {
              score: 41.5,
              app_version: "v0.2.0-66-g959adc4",
              measured_at: "2026-08-28T19:12:54+00:00",
            },
          }),
          { status: 200 },
        ),
    );

    const body = await (await GET()).json();

    expect(body).toEqual(READY_IDENTITY);
    for (const key of ["jobs", "workers", "auth", "claimed_performance"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("reconstructs the body — no camelCase translation, every key stays snake_case", async () => {
    mockFetch(() => new Response(JSON.stringify(READY_UPSTREAM), { status: 200 }));

    const response = await GET();
    const body = await response.json();

    for (const key of Object.keys(body)) {
      expect(key).not.toMatch(/[A-Z]/);
    }
  });

  it("forces application/json regardless of a hostile upstream content type", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify(READY_UPSTREAM), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(READY_IDENTITY);
  });

  it("forces application/json when the upstream response has no content-type header at all", async () => {
    mockFetch(() => new Response(JSON.stringify(READY_UPSTREAM), { status: 200 }));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("does not leak arbitrary upstream headers (explicit allowlist — content-type/cache-control only)", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify(READY_UPSTREAM), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-upstream-secret": "should-not-leak",
            server: "uvicorn",
          },
        }),
    );

    const response = await GET();

    expect(response.headers.get("x-upstream-secret")).toBeNull();
    expect(response.headers.get("server")).toBeNull();
  });
});

describe("GET /api/info — connection/timeout failures", () => {
  it("fails code-first (502, backend_unreachable) on a connection failure, without leaking the backend URL", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch(() => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:8000");
    });

    const response = await GET();
    const parsedBody = await response.json();

    expect(response.status).toBe(502);
    expect(parsedBody).toEqual({ status: "unavailable", reason: "backend_unreachable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The private backend URL must never reach the browser (DL11 D1).
    expect(JSON.stringify(parsedBody)).not.toContain("backend:8000");
    expect(consoleError).toHaveBeenCalled();
  });

  it("fails code-first (502, backend_unreachable) when the bounded request times out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });

    const response = await GET();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ status: "unavailable", reason: "backend_unreachable" });
  });

  it("fails code-first (502, backend_unreachable) when the response body fails to read after headers arrive", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // fetch() itself resolves (headers arrived) but consuming the body — a reset,
    // a truncated declared length, or a stream read error — rejects afterward.
    const bodyReadFailure = new Error("terminated");
    mockFetch(
      () =>
        ({
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: () => Promise.reject(bodyReadFailure),
        }) as unknown as Response,
    );

    const response = await GET();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ status: "unavailable", reason: "backend_unreachable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("GET /api/info — closed-contract rejections (502 invalid_upstream_response)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("rejects malformed (non-JSON) upstream bodies", async () => {
    mockFetch(() => new Response("<html>not json</html>", { status: 200 }));
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects a hostile text/html body that is also not valid JSON", async () => {
    mockFetch(
      () =>
        new Response("<html>service down</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects a body with no status field at all", async () => {
    mockFetch(() => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects a JSON array body", async () => {
    mockFetch(() => new Response(JSON.stringify([1, 2, 3]), { status: 200 }));
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects an unknown status value", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ ...READY_UPSTREAM, status: "warming" }), { status: 200 }),
    );
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects a ready body missing a required identity field", async () => {
    const { job_store_id: _omit, ...incomplete } = READY_UPSTREAM;
    mockFetch(() => new Response(JSON.stringify(incomplete), { status: 200 }));
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects a ready body with a mistyped identity field", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ ...READY_UPSTREAM, instance_id: 12345 }), { status: 200 }),
    );
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects a ready body carrying an extra/private field (e.g. a leaked backend_url)", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ ...READY_UPSTREAM, backend_url: "http://backend:8000" }), {
          status: 200,
        }),
    );
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects a ready body without the core-owned jobs object", async () => {
    const { jobs: _omit, ...withoutJobs } = READY_UPSTREAM;
    mockFetch(() => new Response(JSON.stringify(withoutJobs), { status: 200 }));
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects a ready body whose worker count is not an integer", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ ...READY_UPSTREAM, workers: { online: "1" } }), {
          status: 200,
        }),
    );
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects a claimed performance that is not a complete, positive benchmark", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            ...READY_UPSTREAM,
            claimed_performance: {
              score: 0,
              app_version: "v1",
              measured_at: "2026-08-28T19:12:54+00:00",
            },
          }),
          { status: 200 },
        ),
    );
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects an unavailable body without the core-owned auth descriptor", async () => {
    const { auth: _omit, ...withoutAuth } = UNAVAILABLE_UPSTREAM;
    mockFetch(() => new Response(JSON.stringify(withoutAuth), { status: 503 }));
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects an unavailable body missing the required string reason", async () => {
    const { reason: _omit, ...withoutReason } = UNAVAILABLE_UPSTREAM;
    mockFetch(() => new Response(JSON.stringify(withoutReason), { status: 503 }));
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects an unavailable body with a mistyped reason", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ ...UNAVAILABLE_UPSTREAM, reason: 503 }), { status: 503 }),
    );
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects status:ready paired with HTTP 503 (status/body mismatch)", async () => {
    mockFetch(() => new Response(JSON.stringify(READY_UPSTREAM), { status: 503 }));
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects status:unavailable paired with HTTP 200 (status/body mismatch)", async () => {
    mockFetch(() => new Response(JSON.stringify(UNAVAILABLE_UPSTREAM), { status: 200 }));
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects a valid-looking ready body wrapped in an unexpected HTTP 500", async () => {
    mockFetch(() => new Response(JSON.stringify(READY_UPSTREAM), { status: 500 }));
    await expectRejectedAsInvalidUpstream(await GET());
  });

  it("rejects a reason field present on an otherwise-ready (status:ready) body", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ ...READY_UPSTREAM, reason: "job_store_unavailable" }), {
          status: 200,
        }),
    );
    await expectRejectedAsInvalidUpstream(await GET());
  });
});
