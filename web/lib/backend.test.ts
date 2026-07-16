import { afterEach, describe, expect, it, vi } from "vitest";
import { getBackendApiUrl, getPublicOrigin, isPublicOriginSecure } from "@/lib/backend";

afterEach(() => {
  delete process.env.BACKEND_API_URL;
  delete process.env.PUBLIC_ORIGIN;
  vi.unstubAllEnvs();
});

describe("getBackendApiUrl (development)", () => {
  it("falls back to the documented dev default when unset", () => {
    expect(getBackendApiUrl()).toBe("http://localhost:8000");
  });

  it("uses a valid configured URL and strips the trailing slash", () => {
    process.env.BACKEND_API_URL = "http://backend:8000/";
    expect(getBackendApiUrl()).toBe("http://backend:8000");
  });

  it("fails fast with an actionable error on an unparseable URL", () => {
    process.env.BACKEND_API_URL = "not a url";
    expect(() => getBackendApiUrl()).toThrowError(/BACKEND_API_URL is not a valid absolute URL/);
  });

  it("fails fast on a disallowed scheme", () => {
    process.env.BACKEND_API_URL = "ftp://backend:8000";
    expect(() => getBackendApiUrl()).toThrowError(/must use the http: or https: scheme/);
  });

  it("treats a present-but-blank value as invalid (not a silent default)", () => {
    process.env.BACKEND_API_URL = "   ";
    expect(() => getBackendApiUrl()).toThrowError(/BACKEND_API_URL is set but blank/);
  });
});

describe("PUBLIC_ORIGIN → Secure cookie policy", () => {
  it("is not secure on the http://localhost dev default", () => {
    expect(isPublicOriginSecure()).toBe(false);
    expect(getPublicOrigin().origin).toBe("http://localhost:3000");
  });

  it("is secure for an HTTPS public origin", () => {
    process.env.PUBLIC_ORIGIN = "https://nursescheduling.org";
    expect(isPublicOriginSecure()).toBe(true);
  });

  it("is not secure for an explicit http://localhost origin", () => {
    process.env.PUBLIC_ORIGIN = "http://localhost:3000";
    expect(isPublicOriginSecure()).toBe(false);
  });

  it("fails fast on an invalid PUBLIC_ORIGIN", () => {
    process.env.PUBLIC_ORIGIN = "wss://example.org";
    expect(() => isPublicOriginSecure()).toThrowError(
      /PUBLIC_ORIGIN must use the http: or https: scheme/,
    );
  });
});

describe("production requires explicit config (no localhost default)", () => {
  it("throws when BACKEND_API_URL is unset in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.PUBLIC_ORIGIN = "https://nursescheduling.org";
    expect(() => getBackendApiUrl()).toThrowError(/BACKEND_API_URL is required in production/);
  });

  it("throws when PUBLIC_ORIGIN is unset in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.BACKEND_API_URL = "http://backend:8000";
    expect(() => getPublicOrigin()).toThrowError(/PUBLIC_ORIGIN is required in production/);
  });

  it("accepts valid explicit values in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.BACKEND_API_URL = "http://backend:8000";
    process.env.PUBLIC_ORIGIN = "https://nursescheduling.org";
    expect(getBackendApiUrl()).toBe("http://backend:8000");
    expect(isPublicOriginSecure()).toBe(true);
  });
});
