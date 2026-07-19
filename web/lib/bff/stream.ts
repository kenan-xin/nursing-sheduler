import { copyAllowedHeaders, SSE_RESPONSE_HEADERS } from "@/lib/bff/headers";
import { LAST_EVENT_ID_HEADER } from "@/lib/bff/types";
import { backendUnreachable, buildUpstreamHeaders, upstreamUrl } from "@/lib/bff/upstream";

// Whitelist the reconnect cursor. The client resumes by sending its last applied
// opaque cursor as `Last-Event-ID`; we forward ONLY that request header upstream,
// where the backend validates it and replays after it (tech-plan §5). The cursor is
// opaque and job-bound, not a credential.
function reconnectHeader(request: Request): Record<string, string> {
  const cursor = request.headers.get(LAST_EVENT_ID_HEADER);
  return cursor !== null ? { [LAST_EVENT_ID_HEADER]: cursor } : {};
}

// Relay a non-2xx SSE upstream response (an expired-job 404, a structured 4xx/5xx
// error) as a JSON body verbatim. `fetch()` resolving only means headers arrived
// — the error body stream itself can still reset or truncate mid-read (a
// declared Content-Length never satisfied, a connection drop). `arrayBuffer()`
// rejects in that case; without this boundary it escapes as an uncaught
// rejection (a framework 500) instead of the code-first `backend_unreachable`
// envelope every other upstream failure maps to (same shape as the JSON relay
// boundary in `upstream.ts`). `path` is only ever used for safe server-side
// logging — the private backend URL must never reach the browser (DL11 D1).
export async function relayEventErrorResponse(upstream: Response, path: string): Promise<Response> {
  const headers = copyAllowedHeaders(upstream.headers, ["content-type"]);
  headers.set("cache-control", "no-store");
  let body: ArrayBuffer;
  try {
    body = await upstream.arrayBuffer();
  } catch (error) {
    return backendUnreachable(error, path);
  }
  return new Response(body, { status: upstream.status, headers });
}

// fetch-stream SSE proxy (tech-plan §3, critique #1/#4). Native EventSource can't
// read the HTTP status/body, so it can't tell an expired-job 404 from a
// 5xx/network error — which C2 restart tolerance requires. So we fetch, inspect
// the initial status, and:
//   - non-2xx: relay the JSON error verbatim (client classifies expired vs 5xx);
//   - 2xx: pass the upstream ReadableStream through UNCHANGED, preserving the SSE
//     headers, while owning an AbortController that cancels the upstream body on
//     EVERY downstream disconnect/error. A bare `new Response(upstream.body)` does
//     NOT propagate cancellation — hence the explicit wrapper + `cancel()` hook.
export async function proxyEventStream(request: Request, path: string): Promise<Response> {
  const controller = new AbortController();
  const onDownstreamAbort = () => controller.abort();

  if (request.signal.aborted) {
    controller.abort();
  } else {
    request.signal.addEventListener("abort", onDownstreamAbort, { once: true });
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(path), {
      method: "GET",
      headers: buildUpstreamHeaders(request, {
        accept: "text/event-stream",
        ...reconnectHeader(request),
      }),
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    request.signal.removeEventListener("abort", onDownstreamAbort);
    return backendUnreachable(error, path);
  }

  // Inspect initial status/body before streaming.
  if (!upstream.ok || upstream.body === null) {
    request.signal.removeEventListener("abort", onDownstreamAbort);
    return relayEventErrorResponse(upstream, path);
  }

  const reader = upstream.body.getReader();
  const passthrough = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          streamController.close();
          request.signal.removeEventListener("abort", onDownstreamAbort);
          return;
        }
        streamController.enqueue(value);
      } catch (error) {
        streamController.error(error);
        request.signal.removeEventListener("abort", onDownstreamAbort);
      }
    },
    cancel(reason) {
      // Downstream disconnected/cancelled → propagate to the upstream body.
      controller.abort(reason);
      reader.cancel(reason).catch(() => {});
      request.signal.removeEventListener("abort", onDownstreamAbort);
    },
  });

  const headers = copyAllowedHeaders(upstream.headers, SSE_RESPONSE_HEADERS);
  headers.set("content-type", upstream.headers.get("content-type") ?? "text/event-stream");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-cache");
  if (!headers.has("x-accel-buffering")) headers.set("x-accel-buffering", "no");

  return new Response(passthrough, { status: upstream.status, headers });
}
