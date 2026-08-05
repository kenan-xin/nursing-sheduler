import { withReadinessGate } from "@/lib/bff/readiness";
import { proxyJsonRequest } from "@/lib/bff/upstream";

// GET /api/optimize/{id}/roster — fetch the structured roster container
// (api/optimize.py::get_roster). On success: relay the backend's
// `application/json` body verbatim — the captured shape is the authoritative
// v1 container minus `xlsx.base64` (B2 / tech-plan §2). On error: relay the
// code-first JSON verbatim (`job_not_found` is recovery, `job_artifact_not_ready`
// maps to the shared `no-artifact` kind, `roster_container_invalid` surfaces as
// a 5xx `server-error`); the client classifies via `classifyOptimizeError` with
// the `roster` endpoint. Fails closed when the backend is unready.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withReadinessGate(
  async (request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
    const { id } = await params;
    return proxyJsonRequest(request, {
      method: "GET",
      path: `/optimize/${encodeURIComponent(id)}/roster`,
    });
  },
);
