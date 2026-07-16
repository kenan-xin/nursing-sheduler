import {
  backendUnreachable,
  buildUpstreamHeaders,
  type NodeRequestInit,
  relayJsonResponse,
  upstreamUrl,
} from "@/lib/bff/upstream";

// POST /api/optimize — multipart submit (serve.py::create_optimize_job, 202).
// The body is piped through UNPARSED: Node/undici need `duplex: "half"` for a
// ReadableStream body, and the EXACT inbound `Content-Type` (incl. the multipart
// boundary) must be forwarded or the multipart parser never sees the parts. The
// backend enforces the 2 MiB limit (exact 413 "Scheduling YAML is too large");
// the client's 2 MiB check is UX only. This is also where the backend mints the
// `nurse_scheduling_client_uuid` cookie, so `Set-Cookie` is rewritten (Secure).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type");
  if (contentType === null) {
    return Response.json(
      { detail: "A multipart/form-data Content-Type is required." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const init: NodeRequestInit = {
    method: "POST",
    headers: buildUpstreamHeaders(request, { "content-type": contentType }),
    body: request.body,
    cache: "no-store",
    redirect: "manual",
    duplex: "half",
  };

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl("/optimize"), init);
  } catch (error) {
    return backendUnreachable(error, "/optimize");
  }

  return relayJsonResponse(upstream);
}
