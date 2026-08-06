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

import type { OptimizeBasisRecordV2 as OptimizeBasisRow } from "./basis-row";

/** One planned reaping step, in the order it must be applied. */
export type ReapAction =
  | { kind: "clear-payload"; basisId: string; reason: ReapReason }
  | { kind: "delete-row"; basisId: string; reason: ReapReason };

export type ReapReason =
  | "expired"
  | "unreferenced"
  | "parent-of-expired-child" // never emitted; named so an accidental use is visible
  | "orphaned-child";

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
  const candidates = rows.filter((row) => row.ownerKind === "candidate");
  const ordinaries = rows.filter((row) => row.ownerKind === "ordinary");

  const doomed = new Set<string>();
  const payloadOnly: ReapAction[] = [];
  const childDeletes: ReapAction[] = [];
  const parentDeletes: ReapAction[] = [];

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
    if (!referencedBasisIds.has(row.basisId) && row.submittedYaml !== null) {
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
    if (isExpired(row, now)) {
      // A parent is only removed once no child row survives this pass. A surviving
      // child would otherwise be orphaned mid-plan; it is reaped next pass instead.
      const hasSurvivingChild = candidates.some(
        (child) => child.parentBasisId === row.basisId && !doomed.has(child.basisId),
      );
      if (!hasSurvivingChild) {
        parentDeletes.push({ kind: "delete-row", basisId: row.basisId, reason: "expired" });
        continue;
      }
    }
    if (!referencedBasisIds.has(row.basisId) && row.submittedYaml !== null) {
      payloadOnly.push({ kind: "clear-payload", basisId: row.basisId, reason: "unreferenced" });
    }
  }

  // INVARIANT 3 then 1: raw payload clears first, then children, then parents.
  return [...payloadOnly, ...childDeletes, ...parentDeletes];
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
  if (isExpired(row, now)) return false;
  return referencedBasisIds.has(row.basisId);
}
