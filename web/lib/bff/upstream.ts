import { getBackendApiUrl } from "@/lib/backend";
import { buildUpstreamCookieHeader } from "@/lib/bff/cookies";
import { applyRewrittenSetCookies, copyAllowedHeaders } from "@/lib/bff/headers";

// Node/undici require `duplex: "half"` to send a `ReadableStream` request body;
// it is not yet in the DOM `RequestInit` type, hence this extension.
export type NodeRequestInit = RequestInit & { duplex?: "half" };

export function upstreamUrl(path: string): string {
  return `${getBackendApiUrl()}${path}`;
}

// Synthesize the upstream request headers: only the client-uuid cookie, plus any
// explicit extras (e.g. the exact multipart `content-type`). Never a blind copy
// of the inbound headers.
export function buildUpstreamHeaders(request: Request, extra?: Record<string, string>): Headers {
  const headers = new Headers();
  const cookie = buildUpstreamCookieHeader(request);
  if (cookie !== null) headers.set("cookie", cookie);
  if (extra) {
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  }
  return headers;
}

// The private backend URL must never reach the browser (DL11 D1). Log it
// server-side; return a generic code-first 502 the client can classify
// (`backend_unreachable`) without leaking the upstream address.
export function backendUnreachable(error: unknown, path: string): Response {
  console.error(`[bff] upstream unreachable: ${path}`, error);
  return Response.json(
    { error: { code: "backend_unreachable", message: "The scheduling service is unreachable." } },
    { status: 502, headers: { "cache-control": "no-store" } },
  );
}

// Relay a JSON/text upstream response: body verbatim, whitelisted headers,
// `Set-Cookie` with `Secure` re-derived from PUBLIC_ORIGIN, `no-store`. Used for
// poll / cancel / finish-now / submit and for relaying error bodies verbatim
// (the client classifies the code-first envelope; the BFF does not reshape it).
//
// `fetch()` resolving only means headers arrived — the body stream itself can
// still reset or truncate mid-read (a declared Content-Length never satisfied, a
// connection drop). `arrayBuffer()` rejects in that case; without this boundary
// it escapes as an uncaught rejection (a framework 500) instead of the code-first
// `backend_unreachable` envelope every other upstream failure maps to. `path` is
// only ever used for safe server-side logging — the private backend URL must
// never reach the browser (DL11 D1).
export async function relayJsonResponse(upstream: Response, path: string): Promise<Response> {
  const headers = copyAllowedHeaders(upstream.headers, ["content-type"]);
  headers.set("cache-control", "no-store");
  applyRewrittenSetCookies(headers, upstream);

  let body: ArrayBuffer;
  try {
    body = await upstream.arrayBuffer();
  } catch (error) {
    return backendUnreachable(error, path);
  }
  return new Response(body, { status: upstream.status, headers });
}

// Proxy a simple JSON request (no request body) to the backend and relay it.
export async function proxyJsonRequest(
  request: Request,
  init: { method: string; path: string },
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(init.path), {
      method: init.method,
      headers: buildUpstreamHeaders(request),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (error) {
    return backendUnreachable(error, init.path);
  }

  return relayJsonResponse(upstream, init.path);
}
