import { getBackendApiUrl } from "@/lib/backend";

// Runtime readiness gate (tech-plan §2/§7, T02r F3 handoff). Compose `depends_on`
// only orders STARTUP — it is not a runtime circuit breaker. A Redis outage makes
// the backend's `/ready` return 503, but nothing stops the BFF from forwarding a
// business request into that unready backend. This guard closes that gap: before
// forwarding ANY optimization business request, probe the private backend `/ready`
// within a bounded deadline and FAIL CLOSED locally when it is unready, times out,
// or is unreachable — the business request is never forwarded.
//
// `/api/health` is deliberately NOT gated: it is a status passthrough, not a
// business gate (it must still report backend 503/502 so the deploy probe can see
// the outage).

// Bounded deadline for the readiness probe. Short: it is a private in-network hop
// to a liveness endpoint, and we must not let a hung backend stall every request.
export const READINESS_PROBE_TIMEOUT_MS = 2_000;

// A backend-unready fail-closed response, code-first so the client can classify it
// (`backend_unready`). Always 503 with `no-store`; the reason is logged server-side
// only, never leaked to the browser.
function backendUnready(): Response {
  return Response.json(
    { error: { code: "backend_unready", message: "The scheduling service is not ready." } },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

// The only trusted `/ready` shape: HTTP 200 with the exact closed body
// `{ "status": "ready" }` — no missing/extra/mistyped key, no other status value.
// Deliberately does not reuse `/api/info`'s identity contract (`app/api/info/validate.ts`):
// readiness only needs a boolean gate, not the broader diagnostic identity payload.
function isExactReadyBody(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "status") return false;
  return (body as Record<string, unknown>).status === "ready";
}

// Probe the backend `/ready`. Returns null when it is exactly ready (proceed), or
// a fail-closed 503 Response otherwise. Every failure mode — a non-200 status
// (including 204 and other 2xx), a malformed/mistyped/unknown-status body, a
// non-JSON body, a body-read reset/truncation after headers arrive, a
// bounded-deadline timeout, or a connection error — fails closed identically
// BEFORE any business handler runs, so a business request can never slip through
// to an unready or misreporting backend.
export async function checkBackendReady(): Promise<Response | null> {
  const upstreamUrl = `${getBackendApiUrl()}/ready`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(READINESS_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    // Timeout (AbortError) or connection failure — treat as unready, fail closed.
    console.error("[bff] readiness probe failed", error);
    return backendUnready();
  }

  if (upstream.status !== 200) {
    // Covers 204, every other non-200 status (2xx or otherwise), and an
    // HTTP/body mismatch such as a "ready" body wrapped in a non-200 response.
    console.warn(`[bff] backend not ready (status ${upstream.status})`);
    return backendUnready();
  }

  let rawBody: string;
  try {
    rawBody = await upstream.text();
  } catch (error) {
    // Headers arrived (fetch resolved) but the body stream itself failed — a
    // reset, a truncated declared length, or a read error. Fail closed exactly
    // like a connection failure rather than throwing to a framework 500.
    console.error("[bff] readiness probe body failed to read", error);
    return backendUnready();
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch (error) {
    // A hostile/missing upstream content-type never bypasses this: parsing
    // never trusts the media type, only whether the bytes are valid JSON.
    console.error("[bff] readiness probe body was not valid JSON", error);
    return backendUnready();
  }

  if (!isExactReadyBody(parsedBody)) {
    console.warn("[bff] readiness probe body failed the closed ready contract");
    return backendUnready();
  }
  return null;
}

// Wrap a business route handler so it fails closed unless the backend is ready.
// The probe runs BEFORE the handler, so a submit's request body is never consumed
// when the backend is unready. Works for handlers with or without a route context
// argument (`{ params }`).
export function withReadinessGate<Rest extends unknown[]>(
  handler: (request: Request, ...rest: Rest) => Promise<Response>,
): (request: Request, ...rest: Rest) => Promise<Response> {
  return async (request: Request, ...rest: Rest): Promise<Response> => {
    const unready = await checkBackendReady();
    if (unready !== null) return unready;
    return handler(request, ...rest);
  };
}
