import { copyAllowedHeaders, SSE_RESPONSE_HEADERS } from "@/lib/bff/headers";
import { backendUnreachable, buildUpstreamHeaders, upstreamUrl } from "@/lib/bff/upstream";

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
      headers: buildUpstreamHeaders(request, { accept: "text/event-stream" }),
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
    const headers = copyAllowedHeaders(upstream.headers, ["content-type"]);
    headers.set("cache-control", "no-store");
    const body = await upstream.arrayBuffer();
    return new Response(body, { status: upstream.status, headers });
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
