// T08 — the expiry-indexed local reaper for Optimize basis rows.
//
// Pure planning, deliberately separated from the Dexie write: the ORDERING is the
// correctness property, and a pure plan can be asserted on directly instead of
// inferred from surviving rows after a transaction.
//
// Four invariants, each protecting a different failure:
//   1. Children before parents — a candidate is removed before the ordinary run it
//      derives from, so a parent is never orphaned by its own child's removal.
//   2. Candidate expiry never removes the ordinary parent — a diagnostic side
//      quest must not destroy the real run's evidence.
//   3. Raw material before compact identity — the submitted YAML is cleared first,
//      so history keeps readable identifiers and diffs after the payload is gone.
//   4. No reference extends validity — an active reference may hold RAW DISPLAY
//      DATA past its natural removal, but never past the advertised server expiry.
//      Evidence validity is the server's to grant, not the browser's to renew.
//   5. A legacy row is retained under a POLICY, never by omission — see
//      `LEGACY RETENTION POLICY` below.
//
// LEGACY RETENTION POLICY (schema V1 rows).
// A pre-T08 row cannot be partitioned by `ownerKind` because it has none, and it
// can never become trusted evidence because its digest was produced by an encoder
// this build no longer has. Partitioning on `ownerKind` alone therefore matched it
// as neither candidate nor ordinary and retained it forever. The policy is:
//   • EXPIRED (including an absent or unreadable expiry) → DELETE the row. Its
//     advertised retention has run out and nothing can read it, so keeping it is
//     retention without a purpose.
//   • UNEXPIRED → COMPACT it: drop any raw material it holds and keep the compact
//     identity until its own advertised expiry, exactly as invariant 3 does for a
//     V2 row. A reference cannot protect it, because nothing may display raw
//     material whose provenance cannot be verified.

import {
  basisRowPayload,
  isOptimizeBasisRecordV2,
  type OptimizeBasisRecordV2,
  type StoredOptimizeBasisRow as OptimizeBasisRow,
} from "./basis-row";

/** One planned reaping step, in the order it must be applied. */
export type ReapAction =
  | { kind: "clear-payload"; basisId: string; reason: ReapReason }
  | { kind: "delete-row"; basisId: string; reason: ReapReason };

export type ReapReason =
  | "expired"
  | "unreferenced"
  | "parent-of-expired-child" // never emitted; named so an accidental use is visible
  | "orphaned-child"
  /** A schema-V1 row past its advertised expiry, removed under the legacy policy. */
  | "legacy-expired"
  /** A still-unexpired schema-V1 row, compacted because it can never be read. */
  | "legacy-unreadable";

export interface ReapInput {
  rows: OptimizeBasisRow[];
  /**
   * Basis ids something still needs: a non-terminal candidate, an open Preview, or
   * a receipt reconciliation. A referenced row keeps its payload only while it is
   * also unexpired.
   */
  referencedBasisIds: ReadonlySet<string>;
  now: Date;
}

