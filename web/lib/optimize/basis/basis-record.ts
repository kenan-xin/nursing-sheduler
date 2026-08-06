// T08 — building the immutable local basis record and the submission fields that
// let the backend verify it independently.
//
// One function derives BOTH, from ONE prepared submission, so the bytes that were
// digested, the bytes that are stored, and the bytes that are sent cannot diverge.
// Deriving them separately is exactly how a basis ends up describing a document
// nobody submitted.

import { WORKSPACE_VERSION } from "@/lib/scenario";
import type { InfoSemanticProfile } from "@/app/api/info/types";
import type {
  OptimizeBasisOwnerKind,
  OptimizeBasisRecordFields,
  OptimizeBasisRecordV2 as OptimizeBasisRow,
} from "./basis-row";
import {
  BASIS_SCHEMA_VERSION,
  computeBasisId,
  sha256HexOfUtf8,
  type AnonymizationMode,
  type OptimizeBasisV2,
} from "./optimize-basis";

/**
 * Version of the exact-YAML serializer that produces submitted bytes
 * (`serializeCanonicalDocument`).
 *
 * BUMP THIS whenever that serializer's output changes for an unchanged document.
 * Failing to bump it would let two byte-different submissions of the same scenario
 * claim the same serializer semantics; the `inputSha256` would still differ, so
 * identity stays sound, but the recorded provenance would be a lie.
 */
export const OPTIMIZE_SERIALIZER_VERSION = "canonical-strict-yaml-v1";

/** The exact solver selector the backend accepts. */
export const OPTIMIZE_SOLVER = "ortools/cp-sat";

/** The form fields a submission carries so the backend can re-verify the claim. */
export interface BasisSubmissionFields {
  basis_id: string;
  input_sha256: string;
  submission_contract_version: string;
  workspace_schema_version: string;
  serializer_version: string;
  anonymization_mode: AnonymizationMode;
  expected_solver_semantic_version: string;
  expected_backend_capability_version: string;
  parent_basis_id?: string;
  transform_digest?: string;
}

export interface BuildBasisInput {
  /** The EXACT strict YAML that will be submitted, byte for byte. */
  yaml: string;
  /** Whether the fixed people-only anonymization transform produced those bytes. */
  anonymized: boolean;
  /** The profile just read from `/info`. */
  profile: InfoSemanticProfile;
  /**
   * The options that will actually be SENT. The backend binds its RESOLVED values
   * into the basis, so a client that omits an option and guesses its default fails
   * the identity comparison. Both are therefore required here and must be sent.
   */
  options: { prettify: boolean; timeoutSeconds: number };
  scenarioId: string;
  documentRevision: number;
  ownerKind: OptimizeBasisOwnerKind;
  attemptId: string;
  /** Required for a candidate, forbidden for an ordinary run. */
  parentBasisId?: string;
  transformDigest?: string;
  /** Injected so the record's timestamp is deterministic in tests. */
  now: Date;
}

export interface BuiltBasis {
  basisId: string;
  basis: OptimizeBasisV2;
  fields: BasisSubmissionFields;
  /** The immutable local row, before the accepted job id is bound. */
  record: OptimizeBasisRow;
}

/** A candidate must own a parent and a transform; an ordinary run must own neither. */
export class BasisOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BasisOwnershipError";
  }
}

function toRecordFields(basis: OptimizeBasisV2): OptimizeBasisRecordFields {
  return {
    schemaVersion: basis.schemaVersion,
    submissionContractVersion: basis.submissionContractVersion,
    workspaceSchemaVersion: basis.workspaceSchemaVersion,
    serializerVersion: basis.serializerVersion,
    anonymizationMode: basis.anonymizationMode,
    inputSha256: basis.inputSha256,
    normalizedOptions: { ...basis.normalizedOptions },
    solverSemanticVersion: basis.solverSemanticVersion,
    backendCapabilityVersion: basis.backendCapabilityVersion,
  };
}

/**
 * Build the basis, its submission fields, and the immutable local row from one
 * prepared submission.
 *
 * @throws {BasisOwnershipError} If the ownership fields contradict `ownerKind`.
 * @throws {OptimizeBasisError} If a field is out of domain or Web Crypto is absent.
 */
