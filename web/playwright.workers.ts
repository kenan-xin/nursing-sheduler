// Deterministic Playwright worker policy (qq0.29 capacity audit).
//
// Playwright's built-in default is `Math.ceil(cpus / 2)` — UNBOUNDED. On a large
// runner (e.g. 60+ cores) that spawns 30+ browser workers; the qq0.29 audit
// reproduced this as generic 30s interaction timeouts (CPU starvation, NOT an
// app-init race) once oversubscription hit ~1.5–2x the core count under
// concurrent load. The literal default command (`pnpm test:e2e`) must not pass
// on one host and fail massively on another purely because of unbounded worker
// scaling, so the required release gate uses a BOUNDED, deterministic count.
//
// Audit evidence (32-core host): floor(cpus/2)=16 workers passed all 227 tests
// even under full CPU saturation; failures only appeared at 48–64 workers. The
// cap keeps a safety margin below that on any host while staying build-dominated
// (workers 8 vs 16 differ by <1s wall — the Next build dwarfs test execution).
//
// The high-parallelism `test:e2e:stress` lane deliberately opts OUT of this cap
// to exercise the oversubscription edge; it is explicitly NOT the release gate.

/** Bounded default for the required release gate. */
export const DEFAULT_WORKER_CAP = 8;

/** Env var that lets a caller pin an explicit worker count (integer ≥ 1). */
export const WORKERS_ENV = "PLAYWRIGHT_WORKERS";

export type ResolveWorkerOptions = {
  /** Detected logical CPU count (e.g. `os.cpus().length`). */
  cpuCount: number;
  /** Raw override string (e.g. `process.env.PLAYWRIGHT_WORKERS`). */
  override?: string | undefined;
  /** Upper bound on the computed count. Defaults to `DEFAULT_WORKER_CAP`. */
  cap?: number;
};

/**
 * Resolve the Playwright worker count deterministically.
 *
 * Precedence:
 *  1. A valid positive-integer `override` wins verbatim (explicit escape hatch —
 *     the stress lane and ad-hoc runs use this).
 *  2. Otherwise `clamp(floor(cpuCount / 2), 1, cap)` — half the cores, never
 *     below 1, never above the cap. Bounding the upper end is what makes the
 *     default gate deterministic across differently-sized hosts.
 *
 * A malformed or non-positive override is ignored (falls through to the computed
 * value) rather than silently producing 0/NaN workers.
 */
export function resolveWorkerCount({
  cpuCount,
  override,
  cap = DEFAULT_WORKER_CAP,
}: ResolveWorkerOptions): number {
  const parsedOverride = parsePositiveInt(override);
  if (parsedOverride !== undefined) return parsedOverride;

  const safeCpuCount = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.floor(cpuCount) : 1;
  const effectiveCap = Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : DEFAULT_WORKER_CAP;
  const halfCores = Math.floor(safeCpuCount / 2);
  return Math.max(1, Math.min(halfCores, effectiveCap));
}

/**
 * Parse a strictly-positive, SAFE integer; returns `undefined` for anything
 * else. The digit-only regex admits arbitrarily long strings whose numeric
 * value exceeds `Number.MAX_SAFE_INTEGER` and loses precision (e.g. a giant
 * override rounding to a nonsense worker count), so a safe-integer check
 * rejects overflow rather than passing a lossy value straight to Playwright.
 */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}
