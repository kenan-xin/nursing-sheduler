import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/optimize/options/route";

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  ) as typeof fetch;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const request = () => new Request("http://app.test/api/optimize/options");

// core/nurse_scheduling/server/api/schemas.py::OptimizationOptionsResponse.from_settings
function coreOptions() {
  return {
    schema_version: "alpha",
    solver: {
      default: "ortools/cp-sat",
      choices: [
        {
          value: "ortools/cp-sat",
          label: "OR-Tools | CP-SAT",
          compute: "cpu",
          timeout: { default: 120, minimum: 10, maximum: 600 },
          controls: { cancel_running: true, finish_now: true },
        },
      ],
    },
    prettify: { default: true },
  };
}

beforeEach(() => {
  process.env.BACKEND_API_URL = "http://backend:8000";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BACKEND_API_URL;
  vi.restoreAllMocks();
});

describe("GET /api/optimize/options", () => {
  it("proxies the backend options and relays only the default solver's timeout", async () => {
    let seen = "";
    mockFetch((url) => {
      seen = url;
      return json(200, coreOptions());
    });
    const response = await GET(request());
    expect(seen).toBe("http://backend:8000/optimize/options");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Core-only keys (schema_version, solver choices, prettify) never reach the browser.
    expect(await response.json()).toEqual({
      timeout: { default: 120, minimum: 10, maximum: 600 },
    });
  });

  it("picks the timeout of the advertised default solver", async () => {
    const body = coreOptions();
    body.solver.choices.unshift({
      ...body.solver.choices[0],
      value: "ortools/mathopt/highs",
      label: "HiGHS",
      timeout: { default: 5, minimum: 1, maximum: 10 },
    });
    mockFetch(() => json(200, body));
    expect(await (await GET(request())).json()).toEqual({
      timeout: { default: 120, minimum: 10, maximum: 600 },
    });
  });

  it("reports a backend that predates the endpoint as unsupported (404)", async () => {
    // An older core routes `/optimize/options` to `/optimize/{job_id}`: a code-first 404.
    mockFetch(() => json(404, { error: { code: "job_not_found", message: "Job not found" } }));
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "backend_route_unsupported", message: expect.any(String) },
    });
  });

  it("fails closed when the backend is unreachable, without leaking its URL", async () => {
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const response = await GET(request());
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("backend_unreachable");
    expect(text).not.toContain("backend:8000");
  });

  it("relays a backend-authored error other than 404", async () => {
    mockFetch(() => json(401, { detail: "Not authenticated" }));
    const response = await GET(request());
    expect(response.status).toBe(401);
  });

  const mutations: Array<[string, (body: ReturnType<typeof coreOptions>) => unknown]> = [
    ["a non-object body", () => [1, 2]],
    ["an unknown schema version", (b) => ({ ...b, schema_version: "beta" })],
    ["an extra top-level key", (b) => ({ ...b, backend_url: "http://x" })],
    ["a missing prettify", ({ prettify: _p, ...rest }) => rest],
    ["a non-boolean prettify default", (b) => ({ ...b, prettify: { default: "yes" } })],
    ["no choices", (b) => ({ ...b, solver: { ...b.solver, choices: [] } })],
    [
      "a default solver not among the choices",
      (b) => ({ ...b, solver: { ...b.solver, default: "x" } }),
    ],
    ["a fractional timeout", (b) => withTimeout(b, { default: 1.5, minimum: 1, maximum: 600 })],
    ["a zero minimum", (b) => withTimeout(b, { default: 5, minimum: 0, maximum: 600 })],
    [
      "a default below the minimum",
      (b) => withTimeout(b, { default: 5, minimum: 10, maximum: 600 }),
    ],
    [
      "a default above the maximum",
      (b) => withTimeout(b, { default: 700, minimum: 10, maximum: 600 }),
    ],
    [
      "an extra timeout key",
      (b) => withTimeout(b, { default: 120, minimum: 10, maximum: 600, step: 1 }),
    ],
    ["an unknown compute kind", (b) => withChoice(b, { compute: "tpu" })],
    [
      "a non-boolean control",
      (b) => withChoice(b, { controls: { cancel_running: 1, finish_now: true } }),
    ],
    ["an empty label", (b) => withChoice(b, { label: "" })],
  ];

  it.each(mutations)("rejects %s as an invalid upstream response", async (_name, mutate) => {
    mockFetch(() => json(200, mutate(coreOptions())));
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "invalid_upstream_response", message: expect.any(String) },
    });
  });

  it("rejects a body that is not JSON", async () => {
    mockFetch(() => new Response("<html>", { status: 200 }));
    expect((await GET(request())).status).toBe(502);
  });
});

function withChoice(body: ReturnType<typeof coreOptions>, over: Record<string, unknown>) {
  return {
    ...body,
    solver: { ...body.solver, choices: [{ ...body.solver.choices[0], ...over }] },
  };
}

function withTimeout(body: ReturnType<typeof coreOptions>, timeout: Record<string, unknown>) {
  return withChoice(body, { timeout });
}
