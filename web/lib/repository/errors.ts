// Typed repository failures. Every fenced operation fails CLOSED with one of
// these codes rather than a bare `Error`, so callers (and T03's cutover paths)
// can distinguish "you are stale, reread" from "the write itself broke".

export type RepositoryErrorCode =
  /** No envelope exists for the requested scenario identity. */
  | "scenario_not_found"
  /** The caller's expected scenario identity is not the one it is writing to. */
  | "scenario_mismatch"
  /** The caller's `expectedDocumentRevision` is not the persisted one. */
  | "stale_revision"
  /** No lease, or the lease belongs to another tab. */
  | "not_owner"
  /** The lease exists and is this tab's, but it expired. */
  | "lease_expired"
  /** The caller presented an epoch older than the persisted one (took over). */
  | "lease_epoch_stale"
  /** A switch target is already owned by a live writer in another tab. */
  | "target_owned"
  /** Nothing reversible remains at the history cursor. */
  | "nothing_to_undo"
  /** Nothing reapplyable remains above the history cursor. */
  | "nothing_to_redo"
  /** A captured assistant generation no longer matches the permanent fence. */
  | "generation_fenced"
  /** The same idempotency key was replayed with different input. */
  | "idempotency_conflict"
  /** The legacy persisted record could not be parsed or sanitized. */
  | "migration_corrupt"
  /** The command's RESULT is not a structurally valid scenario document. */
  | "invalid_document"
  /** A proposal's own commands no longer validate against the persisted document. */
  | "proposal_rejected"
  /** The persisted proposal is missing, settled, or not the one being applied. */
  | "proposal_conflict"
  /** An operational assumption has no matching confirmation for this revision. */
  | "confirmation_missing"
  /** The receipt's commit is not the current reversible top of this session. */
  | "receipt_not_undoable";

/** A repository operation that failed a durable precondition or fence. */
export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: RepositoryErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "RepositoryError";
    this.code = code;
    this.detail = detail;
  }
}

/** Narrow an unknown throwable to a {@link RepositoryError} with a given code. */
export function isRepositoryError(
  error: unknown,
  code?: RepositoryErrorCode,
): error is RepositoryError {
  return error instanceof RepositoryError && (code === undefined || error.code === code);
}
