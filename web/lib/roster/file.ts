// The roster-file wire format (F3).
//
// A Dexie `Blob` is not a shareable artifact, so the roster FILE is one
// self-describing JSON document with the frozen workbook base64-embedded:
//
//   MIME       application/x-nurse-roster+json
//   extension  .nurse-roster.json
//
// Import is fail-closed at four layers, in this order, so a hostile or truncated
// file cannot reach the working roster:
//
//   1. carrier guard      — extension, declared type, and byte size BEFORE parsing;
//   2. structural parse   — strict JSON, exact top-level fields;
//   3. version verdict    — exact / migrate-older / reject-newer (`./schema-version`);
//   4. document validation— the whole migrated document (`./validate`), including a
//                           recomputed baseline hash and a re-derived context.
//
// The embedded workbook is guarded on BOTH sides of the decode: the declared
// base64 length bounds the decoded size before any allocation, and the actual
// decoded length is re-checked after.

import {
  classifyRosterFileVersion,
  describeVersionVerdict,
  migrateRosterFileDocument,
  resolveVersionPolicy,
  type RosterVersionPolicy,
} from "./schema-version";
import { XLSX_MEDIA_TYPE } from "./container";
import { MAX_FROZEN_XLSX_BYTES, validateRosterDocument } from "./validate";
import { ROSTER_DOCUMENT_FIELDS, type RosterDocument, type RosterFileDocument } from "./types";

/** The roster file's own media type. */
export const ROSTER_FILE_MIME = "application/x-nurse-roster+json";

/** The roster file's compound extension. */
export const ROSTER_FILE_EXTENSION = ".nurse-roster.json";

/**
 * Frozen cap on the whole encoded file, matching the backend's container cap. It
 * sits above the 32 MiB workbook cap by more than the worst-case base64 expansion,
 * leaving headroom for the structured JSON around it.
 */
export const MAX_ROSTER_FILE_BYTES = 48 * 1024 * 1024;

/**
 * Declared carrier types accepted on import. Browsers do not know the roster media
 * type from a compound extension — a `.json` tail is commonly reported as
 * `application/json` and an unknown compound extension as `""` — so those two are
 * accepted alongside the real type. Anything else positively contradicts the
 * extension and is rejected.
 */
const ACCEPTED_FILE_TYPES: readonly string[] = [ROSTER_FILE_MIME, "application/json", ""];

/**
 * The canonical (non-URL-safe) base64 alphabet, as a FLAT character class.
 *
 * Deliberately not the grouped `(?:[A-Za-z0-9+/]{4})*…` form: that pattern
 * backtracks catastrophically on a multi-megabyte string and overflows the stack
 * before any size guard can fire — which a hostile file would reach for. Padding is
 * validated separately, so a single un-nested class is enough and runs linearly.
 */
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*$/;

// ---------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------

/** Chunked so a multi-megabyte workbook cannot blow the argument limit. */
const BTOA_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BTOA_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BTOA_CHUNK));
  }
  return btoa(binary);
}

/** The `=` run at the end of a base64 string, capped at the legal maximum of two. */
function paddingLength(base64: string): number {
  return base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
}

/** The exact decoded byte length a strict base64 string represents. */
function decodedLength(base64: string): number {
  return (base64.length / 4) * 3 - paddingLength(base64);
}

/**
 * Decode strict base64. The grammar check rejects URL-safe alphabets, whitespace,
 * and wrong padding, and the re-encode comparison rejects a final group whose
 * unused bits are non-zero — which `atob` would otherwise accept and normalize,
 * letting two different strings decode to the same bytes.
 */
