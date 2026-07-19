import { describe, expect, it } from "vitest";
import {
  buildUpstreamCookieHeader,
  extractClientId,
  rewriteSetCookieSecure,
} from "@/lib/bff/cookies";

function requestWithCookie(cookie?: string): Request {
  return new Request("http://localhost/api/optimize", cookie ? { headers: { cookie } } : undefined);
}

describe("extractClientId", () => {
  it("reads only the client-id cookie, ignoring others", () => {
    const request = requestWithCookie("theme=dark; nurse_scheduling_client_id=abc123; other=1");
    expect(extractClientId(request)).toBe("abc123");
  });

  it("returns null when the cookie is absent", () => {
    expect(extractClientId(requestWithCookie("theme=dark"))).toBeNull();
    expect(extractClientId(requestWithCookie())).toBeNull();
  });
});

describe("buildUpstreamCookieHeader", () => {
  it("synthesizes only the single cookie", () => {
    const request = requestWithCookie("a=1; nurse_scheduling_client_id=xyz; b=2");
    expect(buildUpstreamCookieHeader(request)).toBe("nurse_scheduling_client_id=xyz");
  });

  it("returns null on first submit (no cookie yet)", () => {
    expect(buildUpstreamCookieHeader(requestWithCookie())).toBeNull();
  });
});

describe("rewriteSetCookieSecure", () => {
  const upstream = "nurse_scheduling_client_id=abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800";

  it("adds Secure for an HTTPS public origin, preserving other attributes", () => {
    const rewritten = rewriteSetCookieSecure(upstream, true);
    expect(rewritten).toContain("nurse_scheduling_client_id=abc");
    expect(rewritten).toContain("HttpOnly");
    expect(rewritten).toContain("SameSite=Lax");
    expect(rewritten).toContain("Path=/");
    expect(rewritten).toContain("Max-Age=604800");
    expect(rewritten).toContain("Secure");
  });

  it("removes Secure for an HTTP (localhost) public origin", () => {
    const withSecure = `${upstream}; Secure`;
    const rewritten = rewriteSetCookieSecure(withSecure, false);
    expect(rewritten).not.toMatch(/;\s*Secure/i);
    expect(rewritten).toContain("HttpOnly");
    expect(rewritten).toContain("Max-Age=604800");
  });

  it("is idempotent when Secure is already present", () => {
    const once = rewriteSetCookieSecure(upstream, true);
    expect(rewriteSetCookieSecure(once, true)).toBe(once);
  });
});
