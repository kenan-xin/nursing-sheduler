import {
  applyRewrittenSetCookies,
  copyAllowedHeaders,
  XLSX_RESPONSE_HEADERS,
} from "@/lib/bff/headers";
import { withReadinessGate } from "@/lib/bff/readiness";
import {
  backendUnreachable,
  buildUpstreamHeaders,
  relayJsonResponse,
  upstreamUrl,
} from "@/lib/bff/upstream";

// GET /api/optimize/{id}/xlsx — download (api/optimize.py::download_xlsx). On
// success: stream the workbook, preserving only `Content-Disposition` (score/status
// now come from the retained `JobResponse.result`, tech-plan §5). On error: relay
// the code-first JSON verbatim — a `job_artifact_not_found`/`job_artifact_not_ready`
// is a no-download state, not job expiry; the client classifies via
// `classifyOptimizeError`. Fails closed when the backend is unready.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withReadinessGate(
  async (request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
    const { id } = await params;

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl(`/optimize/${encodeURIComponent(id)}/xlsx`), {
        method: "GET",
        headers: buildUpstreamHeaders(request),
        cache: "no-store",
        redirect: "manual",
      });
    } catch (error) {
      return backendUnreachable(error, `/optimize/${id}/xlsx`);
    }

    if (!upstream.ok || upstream.body === null) {
      return relayJsonResponse(upstream, `/optimize/${id}/xlsx`);
    }

    const headers = copyAllowedHeaders(upstream.headers, XLSX_RESPONSE_HEADERS);
    headers.set("cache-control", "no-store");
    applyRewrittenSetCookies(headers, upstream);

    return new Response(upstream.body, { status: upstream.status, headers });
  },
);
