// Build-stamp source for the saved YAML's `appVersion` field (T17a).
//
// `NEXT_PUBLIC_APP_VERSION` is the client bundle's projection of the root
// `VERSION` SSOT (Docker: T01); plain `pnpm dev` leaves it unset and the call
// falls back to `"unknown"`. The fallback is expected — production stamps the
// value via the T01 build path — so `currentAppVersion()` must tolerate the
// unset case rather than assume a value.
//
// The string is forwarded verbatim (including any `-dirty` suffix the build
// wrapper may append). T17 must not fabricate or strip `-dirty`; the T17b
// load-gate keys on this exact string.

export function currentAppVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";
}
