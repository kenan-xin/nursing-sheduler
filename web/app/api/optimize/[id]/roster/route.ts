import { withReadinessGate } from "@/lib/bff/readiness";
import { guardUnsupportedRoute, proxyJsonRequest } from "@/lib/bff/upstream";

// GET /api/optimize/{id}/roster — fetch the structured roster container
// (api/optimize.py::get_roster). On success: relay the backend's
// `application/json` body verbatim — the captured shape is the authoritative
// v1 container minus `xlsx.base64` (B2 / tech-plan §2). On error: relay the
// code-first JSON verbatim (`job_not_found` is recovery, `job_artifact_not_ready`
// maps to the shared `no-artifact` kind, `roster_container_invalid` surfaces as
// a 5xx `server-error`); the client classifies via `classifyOptimizeError` with
// the `roster` endpoint. Fails closed when the backend is unready.
//
// The ONE response not relayed verbatim is a 404 with no code-first envelope.
// This route is the newest of the optimize endpoints, so it is the first thing a
// stale or foreign backend fails to route — and FastAPI answers an unrouted path
// with the same 404 status the application uses for `job_not_found`. Verbatim,
// that reaches the user as a bare "Not Found" that looks like a vanished job,
// strands the terminal chain, and states no recovery. `guardUnsupportedRoute`
// turns it into a code-first 502 that names the real problem. It stays a failure:
// no roster is saved, no cleanup is authorized, and the run stays blocked.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROSTER_UNSUPPORTED =
  "The scheduling service this app is connected to does not support saving rosters, so it needs to be updated before rosters can be saved here.";

export const GET = withReadinessGate(
  async (request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
    const { id } = await params;
    const response = await proxyJsonRequest(request, {
      method: "GET",
      path: `/optimize/${encodeURIComponent(id)}/roster`,
    });
    return guardUnsupportedRoute(response, ROSTER_UNSUPPORTED);
  },
);
