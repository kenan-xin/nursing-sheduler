// T08 — canonical `OptimizeBasisV2` encoding and submission identity.
//
// This is the TypeScript half of ONE schema-specific canonical encoder. The
// Python half lives in `core/nurse_scheduling/server/optimize_basis.py`, and both
// are pinned to the shared golden vectors in
// `contracts/optimize-basis-v2.golden.json`.
//
// Deliberately NOT a generic object serializer:
//   • the field order is a fixed literal list, never `Object.keys` iteration;
//   • every value carries an explicit type tag (`s:` / `b:` / `i:` / `z:`), so a
//     string "true" can never encode like the boolean `true` and a string "2"
//     can never encode like the integer `2`;
//   • integers are canonical decimal (no `+`, no leading zero, no float form);
//   • strings escape `\`, LF, CR, and TAB, so no value can inject a field line.
//
// A generic encoder would let an added/renamed/reordered field silently change the
// identity of retained evidence. `@/lib/scenario/hash`'s `canonicalHash` is
// explicitly excluded: it is a non-cryptographic dirty-state fingerprint, not a
// submission identity, and `@/lib/repository/digest` says the same of
// `commandDigest`.

/** Header line of the canonical encoding; bumping it changes every `basisId`. */
export const BASIS_ENCODING_VERSION = "optimize-basis/v2";

/** The only `schemaVersion` this encoder accepts. */
export const BASIS_SCHEMA_VERSION = 2 as const;

/**
 * Submission anonymization policies. Both produce different exact bytes for the
 * same scenario, so the basis binds which transform ran.
 *
 * `people` is T16's fixed people-only transform (people ids rewritten, every
 * free-text `description` stripped); `none` is the plain strict byte path.
 */
export const ANONYMIZATION_MODES = ["none", "people"] as const;
export type AnonymizationMode = (typeof ANONYMIZATION_MODES)[number];

/** The solver options that change scheduling semantics for identical bytes. */
export interface NormalizedOptimizeOptions {
  solver: string;
  /** Resolved preference — never the request's absent/`null` default. */
  prettify: boolean;
  timeoutSeconds: number;
}

/**
 * The immutable identity of one Optimize submission: the exact submitted bytes
 * AND the semantics under which they were solved. Evidence is never compared
 * across a serializer, anonymization, option, solver, or capability change.
 */
export interface OptimizeBasisV2 {
  schemaVersion: typeof BASIS_SCHEMA_VERSION;
  submissionContractVersion: string;
  workspaceSchemaVersion: string;
  serializerVersion: string;
  anonymizationMode: AnonymizationMode;
  /** SHA-256 of the exact submitted UTF-8 YAML bytes, lowercase hex. */
  inputSha256: string;
  normalizedOptions: NormalizedOptimizeOptions;
  solverSemanticVersion: string;
  backendCapabilityVersion: string;
}

/** A basis field is missing, mistyped, or out of domain. */
export class OptimizeBasisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimizeBasisError";
  }
}

/** Lowercase-hex SHA-256; an uppercase or truncated digest is rejected, not normalized. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

function encodeString(field: string, value: unknown): string {
  if (value === null) throw new OptimizeBasisError(`${field} must not be null`);
  if (typeof value !== "string" || value === "") {
    throw new OptimizeBasisError(`${field} must be a non-empty string`);
  }
  // Backslash first, or the escapes introduced below would be re-escaped.
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `s:${escaped}`;
}

function encodeBoolean(field: string, value: unknown): string {
  if (value === null) throw new OptimizeBasisError(`${field} must not be null`);
  if (typeof value !== "boolean") throw new OptimizeBasisError(`${field} must be a boolean`);
  return value ? "b:true" : "b:false";
}

function encodeInteger(field: string, value: unknown): string {
  if (value === null) throw new OptimizeBasisError(`${field} must not be null`);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new OptimizeBasisError(`${field} must be an integer`);
  }
  // `Number.isInteger` already excludes NaN/±Infinity and any fractional value,
  // and `String(int)` is canonical decimal for every safe integer. `-0` is the
  // one exception JS prints as "0" — which is exactly the canonical form.
  return `i:${String(value)}`;
}

/**
 * Return the canonical UTF-8 text of a basis.
 *
 * @throws {OptimizeBasisError} If any field is missing, mistyped, or out of domain.
 */
