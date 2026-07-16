import {
  applyRewrittenSetCookies,
  copyAllowedHeaders,
  XLSX_RESPONSE_HEADERS,
} from "@/lib/bff/headers";
import {
  backendUnreachable,
  buildUpstreamHeaders,
  relayJsonResponse,
  upstreamUrl,
} from "@/lib/bff/upstream";

// GET /api/optimize/{id}/xlsx — download (serve.py::download_optimize_job_xlsx).
// On success: stream the workbook, preserving Content-Disposition / X-Schedule-Score
// / X-Schedule-Status. On error: relay JSON verbatim — a structured 404 "No feasible
// solution is available." is a terminal no-result (NOT expiry), a 409 "Result is not
// ready yet." is non-terminal; the client classifies via `classifyOptimizeError`.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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
    return relayJsonResponse(upstream);
  }

  const headers = copyAllowedHeaders(upstream.headers, XLSX_RESPONSE_HEADERS);
  headers.set("cache-control", "no-store");
  applyRewrittenSetCookies(headers, upstream);

  return new Response(upstream.body, { status: upstream.status, headers });
}
