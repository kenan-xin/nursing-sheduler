// Strict, closed parser for core's `GET /optimize/options`
// (core/nurse_scheduling/server/api/schemas.py::OptimizationOptionsResponse). The
// whole payload is checked, because core owns it, but only the default solver's
// timeout is relayed: v2 is CP-SAT only (U31), so no screen reads the solver
// choices, compute kind, controls or prettify default.

/** The timeout default and inclusive bounds a deployment accepts, in seconds. */
export interface OptimizeTimeoutOptions {
  default: number;
  minimum: number;
  maximum: number;
}

/** The BFF's `200` body for `GET /api/optimize/options`. */
export interface OptimizeOptionsResponse {
  timeout: OptimizeTimeoutOptions;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** Core's own invariant (config.py): integers with `1 <= minimum <= default <= maximum`. */
export function readTimeoutOptions(value: unknown): OptimizeTimeoutOptions | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["default", "minimum", "maximum"])) {
    return null;
  }
  const { default: fallback, minimum, maximum } = value;
  if (
    !Number.isSafeInteger(fallback) ||
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum)
  ) {
    return null;
  }
  const [d, min, max] = [fallback, minimum, maximum] as number[];
  if (min < 1 || min > d || d > max) return null;
  return { default: d, minimum: min, maximum: max };
}

function readChoice(value: unknown): { value: string; timeout: OptimizeTimeoutOptions } | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["value", "label", "compute", "timeout", "controls"])
  ) {
    return null;
  }
  const { controls } = value;
  if (
    !isNonEmptyString(value.value) ||
    !isNonEmptyString(value.label) ||
    (value.compute !== "cpu" && value.compute !== "gpu") ||
    !isPlainObject(controls) ||
    !hasExactKeys(controls, ["cancel_running", "finish_now"]) ||
    typeof controls.cancel_running !== "boolean" ||
    typeof controls.finish_now !== "boolean"
  ) {
    return null;
  }
  const timeout = readTimeoutOptions(value.timeout);
  return timeout === null ? null : { value: value.value, timeout };
}

/** The default solver's timeout options, or `null` unless the body is EXACTLY core's shape. */
export function parseOptimizeOptionsPayload(body: unknown): OptimizeOptionsResponse | null {
  if (!isPlainObject(body) || !hasExactKeys(body, ["schema_version", "solver", "prettify"])) {
    return null;
  }
  const { solver, prettify } = body;
  if (
    body.schema_version !== "alpha" ||
    !isPlainObject(prettify) ||
    !hasExactKeys(prettify, ["default"]) ||
    typeof prettify.default !== "boolean" ||
    !isPlainObject(solver) ||
    !hasExactKeys(solver, ["default", "choices"]) ||
    !isNonEmptyString(solver.default) ||
    !Array.isArray(solver.choices) ||
    solver.choices.length === 0
  ) {
    return null;
  }
  const choices = solver.choices.map(readChoice);
  if (choices.some((choice) => choice === null)) return null;
  const selected = choices.find((choice) => choice?.value === solver.default);
  return selected ? { timeout: selected.timeout } : null;
}