export function encodeOptimizeBasisV2(basis: OptimizeBasisV2): string {
  if (basis === null || typeof basis !== "object") {
    throw new OptimizeBasisError("basis must be an object");
  }
  if (basis.schemaVersion !== BASIS_SCHEMA_VERSION) {
    throw new OptimizeBasisError(`schemaVersion must be ${BASIS_SCHEMA_VERSION}`);
  }
  if (typeof basis.inputSha256 !== "string" || !SHA256_HEX.test(basis.inputSha256)) {
    throw new OptimizeBasisError("inputSha256 must be 64 lowercase hex characters");
  }
  if (!(ANONYMIZATION_MODES as readonly string[]).includes(basis.anonymizationMode)) {
    throw new OptimizeBasisError(
      `anonymizationMode must be one of ${ANONYMIZATION_MODES.join(", ")}`,
    );
  }
  const options = basis.normalizedOptions;
  if (options === null || typeof options !== "object") {
    throw new OptimizeBasisError("normalizedOptions must be supplied");
  }
  if (typeof options.timeoutSeconds !== "number" || !Number.isInteger(options.timeoutSeconds)) {
    throw new OptimizeBasisError("normalizedOptions.timeoutSeconds must be an integer");
  }
  if (options.timeoutSeconds <= 0) {
    throw new OptimizeBasisError("normalizedOptions.timeoutSeconds must be positive");
  }

  // The field order is this literal list. Never derive it from the object.
  const lines = [
    BASIS_ENCODING_VERSION,
    `schemaVersion=${encodeInteger("schemaVersion", basis.schemaVersion)}`,
    `submissionContractVersion=${encodeString("submissionContractVersion", basis.submissionContractVersion)}`,
    `workspaceSchemaVersion=${encodeString("workspaceSchemaVersion", basis.workspaceSchemaVersion)}`,
    `serializerVersion=${encodeString("serializerVersion", basis.serializerVersion)}`,
    `anonymizationMode=${encodeString("anonymizationMode", basis.anonymizationMode)}`,
    `inputSha256=${encodeString("inputSha256", basis.inputSha256)}`,
    `normalizedOptions.solver=${encodeString("normalizedOptions.solver", options.solver)}`,
    `normalizedOptions.prettify=${encodeBoolean("normalizedOptions.prettify", options.prettify)}`,
    `normalizedOptions.timeoutSeconds=${encodeInteger("normalizedOptions.timeoutSeconds", options.timeoutSeconds)}`,
    `solverSemanticVersion=${encodeString("solverSemanticVersion", basis.solverSemanticVersion)}`,
    `backendCapabilityVersion=${encodeString("backendCapabilityVersion", basis.backendCapabilityVersion)}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Return the canonical UTF-8 BYTES of a basis (what is actually digested). */
export function encodeOptimizeBasisV2Bytes(basis: OptimizeBasisV2): Uint8Array {
  return new TextEncoder().encode(encodeOptimizeBasisV2(basis));
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * SHA-256 of exact bytes, as lowercase hex, via Web Crypto.
 *
 * `crypto.subtle` requires a secure context (HTTPS or localhost). It is absent in
 * an insecure deployment, and the caller must treat that as "no basis available"
 * rather than substituting a weaker digest.
 *
 * @throws {OptimizeBasisError} If Web Crypto's SubtleCrypto is unavailable.
 */
export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new OptimizeBasisError(
      "Web Crypto SubtleCrypto is unavailable, so an Optimize submission identity cannot be computed.",
    );
  }
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Copy into a plain ArrayBuffer: a Uint8Array over a larger/SharedArrayBuffer
  // pool would otherwise digest bytes outside the intended view.
  const exact = new Uint8Array(view.byteLength);
  exact.set(view);
  return toHex(await subtle.digest("SHA-256", exact.buffer));
}

/** SHA-256 of the exact submitted UTF-8 YAML text. */
export function sha256HexOfUtf8(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

/**
 * The `basisId`: SHA-256 of the canonical encoding of a basis.
 *
 * @throws {OptimizeBasisError} If any field is invalid or Web Crypto is unavailable.
 */
export function computeBasisId(basis: OptimizeBasisV2): Promise<string> {
  return sha256Hex(encodeOptimizeBasisV2Bytes(basis));
}
