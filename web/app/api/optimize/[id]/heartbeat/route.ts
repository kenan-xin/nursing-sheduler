import { proxyJsonRequest } from "@/lib/bff/upstream";

// POST /api/optimize/{id}/heartbeat — proxy of serve.py::heartbeat_optimize_job.
// Returns `{ jobId, status }`. 404 unknown / 409 already-finished relay verbatim;
// the client stops heartbeating on either (every terminal state incl. 409).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyJsonRequest(request, {
    method: "POST",
    path: `/optimize/${encodeURIComponent(id)}/heartbeat`,
  });
}
