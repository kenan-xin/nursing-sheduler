import { withReadinessGate } from "@/lib/bff/readiness";
import { proxyEventStream } from "@/lib/bff/stream";

// GET /api/optimize/{id}/events — SSE passthrough (api/optimize.py::stream_events).
// Verbatim upstream stream, preserving text/event-stream + Cache-Control:no-cache
// + X-Accel-Buffering:no and the persisted `id:` cursors; forwards the client's
// `Last-Event-ID` reconnect header upstream; cancels the upstream body on
// downstream disconnect. Fails closed when the backend is unready.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withReadinessGate(
  async (request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
    const { id } = await params;
    return proxyEventStream(request, `/optimize/${encodeURIComponent(id)}/events`);
  },
);