function base64ToBytes(
  base64: string,
): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  if (typeof base64 !== "string") return { ok: false, reason: "frozenXlsx.base64 is not a string" };
  if (base64.length === 0) return { ok: false, reason: "frozenXlsx.base64 is empty" };
  if (base64.length % 4 !== 0) {
    return { ok: false, reason: "frozenXlsx.base64 is not strict base64" };
  }

  // The PRE-DECODE size guard runs before the alphabet check and before any
  // allocation: the declared length is arithmetic on the string length, so an
  // oversized payload is refused without the decoder ever touching its contents.
  const declared = decodedLength(base64);
  if (declared <= 0) return { ok: false, reason: "frozenXlsx.base64 decodes to no bytes" };
  if (declared > MAX_FROZEN_XLSX_BYTES) {
    return {
      ok: false,
      reason: `the embedded workbook declares ${declared} bytes, above the ${MAX_FROZEN_XLSX_BYTES}-byte limit`,
    };
  }

  // Padding is stripped first so the alphabet class never has to express it — an
  // `=` anywhere but the final one or two positions leaves a stray `=` in the body
  // and fails here.
  if (!BASE64_ALPHABET.test(base64.slice(0, base64.length - paddingLength(base64)))) {
    return { ok: false, reason: "frozenXlsx.base64 is not strict base64" };
  }

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return { ok: false, reason: "frozenXlsx.base64 is not decodable base64" };
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  if (bytes.length !== declared) {
    return { ok: false, reason: "frozenXlsx.base64 decoded to an unexpected length" };
  }
  if (bytes.length > MAX_FROZEN_XLSX_BYTES) {
    return {
      ok: false,
      reason: `the embedded workbook is ${bytes.length} bytes, above the ${MAX_FROZEN_XLSX_BYTES}-byte limit`,
    };
  }
  if (bytesToBase64(bytes) !== base64) {
    return { ok: false, reason: "frozenXlsx.base64 is not canonically encoded" };
  }
  return { ok: true, bytes };
}

// ---------------------------------------------------------------------------
// Deterministic encoding
// ---------------------------------------------------------------------------

/**
 * Serialize with object keys sorted and no insignificant whitespace, so the same
 * logical document always produces the same bytes (and therefore the same file
 * hash). Array order — the people, date, coordinate, and edits axes — is preserved
 * exactly. Throws on a non-finite number: those have no JSON spelling, and
 * `JSON.stringify` would silently write `null`.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("a roster file cannot carry a non-finite number");
  }
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** A ready-to-download roster file. */
export interface EncodedRosterFile {
  blob: Blob;
  filename: string;
  /** The exact UTF-8 bytes in the blob, for hashing/round-trip assertions. */
  bytes: Uint8Array;
}

/**
 * A stable, human-recognizable filename derived from the document itself — the
 * roster's first date plus a short baseline prefix. Deliberately clock-free so the
 * same document always exports under the same name.
 */
export function rosterFileName(document: RosterDocument): string {
  const firstDate = document.context.calendar[0]?.iso ?? "roster";
  const shortBaseline = document.provenance.solvedBaselineId.slice(0, 8);
  return `roster-${firstDate}-${shortBaseline}${ROSTER_FILE_EXTENSION}`;
}

/** Project an in-memory document to its wire form (workbook → strict base64). */
export async function toRosterFileDocument(document: RosterDocument): Promise<RosterFileDocument> {
  const bytes = new Uint8Array(await document.frozenXlsx.arrayBuffer());
  return {
    schemaVersion: document.schemaVersion,
    provenance: document.provenance,
    submission: document.submission,
    context: document.context,
    solvedDays: document.solvedDays,
    edits: document.edits,
    coordinateMap: document.coordinateMap,
    frozenXlsx: { base64: bytesToBase64(bytes), mime: XLSX_MEDIA_TYPE },
  };
}

export type EncodeRosterFileResult =
  | { ok: true; file: EncodedRosterFile }
  | { ok: false; reason: string };

/**
 * Encode a roster document as a downloadable roster file. The document is
 * VALIDATED first: an invalid working roster must not be exported as if it were a
 * shareable artifact, and the recipient's import would reject it anyway.
 */
