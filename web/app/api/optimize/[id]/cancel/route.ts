import { proxyJsonRequest } from "@/lib/bff/upstream";

// POST /api/optimize/{id}/cancel — 1:1 proxy of serve.py::cancel_optimize_job
// (`_request_optimize_job_stop`). Queued → CANCELLED immediately; running →
// CANCELLING (final CANCELLED/FAILED is decided by the solver and surfaced via
// SSE/poll — the BFF is transparent). 404 unknown / 409 already-finished relay
// verbatim so the client keeps the endpoint-specific status.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyJsonRequest(request, {
    method: "POST",
    path: `/optimize/${encodeURIComponent(id)}/cancel`,
  });
}
