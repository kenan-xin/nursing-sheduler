import { getBackendApiUrl } from "@/lib/backend";
import { buildUpstreamCookieHeader } from "@/lib/bff/cookies";
import { extractStructuredError } from "@/lib/bff/errors";
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

// A `path` reaches a log label with a caller-controlled segment (a URL-decoded
// `[id]`). A raw CR/LF would forge a second log line, so escape the line breaks
// (and TAB, for a single tidy line) at the sink — every caller is then safe by
// construction, whatever it interpolated. Mirrors the basis serializer's escaping.
function logSafePath(path: string): string {
  return path
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

// The private backend URL must never reach the browser (DL11 D1). Log it
// server-side; return a generic code-first 502 the client can classify
// (`backend_unreachable`) without leaking the upstream address.
export function backendUnreachable(error: unknown, path: string): Response {
  console.error(`[bff] upstream unreachable: ${logSafePath(path)}`, error);
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

// The code this boundary synthesizes when the configured upstream does not route
// a path the app depends on. Deliberately NOT a 404 code: the client must never
// be able to read a deployment mismatch as a job that no longer exists.
export const BACKEND_ROUTE_UNSUPPORTED = "backend_route_unsupported";

// Tell "this service cannot do that" apart from "that job is gone".
//
// FastAPI answers a path it does not route with its own generic
// `404 {"detail":"Not Found"}` — the SAME status the application uses for a
// code-first `job_not_found`. Relayed verbatim, a backend that predates a route
// is therefore indistinguishable from a missing job: the client classifier finds
// no `error.code`, falls through to `unknown`, and the user is left with a bare
// "Not Found" and nothing to act on. That is a real deployment shape — a stale or
// foreign backend process, a wrong `BACKEND_API_URL`, a partially rolled-out
// image — not a hypothetical.
//
// This boundary is the only one that can tell them apart, because it is the one
// that chose the upstream path. A 404 carrying NO code-first envelope did not
// come from the application's error contract, so it is a route miss: reported as
// a code-first 502 the client can classify and explain. Non-404s and code-first
// 404s are returned untouched — the relay stays byte-exact for every response the
// backend actually authored.
//
// 502, not 404, is load-bearing: `isExactJobGoneResponse` requires a 404, so
// moving the status makes it structurally impossible for this response to become
// job-gone (and therefore DELETE) authority anywhere downstream.
export async function guardUnsupportedRoute(
  response: Response,
  unsupportedMessage: string,
): Promise<Response> {
  if (response.status !== 404) return response;

  let body: unknown = null;
  try {
    body = JSON.parse(await response.clone().text());
  } catch {
    // A 404 whose body is absent, truncated, or not JSON at all (an intermediary
    // proxy's own page) is likewise not the application's error contract.
    body = null;
  }
  if (extractStructuredError(body) !== null) return response;

  return Response.json(
    { error: { code: BACKEND_ROUTE_UNSUPPORTED, message: unsupportedMessage } },
    { status: 502, headers: { "cache-control": "no-store" } },
  );
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
