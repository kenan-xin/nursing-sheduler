"use client";

// T16e — backend version identity. Shows a server-status pill, the api/frontend/
// backend version line, and the old app's version-mismatch and offline warnings.
// Reads through the same-origin `/api/info` proxy (never a cross-origin backend).

import { FaSpinner, FaWifi } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { OptimizeServerInfo } from "@/lib/optimize";
import { Callout } from "./callout";

export interface ServerIdentityProps {
  info: OptimizeServerInfo;
}

function StatusBadge({ status }: { status: OptimizeServerInfo["status"] }) {
  if (status === "online") {
    return (
      <Badge variant="success">
        <FaWifi aria-hidden /> Online
      </Badge>
    );
  }
  if (status === "checking") {
    return (
      <Badge variant="neutral">
        <FaSpinner className="animate-spin-slow" aria-hidden /> Checking
      </Badge>
    );
  }
  return (
    <Badge variant="error">
      <FaWifi aria-hidden /> Offline
    </Badge>
  );
}

export function ServerIdentity({ info }: ServerIdentityProps) {
  return (
    <div className="space-y-3" data-testid="optimize-server-identity">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            Server
          </span>
          <StatusBadge status={info.status} />
        </div>
        <Button variant="outline" size="sm" onClick={info.recheck} data-testid="optimize-recheck">
          Re-check
        </Button>
      </div>

      <p className="text-meta text-ink3">
        API version: {info.apiVersion ?? "—"} · Frontend version: {info.clientVersion} · Backend
        version: {info.backendVersion ?? "—"}
      </p>

      {info.versionMismatch ? (
        <Callout tone="warn" data-testid="optimize-version-mismatch">
          Frontend and backend versions do not match. If nothing breaks, you can continue.
        </Callout>
      ) : null}

      {info.status === "offline" ? (
        <Callout tone="warn" data-testid="optimize-server-offline" alert>
          Backend is not responding at the configured endpoint.
          {info.unavailableReason !== null ? ` (${info.unavailableReason})` : ""}
        </Callout>
      ) : null}
    </div>
  );
}
