// Roster-file schema versioning (F3).
//
// Compatibility is decided by the FILE's own `schemaVersion`, never by the app or
// build version (`provenance.appBuild` is provenance only). Three outcomes, and
// nothing in between:
//
//   exact       — the version this build writes; load as-is.
//   migrate     — an older version with a complete migration chain to current.
//   rejected    — a newer version, an older version with no chain, or a string
//                 that is not a roster-file version at all.
//
// A newer file is never "best effort" loaded: it may carry fields this build would
// silently drop, and dropping them would corrupt the recipient's copy of a shared
// roster.

import { ROSTER_DOCUMENT_SCHEMA_VERSION } from "./types";
import { validateRosterDocument, type RosterValidation } from "./validate";

/** `roster-file/<n>` with no leading zeros. */
const VERSION_PATTERN = /^roster-file\/([1-9][0-9]*)$/;

/** The numeric version this build reads and writes. */
export const CURRENT_ROSTER_FILE_VERSION = Number(
  VERSION_PATTERN.exec(ROSTER_DOCUMENT_SCHEMA_VERSION)![1],
);

/** Format a numeric version back to its wire string. */
export function rosterFileVersionString(version: number): string {
  return `roster-file/${version}`;
}

/**
 * One step of the migration chain: read a document at `from`, return it at
 * `from + 1`. Steps are single-version so the chain composes and every step is
 * independently testable; a step may reject a document it cannot faithfully
 * upgrade rather than guessing.
 */
export interface RosterFileMigration {
  from: number;
  migrate(
    document: Record<string, unknown>,
  ): { ok: true; document: Record<string, unknown> } | { ok: false; reason: string };
}

/**
 * The registered migrations. Empty at v1 — there is no older version yet — but the
 * chain machinery is live and tested against an injected registry, so the first
 * real migration only has to add a step, not build the mechanism under pressure.
 */
export const ROSTER_FILE_MIGRATIONS: readonly RosterFileMigration[] = [];

/** Validates a whole document already stamped at the policy's current version. */
export type RosterDocumentSchemaValidator = (value: unknown) => Promise<RosterValidation>;

/**
 * One coherent schema policy: which version is current, how older files reach it,
 * and which validator judges the result. The three travel TOGETHER by construction.
 *
 * That coupling is the point. When `currentVersion` and the validator's expected
 * version could drift apart, migrate-older was dead on arrival: a v1 file would
 * migrate to v2 and then be rejected by a validator still demanding v1. Bumping the
 * schema now means editing one object — add the migration step, raise
 * `currentVersion`, supply the new validator — and a bump that forgets any of the
 * three fails its own tests instead of failing users' files.
 *
 * All three fields are injectable FOR TESTS ONLY, mirroring the backend's injectable
 * size limits: at v1 the migrate-older branch is otherwise unreachable and would
 * ship unexercised. Production passes no policy at all.
 */
export interface RosterVersionPolicy {
  migrations?: readonly RosterFileMigration[];
  currentVersion?: number;
  /**
   * Validator for a document at `currentVersion`. Defaults to this build's
   * whole-document validator, told to require `currentVersion`'s version string —
   * so a policy that only raises the version still validates coherently, and a real
   * future schema supplies its own structural validator here.
   */
  validate?: RosterDocumentSchemaValidator;
}

/** The fully resolved policy: never partially defaulted at a call site. */
export interface ResolvedRosterVersionPolicy {
  migrations: readonly RosterFileMigration[];
  currentVersion: number;
  validate: RosterDocumentSchemaValidator;
}

export function resolveVersionPolicy(
  policy: RosterVersionPolicy = {},
): ResolvedRosterVersionPolicy {
  const currentVersion = policy.currentVersion ?? CURRENT_ROSTER_FILE_VERSION;
  const schemaVersion = rosterFileVersionString(currentVersion);
  return {
    migrations: policy.migrations ?? ROSTER_FILE_MIGRATIONS,
    currentVersion,
    validate: policy.validate ?? ((value) => validateRosterDocument(value, { schemaVersion })),
  };
}

export type RosterVersionVerdict =
  | { status: "exact"; version: number }
  | { status: "migrate"; version: number }
  | { status: "newer"; version: number }
  | { status: "unsupported"; version: number }
  | { status: "unrecognized" };

/** A single-line explanation for a rejected verdict, suitable for the import surface. */
export function describeVersionVerdict(
  verdict: RosterVersionVerdict,
  policy: RosterVersionPolicy = {},
): string {
  const { currentVersion } = resolveVersionPolicy(policy);
  switch (verdict.status) {
    case "exact":
    case "migrate":
      return `roster file version ${verdict.version} is supported`;
    case "newer":
      return (
        `this roster file was written by a newer version of the app ` +
        `(file schema ${rosterFileVersionString(verdict.version)}, this build reads ` +
        `${rosterFileVersionString(currentVersion)}) and cannot be opened`
      );
    case "unsupported":
      return (
        `roster file schema ${rosterFileVersionString(verdict.version)} is too old ` +
        `to be upgraded by this build`
      );
    case "unrecognized":
      return "this file does not carry a roster file schema version";
  }
}

/** Classify a raw `schemaVersion` value against a build's version and migrations. */
export function classifyRosterFileVersion(
  schemaVersion: unknown,
  policy: RosterVersionPolicy = {},
): RosterVersionVerdict {
  const { migrations, currentVersion } = resolveVersionPolicy(policy);
  if (typeof schemaVersion !== "string") return { status: "unrecognized" };
  const match = VERSION_PATTERN.exec(schemaVersion);
  if (!match) return { status: "unrecognized" };
  const version = Number(match[1]);
  if (version === currentVersion) return { status: "exact", version };
  if (version > currentVersion) return { status: "newer", version };
  return hasChain(version, migrations, currentVersion)
    ? { status: "migrate", version }
    : { status: "unsupported", version };
}

/** Whether every single-version step from `version` up to current is registered. */
function hasChain(
  version: number,
  migrations: readonly RosterFileMigration[],
  currentVersion: number,
): boolean {
  for (let step = version; step < currentVersion; step++) {
    if (!migrations.some((migration) => migration.from === step)) return false;
  }
  return true;
}

export type MigrateResult =
  | { ok: true; document: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Run the migration chain from `version` to current. Each step must produce a
 * document stamped at the next version, so a step that forgets to restamp is
 * caught here rather than surfacing as a confusing validation failure later.
 */
export function migrateRosterFileDocument(
  document: Record<string, unknown>,
  version: number,
  policy: RosterVersionPolicy = {},
): MigrateResult {
  const { migrations, currentVersion } = resolveVersionPolicy(policy);
  let current = document;
  for (let step = version; step < currentVersion; step++) {
    const migration = migrations.find((candidate) => candidate.from === step);
    if (!migration) {
      return { ok: false, reason: `no migration from roster file schema version ${step}` };
    }
    const result = migration.migrate(current);
    if (!result.ok) {
      return { ok: false, reason: `migration from version ${step} failed: ${result.reason}` };
    }
    const expected = rosterFileVersionString(step + 1);
    if (result.document.schemaVersion !== expected) {
      return {
        ok: false,
        reason: `migration from version ${step} did not stamp ${expected}`,
      };
    }
    current = result.document;
  }
  return { ok: true, document: current };
}
