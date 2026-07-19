import { withReadinessGate } from "@/lib/bff/readiness";
import { proxyJsonRequest } from "@/lib/bff/upstream";

// POST /api/optimize/{id}/finish-now — proxy of api/optimize.py::finish_job_now.
// Asks a supported running solver to return its current feasible result early. The
// server owns whether this is permitted (`controls.early_completion_available`); a
// code-first 404/409 relays verbatim. This replaces the removed client heartbeat:
// browser liveness no longer drives any job lifecycle (tech-plan §5). Fails closed
// when the backend is unready.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withReadinessGate(
  async (request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
    const { id } = await params;
    return proxyJsonRequest(request, {
      method: "POST",
      path: `/optimize/${encodeURIComponent(id)}/finish-now`,
    });
  },
);
