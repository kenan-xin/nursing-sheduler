// LEGACY persisted-record decoding (was T04's live persistence plumbing).
//
// T03 retired Zustand `persist` write-behind: the transactional repository is now
// the only durable scenario writer, so the storage seam, its serialized write
// queue, its in-memory double, and the Dexie key/value adapter are all gone.
//
// What survives is exactly what is still needed to READ the one legacy record a
// pre-T03 build left behind: its key, its payload version, the forward migration,
// the sanitizer, and the non-finite-number codec. The repository's one-time
// migration (`lib/repository/migration.ts`) is now the only caller — it decodes
// through this exact chain rather than a re-implementation, which is what makes a
// migrated envelope produce a byte-identical Workspace document and an identical
// backup fingerprint.

import type { ScenarioUiState } from "@/lib/scenario";
import { SCENARIO_KEYS } from "./fingerprint";

/** The single IndexedDB key the durable scenario store persists under. */
export const SCENARIO_PERSIST_KEY = "nurse-scheduler/scenario";

/** Current persistence payload version; a bump triggers `migrateScenarioState`. */
export const SCENARIO_PERSIST_VERSION = 6;

/**
 * The persisted `state` payload at the current version: the durable scenario
 * slice plus the Workspace-backup fingerprint (persisted alongside so a reload can
 * tell whether the restored work still matches its last downloaded backup).
 */
export type PersistedScenarioState = ScenarioUiState & {
  backupFingerprint: string | null;
};

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Forward-migrate a persisted `state` payload to the current version. Zustand
 * passes the raw persisted `state` and its stored `version` (only when it differs
 * from the current version). A payload from a FUTURE version is refused (throwing
 * routes hydration to `recoverable-error` and, crucially, leaves the stored record
 * intact — persist does not rewrite on a hydration error) so we never silently
 * downgrade newer data. Structural validation of the payload happens in the
 * sanitizer at merge time; this function only shapes known-version upgrades.
 *
 * v0 → v1: the person×date matrix was stored under `requests`; the export layout
 * and baseline fingerprint could be absent.
 * v1 → v2 and v2 → v3 shaped the durable `guidedRulePins` field, which no longer
 * exists (RP-2). No migration is needed to drop it: the key is not in
 * `SCENARIO_KEYS`, so the sanitizer never reads it and it is silently discarded.
 * v3 → v4: the backup-freshness baseline was redefined (T17r review P0) to mean
 * "the state at the last successful plain Download". Older records stored a
 * baseline computed under the previous strict-projection scheme and set on
 * hydration/New/Load, which no longer marks a genuine backup — clear it to `null`
 * (unknown) so no stale backup is falsely claimed fresh.
 * v4 → v5: the persisted key `baselineFingerprint` was renamed to
 * `backupFingerprint` (T08e) to name the download-backup contract explicitly. A v4
 * record already stored its value under the download-baseline semantics (set only
 * by a real plain Download), so carry it across verbatim under the new key.
 * v5 → v6: `guidedRules` left the Workspace V1 document (RP-3), and the backup
 * fingerprint hashes that document — so every pre-v6 fingerprint, including one
 * taken from a scenario whose `guidedRules` was the empty list, names bytes this
 * build can no longer reproduce. Clear it to `null` (unknown), following the v3 → v4
 * precedent, so no stale backup is falsely reported current.
 */
export function migrateScenarioState(persisted: unknown, fromVersion: number): unknown {
  if (fromVersion > SCENARIO_PERSIST_VERSION) {
    throw new Error(
      `Persisted scenario version ${fromVersion} is newer than the supported version ${SCENARIO_PERSIST_VERSION}; refusing to downgrade.`,
    );
  }

  // An explicitly null persisted payload is corrupt at any version — preserve
  // that signal rather than coercing it to `{}`, so the sanitizer's null check
  // (not a version mismatch) is what reports the corruption.
  if (persisted === null) return null;

  const source = (persisted ?? {}) as Record<string, unknown>;
  const migrated: Record<string, unknown> = { ...source };

  if (fromVersion < 1) {
    if (migrated.reqData === undefined && migrated.requests !== undefined) {
      migrated.reqData = migrated.requests;
    }
    delete migrated.requests;
    if (migrated.exportLayout === undefined) {
      migrated.exportLayout = { formatting: [], extraColumns: [], extraRows: [] };
    }
  }

  if (fromVersion < 4) {
    // A pre-v4 baseline was set under the old strict-projection/download-baseline
    // semantics; it no longer denotes a real backup. Reset to unknown (`null`).
    migrated.baselineFingerprint = null;
  }

  if (fromVersion < 5) {
    // Rename the persisted key to the explicit backup-contract name. A v4 record's
    // value already means "the last plain Download", so carry it across verbatim;
    // a pre-v4 record was just cleared to `null` above and is renamed the same way.
    if ("baselineFingerprint" in migrated) {
      migrated.backupFingerprint = migrated.baselineFingerprint;
      delete migrated.baselineFingerprint;
    }
  }

  if (fromVersion < 6) {
    // The Workspace document the fingerprint hashes lost its `guidedRules` key, so
    // a pre-v6 backup can no longer be reproduced byte-for-byte. Reset to unknown.
    migrated.backupFingerprint = null;
  }

  return migrated;
}