function expiryMillis(row: OptimizeBasisRow): number {
  if (row.expiresAt === null) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(row.expiresAt);
  // An absent or unparseable expiry is treated as already expired, never as
  // "retain forever": an unreadable expiry must not become unbounded retention.
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

function isExpired(row: OptimizeBasisRow, now: Date): boolean {
  return expiryMillis(row) <= now.getTime();
}

/**
 * Plan the reaping pass over a set of basis rows.
 *
 * The returned actions are ORDERED and must be applied in sequence. Applying them
 * out of order breaks invariants 1 and 3 even though the final row set matches.
 */
export function planReap(input: ReapInput): ReapAction[] {
  const { rows, referencedBasisIds, now } = input;

  const byId = new Map(rows.map((row) => [row.basisId, row]));
  // Legacy rows are partitioned FIRST and explicitly. Every later partition reads
  // a V2-only field, so a row that reached one of them without being a real V2
  // record would silently fall through all of them — which is precisely how an
  // expired legacy row previously yielded an empty plan forever.
  const current: OptimizeBasisRecordV2[] = [];
  const legacy: OptimizeBasisRow[] = [];
  for (const row of rows) {
    if (isOptimizeBasisRecordV2(row)) current.push(row);
    else legacy.push(row);
  }
  const candidates = current.filter((row) => row.ownerKind === "candidate");
  const ordinaries = current.filter((row) => row.ownerKind === "ordinary");

  const doomed = new Set<string>();
  const payloadOnly: ReapAction[] = [];
  const childDeletes: ReapAction[] = [];
  const parentDeletes: ReapAction[] = [];
  const legacyDeletes: ReapAction[] = [];

  /**
   * A parent may only go once no child row survives THIS pass; a surviving child
   * would otherwise be orphaned mid-plan. It is reaped next pass instead.
   */
  const hasSurvivingChild = (basisId: string): boolean =>
    candidates.some((child) => child.parentBasisId === basisId && !doomed.has(child.basisId));

  // ---- children first -----------------------------------------------------
  for (const row of candidates) {
    // A candidate whose parent row is gone can never be interpreted again; it is
    // removed regardless of its own expiry rather than left as unreadable residue.
    if (row.parentBasisId === null || !byId.has(row.parentBasisId)) {
      doomed.add(row.basisId);
      childDeletes.push({ kind: "delete-row", basisId: row.basisId, reason: "orphaned-child" });
      continue;
    }
    if (isExpired(row, now)) {
      doomed.add(row.basisId);
      childDeletes.push({ kind: "delete-row", basisId: row.basisId, reason: "expired" });
      continue;
    }
    // Unexpired but unreferenced: drop the copied raw material early. The compact
    // identity stays so history remains readable.
    if (!referencedBasisIds.has(row.basisId) && basisRowPayload(row) !== null) {
      payloadOnly.push({
        kind: "clear-payload",
        basisId: row.basisId,
        reason: "unreferenced",
      });
    }
  }

  // ---- then parents -------------------------------------------------------
  for (const row of ordinaries) {
    // INVARIANT 2: a live child is NOT a reason to delete the parent, and an
    // expired child is not either. Only the parent's OWN expiry removes it.
    if (isExpired(row, now) && !hasSurvivingChild(row.basisId)) {
      parentDeletes.push({ kind: "delete-row", basisId: row.basisId, reason: "expired" });
      continue;
    }
    if (!referencedBasisIds.has(row.basisId) && basisRowPayload(row) !== null) {
      payloadOnly.push({ kind: "clear-payload", basisId: row.basisId, reason: "unreferenced" });
    }
  }

  // ---- then legacy rows, under the documented policy ----------------------
  for (const row of legacy) {
    // A V2 candidate hanging off a legacy parent is vanishingly unlikely (T10
    // creates candidates and only from V2 parents), but the guard is the same one
    // ordinaries use so invariant 1 does not depend on that staying true.
    if (isExpired(row, now) && !hasSurvivingChild(row.basisId)) {
      legacyDeletes.push({ kind: "delete-row", basisId: row.basisId, reason: "legacy-expired" });
      continue;
    }
    // Unexpired: compact it. A REFERENCE DOES NOT PROTECT IT — unlike a V2 row,
    // nothing may display raw material whose provenance cannot be verified.
    if (basisRowPayload(row) !== null) {
      payloadOnly.push({
        kind: "clear-payload",
        basisId: row.basisId,
        reason: "legacy-unreadable",
      });
    }
  }

  // INVARIANT 3 then 1: raw payload clears first, then children, then parents —
  // legacy deletes ride with the parents, after every child has been removed.
  return [...payloadOnly, ...childDeletes, ...parentDeletes, ...legacyDeletes];
}

/**
 * Whether a row's RAW PAYLOAD may still be shown.
 *
 * An active reference keeps display data alive up to — never beyond — the
 * advertised expiry. This is the check that stops a long-lived Preview from
 * quietly extending the life of evidence the server has already released.
 */
export function mayRetainPayload(
  row: OptimizeBasisRow,
  referencedBasisIds: ReadonlySet<string>,
  now: Date,
): boolean {
  // A legacy row's raw material is never displayable: its identity was produced by
  // an encoder this build no longer has, so nothing can attest what those bytes
  // are. No reference can grant what verification cannot.
  if (!isOptimizeBasisRecordV2(row)) return false;
  if (isExpired(row, now)) return false;
  return referencedBasisIds.has(row.basisId);
}
