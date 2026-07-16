import { isPublicOriginSecure } from "@/lib/backend";
import { rewriteSetCookieSecure } from "@/lib/bff/cookies";

// Explicit response-header allowlists (no blind copy — avoids relaying hop-by-hop
// headers like `connection`/`transfer-encoding` that break the Node/Next layer).
export const JSON_RESPONSE_HEADERS = ["content-type"] as const;

// XLSX download must carry the schedule metadata end-to-end (C2 expose_headers).
export const XLSX_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "x-schedule-score",
  "x-schedule-status",
] as const;

// SSE passthrough headers that must survive Next AND Cloudflare (tech-plan §3).
export const SSE_RESPONSE_HEADERS = ["content-type", "cache-control", "x-accel-buffering"] as const;

export function copyAllowedHeaders(from: Headers, allow: readonly string[]): Headers {
  const out = new Headers();
  for (const name of allow) {
    const value = from.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

// Forward each upstream `Set-Cookie`, re-deriving `Secure` from PUBLIC_ORIGIN.
// `getSetCookie()` returns the un-merged list (Node/undici Headers).
export function applyRewrittenSetCookies(target: Headers, upstream: Response): void {
  const secure = isPublicOriginSecure();
  for (const cookie of upstream.headers.getSetCookie()) {
    target.append("set-cookie", rewriteSetCookieSecure(cookie, secure));
  }
}
