// The tool-capable OpenRouter model catalog (T04, tech-plan "OpenRouter setup and
// model catalog").
//
// Setup and repair need reliable tool calling, so a model that does not advertise
// tool support is not offered. The filter is on OpenRouter's own
// `supported_parameters`, which is the provider's declaration rather than our
// guess -- and it is a NECESSARY condition, not a sufficient one, which is why the
// probe still has to prove the contract against the actual account.
//
// The fallback list is VERSIONED and small on purpose. Its job is to keep Settings
// usable when the public catalog is unreachable; it is not a curated
// recommendation set that has to stay current, and a stale entry simply fails its
// probe like any other slug.

import { OPENROUTER_BASE_URL } from "@/lib/ai/protocol";

/** A catalog row, reduced to what Settings actually renders. */
export interface CatalogModel {
  id: string;
  name: string;
  /** Context window in tokens, when OpenRouter reports one. */
  contextLength: number | null;
}

export interface ModelCatalog {
  /** Whether the rows came from OpenRouter or from the built-in fallback. */
  source: "catalog" | "fallback";
  /** Bumped whenever the fallback list changes, so a client can tell them apart. */
  fallbackVersion: number;
  models: CatalogModel[];
  /** The recommended default, present in `models` whenever the list is non-empty. */
  recommendedId: string | null;
}

/** Bump when {@link FALLBACK_MODELS} changes. */
export const FALLBACK_CATALOG_VERSION = 1;

/**
 * The versioned offline list. Every entry is a tool-capable slug at the time of
 * writing; availability is still the account's and OpenRouter's to decide, which
 * the probe is what establishes.
 */
export const FALLBACK_MODELS: readonly CatalogModel[] = Object.freeze([
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", contextLength: 200_000 },
  { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", contextLength: 200_000 },
  { id: "openai/gpt-4.1", name: "GPT-4.1", contextLength: 1_047_576 },
  { id: "openai/gpt-4.1-mini", name: "GPT-4.1 mini", contextLength: 1_047_576 },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", contextLength: 1_048_576 },
]);

/** The one recommended default the enablement flow asks Settings to preselect. */
export const RECOMMENDED_MODEL_ID = "anthropic/claude-sonnet-4.5";

/** OpenRouter's public catalog row, narrowed to the fields this app reads. */
interface RawModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  supported_parameters?: unknown;
}

/**
 * Keep only rows that declare tool support, and normalize them.
 *
 * Fail-closed on shape: a row without a usable `id`, or whose
 * `supported_parameters` is not a list naming `tools`, is dropped rather than
 * optimistically offered. An unrecognised catalog therefore yields an EMPTY list,
 * which the caller reports as unavailable -- never a list of models that cannot
 * take actions.
 */
export function selectToolCapableModels(payload: unknown): CatalogModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  const models: CatalogModel[] = [];
  for (const row of data as RawModel[]) {
    if (typeof row?.id !== "string" || row.id.length === 0) continue;
    const params = row.supported_parameters;
    if (!Array.isArray(params) || !params.includes("tools")) continue;
    models.push({
      id: row.id,
      name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.id,
      contextLength: typeof row.context_length === "number" ? row.context_length : null,
    });
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return models;
}

/** The recommended default if the list offers it, else its first row. */
export function pickRecommended(models: readonly CatalogModel[]): string | null {
  if (models.length === 0) return null;
  return models.some((model) => model.id === RECOMMENDED_MODEL_ID)
    ? RECOMMENDED_MODEL_ID
    : models[0].id;
}

/** The offline catalog, used whenever the live one cannot be read. */
export function fallbackCatalog(): ModelCatalog {
  const models = [...FALLBACK_MODELS];
  return {
    source: "fallback",
    fallbackVersion: FALLBACK_CATALOG_VERSION,
    models,
    recommendedId: pickRecommended(models),
  };
}

/**
 * Fetch and filter the live catalog, falling back when it is unreachable or
 * unreadable.
 *
 * No credential is sent: the catalog is public metadata, and Settings must be able
 * to show model choices BEFORE a key exists.
 */
export async function fetchModelCatalog(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ModelCatalog> {
  try {
    const response = await fetchImpl(`${OPENROUTER_BASE_URL}/models`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return fallbackCatalog();

    const models = selectToolCapableModels(await response.json());
    if (models.length === 0) return fallbackCatalog();

    return {
      source: "catalog",
      fallbackVersion: FALLBACK_CATALOG_VERSION,
      models,
      recommendedId: pickRecommended(models),
    };
  } catch {
    // Deliberately swallowed: an upstream error object may carry request detail,
    // and the caller's contract is "a usable list or the fallback", never a
    // forwarded provider failure.
    return fallbackCatalog();
  }
}
