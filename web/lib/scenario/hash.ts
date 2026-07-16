// Canonical hashing (T18) — the dirty-baseline fingerprint T04 persists and
// compares against. The requirement is a *deterministic, order-independent*
// fingerprint over a `CanonicalScenarioDocument`: two semantically-equal
// documents (same fields, object keys in any insertion order) hash identically,
// and any change to the canonical document changes the hash.
//
// Zero-dependency and isomorphic by design. Web Crypto's `crypto.subtle.digest`
// is async and Node's `crypto.createHash` is not available in the browser store,
// so neither fits a synchronous, environment-agnostic dirty check. Instead we
// canonically stringify (sorted keys) and run two FNV-1a-64 passes (forward and
// reversed) to a 128-bit hex digest. This is a *change-detection* fingerprint,
// not a cryptographic hash — a missed-dirty collision is astronomically unlikely
// and non-catastrophic (worst case: one un-flagged edit).

import type { CanonicalScenarioDocument } from "./types";

/**
 * Deterministically serialize a JSON-like value with object keys sorted, so that
 * key *insertion order* never affects the output. `undefined` object properties
 * are dropped; `undefined` array elements become `null`; the non-finite numbers
 * `Infinity` / `-Infinity` / `NaN` (which `JSON.stringify` would turn into
 * `null`) are preserved.
 *
 * Non-finite numbers and bigints are encoded as **unquoted barewords** with an
 * `@` sentinel prefix (e.g. `@Infinity`). Every genuine string is emitted via
 * `JSON.stringify` and is therefore double-quoted, and every finite number is
 * emitted as digits, so a bareword `@Infinity` can never collide with the
 * literal string `"@Infinity"` (which serializes with its quotes) or any other
 * value — the alias the original quoted tags allowed is gone.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null) return "null";

  const type = typeof value;

  if (type === "number") {
    const n = value as number;
    if (Number.isFinite(n)) return String(n);
    if (n === Infinity) return "@Infinity";
    if (n === -Infinity) return "@-Infinity";
    return "@NaN";
  }

  if (type === "bigint") return `@bigint:${(value as bigint).toString()}`;
  if (type === "string") return JSON.stringify(value);
  if (type === "boolean") return value ? "true" : "false";

  if (Array.isArray(value)) {
    const parts = value.map((element) =>
      canonicalStringify(element === undefined ? null : element),
    );
    return `[${parts.join(",")}]`;
  }

  if (type === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`);
    return `{${parts.join(",")}}`;
  }

  // `undefined`, functions, symbols at the top level have no canonical form.
  return "null";
}

// `BigInt(...)` constructors (not `123n` literals) — the tsconfig target is
// ES2017, which forbids BigInt literal syntax though the runtime type is fine.
const FNV_PRIME = BigInt("1099511628211");
const FNV_MASK = (BigInt(1) << BigInt(64)) - BigInt(1);
const FNV_OFFSET_FORWARD = BigInt("14695981039346656037");
// A distinct offset basis for the reverse pass (the forward basis' 64-bit
// complement), decorrelating the two digests.
const FNV_OFFSET_REVERSE = FNV_OFFSET_FORWARD ^ FNV_MASK;

function fnv1a64(bytes: Uint8Array, offsetBasis: bigint, reverse: boolean): bigint {
  let hash = offsetBasis & FNV_MASK;
  const length = bytes.length;
  for (let i = 0; i < length; i++) {
    const byte = bytes[reverse ? length - 1 - i : i];
    hash = (hash ^ BigInt(byte)) & FNV_MASK;
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash;
}

function toHex64(hash: bigint): string {
  return hash.toString(16).padStart(16, "0");
}

/**
 * Order-independent 128-bit fingerprint of a canonical scenario document,
 * returned as a 32-character lowercase hex string. Stable across runs and
 * environments; changes iff `canonicalStringify(doc)` changes.
 */
export function canonicalHash(doc: CanonicalScenarioDocument): string {
  const json = canonicalStringify(doc);
  const bytes = new TextEncoder().encode(json);
  const forward = fnv1a64(bytes, FNV_OFFSET_FORWARD, false);
  const reverse = fnv1a64(bytes, FNV_OFFSET_REVERSE, true);
  return toHex64(forward) + toHex64(reverse);
}
