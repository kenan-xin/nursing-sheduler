// Server-side config for the BFF (DL11 D1, tech-plan §3/§7). The browser never
// talks to the backend directly — it calls same-origin `/api/*`, and Next forwards
// server-side to `BACKEND_API_URL` inside the Docker network.
//
// Two values drive the boundary:
//   - BACKEND_API_URL  — private upstream base (Compose: `http://backend:8000`).
//   - PUBLIC_ORIGIN    — the trusted public scheme+host the browser sees. This,
//     NOT the internal upstream URL, decides the cookie `Secure` attribute:
//     HTTPS in prod, off on `http://localhost` for dev.
//
// Validation rules (enforced at startup via `web/instrumentation.ts`, and again per
// call as a safety net):
//   - development: an unset value falls back to the documented localhost default;
//   - production: BOTH values are REQUIRED (no localhost default);
//   - any environment: a present-but-blank/whitespace value is INVALID (not a
//     default), as is a non-http(s) scheme or an unparseable URL. All fail fast
//     with an actionable error.
const DEV_DEFAULT_BACKEND_API_URL = "http://localhost:8000";
const DEV_DEFAULT_PUBLIC_ORIGIN = "http://localhost:3000";
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function parseAndValidateUrl(envName: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `[bff-config] ${envName} is not a valid absolute URL (got ${JSON.stringify(value)}). ` +
        'Set it to an absolute http(s) URL, e.g. "http://backend:8000".',
    );
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error(
      `[bff-config] ${envName} must use the http: or https: scheme ` +
        `(got "${url.protocol}" from ${JSON.stringify(value)}).`,
    );
  }

  return url;
}

function resolveConfiguredUrl(
  envName: string,
  rawValue: string | undefined,
  devDefault: string,
): URL {
  if (rawValue === undefined) {
    // Unset: allowed in development (documented default), required in production.
    if (isProduction()) {
      throw new Error(
        `[bff-config] ${envName} is required in production — there is no localhost ` +
          "default outside development. Set it to an absolute http(s) URL.",
      );
    }
    return parseAndValidateUrl(envName, devDefault);
  }

  // Present-but-blank is an explicit misconfiguration, never a silent default.
  if (rawValue.trim() === "") {
    throw new Error(
      `[bff-config] ${envName} is set but blank. Unset it to use the dev default, ` +
        "or provide an absolute http(s) URL.",
    );
  }

  return parseAndValidateUrl(envName, rawValue.trim());
}

// Private upstream base URL, without a trailing slash so callers append `/path`.
export function getBackendApiUrl(): string {
  const url = resolveConfiguredUrl(
    "BACKEND_API_URL",
    process.env.BACKEND_API_URL,
    DEV_DEFAULT_BACKEND_API_URL,
  );
  return url.href.replace(/\/+$/, "");
}

// The trusted public origin the browser reaches Next through.
export function getPublicOrigin(): URL {
  return resolveConfiguredUrl(
    "PUBLIC_ORIGIN",
    process.env.PUBLIC_ORIGIN,
    DEV_DEFAULT_PUBLIC_ORIGIN,
  );
}

// Whether cookies returned to the browser must carry `Secure`. Derived from the
// PUBLIC_ORIGIN scheme — never from the (always-HTTP, internal) upstream URL.
export function isPublicOriginSecure(): boolean {
  return getPublicOrigin().protocol === "https:";
}

// Eager fail-fast, wired into the server-start hook (`web/instrumentation.ts`).
// Validates both values so a misconfiguration crashes startup rather than failing
// on the first request.
export function assertBffConfigValid(): void {
  getBackendApiUrl();
  getPublicOrigin();
}
