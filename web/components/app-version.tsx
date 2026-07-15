"use client";

// Read-only build-version badge (client component). `NEXT_PUBLIC_APP_VERSION` is
// inlined into the client bundle at build time — a runtime env change cannot alter
// it, which is exactly the property the version-equality gate checks against the
// backend's `/api/health.appVersion`. The richer online/offline + version-status UI
// is owned by later tickets; this is the minimal surface that makes the stamp
// observable.
export function AppVersion() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";
  return (
    <span data-testid="app-version" className="text-muted-foreground text-xs">
      v{version}
    </span>
  );
}