export async function buildOptimizeBasis(input: BuildBasisInput): Promise<BuiltBasis> {
  const isCandidate = input.ownerKind === "candidate";
  const parentBasisId = input.parentBasisId ?? null;
  const transformDigest = input.transformDigest ?? null;
  if (isCandidate && (parentBasisId === null || transformDigest === null)) {
    throw new BasisOwnershipError(
      "A candidate basis must carry both a parent basis id and a transform digest.",
    );
  }
  if (!isCandidate && (parentBasisId !== null || transformDigest !== null)) {
    throw new BasisOwnershipError(
      "An ordinary basis must not carry a parent basis id or a transform digest.",
    );
  }

  const anonymizationMode: AnonymizationMode = input.anonymized ? "people" : "none";
  const inputSha256 = await sha256HexOfUtf8(input.yaml);
  const basis: OptimizeBasisV2 = {
    schemaVersion: BASIS_SCHEMA_VERSION,
    submissionContractVersion: input.profile.submission_contract_version,
    workspaceSchemaVersion: String(WORKSPACE_VERSION),
    serializerVersion: OPTIMIZE_SERIALIZER_VERSION,
    anonymizationMode,
    inputSha256,
    normalizedOptions: {
      solver: OPTIMIZE_SOLVER,
      prettify: input.options.prettify,
      timeoutSeconds: input.options.timeoutSeconds,
    },
    solverSemanticVersion: input.profile.solver_semantic_version,
    backendCapabilityVersion: input.profile.backend_capability_version,
  };
  const basisId = await computeBasisId(basis);

  const fields: BasisSubmissionFields = {
    basis_id: basisId,
    input_sha256: inputSha256,
    submission_contract_version: basis.submissionContractVersion,
    workspace_schema_version: basis.workspaceSchemaVersion,
    serializer_version: basis.serializerVersion,
    anonymization_mode: anonymizationMode,
    expected_solver_semantic_version: basis.solverSemanticVersion,
    expected_backend_capability_version: basis.backendCapabilityVersion,
    ...(parentBasisId !== null ? { parent_basis_id: parentBasisId } : {}),
    ...(transformDigest !== null ? { transform_digest: transformDigest } : {}),
  };

  return {
    basisId,
    basis,
    fields,
    record: {
      basisId,
      schemaVersion: BASIS_SCHEMA_VERSION,
      scenarioId: input.scenarioId,
      documentRevision: input.documentRevision,
      submissionDigest: inputSha256,
      basis: toRecordFields(basis),
      ownerKind: input.ownerKind,
      attemptId: input.attemptId,
      // Bound only once the backend confirms a matching identity; until then the
      // row records an attempt, not an accepted run.
      jobId: null,
      parentBasisId,
      transformDigest,
      submittedYaml: input.yaml,
      createdAt: input.now.toISOString(),
      expiresAt: null,
    },
  };
}

/** The backend identifiers a client must match before binding a job to a basis. */
export interface AcceptedJobIdentity {
  jobId: string;
  basisId: string | null;
  inputSha256: string | null;
  expiresAt: string | null;
}

/**
 * Bind an accepted job to a local basis row, or refuse.
 *
 * Returns `null` when the backend's echoed identity disagrees with what was
 * submitted. That is a TRANSPORT-INTEGRITY failure, not a retryable hiccup: the
 * caller quarantines the attempt rather than binding a job whose evidence would
 * be attributed to the wrong submission. Because binding is the only write that
 * ever touches an accepted row, refusing here keeps the row immutable-and-correct
 * rather than immutable-and-wrong.
 */
export function bindAcceptedJob(
  record: OptimizeBasisRow,
  accepted: AcceptedJobIdentity,
): OptimizeBasisRow | null {
  if (record.jobId !== null) return null;
  if (accepted.basisId !== record.basisId) return null;
  if (accepted.inputSha256 !== record.submissionDigest) return null;
  return { ...record, jobId: accepted.jobId, expiresAt: accepted.expiresAt };
}
