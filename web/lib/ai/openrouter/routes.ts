// The setup routes' request handlers (T04), separated from their Next route files
// so the containment contract is exercised by the unit suite against the real
// handler rather than asserted about a wrapper.
//
// Both routes are deliberately SEPARATE from the chat runtime: the catalog is
// public and keyless, and the probe must be callable while no configuration is
// stored yet. Neither may ever share the chat route's agent, thread, or history.

import { AI_SETUP_CODES, AI_KEY_HEADER, AI_MODEL_HEADER } from "@/lib/ai/protocol";
import { fetchModelCatalog, type ModelCatalog } from "./catalog";
import { probeCredentials } from "./probe";

/**
 * Every response from these routes.
 *
 * `no-store` is unconditional. The catalog body is public metadata, but the probe
 * response is a per-account fact and both are reached through the same origin as
 * the app -- so rather than reason per route about what a shared cache may keep,
 * neither is cacheable anywhere but the in-process memo below. No route here ever
 * sets a cookie.
 */
function contained(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** How long a successfully fetched catalog is reused before refetching. */
export const CATALOG_TTL_MS = 15 * 60 * 1000;

type Memo = { at: number; catalog: ModelCatalog };
let memo: Memo | null = null;

/** Test seam: drop the memo so a suite can observe a real fetch. */
export function resetCatalogMemo(): void {
  memo = null;
}

export interface CatalogHandlerOptions {
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * `GET /api/ai/openrouter/models`.
 *
 * The memo exists so that a Settings screen mounted repeatedly (or by several
 * tabs) does not re-hit OpenRouter's catalog for a list that changes daily at
 * most. Only a LIVE catalog is memoized: a fallback result is not, so the very
 * next request retries the real thing instead of pinning the offline list for
 * fifteen minutes after one transient failure.
 */
export async function handleModelCatalogRequest(
  options: CatalogHandlerOptions = {},
): Promise<Response> {
  const now = options.now ?? (() => Date.now());
  const at = now();

  if (memo && at - memo.at < CATALOG_TTL_MS) return contained(memo.catalog);

  const catalog = await fetchModelCatalog(options.fetchImpl ?? globalThis.fetch);
  if (catalog.source === "catalog") memo = { at, catalog };
  return contained(catalog);
}

export interface ProbeHandlerOptions {
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * `POST /api/ai/openrouter/test`.
 *
 * The credential arrives as a transient header, is used to build one provider
 * request, and is dropped when this function returns. It is never written to a
 * cookie, a store, a log line, or the response.
 */
export async function handleProbeRequest(
  request: Request,
  options: ProbeHandlerOptions = {},
): Promise<Response> {
  const apiKey = request.headers.get(AI_KEY_HEADER)?.trim();
  const model = request.headers.get(AI_MODEL_HEADER)?.trim();
  if (!apiKey || !model) {
    return contained({ ok: false, code: AI_SETUP_CODES.credentialsRequired }, 400);
  }

  const result = await probeCredentials({
    apiKey,
    model,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    // The browser's abort (a cancelled test, a closed Settings screen) has to reach
    // the provider call, or a cancelled probe keeps billing.
    ...(request.signal ? { signal: request.signal } : {}),
  });

  // A rejected probe is a successful ANSWER, not a transport failure: the client
  // renders guidance from the code, so a non-200 would only invite a retry loop.
  return contained(result);
}
