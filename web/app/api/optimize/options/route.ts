import {
  backendUnreachable,
  BACKEND_ROUTE_UNSUPPORTED,
  buildUpstreamHeaders,
  relayJsonResponse,
  upstreamUrl,
} from "@/lib/bff/upstream";
import {
  parseOptimizeOptionsPayload,
  type OptimizeOptionsResponse,
} from "@/app/api/optimize/options/validate";

// GET /api/optimize/options — the deployment's run options (api/optimize.py::
// get_optimization_options). Like /api/info, the body is strictly validated and the
// response RECONSTRUCTED from the allowlisted fields (`validate.ts`), never relayed.
//
// A backend that predates the endpoint routes the path to `/optimize/{job_id}` and
// answers a 404, so every upstream 404 becomes `backend_route_unsupported` and the
// client keeps the legacy defaults (v1 338b588). Other backend-authored errors are
// relayed as the other proxy routes do.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PATH = "/optimize/options";
const NO_STORE = { "cache-control": "no-store" };

function errorBody(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: NO_STORE });
}

export async function GET(request: Request): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(PATH), {
      method: "GET",
      headers: buildUpstreamHeaders(request, { accept: "application/json" }),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (error) {
    return backendUnreachable(error, PATH);
  }

  if (upstream.status === 404) {
    return errorBody(
      404,
      BACKEND_ROUTE_UNSUPPORTED,
      "The scheduling service does not advertise its run options.",
    );
  }
  if (upstream.status !== 200) return relayJsonResponse(upstream, PATH);

  let parsed: OptimizeOptionsResponse | null;
  try {
    parsed = parseOptimizeOptionsPayload(JSON.parse(await upstream.text()));
  } catch (error) {
    // A body that fails to read or is not JSON is as untrusted as a malformed one.
    console.error(`[bff] upstream ${PATH} body unreadable`, error);
    parsed = null;
  }
  if (parsed === null) {
    console.error(`[bff] upstream ${PATH} failed the closed options contract`);
    return errorBody(
      502,
      "invalid_upstream_response",
      "The scheduling service returned invalid run options.",
    );
  }
  const body: OptimizeOptionsResponse = {
    timeout: {
      default: parsed.timeout.default,
      minimum: parsed.timeout.minimum,
      maximum: parsed.timeout.maximum,
    },
  };
  return Response.json(body, { status: 200, headers: NO_STORE });
}