// ---------------------------------------------------------------------------
// Payload sanitizer
// ---------------------------------------------------------------------------

const CARD_KIND_KEYS = [
  "requirements",
  "successions",
  "counts",
  "affinities",
  "coverings",
] as const;

const EXPORT_LAYOUT_KEYS = ["formatting", "extraColumns", "extraRows"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- Primitive assertions (throw with a descriptive label on failure) ---------

function requireString(value: unknown, label: string): void {
  if (typeof value !== "string") throw new Error(`Persisted ${label} must be a string.`);
}

function requireNumber(value: unknown, label: string): void {
  if (typeof value !== "number") throw new Error(`Persisted ${label} must be a number.`);
}

function requireStringOrNumber(value: unknown, label: string): void {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Persisted ${label} must be a string or number.`);
  }
}

function requireOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`Persisted ${label} must be a string or absent.`);
  }
}

function requireOptionalNumber(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "number") {
    throw new Error(`Persisted ${label} must be a number or absent.`);
  }
}

function requireObjectArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`Persisted ${label} must be an array.`);
  return (value as unknown[]).map((el, i) => {
    if (!isPlainObject(el)) throw new Error(`Persisted ${label}[${i}] must be an object.`);
    return el;
  });
}

// --- Domain union validators (structural — not zod refinements) ---------------

function isStringOrNumber(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number";
}

/** PersonRef | PersonRef[]  or  DateRef | DateRef[] */
function validateRefOrArray(value: unknown, label: string): void {
  if (isStringOrNumber(value)) return;
  if (Array.isArray(value)) {
    for (const el of value) {
      if (!isStringOrNumber(el)) {
        throw new Error(`Persisted ${label} array element must be a string or number.`);
      }
    }
    return;
  }
  throw new Error(`Persisted ${label} must be a string, number, or array thereof.`);
}

/** Flat array of string-or-number elements (PersonRef[] / DateRef[] / ExportShiftTypeRef[]). */
function validateRefArrayElements(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`Persisted ${label} must be an array.`);
  for (const el of value) {
    if (!isStringOrNumber(el)) {
      throw new Error(`Persisted ${label} element must be a string or number.`);
    }
  }
}

/** NestedPersonRefList — Array<PersonRef | PersonRef[]> (number|string elements). */
function validateNestedPersonList(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`Persisted ${label} must be an array.`);
  for (const el of value) {
    if (Array.isArray(el)) {
      for (const sub of el) {
        if (!isStringOrNumber(sub)) {
          throw new Error(`Persisted ${label} nested element must be a string or number.`);
        }
      }
    } else if (!isStringOrNumber(el)) {
      throw new Error(`Persisted ${label} element must be a string, number, or array.`);
    }
  }
}

/** NestedShiftTypeRefList — Array<ShiftTypeRef | ShiftTypeRef[]> (string-only elements). */
function validateNestedShiftTypeList(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`Persisted ${label} must be an array.`);
  for (const el of value) {
    if (Array.isArray(el)) {
      for (const sub of el) {
        if (typeof sub !== "string") {
          throw new Error(`Persisted ${label} nested element must be a string.`);
        }
      }
    } else if (typeof el !== "string") {
      throw new Error(`Persisted ${label} element must be a string or string array.`);
    }
  }
}

/** ShiftTypeRef | NestedShiftTypeRefList — string or nested string-only list */
function validateShiftTypeRefOrList(value: unknown, label: string): void {
  if (typeof value === "string") return;
  validateNestedShiftTypeList(value, label);
}

/** CoefficientEntry[] — each element is a [string, number] 2-tuple */
function validateOptionalCoefficients(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`Persisted ${label} must be an array.`);
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "number"
    ) {
      throw new Error(`Persisted ${label} element must be a [string, number] tuple.`);
    }
  }
}

// --- Field-level validators ---------------------------------------------------

function validateMeta(value: unknown): void {
  if (!isPlainObject(value)) throw new Error(`Persisted "meta" must be an object.`);
  requireString(value.apiVersion, "meta.apiVersion");
  requireOptionalString(value.appVersion, "meta.appVersion");
  requireOptionalString(value.description, "meta.description");
  requireOptionalString(value.country, "meta.country");
}

function validatePerson(el: Record<string, unknown>): void {
  requireOptionalString(el._k, "staff element _k");
  requireStringOrNumber(el.id, "staff element id");
  requireOptionalString(el.description, "staff element description");
  if (el.history !== undefined) {
    if (!Array.isArray(el.history)) {
      throw new Error("Persisted staff element history must be an array.");
    }
    for (const h of el.history) {
      if (typeof h !== "string") {
        throw new Error("Persisted staff element history entry must be a string.");
      }
    }
  }
  if (el.temporary !== undefined && typeof el.temporary !== "boolean") {
    throw new Error("Persisted staff element temporary must be a boolean or absent.");
  }
}

function validateShiftType(el: Record<string, unknown>): void {
  requireOptionalString(el._k, "shifts element _k");
  requireStringOrNumber(el.id, "shifts element id");
  requireOptionalString(el.description, "shifts element description");
  requireOptionalNumber(el.durationMinutes, "shifts element durationMinutes");
  requireOptionalString(el.startTime, "shifts element startTime");
  requireOptionalString(el.endTime, "shifts element endTime");
  requireOptionalNumber(el.restMinutes, "shifts element restMinutes");
}

function validateGroupCollection(value: unknown, field: string): void {
  for (const el of requireObjectArray(value, field)) {
    requireOptionalString(el._k, `${field} element _k`);
    requireString(el.id, `${field} element id`);
    requireOptionalString(el.description, `${field} element description`);
    if (!Array.isArray(el.members)) {
      throw new Error(`Persisted ${field} element members must be an array.`);
    }
    for (const m of el.members) {
      if (!isStringOrNumber(m)) {
        throw new Error(`Persisted ${field} element members entry must be a string or number.`);
      }
    }
  }
}

function validateReqData(value: unknown): void {
  requireObjectArray(value, "reqData").forEach((el, i) => {
    const label = `reqData[${i}]`;
    requireOptionalString(el.uid, `${label}.uid`);
    requireStringOrNumber(el.person, `${label}.person`);
    requireStringOrNumber(el.date, `${label}.date`);
    requireOptionalString(el.description, `${label}.description`);
    const kind = el.kind;
    if (kind !== "request" && kind !== "leave" && kind !== "off") {
      throw new Error(`Persisted ${label}.kind must be "request", "leave", or "off".`);
    }
    if ((kind === "off" || kind === "request") && typeof el.weight !== "number") {
      throw new Error(`Persisted ${label}.weight must be a number.`);
    }
    if (kind === "request" && typeof el.shiftType !== "string") {
      throw new Error(`Persisted ${label}.shiftType must be a string.`);
    }
  });
}

// --- Export-layout rule validators (keyed by discriminant `type`) -------------

const PERSON_FORMATTING_TYPES = new Set(["row", "people header", "history"]);
const DATE_FORMATTING_TYPES = new Set(["column", "date header"]);

function validateOptionalNote(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value) || typeof value.text !== "string") {
    throw new Error(`Persisted ${label} must be an object with a string "text".`);
  }
}

/** Allowed `when.preference.requestShape` literals (CanonicalExportPreferenceCondition). */
const REQUEST_SHAPE_LITERALS = new Set([
  "person-item-to-date-item",
  "people-group-to-date-item",
  "person-item-to-date-group",
  "people-group-to-date-group",
  "ALL",
]);

function validateOptionalWhen(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value) || !isPlainObject(value.preference)) {
    throw new Error(`Persisted ${label} must be an object with a "preference" object.`);
  }
  const pref = value.preference as Record<string, unknown>;
  if (!Array.isArray(pref.types)) {
    throw new Error(`Persisted ${label}.preference.types must be an array.`);
  }
  for (const t of pref.types) {
    if (t !== "shift request") {
      throw new Error(`Persisted ${label}.preference.types entry must be "shift request".`);
    }
  }
  if (pref.requestShape !== undefined) {
    if (!Array.isArray(pref.requestShape)) {
      throw new Error(`Persisted ${label}.preference.requestShape must be an array.`);
    }
    for (const s of pref.requestShape) {
      if (typeof s !== "string" || !REQUEST_SHAPE_LITERALS.has(s)) {
        throw new Error(
          `Persisted ${label}.preference.requestShape entry must be one of the committed request-shape literals.`,
        );
      }
    }
  }
  if (pref.satisfied !== undefined && typeof pref.satisfied !== "boolean") {
    throw new Error(`Persisted ${label}.preference.satisfied must be a boolean.`);
  }
  if (pref.weightRange !== undefined) {
    if (!Array.isArray(pref.weightRange)) {
      throw new Error(`Persisted ${label}.preference.weightRange must be an array.`);
    }
    for (const w of pref.weightRange) {
      if (typeof w !== "number") {
        throw new Error(`Persisted ${label}.preference.weightRange entry must be a number.`);
      }
    }
  }
}

function validateFormattingRule(el: Record<string, unknown>, i: number): void {
  const label = `exportLayout.formatting[${i}]`;
  requireString(el.type, `${label}.type`);
  // Base optional fields apply to every formatting rule (CanonicalBaseFormattingRule + UI uid).
  requireOptionalString(el.uid, `${label}.uid`);
  requireOptionalString(el.description, `${label}.description`);
  requireOptionalString(el.backgroundColor, `${label}.backgroundColor`);
  requireOptionalString(el.bottomBorderColor, `${label}.bottomBorderColor`);
  requireOptionalString(el.rightBorderColor, `${label}.rightBorderColor`);
  requireOptionalString(el.fontColor, `${label}.fontColor`);
  const type = el.type as string;
  if (type === "cell") {
    requireOptionalString(el.appendText, `${label}.appendText`);
    validateRefArrayElements(el.people, `${label}.people`);
    validateRefArrayElements(el.dates, `${label}.dates`);
    validateRefArrayElements(el.shiftTypes, `${label}.shiftTypes`);
    validateOptionalNote(el.note, `${label}.note`);
    validateOptionalWhen(el.when, `${label}.when`);
  } else if (PERSON_FORMATTING_TYPES.has(type)) {
    validateRefArrayElements(el.people, `${label}.people`);
  } else if (DATE_FORMATTING_TYPES.has(type)) {
    validateRefArrayElements(el.dates, `${label}.dates`);
  } else if (type === "history header") {
    // no extra required fields
  } else {
    throw new Error(`Persisted ${label}.type "${type}" is not a recognized formatting rule type.`);
  }
}

function validateExtraColumn(el: Record<string, unknown>, i: number): void {
  const label = `exportLayout.extraColumns[${i}]`;
  requireString(el.type, `${label}.type`);
  if (el.type !== "count") {
    throw new Error(`Persisted ${label}.type must be "count".`);
  }
  requireOptionalString(el.uid, `${label}.uid`);
  requireOptionalString(el.description, `${label}.description`);
  requireOptionalString(el.rightBorderColor, `${label}.rightBorderColor`);
  requireString(el.header, `${label}.header`);
  validateRefArrayElements(el.countShiftTypes, `${label}.countShiftTypes`);
  validateRefArrayElements(el.countDates, `${label}.countDates`);
  validateOptionalCoefficients(
    el.countShiftTypeCoefficients,
    `${label}.countShiftTypeCoefficients`,
  );
}

function validateExtraRow(el: Record<string, unknown>, i: number): void {
  const label = `exportLayout.extraRows[${i}]`;
  requireString(el.type, `${label}.type`);
  if (el.type !== "count") {
    throw new Error(`Persisted ${label}.type must be "count".`);
  }
  requireOptionalString(el.uid, `${label}.uid`);
  requireOptionalString(el.description, `${label}.description`);
  requireOptionalString(el.bottomBorderColor, `${label}.bottomBorderColor`);
  requireString(el.header, `${label}.header`);
  validateRefArrayElements(el.countShiftTypes, `${label}.countShiftTypes`);
  validateRefArrayElements(el.countPeople, `${label}.countPeople`);
}

function validateExportLayout(value: unknown): void {
  if (!isPlainObject(value)) throw new Error(`Persisted "exportLayout" must be an object.`);
  for (const key of EXPORT_LAYOUT_KEYS) {
    if (!(key in value)) {
      throw new Error(`Persisted "exportLayout.${key}" is required.`);
    }
  }
  requireObjectArray(value.formatting, "exportLayout.formatting").forEach(validateFormattingRule);
  requireObjectArray(value.extraColumns, "exportLayout.extraColumns").forEach(validateExtraColumn);
  requireObjectArray(value.extraRows, "exportLayout.extraRows").forEach(validateExtraRow);
}

// --- Card body validators (keyed by card kind) --------------------------------

function validateRequirementCard(el: Record<string, unknown>): void {
  validateShiftTypeRefOrList(el.shiftType, "cardsByKind.requirements element shiftType");
  requireNumber(el.requiredNumPeople, "cardsByKind.requirements element requiredNumPeople");
  requireNumber(el.weight, "cardsByKind.requirements element weight");
  if (el.qualifiedPeople !== undefined) {
    validateRefOrArray(el.qualifiedPeople, "cardsByKind.requirements element qualifiedPeople");
  }
  requireOptionalNumber(
    el.preferredNumPeople,
    "cardsByKind.requirements element preferredNumPeople",
  );
  if (el.skillMix !== undefined) {
    if (!Array.isArray(el.skillMix)) {
      throw new Error("Persisted cardsByKind.requirements element skillMix must be an array.");
    }
    for (const entry of el.skillMix) {
      if (!isPlainObject(entry)) {
        throw new Error(
          "Persisted cardsByKind.requirements element skillMix entry must be an object.",
        );
      }
      requireStringOrNumber(entry.people, "cardsByKind.requirements element skillMix people");
      requireNumber(entry.minNumPeople, "cardsByKind.requirements element skillMix minNumPeople");
    }
  }
  if (el.date !== undefined) {
    validateRefOrArray(el.date, "cardsByKind.requirements element date");
  }
  validateOptionalCoefficients(
    el.shiftTypeCoefficients,
    "cardsByKind.requirements element shiftTypeCoefficients",
  );
}

function validateSuccessionCard(el: Record<string, unknown>): void {
  validateRefOrArray(el.person, "cardsByKind.successions element person");
  validateNestedShiftTypeList(el.pattern, "cardsByKind.successions element pattern");
  requireNumber(el.weight, "cardsByKind.successions element weight");
  if (el.date !== undefined) {
    validateRefOrArray(el.date, "cardsByKind.successions element date");
  }
}

function validateCountCard(el: Record<string, unknown>): void {
  validateRefOrArray(el.person, "cardsByKind.counts element person");
  validateRefOrArray(el.countDates, "cardsByKind.counts element countDates");
  // countShiftTypes: ShiftTypeRef | ShiftTypeRef[] — flat, string-only
  if (typeof el.countShiftTypes === "string") {
    // single ShiftTypeRef — valid
  } else if (Array.isArray(el.countShiftTypes)) {
    for (const st of el.countShiftTypes) {
      if (typeof st !== "string") {
        throw new Error(
          "Persisted cardsByKind.counts element countShiftTypes entry must be a string.",
        );
      }
    }
  } else {
    throw new Error(
      "Persisted cardsByKind.counts element countShiftTypes must be a string or array.",
    );
  }
  // expression: string | string[]
  if (typeof el.expression !== "string" && !Array.isArray(el.expression)) {
    throw new Error("Persisted cardsByKind.counts element expression must be a string or array.");
  }
  if (Array.isArray(el.expression)) {
    for (const e of el.expression) {
      if (typeof e !== "string") {
        throw new Error("Persisted cardsByKind.counts element expression entry must be a string.");
      }
    }
  }
  // target: number | number[]
  if (typeof el.target !== "number" && !Array.isArray(el.target)) {
    throw new Error("Persisted cardsByKind.counts element target must be a number or array.");
  }
  if (Array.isArray(el.target)) {
    for (const t of el.target) {
      if (typeof t !== "number") {
        throw new Error("Persisted cardsByKind.counts element target entry must be a number.");
      }
    }
  }
  requireNumber(el.weight, "cardsByKind.counts element weight");
  // Count marker union: contracted_hours or ordinary (policy/unit forbidden without tag)
  if (el.tag === "contracted_hours") {
    if (el.policy !== "exact" && el.policy !== "range") {
      throw new Error('Persisted cardsByKind.counts element policy must be "exact" or "range".');
    }
    requireOptionalString(el.unit, "cardsByKind.counts element unit");
  } else if (el.tag === undefined) {
    if (el.policy !== undefined || el.unit !== undefined) {
      throw new Error(
        "Persisted cardsByKind.counts element: policy/unit are only valid on a contracted_hours count.",
      );
    }
  } else {
    throw new Error(
      `Persisted cardsByKind.counts element tag must be "contracted_hours" or absent.`,
    );
  }
  validateOptionalCoefficients(
    el.countShiftTypeCoefficients,
    "cardsByKind.counts element countShiftTypeCoefficients",
  );
}

function validateAffinityCard(el: Record<string, unknown>): void {
  validateRefOrArray(el.date, "cardsByKind.affinities element date");
  validateNestedPersonList(el.people1, "cardsByKind.affinities element people1");
  validateNestedPersonList(el.people2, "cardsByKind.affinities element people2");
  validateNestedShiftTypeList(el.shiftTypes, "cardsByKind.affinities element shiftTypes");
  requireNumber(el.weight, "cardsByKind.affinities element weight");
}

function validateCoveringCard(el: Record<string, unknown>): void {
  validateNestedPersonList(el.preceptors, "cardsByKind.coverings element preceptors");
  validateNestedPersonList(el.preceptees, "cardsByKind.coverings element preceptees");
  validateNestedShiftTypeList(el.shiftTypes, "cardsByKind.coverings element shiftTypes");
  requireNumber(el.weight, "cardsByKind.coverings element weight");
  if (el.date !== undefined) {
    validateRefOrArray(el.date, "cardsByKind.coverings element date");
  }
}

const CARD_BODY_VALIDATORS: Record<
  (typeof CARD_KIND_KEYS)[number],
  (el: Record<string, unknown>) => void
> = {
  requirements: validateRequirementCard,
  successions: validateSuccessionCard,
  counts: validateCountCard,
  affinities: validateAffinityCard,
  coverings: validateCoveringCard,
};

function validateCardsByKind(value: unknown): void {
  if (!isPlainObject(value)) throw new Error(`Persisted "cardsByKind" must be an object.`);
  for (const kind of CARD_KIND_KEYS) {
    if (!(kind in value)) {
      throw new Error(`Persisted "cardsByKind.${kind}" is required.`);
    }
    const elements = requireObjectArray(value[kind], `cardsByKind.${kind}`);
    const validateBody = CARD_BODY_VALIDATORS[kind];
    for (const el of elements) {
      requireString(el.uid, `cardsByKind.${kind} element uid`);
      requireOptionalString(el.description, `cardsByKind.${kind} element description`);
      if (el.disabled !== undefined && typeof el.disabled !== "boolean") {
        throw new Error(`Persisted cardsByKind.${kind} element disabled must be a boolean.`);
      }
      if (el.applied !== undefined && typeof el.applied !== "boolean") {
        throw new Error(`Persisted cardsByKind.${kind} element applied must be a boolean.`);
      }
      validateBody(el);
    }
  }
}

/**
 * Recursively validate a present scenario field's COMPLETE structure. Throws on
 * any nested malformation (e.g. `{ meta: {} }`, `{ cardsByKind: {} }`,
 * `{ staff: [null] }`, a uid-only card body, an empty export rule) so hydration
 * routes to `recoverable-error` BEFORE the malformed state is applied to the
 * live store by Zustand's `set(state, true)`.
 */
function validateScenarioField(key: string, value: unknown): void {
  switch (key) {
    case "meta":
      validateMeta(value);
      break;
    case "staff":
      for (const el of requireObjectArray(value, "staff")) validatePerson(el);
      break;
    case "shifts":
      for (const el of requireObjectArray(value, "shifts")) validateShiftType(el);
      break;
    case "staffGroups":
    case "shiftGroups":
    case "dateGroups":
      validateGroupCollection(value, key);
      break;
    case "reqData":
      validateReqData(value);
      break;
    case "rangeStart":
    case "rangeEnd":
      requireString(value, key);
      break;
    case "exportLayout":
      validateExportLayout(value);
      break;
    case "cardsByKind":
      validateCardsByKind(value);
      break;
    case "maxOneShiftPerDay":
      if (value === undefined) break;
      if (!isPlainObject(value)) {
        throw new Error(`Persisted "maxOneShiftPerDay" must be an object.`);
      }
      requireOptionalString(value.description, "maxOneShiftPerDay.description");
      break;
    default:
      break;
  }
}

/**
 * Allowlist a parseable persisted payload down to the known scenario-slice keys
 * (plus `backupFingerprint`), recursively validating each present field's
 * complete structure. Unknown keys are dropped — so a well-formed-but-wrong
 * payload can never overwrite store actions or inject foreign state.
 *
 * `undefined` (no stored record) yields an empty overlay. An explicit `null`
 * payload is treated as a corrupt record and THROWS (only `undefined` means "no
 * record"). A present-but-malformed field — including nested malformation such as
 * `{ meta: {} }`, `{ cardsByKind: {} }`, `{ exportLayout: {} }`, or
 * `{ staff: [null] }` — also THROWS so hydration can recover to
 * `recoverable-error` without applying any malformed state to the live store.
 */
export function sanitizePersistedScenario(persisted: unknown): Partial<PersistedScenarioState> {
  if (persisted === undefined) return {};
  if (persisted === null) {
    throw new Error("Persisted scenario payload is explicitly null (corrupt record).");
  }
  if (!isPlainObject(persisted)) {
    throw new Error("Persisted scenario payload is not an object.");
  }

  const out: Record<string, unknown> = {};
  for (const key of SCENARIO_KEYS) {
    if (!(key in persisted)) continue;
    const value = persisted[key];
    validateScenarioField(key, value);
    out[key] = value;
  }

  if ("backupFingerprint" in persisted) {
    const fingerprint = persisted.backupFingerprint;
    if (fingerprint !== null && typeof fingerprint !== "string") {
      throw new Error("Persisted backupFingerprint is invalid.");
    }
    out.backupFingerprint = fingerprint;
  }

  return out as Partial<PersistedScenarioState>;
}

// ---------------------------------------------------------------------------
// Non-finite weight codec — the legacy JSON boundary
// ---------------------------------------------------------------------------
//
// `Weight` is "an integer, or ±Infinity for a hard constraint" (lib/scenario/types.ts),
// and the product exposes both signs as real actions — the Guided Rules ±∞
// controls, and `LEAVE_PIN_WEIGHT`. Native `JSON.stringify` has no representation
// for a non-finite number and silently emits `null`, so every hard weight written
// to IndexedDB came back as `null` and the sanitizer rejected the whole record.
//
// The codec now has ONE caller: decoding the legacy record during the repository
// migration. The repository stores structured values through IndexedDB's
// structured clone, which represents ±Infinity natively — so nothing written
// after T03 is ever encoded. The ENCODER is retained because the decoder's
// contract is only meaningful against it, and tests pin the round trip.
//
// The representation is a single-key tagged OBJECT rather than a sentinel string,
// which is what makes it unambiguous in both directions:
//   • encoding only ever wraps a number, so an authored string that happens to
//     read `"Infinity"` — or even the envelope's own JSON text — round-trips as
//     exactly that string;
//   • decoding only ever unwraps an object carrying the reserved key, and the
//     durable scenario shape has no free-form record that could produce one.
//
// The codec is also SCOPED BY FIELD, because "a non-finite number" is not a
// property of the payload — it is a property of the DOMAIN a value sits in. A
// global codec revived a forged tag under `requiredNumPeople` into numeric
// `Infinity`, and the sanitizer's generic `typeof value === "number"` check
// happily accepted it, so a foreign record could hydrate in a state the producer
// schema forbids. The approved positions below were derived by auditing the
// persisted slice (`SCENARIO_KEYS`) against the producer/import schemas:
//
//   • `weight` — every `Weight`-typed field in the durable slice is spelled
//     exactly this: the five card kinds and the `off`/`request` matrix cells.
//   • `weightRange` — `exportLayout.formatting[].when.preference.weightRange` is
//     an ARRAY of `zLooseNumber`, documented as "unlike a preference weight —
//     unrestricted", and reachable today through a Workspace Load.
//
// Every other numeric field — `requiredNumPeople`, `preferredNumPeople`, `target`,
// `durationMinutes`, `restMinutes`, ids, coefficients — is finite-only, and a tag
// there is refused rather than decoded.
//
// Three deliberate non-goals: `NaN` is NOT encoded (it is not a representable
// `Weight`, so it keeps failing closed at the sanitizer); an already-corrupted
// `null` is left alone (its sign is unrecoverable, and guessing one would silently
// invent a hard constraint in a ward's roster); and nothing here tries to
// out-validate the sanitizer on FOREIGN keys.

/** The reserved key tagging a non-finite number in the legacy JSON payload. */
export const NON_FINITE_PERSIST_TAG = "$nsNonFinite";

const POSITIVE_INFINITY_TAG = "Infinity";
const NEGATIVE_INFINITY_TAG = "-Infinity";

/** Scalar properties whose domain admits a signed infinity (see the audit above). */
const SIGNED_INFINITY_SCALAR_KEYS: ReadonlySet<string> = new Set(["weight"]);

/** Properties holding an ARRAY of numbers whose domain admits signed infinities. */
const SIGNED_INFINITY_LIST_KEYS: ReadonlySet<string> = new Set(["weightRange"]);

/** Whether `value` is an object carrying the reserved tag — well-formed or not. */
function isTagged(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, NON_FINITE_PERSIST_TAG)
  );
}

/** Wrap `±Infinity`; leave everything else (including `NaN`) exactly as it is. */
function encodeIfInfinite(value: unknown): unknown {
  // Only a number can be equal to an infinity, so no `typeof` guard is needed.
  if (value === Number.POSITIVE_INFINITY) {
    return { [NON_FINITE_PERSIST_TAG]: POSITIVE_INFINITY_TAG };
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return { [NON_FINITE_PERSIST_TAG]: NEGATIVE_INFINITY_TAG };
  }
  return value;
}

/** Unwrap a well-formed envelope; THROW on a tagged-but-malformed one. */
function decodeEnvelope(value: unknown): unknown {
  if (!isTagged(value)) return value;
  const tag = value[NON_FINITE_PERSIST_TAG];
  // Exactly one key: a tag carrying passengers is malformed, not a hard weight.
  if (Object.keys(value).length === 1) {
    if (tag === POSITIVE_INFINITY_TAG) return Number.POSITIVE_INFINITY;
    if (tag === NEGATIVE_INFINITY_TAG) return Number.NEGATIVE_INFINITY;
  }
  throw new Error(
    `Persisted scenario carries a malformed ${NON_FINITE_PERSIST_TAG} envelope ` +
      `(${JSON.stringify(value).slice(0, 120)}); refusing to guess a value.`,
  );
}

/**
 * `JSON.stringify` replacer for the legacy payload. `stringify` applies the
 * replacer BEFORE it would coerce a non-finite number to `null`, so the tagged
 * envelope is what reaches storage.
 *
 * The replacer visits a holder BEFORE its children, which is why an
 * infinity-tolerant LIST is rewritten here at its own key rather than element by
 * element: an array element's own visit knows only its index, never which array it
 * belongs to. The rewritten array is walked afterwards, where each envelope is
 * already an object and passes straight through — so there is no recursion.
 */
export function encodeNonFiniteNumbers(key: string, value: unknown): unknown {
  if (SIGNED_INFINITY_SCALAR_KEYS.has(key)) return encodeIfInfinite(value);
  if (SIGNED_INFINITY_LIST_KEYS.has(key) && Array.isArray(value)) {
    return value.map((element) => encodeIfInfinite(element));
  }
  return value;
}

/**
 * `JSON.parse` reviver for the legacy payload — the matching decode, which runs
 * strictly BEFORE `migrateScenarioState` and `sanitizePersistedScenario`. The
 * migration therefore sees real numeric infinities at the positions whose domain
 * admits them, exactly as the binding types say it should.
 *
 * Three outcomes, and every one of them is closed:
 *   • an approved position with a well-formed envelope decodes to the signed
 *     numeric infinity;
 *   • an approved position with a tagged-but-malformed envelope THROWS;
 *   • a FINITE-ONLY position carrying a tag THROWS — the value is refused rather
 *     than revived into a domain the schema forbids.
 *
 * A throw is caught by the migration and recorded as a `corrupt` outcome, leaving
 * the legacy row intact rather than half-migrated.
 *
 * `JSON.parse` walks bottom-up and binds `this` to the holder, so an ARRAY element
 * is passed over here and judged by its parent on the next visit — that is what
 * lets an infinity-tolerant list decode while an element of any other numeric
 * array is left as an object for the sanitizer to reject.
 */
export function decodeNonFiniteNumbers(this: unknown, key: string, value: unknown): unknown {
  if (SIGNED_INFINITY_SCALAR_KEYS.has(key)) return decodeEnvelope(value);
  if (SIGNED_INFINITY_LIST_KEYS.has(key) && Array.isArray(value)) {
    return value.map((element) => decodeEnvelope(element));
  }
  // An array element is decided by its parent, which is visited next.
  if (Array.isArray(this)) return value;
  if (isTagged(value)) {
    throw new Error(
      `Persisted scenario carries a ${NON_FINITE_PERSIST_TAG} envelope at the finite-only ` +
        `field "${key}"; a signed infinity is only valid for a weight.`,
    );
  }
  return value;
}
