import { applyRewrittenSetCookies } from "@/lib/bff/headers";
import { withReadinessGate } from "@/lib/bff/readiness";
import {
  backendUnreachable,
  buildUpstreamHeaders,
  proxyJsonRequest,
  relayJsonResponse,
  upstreamUrl,
} from "@/lib/bff/upstream";

// GET /api/optimize/{id} — poll job status (api/optimize.py::get_job). A code-first
// 404 `{error:{code:"job_not_found"}}` here is the recovery signal (expired /
// deleted / never existed); the client classifies it via `classifyOptimizeError`.
// Errors relay verbatim. Fails closed when the backend is unready.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withReadinessGate(
  async (request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
    const { id } = await params;
    return proxyJsonRequest(request, {
      method: "GET",
      path: `/optimize/${encodeURIComponent(id)}`,
    });
  },
);

// DELETE /api/optimize/{id} — delete a terminal job and its retained data
// (api/optimize.py::delete_job, 204). The public diagnostic's cleanup needs this
// on the same-origin surface; without it a public run cannot honor its deletion
// contract. Cookie-scoped like the other proxies (only the client-id cookie is
// forwarded). A success is 204 No Content — a null-body status, so it is relayed
// WITHOUT a body (relayJsonResponse always constructs a body and would throw on a
// null-body status); a code-first 404/409 (`job_not_found` / not terminal) relays
// verbatim for the client to classify. Fails closed when the backend is unready.
export const DELETE = withReadinessGate(
  async (request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
    const { id } = await params;
    const path = `/optimize/${encodeURIComponent(id)}`;

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl(path), {
        method: "DELETE",
        headers: buildUpstreamHeaders(request),
        cache: "no-store",
        redirect: "manual",
      });
    } catch (error) {
      return backendUnreachable(error, path);
    }

    if (upstream.status === 204) {
      const headers = new Headers({ "cache-control": "no-store" });
      applyRewrittenSetCookies(headers, upstream);
      return new Response(null, { status: 204, headers });
    }

    // Non-204 code-first envelope (404 job_not_found / 409 not terminal) — relay verbatim.
    return relayJsonResponse(upstream, path);
  },
);
