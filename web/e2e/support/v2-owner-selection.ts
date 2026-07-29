// F4 — owner selection.
//
// `V2_MATRIX_OWNER` (browser suites) and `V2_STYLE_OWNER` (the static provenance
// scanner) share one vocabulary and one validator. Selection happens BEFORE the
// caller declares any test: the runner filters the frozen manifest and then
// calls `test()` / `describe()` on what survives. That is what makes
// `pnpm test:e2e` green at F4 with no hidden route debt — there is no
// `test.skip`, no conditional skip annotation, no migration ledger and no
// source mutation anywhere in this file, and no shape here that could express
// one.
//
//   absent      → foundation only (the F4 default)
//   R1 … R7     → exactly that ticket's rows
//   all         → every row, for G1
//   anything else, or a selection that resolves to nothing, is a CONFIGURATION
//   FAILURE raised before execution, carrying the accepted values and the
//   manifest inventory.

import {
  manifestInventory,
  V2_OWNERS,
  V2_SELECTORS,
  V2_STYLE_OWNER_FILES,
  V2_SURFACE_MATRIX,
  type V2Owner,
  type V2Row,
  type V2Selector,
} from "./v2-surface-matrix";

/** The env var the Playwright suites read. */
export const MATRIX_OWNER_ENV = "V2_MATRIX_OWNER";

/** The env var the static provenance scanner reads. */
export const STYLE_OWNER_ENV = "V2_STYLE_OWNER";

/**
 * The scope an absent selector means. Foundation is the default so that the
 * ordinary `pnpm test:e2e` a developer runs before route migration registers
 * only surfaces that are already v2 — not a suite of routes that are expected
 * to fail, which is how a red suite becomes background noise.
 */
export const DEFAULT_OWNER: V2Owner = "foundation";

/** Raised before any test is declared. Never caught to fall back to a default. */
export class V2OwnerSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V2OwnerSelectionError";
  }
}

function fail(envVar: string, raw: string, detail: string): never {
  throw new V2OwnerSelectionError(
    `${envVar}=${JSON.stringify(raw)} is not a valid selection: ${detail}\n` +
      `  accepted values: ${V2_SELECTORS.join(" | ")} (or unset, which means "${DEFAULT_OWNER}")\n` +
      `  manifest inventory: ${manifestInventory()}`,
  );
}

/**
 * Normalize a raw env value to a selector. `undefined` (unset) becomes the
 * foundation default; an EMPTY or whitespace-only string does NOT — it is a
 * configuration failure, because `V2_MATRIX_OWNER=` in a CI file reads as a
 * deliberate selection and silently widening it to the default would hide the
 * mistake.
 */
export function parseSelector(raw: string | undefined, envVar: string): V2Selector {
  if (raw === undefined) return DEFAULT_OWNER;
  if (raw.trim() === "") fail(envVar, raw, "the value is empty");
  // Deliberately case- and whitespace-SENSITIVE. R2a/R2b/R2c are distinct
  // owners one character apart, so quietly repairing "r2A " would be quietly
  // running a different ticket's rows than the caller asked for.
  if (!(V2_SELECTORS as readonly string[]).includes(raw)) {
    fail(envVar, raw, "unknown owner");
  }
  return raw as V2Selector;
}

/** The owners a selector expands to: `all` → every owner, otherwise just itself. */
export function ownersForSelector(selector: V2Selector): readonly V2Owner[] {
  return selector === "all" ? V2_OWNERS : [selector];
}

/**
 * The rows a selector registers, in manifest order. Throws when the selection
 * resolves to zero rows — which cannot happen against the frozen manifest, and
 * is exactly why it is asserted: a future edit that leaves an owner with no rows
 * would otherwise turn that ticket's suite into a silent no-op.
 */
export function selectRows(raw: string | undefined, envVar = MATRIX_OWNER_ENV): readonly V2Row[] {
  const selector = parseSelector(raw, envVar);
  const owners = new Set<string>(ownersForSelector(selector));
  const rows = V2_SURFACE_MATRIX.filter((row) => owners.has(row.owner));
  if (rows.length === 0) fail(envVar, String(raw), "the selection matches no manifest row");
  return rows;
}

/**
 * The static file-owner patterns a selector selects, de-duplicated and in a
 * stable order. Throws when the selection resolves to no patterns, for the same
 * reason `selectRows` does.
 */
export function selectStyleOwnerPatterns(
  raw: string | undefined,
  envVar = STYLE_OWNER_ENV,
): readonly string[] {
  const selector = parseSelector(raw, envVar);
  const patterns = ownersForSelector(selector).flatMap((owner) => V2_STYLE_OWNER_FILES[owner]);
  const unique = [...new Set(patterns)];
  if (unique.length === 0) fail(envVar, String(raw), "the selection owns no source files");
  return unique;
}

/**
 * The env shape these helpers read. Deliberately a plain record rather than
 * `NodeJS.ProcessEnv`, which requires `NODE_ENV` and so cannot be satisfied by
 * the small literal objects the unit tests pass in.
 */
export type EnvLike = Record<string, string | undefined>;

/** Convenience for the specs: read the process env and select. */
export function selectRowsFromEnv(env: EnvLike = process.env): readonly V2Row[] {
  return selectRows(env[MATRIX_OWNER_ENV], MATRIX_OWNER_ENV);
}

/** Convenience for the static scanner: read the process env and select. */
export function selectStyleOwnerPatternsFromEnv(env: EnvLike = process.env): readonly string[] {
  return selectStyleOwnerPatterns(env[STYLE_OWNER_ENV], STYLE_OWNER_ENV);
}

/** The selector actually in force, for a suite title or a diagnostic. */
export function activeSelector(
  envVar: string = MATRIX_OWNER_ENV,
  env: EnvLike = process.env,
): V2Selector {
  return parseSelector(env[envVar], envVar);
}

// ---------------------------------------------------------------------------
// Glob matching for the static owner sets
// ---------------------------------------------------------------------------

/**
 * Match a `web/`-relative POSIX path against one owner pattern.
 *
 * The supported grammar is deliberately tiny — `**` (any number of path
 * segments, including none) and `*` (any run of characters within one segment)
 * — because the owner sets are hand-authored and a fuller glob dialect would
 * only add ways to write a pattern that means something other than it looks
 * like. Every other character, including the parentheses in Next.js route-group
 * directories like `app/(app)/`, is matched literally.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

const globCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;

  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` swallows the separator too, so `a/**/*.tsx` matches `a/b.tsx`.
        if (pattern[i + 2] === "/") {
          source += "(?:[^/]+/)*";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  source += "$";

  const re = new RegExp(source);
  globCache.set(pattern, re);
  return re;
}

/** Whether any pattern in the set matches the path. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

/** The owner that claims `path`, or undefined when no owner does. */
export function ownerForPath(path: string): V2Owner | undefined {
  return V2_OWNERS.find((owner) => matchesAnyGlob(path, V2_STYLE_OWNER_FILES[owner]));
}
