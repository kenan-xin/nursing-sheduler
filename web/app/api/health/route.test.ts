import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";

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

async function expectUnreachable(response: Response) {
  expect(response.status).toBe(502);
  const parsedBody = await response.json();
  expect(parsedBody).toEqual({ status: "unreachable" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  // The private backend URL must never reach the browser (DL11 D1).
  expect(JSON.stringify(parsedBody)).not.toContain("backend:8000");
}

describe("GET /api/health — passthrough", () => {
  it("proxies a healthy upstream verbatim (status + body + content-type)", async () => {
    const healthBody = JSON.stringify({ status: "ok", appVersion: "v1.2.3" });
    mockFetch((url) => {
      expect(url).toBe("http://backend:8000/health");
      return new Response(healthBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(healthBody);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("relays a non-OK backend status verbatim so the deploy probe can see an outage", async () => {
    const body = JSON.stringify({ status: "unavailable" });
    mockFetch(
      () => new Response(body, { status: 503, headers: { "content-type": "application/json" } }),
    );

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("bounds the private hop with redirect:manual and an AbortSignal", async () => {
    let seenInit: RequestInit | undefined;
    mockFetch((_url, init) => {
      seenInit = init;
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    });

    await GET();

    expect(seenInit?.redirect).toBe("manual");
    expect(seenInit?.cache).toBe("no-store");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("GET /api/health — bounded failures", () => {
  it("returns a bounded 502 (not a hang) when the request aborts on the timeout", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // Model the bounded AbortSignal.timeout firing: fetch rejects with an
    // AbortError, exactly as it would when the backend deadlocks past the deadline
    // instead of blocking up to undici's ~300s default.
    mockFetch(() => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    await expectUnreachable(await GET());
    expect(consoleError).toHaveBeenCalled();
  });

  it("returns a bounded 502 when a never-resolving fetch is aborted by the passed signal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A fetch that never settles on its own — it rejects only when the deadline
    // aborts the signal the route attached, proving the request is unblocked
    // rather than hanging.
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () =>
            reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort);
        }),
    );
    // Fire the bound immediately so the test stays fast while still exercising the
    // real signal wiring the route sets up.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new DOMException("The operation was aborted.", "AbortError")),
    );

    await expectUnreachable(await GET());
  });

  it("fails code-first (502) on a connection failure without leaking the backend URL", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch(() => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:8000");
    });

    await expectUnreachable(await GET());
    expect(consoleError).toHaveBeenCalled();
  });

  it("treats an unexpected backend redirect (opaqueredirect) as unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // `redirect: "manual"` surfaces a backend 3xx as an opaque redirect (status 0);
    // relaying that verbatim would break the Response constructor, so it is
    // treated as unreachable.
    mockFetch(() => ({ type: "opaqueredirect", status: 0 }) as unknown as Response);

    await expectUnreachable(await GET());
  });
});
