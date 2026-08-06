// The solved-baseline identifier (F3).
//
// `solvedBaselineId` is SHA-256 over deterministic UTF-8 canonical JSON of
//
//   { schemaVersion: "roster-baseline/1",
//     people: [typed ids in axis order],
//     dates:  [ISO dates in axis order],
//     solvedDays }
//
// with object keys sorted, array order preserved, and no insignificant
// whitespace. Import RECOMPUTES it from the imported axes and grid and compares,
// so a file whose baseline was tampered with — or whose axes and grid no longer
// agree with the hash they were captured under — fails closed.
//
// Typed ids are emitted by `canonicalStringify` at their JSON type: a numeric `1`
// serializes as `1` and a string `"1"` as `"1"`, so the two never hash alike.
// This is the reason the axes are ordered arrays and not an id-keyed object — an
// object key would collapse both to `"1"`.

import { canonicalStringify, type IsoDate, type PersonId } from "@/lib/scenario";
import { ROSTER_BASELINE_SCHEMA_VERSION, type RosterDayState } from "./types";

/** The axes and grid the baseline identity is computed over. */
export interface RosterBaselineInput {
  people: readonly { id: PersonId }[];
  dates: readonly { iso: IsoDate }[];
  solvedDays: readonly (readonly RosterDayState[])[];
}

/** The exact canonical JSON string the digest is taken over (test-visible). */
export function canonicalBaselineJson(input: RosterBaselineInput): string {
  return canonicalStringify({
    schemaVersion: ROSTER_BASELINE_SCHEMA_VERSION,
    people: input.people.map((person) => person.id),
    dates: input.dates.map((date) => date.iso),
    solvedDays: input.solvedDays,
  });
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A 64-character lowercase hex SHA-256 digest. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Whether a value has the shape of a SHA-256 hex digest. */
export function isSolvedBaselineId(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/**
 * Compute the SHA-256 `solvedBaselineId`. Async because Web Crypto's digest is —
 * this is a cryptographic identity check on untrusted input, so unlike the
 * scenario dirty fingerprint (`scenario/hash.ts`) a non-cryptographic hash would
 * not do.
 */
export async function computeSolvedBaselineId(input: RosterBaselineInput): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalBaselineJson(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}
