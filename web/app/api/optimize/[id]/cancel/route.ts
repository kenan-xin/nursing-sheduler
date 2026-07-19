import { withReadinessGate } from "@/lib/bff/readiness";
import { proxyJsonRequest } from "@/lib/bff/upstream";

// POST /api/optimize/{id}/cancel — 1:1 proxy of api/optimize.py::cancel_job.
// Queued → cancelled immediately; running → cancelling (the final cancelled/failed
// state is decided by the solver and surfaced via SSE/poll — the BFF is
// transparent). Code-first 404/409 relay verbatim so the client keeps the
// endpoint-specific state. Fails closed when the backend is unready.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withReadinessGate(
  async (request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
    const { id } = await params;
    return proxyJsonRequest(request, {
      method: "POST",
      path: `/optimize/${encodeURIComponent(id)}/cancel`,
    });
  },
);
