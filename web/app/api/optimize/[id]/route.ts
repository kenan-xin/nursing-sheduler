import { proxyJsonRequest } from "@/lib/bff/upstream";

// GET /api/optimize/{id} — poll job status (serve.py::get_optimize_job). A plain
// 404 "Optimization job not found" here is the recovery signal (expired/restart);
// the client classifies it via `classifyOptimizeError`. Errors relay verbatim.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyJsonRequest(request, { method: "GET", path: `/optimize/${encodeURIComponent(id)}` });
}
