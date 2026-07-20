"use client";

// T16e — same-origin backend version identity for the Optimize & Export screen.
//
// The old application polled the backend `/info` endpoint to show the server
// status pill and an api/app-version block, and warned when frontend and backend
// versions disagreed. The rebuild reads the SAME identity through the same-origin
// BFF `/api/info` proxy (never a cross-origin backend URL). A `ready` payload at
// HTTP 200 is "online"; a `503` identity report or the BFF's fail-closed `502`
// body is "offline". The version-mismatch rule mirrors the old page: warn when the
// backend app version differs from this bundle's version, or when either carries a
// `-dirty` build suffix.

import { useCallback, useEffect, useRef, useState } from "react";
import { currentAppVersion } from "@/lib/scenario/app-version";
import type { InfoIdentity } from "@/app/api/info/types";

export type OptimizeServerStatus = "checking" | "online" | "offline";

/** The interpreted `/api/info` result the screen renders. */
export interface OptimizeServerInfo {
  status: OptimizeServerStatus;
  apiVersion: string | null;
  backendVersion: string | null;
  clientVersion: string;
  versionMismatch: boolean;
  /** The `unavailable` reason when offline with a reason, else null. */
  unavailableReason: string | null;
  /** Re-fetch `/api/info`, aborting any in-flight check. */
  recheck(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readIdentityVersions(
  body: unknown,
): Pick<InfoIdentity, "api_version" | "app_version"> | null {
  if (!isRecord(body)) return null;
  const apiVersion = body.api_version;
  const appVersion = body.app_version;
  if (typeof apiVersion !== "string" || typeof appVersion !== "string") return null;
  return { api_version: apiVersion, app_version: appVersion };
}

/** True when a build stamp carries the uncommitted `-dirty` suffix. */
function isDirtyVersion(version: string): boolean {
  return version.endsWith("-dirty");
}

/**
 * Whether the backend and client versions should raise the mismatch warning.
 * Mirrors the old page: any difference, or a `-dirty` suffix on either side.
 */
export function optimizeVersionMismatch(backendVersion: string, clientVersion: string): boolean {
  if (isDirtyVersion(backendVersion) || isDirtyVersion(clientVersion)) return true;
  return backendVersion !== clientVersion;
}

/**
 * Interpret one `/api/info` response into the screen's identity view. Pure, so
 * every http/body pairing is unit-testable without a network. A `ready` payload
 * at HTTP 200 is online with identity; a `503` identity report is offline but
 * still exposes its versions; the BFF's `502` fail-closed body is offline with a
 * reason and no versions.
 */
export function classifyOptimizeServerInfo(
  http: number,
  body: unknown,
  clientVersion: string,
): Omit<OptimizeServerInfo, "recheck"> {
  const reason = isRecord(body) && typeof body.reason === "string" ? body.reason : null;
  const versions = readIdentityVersions(body);
  const status: OptimizeServerStatus =
    http === 200 && isRecord(body) && body.status === "ready" ? "online" : "offline";

  const backendVersion = versions?.app_version ?? null;
  return {
    status,
    apiVersion: versions?.api_version ?? null,
    backendVersion,
    clientVersion,
    versionMismatch:
      backendVersion !== null ? optimizeVersionMismatch(backendVersion, clientVersion) : false,
    unavailableReason: status === "offline" ? reason : null,
  };
}

/** The fetch seam: return the http status and parsed body without throwing. */
export type FetchOptimizeInfo = (signal: AbortSignal) => Promise<{ status: number; body: unknown }>;

async function defaultFetchInfo(signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  const response = await fetch("/api/info", { cache: "no-store", signal });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

export interface UseOptimizeServerInfoDeps {
  fetchInfo?: FetchOptimizeInfo;
  clientVersion?: string;
}

const CHECKING: Omit<OptimizeServerInfo, "recheck"> = {
  status: "checking",
  apiVersion: null,
  backendVersion: null,
  clientVersion: "",
  versionMismatch: false,
  unavailableReason: null,
};

/**
 * Read backend identity from `/api/info` on mount and on demand. Each check
 * aborts the prior in-flight request (so a slow first check can't clobber a
 * fresh recheck), and a rejected/aborted fetch resolves to "offline" rather than
 * throwing into the screen.
 */
export function useOptimizeServerInfo(deps?: UseOptimizeServerInfoDeps): OptimizeServerInfo {
  const clientVersion = deps?.clientVersion ?? currentAppVersion();
  const fetchInfo = deps?.fetchInfo ?? defaultFetchInfo;
  const fetchRef = useRef(fetchInfo);
  fetchRef.current = fetchInfo;

  const [state, setState] = useState<Omit<OptimizeServerInfo, "recheck">>({
    ...CHECKING,
    clientVersion,
  });
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const recheck = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState((prev) => ({ ...prev, status: "checking" }));
    void (async () => {
      try {
        const { status, body } = await fetchRef.current(controller.signal);
        if (!mountedRef.current || controller.signal.aborted) return;
        setState(classifyOptimizeServerInfo(status, body, clientVersion));
      } catch {
        if (!mountedRef.current || controller.signal.aborted) return;
        setState({ ...CHECKING, status: "offline", clientVersion });
      }
    })();
  }, [clientVersion]);

  useEffect(() => {
    mountedRef.current = true;
    recheck();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, [recheck]);

  return { ...state, recheck };
}
