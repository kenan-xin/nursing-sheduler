// Promoting a roster document to the working roster (F3 → F1 seam).
//
// F1 owns durability and atomicity: it runs the supplied validator OUTSIDE the
// transaction, then re-checks the source identity and the working revision INSIDE
// it before a single `put`. F3 owns what "valid" means. This module is the thin
// adapter that hands F1 the roster validator, so no caller can promote a document
// with a weaker check — or with none.
//
// The fail-closed guarantee Core Flows asks for follows from the composition: an
// import that fails to decode never reaches storage at all, and one that decodes
// but fails validation is rejected by F1 before `working` is touched. Either way
// the current roster and the source file/candidate are left intact.

import type { RosterStorage, WorkingPromotionOutcome } from "@/lib/store";
import { decodeRosterFile, decodeRosterFileBytes } from "./file";
import type { RosterVersionPolicy } from "./schema-version";
import { validateRosterDocument } from "./validate";
import type { RosterDocument } from "./types";

/** The compare-and-swap expectations a promotion must carry (see F1's contract). */
export interface PromotionFence {
  storage: RosterStorage;
  /** The working revision observed BEFORE the import/validation began. */
  expectedWorkingRevision: number | null;
  /** The clear epoch captured before the flow began. */
  expectedClearEpoch: number;
}

/**
 * A decode/validation failure BEFORE storage was involved. Distinct from F1's own
 * `rejected` so the caller can tell "this file is not importable" from "storage
 * refused the write" — the retry affordances differ.
 */
export interface ImportRejected {
  status: "import-rejected";
  reason: string;
}

export type RosterImportOutcome = WorkingPromotionOutcome | ImportRejected;

/** Promote an already-validated in-memory document. */
export function promoteRosterDocumentToWorking(
  document: RosterDocument,
  fence: PromotionFence,
): Promise<WorkingPromotionOutcome> {
  return fence.storage.promoteDocumentToWorking<RosterDocument>({
    document,
    // Deliberately the REAL validator, not a pass-through: F1 stores exactly what
    // the validator returns, so the value that lands in `working` is the one this
    // gate approved rather than one that merely passed an earlier check.
    validate: validateRosterDocument,
    expectedWorkingRevision: fence.expectedWorkingRevision,
    expectedClearEpoch: fence.expectedClearEpoch,
  });
}

/**
 * Import a user-selected roster file and, only if the whole document validates,
 * durably promote it to the working roster.
 */
export async function importRosterFileToWorking(
  file: Blob & { name?: string },
  fence: PromotionFence,
  policy?: RosterVersionPolicy,
): Promise<RosterImportOutcome> {
  const decoded = await decodeRosterFile(file, policy);
  if (!decoded.ok) return { status: "import-rejected", reason: decoded.reason };
  return promoteRosterDocumentToWorking(decoded.document, fence);
}

/** The bytes-only variant, for callers that already hold the file contents. */
export async function importRosterBytesToWorking(
  bytes: Uint8Array,
  fence: PromotionFence,
  policy?: RosterVersionPolicy,
): Promise<RosterImportOutcome> {
  const decoded = await decodeRosterFileBytes(bytes, policy);
  if (!decoded.ok) return { status: "import-rejected", reason: decoded.reason };
  return promoteRosterDocumentToWorking(decoded.document, fence);
}

/**
 * Promote a captured candidate to the working roster. The candidate was validated
 * when it was assembled; it is validated again here because the value has since
 * crossed a structured-clone boundary and F1 treats stored documents as opaque.
 */
export function promoteCandidateRosterToWorking(
  jobId: string,
  fence: PromotionFence,
): Promise<WorkingPromotionOutcome> {
  return fence.storage.promoteCandidateToWorking<RosterDocument>({
    jobId,
    validate: validateRosterDocument,
    expectedWorkingRevision: fence.expectedWorkingRevision,
    expectedClearEpoch: fence.expectedClearEpoch,
  });
}
