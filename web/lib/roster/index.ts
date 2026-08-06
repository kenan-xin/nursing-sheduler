// Roster document domain (F3) — public surface.
//
// Everything about the roster DOCUMENT lives behind this barrel: its types, the
// derived viewer context, the normalized edits overlay, the solved-baseline
// identity, schema versioning and migrations, the roster-file wire format, and the
// fail-closed validation that gates every write. Durability is F1's
// (`@/lib/store`); capture orchestration is F2's. Neither owns document shape, and
// this module owns nothing else.

export {
  ROSTER_BASELINE_SCHEMA_VERSION,
  ROSTER_DOCUMENT_FIELDS,
  ROSTER_DOCUMENT_SCHEMA_VERSION,
  ROSTER_SUBMISSION_SCHEMA_VERSION,
  type RosterBaselineMinimum,
  type RosterCalendarDay,
  type RosterContext,
  type RosterContextPerson,
  type RosterContextShiftType,
  type RosterCoordinateMap,
  type RosterDayGrid,
  type RosterDayState,
  type RosterDocument,
  type RosterEdit,
  type RosterFileDocument,
  type RosterFileWorkbook,
  type RosterProvenance,
  type RosterSolverStatus,
  type RosterSubmission,
} from "./types";

export {
  dayStateDisplay,
  dayStatesEqual,
  isRosterDayState,
  isTypedId,
  LEAVE_DISPLAY,
  OFF_DISPLAY,
  typedIdKey,
} from "./day-state";

export {
  canonicalBaselineJson,
  computeSolvedBaselineId,
  isSolvedBaselineId,
  type RosterBaselineInput,
} from "./baseline";

export {
  checkNormalizedEdits,
  deriveCurrentDays,
  deriveEditedSinceSolve,
  normalizeRosterEdits,
  withRosterCellEdit,
  type NormalizeResult,
  type OverlayBounds,
  type OverlayCheck,
} from "./overlay";

export {
  checkCoordinateMap,
  checkSolvedDays,
  parseRosterContainer,
  ROSTER_CONTAINER_SCHEMA_VERSION,
  shiftIdKeySet,
  XLSX_MEDIA_TYPE,
  type ParseContainerResult,
  type RosterContainerView,
} from "./container";

export { deriveRosterContext, parseSubmissionDocument, type DeriveContextResult } from "./context";

export {
  assembleRosterDocument,
  type AssembleRosterInput,
  type AssembleRosterResult,
} from "./assemble";

export {
  MAX_FROZEN_XLSX_BYTES,
  validateRosterDocument,
  type RosterValidation,
  type RosterValidationOptions,
} from "./validate";

export {
  freezeContext,
  freezeCoordinateMap,
  freezeDayGrid,
  freezeDayState,
  freezeEdit,
  freezeEdits,
  freezeProvenance,
  freezeRosterDocument,
  freezeSubmission,
} from "./immutable";

export {
  classifyRosterFileVersion,
  CURRENT_ROSTER_FILE_VERSION,
  describeVersionVerdict,
  migrateRosterFileDocument,
  resolveVersionPolicy,
  ROSTER_FILE_MIGRATIONS,
  rosterFileVersionString,
  type MigrateResult,
  type ResolvedRosterVersionPolicy,
  type RosterDocumentSchemaValidator,
  type RosterFileMigration,
  type RosterVersionPolicy,
  type RosterVersionVerdict,
} from "./schema-version";

export {
  checkRosterFileCarrier,
  decodeRosterFile,
  decodeRosterFileBytes,
  encodeRosterFile,
  MAX_ROSTER_FILE_BYTES,
  ROSTER_FILE_EXTENSION,
  ROSTER_FILE_MIME,
  rosterFileName,
  toRosterFileDocument,
  type DecodeRosterFileResult,
  type EncodedRosterFile,
  type EncodeRosterFileResult,
  type RosterFileCarrier,
} from "./file";

export {
  importRosterBytesToWorking,
  importRosterFileToWorking,
  promoteCandidateRosterToWorking,
  promoteRosterDocumentToWorking,
  type ImportRejected,
  type PromotionFence,
  type RosterImportOutcome,
} from "./promote";
