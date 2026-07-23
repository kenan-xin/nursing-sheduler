import { getBackendApiUrl } from "@/lib/backend";

// Read-only health passthrough — the ONLY BFF route in this ticket (T02).
// It proxies the backend `GET /health` and returns its JSON verbatim (including
// `appVersion`), which the version-equality gate compares against the bundle's
// `NEXT_PUBLIC_APP_VERSION`. All other `/api/*` proxy routes are owned by T06.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bounded deadline for the private in-network hop to `/health`, matching the
// `/info` proxy and readiness probe: a backend that accepts the connection then
// deadlocks before sending headers must never stall this request up to undici's
// ~300s default (deploy/version-gate polls would pile up open Next requests).
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;

export async function GET() {
  const upstream = `${getBackendApiUrl()}/health`;

  try {
    const response = await fetch(upstream, {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
    });

    if (response.type === "opaqueredirect") {
      // `redirect: "manual"` surfaces a backend 3xx as an opaque redirect (status
      // 0). A redirect from the health endpoint is unexpected — treat it as
      // unreachable rather than relaying a status-0 response.
      throw new Error(`unexpected redirect from health upstream (${response.status})`);
    }

    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    // The private backend URL must never reach the browser (DL11 D1). Log it
    // server-side only; return a generic status to the client.
    console.error(`[api/health] upstream unreachable: ${upstream}`, error);
    return Response.json(
      { status: "unreachable" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
