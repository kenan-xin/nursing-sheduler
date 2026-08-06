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
 * The SHIPPED pre-T08 basis row, still sitting in real browsers.
 *
 * A build before T08 wrote `schemaVersion: 1` rows carrying a
 * `semanticBasisDigest` and none of the V2 identity. The Dexie 2 -> 3 upgrade is
 * purely additive and deliberately does NOT rewrite rows (see
 * `lib/repository/schema-upgrade.test.ts`), so these survive byte for byte and
 * every reader has to discriminate rather than assume.
 *
 * There is no path from a V1 row to trusted evidence: its digest was computed by
 * an encoder this build no longer has, so nothing here can be recomputed or
 * compared. It is READABLE HISTORY awaiting retention, and nothing more.
 */
export interface OptimizeBasisRecordV1 {
  basisId: string;
  schemaVersion: 1;
  scenarioId: string;
  documentRevision: number;
  submissionDigest: string;
  /** The pre-T08 identity: a digest no current reader can recompute or verify. */
  semanticBasisDigest: string;
  createdAt: string;
  expiresAt: string | null;
  /**
   * Declared OPTIONAL because the shipped V1 row has no such field. It exists on
   * the type only so the reaper can compact a legacy row that somehow holds raw
   * material without inventing a shape the row never had.
   */
  submittedYaml?: string | null;
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

/**
 * Everything the durable `optimizeBases` table may actually hold: an EXPLICIT
 * union, not a V2 row plus optimism.
 *
 * The table has existed since T02 and its rows are never rewritten, so a browser
 * that ran a pre-T08 build still has V1 rows in it. Typing the table as V2 alone
 * made every read a silent, unchecked cast — which is how an expired legacy row
 * became invisible to the reaper and was retained forever. Readers discriminate
 * with `isOptimizeBasisRecordV2` and fail closed on anything else.
 */
export type StoredOptimizeBasisRow = OptimizeBasisRecordV1 | OptimizeBasisRecordV2;

const OWNER_KINDS: ReadonlySet<string> = new Set<OptimizeBasisOwnerKind>(["ordinary", "candidate"]);

/** Whether a stored value carries the full canonical `OptimizeBasisV2` fields. */
function hasRecordFields(value: unknown): value is OptimizeBasisRecordFields {
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Partial<OptimizeBasisRecordFields>;
  const options = fields.normalizedOptions;
  return (
    fields.schemaVersion === 2 &&
    typeof fields.submissionContractVersion === "string" &&
    typeof fields.workspaceSchemaVersion === "string" &&
    typeof fields.serializerVersion === "string" &&
    typeof fields.anonymizationMode === "string" &&
    typeof fields.inputSha256 === "string" &&
    typeof fields.solverSemanticVersion === "string" &&
    typeof fields.backendCapabilityVersion === "string" &&
    typeof options === "object" &&
    options !== null &&
    typeof options.solver === "string" &&
    typeof options.prettify === "boolean" &&
    typeof options.timeoutSeconds === "number"
  );
}

/**
 * Discriminate a stored row as a genuine V2 record.
 *
 * STRUCTURAL, not just `schemaVersion === 2`: the durable table is the one place
 * a row can arrive from a build this one has never seen, and a row that merely
 * CLAIMS to be V2 while missing `ownerKind` would reintroduce exactly the
 * partition hole this closes. Anything that does not match completely is legacy
 * — the fail-closed direction, because a legacy row is only ever retained and
 * reaped, never trusted.
 */
export function isOptimizeBasisRecordV2(row: StoredOptimizeBasisRow): row is OptimizeBasisRecordV2 {
  const candidate = row as Partial<OptimizeBasisRecordV2>;
  return (
    candidate.schemaVersion === 2 &&
    typeof candidate.basisId === "string" &&
    typeof candidate.scenarioId === "string" &&
    typeof candidate.documentRevision === "number" &&
    typeof candidate.submissionDigest === "string" &&
    typeof candidate.ownerKind === "string" &&
    OWNER_KINDS.has(candidate.ownerKind) &&
    typeof candidate.attemptId === "string" &&
    (candidate.jobId === null || typeof candidate.jobId === "string") &&
    (candidate.parentBasisId === null || typeof candidate.parentBasisId === "string") &&
    (candidate.transformDigest === null || typeof candidate.transformDigest === "string") &&
    (candidate.submittedYaml === null || typeof candidate.submittedYaml === "string") &&
    typeof candidate.createdAt === "string" &&
    (candidate.expiresAt === null || typeof candidate.expiresAt === "string") &&
    hasRecordFields(candidate.basis)
  );
}

/**
 * The raw submitted material a stored row still holds, whichever version it is.
 *
 * Reads defensively rather than through the V2 type: a legacy row has no such
 * field at all, and `row.submittedYaml !== null` would be TRUE for that
 * `undefined` — which would make the reaper plan a payload clear that then wrote
 * a `submittedYaml` field onto a row that never had one.
 */
export function basisRowPayload(row: StoredOptimizeBasisRow): string | null {
  const value = (row as { submittedYaml?: unknown }).submittedYaml;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The same row with its raw material dropped and its compact identity intact. */
export function withClearedBasisPayload(row: StoredOptimizeBasisRow): StoredOptimizeBasisRow {
  return { ...row, submittedYaml: null };
}
