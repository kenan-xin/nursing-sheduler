"use client";

// Read-only build-version badge (client component). `NEXT_PUBLIC_APP_VERSION` is
// inlined into the client bundle at build time — a runtime env change cannot alter
// it, which is exactly the property the version-equality gate checks against the
// backend's `/api/health.appVersion`. The richer online/offline + version-status UI
// is owned by later tickets; this is the minimal surface that makes the stamp
// observable.
export function AppVersion() {
  const raw = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";
  // The stamp is now `v`-prefixed git-describe output (`v0.1.1-…`); prefix only
  // when it is not already `v`-prefixed, so a prefixed value never renders `vv0.1.1`.
  const version = raw.startsWith("v") ? raw : `v${raw}`;
  return (
    <span data-testid="app-version" className="text-muted-foreground text-xs">
      {version}
    </span>
  );
}
