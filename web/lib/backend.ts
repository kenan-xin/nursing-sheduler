// Server-side backend base URL for the BFF (DL11 D1). The browser never talks to
// the backend directly — it calls same-origin `/api/*`, and Next forwards here.
// In Compose this is `http://backend:8000`; the dev/non-Compose default targets a
// locally-run backend. The full per-endpoint proxy contract (cookies, headers,
// scheme validation) is owned by T06 — this module only resolves the base URL.
const DEV_DEFAULT_BACKEND_API_URL = "http://localhost:8000";

export function getBackendApiUrl(): string {
  return process.env.BACKEND_API_URL ?? DEV_DEFAULT_BACKEND_API_URL;
}
