import { proxyEventStream } from "@/lib/bff/stream";

// GET /api/optimize/{id}/events — SSE passthrough (serve.py::stream_optimize_job_events).
// Verbatim upstream stream, preserving text/event-stream + Cache-Control:no-cache
// + X-Accel-Buffering:no; cancels the upstream body on downstream disconnect.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyEventStream(request, `/optimize/${encodeURIComponent(id)}/events`);
}
