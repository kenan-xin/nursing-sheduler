"use client";

import { useQuery } from "@tanstack/react-query";
import {
  readTimeoutOptions,
  type OptimizeTimeoutOptions,
} from "@/app/api/optimize/options/validate";
import { optimizeOptionsKey } from "@/lib/query/keys";

/**
 * The timeout a backend without `GET /optimize/options` accepts: core's own
 * defaults (config.py), which v1 kept as its legacy fallback (338b588).
 */
export const LEGACY_OPTIMIZE_TIMEOUT: OptimizeTimeoutOptions = {
  default: 300,
  minimum: 1,
  maximum: 60 * 60,
};

export interface OptimizeTimeoutOptionsResult {
  /** `legacy`: the backend did not advertise usable options, so the defaults apply. */
  source: "backend" | "legacy";
  timeout: OptimizeTimeoutOptions;
}

const LEGACY: OptimizeTimeoutOptionsResult = { source: "legacy", timeout: LEGACY_OPTIMIZE_TIMEOUT };

/**
 * Read the deployment's timeout options through the BFF. Never throws: any answer
 * other than a valid `200` keeps the legacy defaults. v1 fell back only on a 404 and
 * blocked the run otherwise; here `/api/info` already gates an offline backend, and
 * the backend still enforces its real bounds on submit, so a transient miss must
 * not stop a run.
 */
export async function fetchOptimizeTimeoutOptions(
  signal?: AbortSignal,
): Promise<OptimizeTimeoutOptionsResult> {
  try {
    const response = await fetch("/api/optimize/options", { cache: "no-store", signal });
    if (response.status !== 200) return LEGACY;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || Object.keys(body).length !== 1) {
      return LEGACY;
    }
    const timeout = readTimeoutOptions((body as { timeout?: unknown }).timeout);
    return timeout === null ? LEGACY : { source: "backend", timeout };
  } catch {
    return LEGACY;
  }
}

export function useOptimizeTimeoutOptions() {
  return useQuery({
    queryKey: optimizeOptionsKey,
    queryFn: ({ signal }) => fetchOptimizeTimeoutOptions(signal),
  });
}

/**
 * Clamp a FIXED solver timeout into the bounds the deployment accepts.
 *
 * The diagnostic's per-candidate timeout is a constant (`DIAGNOSTIC_CANDIDATE_TIMEOUT_SECONDS`),
 * but a deployment whose `GET /optimize/options` bounds exclude it (`minimum > 90` or
 * `maximum < 90`) rejects the run before it starts. Absent bounds mean the options query
 * has not answered, so the legacy defaults apply — the same fallback the ordinary run uses.
 * This is the ONE clamp: callers pass whatever the query loaded and get an accepted value.
 */
export function clampTimeoutSeconds(
  seconds: number,
  bounds: OptimizeTimeoutOptions | undefined,
): number {
  const { minimum, maximum } = bounds ?? LEGACY_OPTIMIZE_TIMEOUT;
  return Math.min(Math.max(seconds, minimum), maximum);
}
