// T08 — the DURABLE ROW shape for an Optimize submission basis.
//
// This lives beside the rest of the basis code rather than inside
// `lib/repository/types.ts` on purpose. The authority boundary
// (`lib/store/authority-boundary.test.ts`) allows only the projection adapter to
// import the durable repository graph AT ALL — including for types — so a basis
// module that imported its own row type from there would be punching a hole in
// that gate for convenience. The dependency points outward instead: the
// repository re-exports this DTO for its table declaration.
//
// Distinct from `OptimizeBasisV2` in `./optimize-basis`, which is the CANONICAL
// ENCODABLE identity. This is the stored row that WRAPS it with local ownership,
// retention, and job-binding metadata.

/**
 * Who owns a basis row, and therefore what may delete it.
 *
 * `ordinary` is a real user-started Optimize run. `candidate` is a copied
 * counterfactual the assistant submitted (T10 creates them); it is always a CHILD
 * of an ordinary parent and is reaped before its parent, never the other way
 * round — a candidate expiring must not take the run it was derived from with it.
 */
export type OptimizeBasisOwnerKind = "ordinary" | "candidate";

/** The canonical `OptimizeBasisV2` fields, stored verbatim on the durable row. */
export interface OptimizeBasisRecordFields {
  schemaVersion: 2;
  submissionContractVersion: string;
  workspaceSchemaVersion: string;
  serializerVersion: string;
  anonymizationMode: string;
  inputSha256: string;
  normalizedOptions: { solver: string; prettify: boolean; timeoutSeconds: number };
  solverSemanticVersion: string;
  backendCapabilityVersion: string;
}

/**
 * An immutable Optimize submission basis row.
 *
 * IMMUTABLE means immutable: apart from the one-time job binding and the reaper
 * clearing `submittedYaml`, no field is ever rewritten. Rebinding a basis to a
 * different job, parent, or transform would let evidence gathered under one
 * submission be presented as evidence for another — precisely the confusion the
 * basis mechanism exists to prevent. A changed submission is a NEW row.
 *
 * The `optimizeBases` table's existing `expiresAt` index is the reaper's index, so
 * these fields need no Dexie schema version bump: only indexed properties are
 * declared in `lib/repository/schema.ts`.
 */
export interface OptimizeBasisRecordV2 {
  basisId: string;
  schemaVersion: 2;
  scenarioId: string;
  documentRevision: number;
  /** SHA-256 of the exact submitted bytes, lowercase hex. */
  submissionDigest: string;
  /** The full canonical basis, so a recovery check never re-derives it from parts. */
  basis: OptimizeBasisRecordFields;
  ownerKind: OptimizeBasisOwnerKind;
  /** Distinguishes two submissions of byte-identical input; never an identity. */
  attemptId: string;
  /** The accepted backend job, or `null` while submission is unconfirmed. */
  jobId: string | null;
  /** The ordinary parent a candidate derives from; always `null` for `ordinary`. */
  parentBasisId: string | null;
  /** Digest over the validated command set + host diff that produced a candidate. */
  transformDigest: string | null;
  /**
   * The raw submitted YAML, retained only while something still needs it. Cleared
   * by the reaper BEFORE the row itself is removed, so the compact identity
   * survives in history after the raw material is gone.
   */
  submittedYaml: string | null;
  createdAt: string;
  /** Advertised retention expiry of the associated job. */
  expiresAt: string | null;
}