export async function encodeRosterFile(document: RosterDocument): Promise<EncodeRosterFileResult> {
  const verdict = await validateRosterDocument(document);
  if (!verdict.ok) return verdict;

  const wire = await toRosterFileDocument(verdict.document);
  let json: string;
  try {
    json = stableJson(wire);
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
  const bytes = new TextEncoder().encode(json);
  if (bytes.length > MAX_ROSTER_FILE_BYTES) {
    return {
      ok: false,
      reason: `the roster file is ${bytes.length} bytes, above the ${MAX_ROSTER_FILE_BYTES}-byte limit`,
    };
  }
  return {
    ok: true,
    file: {
      blob: new Blob([bytes], { type: ROSTER_FILE_MIME }),
      filename: rosterFileName(verdict.document),
      bytes,
    },
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type DecodeRosterFileResult =
  | { ok: true; document: RosterDocument }
  | { ok: false; reason: string };

/** Optional carrier metadata to guard, when the caller has a real `File`. */
export interface RosterFileCarrier {
  filename?: string;
  /** The browser-declared type; `""` when it could not classify the file. */
  type?: string;
}

/** Guard the carrier before a single byte is parsed. */
export function checkRosterFileCarrier(
  carrier: RosterFileCarrier,
  byteLength: number,
): { ok: true } | { ok: false; reason: string } {
  if (carrier.filename !== undefined && !carrier.filename.endsWith(ROSTER_FILE_EXTENSION)) {
    return {
      ok: false,
      reason: `a roster file must be named "*${ROSTER_FILE_EXTENSION}"`,
    };
  }
  if (carrier.type !== undefined && !ACCEPTED_FILE_TYPES.includes(carrier.type)) {
    return { ok: false, reason: `${carrier.type} is not a roster file media type` };
  }
  if (byteLength === 0) return { ok: false, reason: "the roster file is empty" };
  if (byteLength > MAX_ROSTER_FILE_BYTES) {
    return {
      ok: false,
      reason: `the roster file is ${byteLength} bytes, above the ${MAX_ROSTER_FILE_BYTES}-byte limit`,
    };
  }
  return { ok: true };
}

/**
 * Decode roster-file bytes into a validated in-memory document. `policy` injects
 * the version registry/current version FOR TESTS ONLY, so the migrate-older branch
 * is exercised end to end rather than shipping unproven.
 */
export async function decodeRosterFileBytes(
  bytes: Uint8Array,
  policy?: RosterVersionPolicy,
): Promise<DecodeRosterFileResult> {
  const carrier = checkRosterFileCarrier({}, bytes.length);
  if (!carrier.ok) return carrier;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "the roster file is not valid UTF-8" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `the roster file is not valid JSON: ${String(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "the roster file is not a JSON object" };
  }
  const raw = parsed as Record<string, unknown>;

  const { validate } = resolveVersionPolicy(policy);

  // Version FIRST: a newer file must be rejected on its own terms, not by failing
  // this build's field expectations with a misleading message.
  const verdict = classifyRosterFileVersion(raw.schemaVersion, policy);
  if (
    verdict.status === "newer" ||
    verdict.status === "unsupported" ||
    verdict.status === "unrecognized"
  ) {
    return { ok: false, reason: describeVersionVerdict(verdict, policy) };
  }

  const migrated =
    verdict.status === "exact"
      ? { ok: true as const, document: raw }
      : migrateRosterFileDocument(raw, verdict.version, policy);
  if (!migrated.ok) return migrated;
  const document = migrated.document;

  const missing = ROSTER_DOCUMENT_FIELDS.filter((field) => !(field in document));
  if (missing.length > 0) {
    return { ok: false, reason: `the roster file is missing ${missing.join(", ")}` };
  }

  const workbook = document.frozenXlsx;
  if (typeof workbook !== "object" || workbook === null || Array.isArray(workbook)) {
    return { ok: false, reason: "frozenXlsx is not an object" };
  }
  const workbookRecord = workbook as Record<string, unknown>;
  const workbookKeys = Object.keys(workbookRecord).sort();
  if (workbookKeys.length !== 2 || workbookKeys[0] !== "base64" || workbookKeys[1] !== "mime") {
    return { ok: false, reason: "frozenXlsx must carry exactly base64 and mime" };
  }
  if (workbookRecord.mime !== XLSX_MEDIA_TYPE) {
    return { ok: false, reason: "frozenXlsx.mime is not the workbook media type" };
  }
  const decoded = base64ToBytes(workbookRecord.base64 as string);
  if (!decoded.ok) return decoded;

  // Validation runs on the ASSEMBLED in-memory document, through the validator the
  // POLICY names — so a migrated document is judged at the version it was migrated
  // TO, and the imported bytes still pass exactly the gate a captured candidate does.
  return validate({
    ...document,
    frozenXlsx: new Blob([decoded.bytes.buffer as ArrayBuffer], { type: XLSX_MEDIA_TYPE }),
  });
}

/**
 * Import a user-selected roster file: guard its carrier, then decode and validate
 * its bytes. Nothing is written anywhere — promotion to the working roster is a
 * separate, transactional step (`./promote`).
 */
export async function decodeRosterFile(
  file: Blob & { name?: string },
  policy?: RosterVersionPolicy,
): Promise<DecodeRosterFileResult> {
  const carrier = checkRosterFileCarrier({ filename: file.name, type: file.type }, file.size);
  if (!carrier.ok) return carrier;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return decodeRosterFileBytes(bytes, policy);
}
