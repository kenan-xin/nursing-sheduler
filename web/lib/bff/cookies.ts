import { CLIENT_ID_COOKIE_NAME } from "@/lib/bff/types";

// Read ONLY the client-id cookie from the inbound browser request. We parse the
// header ourselves (rather than lean on NextRequest.cookies) so handlers stay
// testable with a plain `Request`, and so nothing else in the browser cookie jar
// is ever considered.
export function extractClientId(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === CLIENT_ID_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }

  return null;
}

// Synthesize the upstream `Cookie` header from only the client-id cookie.
// Returns null when the browser has no such cookie yet (first submit).
export function buildUpstreamCookieHeader(request: Request): string | null {
  const value = extractClientId(request);
  return value === null ? null : `${CLIENT_ID_COOKIE_NAME}=${value}`;
}

// Rewrite an upstream `Set-Cookie` so its `Secure` attribute reflects the trusted
// PUBLIC_ORIGIN, not the (always-HTTP) internal upstream. Everything else
// (name=value, HttpOnly, SameSite, Path, Max-Age, …) is preserved verbatim.
export function rewriteSetCookieSecure(setCookie: string, secure: boolean): string {
  const segments = setCookie
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  // Segment 0 is the `name=value` pair — always kept. Drop any existing `Secure`
  // attribute from the rest; re-add it only when the public origin is HTTPS.
  const rewritten = segments.filter(
    (segment, index) => index === 0 || segment.toLowerCase() !== "secure",
  );
  if (secure) rewritten.push("Secure");

  return rewritten.join("; ");
}
