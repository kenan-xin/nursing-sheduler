// T08 — the CLOSED recovery classification for a past Optimize run.
//
// The question this answers is narrow and load-bearing: may this old result be
// used as evidence about the current scenario? The answer is derived only from
// host-held facts — the local basis row, the server's job record, and the live
// semantic profile. Chat prose, a job id, a people count, a timestamp, or "it
// looks like the same scenario" NEVER upgrade a failure state to trusted.
//
// Exactly one state (`trusted`) enables diagnosis. Every other state is readable
// history and nothing more. There is no "probably fine" middle.

import type { JobBasis } from "@/lib/bff/types";
import type { OptimizeBasisRecordV2 as OptimizeBasisRow } from "./basis-row";
import type { InfoSemanticProfile } from "@/app/api/info/types";

/**
 * The closed set of recovery states.
 *
 * `semantic-mismatch` and `integrity-mismatch` are deliberately distinct: the
 * first is a backend that legitimately moved on (retry works), the second means
 * two sides disagree about what was submitted (retrying the same thing is not
 * obviously safe, and the row is quarantined).
 */
export type RecoveryState =
  | "trusted"
  | "local-only"
  | "server-only"
  | "semantic-mismatch"
  | "integrity-mismatch";

export interface RecoveryClassification {
  state: RecoveryState;
  /** Only ever true for `trusted`. */
  diagnosisEnabled: boolean;
  /** A stable machine-readable reason; never free text. */
  reason: string;
}

/** What the server currently says about the job this basis was submitted as. */
export type ServerJobFacts =
  | { kind: "present"; basis: JobBasis | null; expiresAt: string | null }
  | { kind: "missing" };

export interface RecoveryInput {
  /** The immutable local row, or `null` when it was never written or was reaped. */
  local: OptimizeBasisRow | null;
  server: ServerJobFacts;
  /** The profile the backend advertises RIGHT NOW, or `null` when unknown. */
  liveProfile: InfoSemanticProfile | null;
  /** Current time, injected so expiry classification is deterministic in tests. */
  now: Date;
}

function classification(
  state: RecoveryState,
  reason: string,
  diagnosisEnabled = false,
): RecoveryClassification {
  return { state, diagnosisEnabled, reason };
}

/** Whether an advertised expiry has passed. An absent expiry is treated as expired. */
function isExpired(expiresAt: string | null, now: Date): boolean {
  if (expiresAt === null) return true;
  const at = Date.parse(expiresAt);
  // An unparseable expiry is not a licence to keep trusting the row.
  return Number.isNaN(at) || at <= now.getTime();
}

/**
 * Classify one past run against current local and server state.
 *
 * Order matters and is deliberate: PRESENCE first (is there anything to compare?),
 * then INTEGRITY (do the two sides describe the same submission?), then SEMANTICS
 * (were they solved under the same rules?). Checking semantics before integrity
 * would report a mismatched-bytes run as a mere version drift and invite a retry
 * that silently re-submits different content.
 */
export function classifyRecovery(input: RecoveryInput): RecoveryClassification {
  const { local, server, liveProfile, now } = input;

  if (local === null) {
    return server.kind === "present"
      ? classification("server-only", "local_basis_missing")
      : classification("local-only", "nothing_retained");
  }
  if (server.kind === "missing") {
    return classification("local-only", "server_job_missing");
  }

  // A server job with no basis cannot be compared at all. It is not an integrity
  // FAILURE (nothing contradicts), it simply carries no identity to trust.
  if (server.basis === null) {
    return classification("server-only", "server_basis_absent");
  }

  // Integrity: the two sides must agree on the identity AND the bytes behind it.
  if (server.basis.basis_id !== local.basisId) {
    return classification("integrity-mismatch", "basis_id_mismatch");
  }
  if (server.basis.input_sha256 !== local.submissionDigest) {
    return classification("integrity-mismatch", "input_digest_mismatch");
  }

  // Ownership: a candidate must still hang off the exact parent and transform it
  // was created for. A rebound child would present one run's evidence as another's.
  if (
    (server.basis.parent_basis_id ?? null) !== local.parentBasisId ||
    (server.basis.transform_digest ?? null) !== local.transformDigest
  ) {
    return classification("integrity-mismatch", "ownership_mismatch");
  }

  // Semantics: the stored run's rules must still be the rules in force. An unknown
  // live profile fails closed — "we cannot check" is not "it matches".
  if (liveProfile === null) {
    return classification("semantic-mismatch", "live_profile_unknown");
  }
  if (
    local.basis.solverSemanticVersion !== liveProfile.solver_semantic_version ||
    local.basis.backendCapabilityVersion !== liveProfile.backend_capability_version ||
    local.basis.submissionContractVersion !== liveProfile.submission_contract_version
  ) {
    return classification("semantic-mismatch", "semantic_profile_changed");
  }
  // The server's own record of the run must agree too: a job solved under an older
  // profile is stale even when the local row happens to match today's.
  if (
    server.basis.solver_semantic_version !== liveProfile.solver_semantic_version ||
    server.basis.backend_capability_version !== liveProfile.backend_capability_version
  ) {
    return classification("semantic-mismatch", "server_profile_stale");
  }

  // Expiry: evidence validity never outlives the advertised expiry, even while the
  // job record still happens to be readable. The SERVER's expiry is authoritative
  // — a local row cannot extend the life of evidence it does not own.
  if (isExpired(server.expiresAt, now)) {
    return classification("server-only", "server_evidence_expired");
  }

  return classification("trusted", "basis_match", true);
}

/**
 * Whether the CURRENT scenario still matches the basis a result was submitted
 * against. A trusted basis proves what was solved; it does not prove the user has
 * not edited since, which is a separate "Out of date" state in the product.
 */
export function isBasisCurrent(
  local: OptimizeBasisRow,
  current: { scenarioId: string; documentRevision: number },
): boolean {
  return (
    local.scenarioId === current.scenarioId && local.documentRevision === current.documentRevision
  );
}
