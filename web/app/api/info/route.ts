import { getBackendApiUrl } from "@/lib/backend";
import type { InfoUnavailableResponse } from "@/app/api/info/types";
import { parseInfoPayload, serializeInfoPayload } from "@/app/api/info/validate";

// GET /api/info — same-origin proxy for the backend's diagnostic identity and
// readiness surface (core/nurse_scheduling/server/app.py::info). The upstream
// body is strictly validated against the closed contract (`validate.ts`) and the
// RESPONSE IS RECONSTRUCTED from only the validated, allowlisted fields — never a
// relay of raw upstream bytes — so an unknown/private field (e.g. a leaked
// `backend_url`), an unsupported status, or an HTTP/body mismatch can never reach
// the browser.
//
// This deliberately does NOT go through `withReadinessGate` (web/lib/bff/readiness.ts):
// that gate probes `/ready` to decide whether to forward a BUSINESS request, but
// `/info` already IS the readiness/identity report — gating it on itself would be a
// pointless recursive probe. It gets its own direct bounded request instead, the
// same private-in-network-hop rationale as the readiness gate.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bounded deadline for the private in-network hop to `/info`, matching the
// readiness probe's rationale: a hung backend must never stall this request.
const INFO_REQUEST_TIMEOUT_MS = 2_000;

function unavailable(reason: InfoUnavailableResponse["reason"]): Response {
  const body: InfoUnavailableResponse = { status: "unavailable", reason };
  return Response.json(body, { status: 502, headers: { "cache-control": "no-store" } });
}

export async function GET() {
  const upstream = `${getBackendApiUrl()}/info`;

  let response: Response;
  try {
    response = await fetch(upstream, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(INFO_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // The private backend URL must never reach the browser (DL11 D1). Log it
    // server-side only; return a generic code-first body to the client. Covers
    // both a connection failure and the bounded-timeout AbortError.
    console.error(`[api/info] upstream unreachable or timed out: ${upstream}`, error);
    return unavailable("backend_unreachable");
  }

  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (error) {
    // Fetch can resolve (headers arrived) and then the body stream itself fail —
    // a reset, a truncated declared length, or a read error. That is a
    // connection failure just like the fetch() rejection above, so it gets the
    // same bounded, code-first envelope rather than throwing to a framework 500.
    console.error(`[api/info] upstream response body failed to read: ${upstream}`, error);
    return unavailable("backend_unreachable");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch (error) {
    // A hostile/missing upstream `content-type` never bypasses this: parsing
    // never trusts the media type, only whether the bytes are valid JSON.
    console.error(`[api/info] upstream response was not valid JSON: ${upstream}`, error);
    return unavailable("invalid_upstream_response");
  }

  const info = parseInfoPayload(parsedJson, response.status);
  if (info === null) {
    console.error(
      `[api/info] upstream response failed the closed /info contract (http ${response.status}): ${upstream}`,
    );
    return unavailable("invalid_upstream_response");
  }

  // Force the public media type after strict validation — never trust a hostile
  // or missing upstream content type — and reconstruct from validated fields only.
  return new Response(serializeInfoPayload(info), {
    status: response.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
