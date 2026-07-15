import { getBackendApiUrl } from "@/lib/backend";

// Read-only health passthrough — the ONLY BFF route in this ticket (T02).
// It proxies the backend `GET /health` and returns its JSON verbatim (including
// `appVersion`), which the version-equality gate compares against the bundle's
// `NEXT_PUBLIC_APP_VERSION`. All other `/api/*` proxy routes are owned by T06.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const upstream = `${getBackendApiUrl()}/health`;

  try {
    const response = await fetch(upstream, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });

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
