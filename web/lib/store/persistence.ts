// Persistence plumbing (T04): the persist key/version, the forward migration, the
// persisted-payload sanitizer, the serialized/awaitable storage queue, and an
// in-memory `StateStorage` double.
//
// The storage seam is Zustand's `StateStorage` (async get/set/remove of a string).
// Dexie is one concrete adapter (`dexie-storage.ts`); tests inject the in-memory
// double. Every adapter is wrapped by the guard, which serializes writes AND
// removes through one FIFO queue so a slow/older op can never land after a newer
// one, exposes an awaitable `drain()` (for `pagehide` and reset), and never
// strands the newest value when an inner op rejects.

import type { StateStorage } from "zustand/middleware";
import {
  dedupeGuidedRulePinsBySource,
  type GuidedRulePin,
  type ScenarioUiState,
} from "@/lib/scenario";
import { SCENARIO_KEYS } from "./fingerprint";

/** The single IndexedDB key the durable scenario store persists under. */
export const SCENARIO_PERSIST_KEY = "nurse-scheduler/scenario";

/** Current persistence payload version; a bump triggers `migrateScenarioState`. */
export const SCENARIO_PERSIST_VERSION = 3;

/**
 * The persisted `state` payload at the current version: the durable scenario
 * slice plus the baseline fingerprint (persisted alongside so a reload can tell
 * restored-unsaved work from clean).
 */
export type PersistedScenarioState = ScenarioUiState & {
  baselineFingerprint: string | null;
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
 * v1 → v2: `guidedRulePins` (T14a) is a new durable field; a record from before it
 * existed defaults to an empty pin list.
 * v2 → v3: `pinConstraint` (T14d) now enforces at most one pin per source
 * constraint; a record written before that invariant existed may hold
 * duplicate pins for the same `(constraintKind, constraintId)` — collapse them
 * to the most recently written one so no hidden, unrenderable pin survives.
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

  if (fromVersion < 2) {
    if (migrated.guidedRulePins === undefined) {
      migrated.guidedRulePins = [];
    }
  }

  if (fromVersion < 3) {
    if (Array.isArray(migrated.guidedRulePins)) {
      migrated.guidedRulePins = dedupeGuidedRulePinsBySource(
        migrated.guidedRulePins as GuidedRulePin[],
      );
    }
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

const GUIDED_RULE_CONSTRAINT_KINDS = new Set<string>(CARD_KIND_KEYS);

function validateGuidedRulePin(el: Record<string, unknown>, i: number): void {
  const label = `guidedRulePins[${i}]`;
  requireString(el.id, `${label}.id`);
  if (
    typeof el.constraintKind !== "string" ||
    !GUIDED_RULE_CONSTRAINT_KINDS.has(el.constraintKind)
  ) {
    throw new Error(
      `Persisted ${label}.constraintKind must be one of ${[...GUIDED_RULE_CONSTRAINT_KINDS].join(", ")}.`,
    );
  }
  requireString(el.constraintId, `${label}.constraintId`);
  requireString(el.category, `${label}.category`);
  requireOptionalString(el.description, `${label}.description`);
  if (!Array.isArray(el.quickFields) || el.quickFields.some((f) => typeof f !== "string")) {
    throw new Error(`Persisted ${label}.quickFields must be an array of strings.`);
  }
}

function validateGuidedRulePins(value: unknown): void {
  requireObjectArray(value, "guidedRulePins").forEach(validateGuidedRulePin);
}

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
    case "guidedRulePins":
      validateGuidedRulePins(value);
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
 * (plus `baselineFingerprint`), recursively validating each present field's
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

  if ("baselineFingerprint" in persisted) {
    const fingerprint = persisted.baselineFingerprint;
    if (fingerprint !== null && typeof fingerprint !== "string") {
      throw new Error("Persisted baselineFingerprint is invalid.");
    }
    out.baselineFingerprint = fingerprint;
  }

  return out as Partial<PersistedScenarioState>;
}

// ---------------------------------------------------------------------------
// Guarded storage (serialized queue + drain + failure resilience)
// ---------------------------------------------------------------------------

/** A `StateStorage` whose writes/removes are serialized, with an awaitable drain. */
export interface GuardedStorage extends StateStorage {
  /** Resolve once the current write/remove queue has fully settled. */
  drain(): Promise<void>;
  /** The last inner write/remove error, if any (cleared by `consumeWriteError`). */
  consumeWriteError(): unknown;
}

/**
 * Wrap a lazily-constructed `StateStorage` in a single FIFO queue so writes and
 * removes never overlap and always apply in submission order — an older/slow op
 * can never land after a newer one. Each op is enqueued as its own task, so a
 * failed op never strands later values (the newest queued value still flushes).
 * Inner errors are recorded (not thrown to the caller, which would be an unhandled
 * rejection since `persist` ignores the returned promise) and surfaced via
 * `consumeWriteError`. `getItem` reads directly (reads need no ordering).
 *
 * The inner adapter is created on first use, so the browser Dexie default is only
 * constructed on the client at first read/write — never during SSR.
 */
export function createGuardedStorage(createInner: () => StateStorage): GuardedStorage {
  let inner: StateStorage | null = null;
  const getInner = () => (inner ??= createInner());

  let chain: Promise<void> = Promise.resolve();
  let revisionCounter = 0;
  let lastWrittenRevision = 0;
  let writeError: unknown = null;

  // Run `task` after the queue settles regardless of the previous op's outcome,
  // then swallow rejection on the stored chain so one failure never stalls the
  // queue (and never becomes an unhandled rejection). The returned promise is the
  // swallowed one, so callers (and `drain`) never see a rejection.
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    chain = chain.then(task, task).catch(() => {});
    return chain;
  };

  return {
    getItem: (name) => getInner().getItem(name),
    setItem: (name, value) => {
      const revision = ++revisionCounter;
      return enqueue(async () => {
        // Monotonic guard: never write a revision older than one already written.
        if (revision <= lastWrittenRevision) return;
        try {
          await getInner().setItem(name, value);
          lastWrittenRevision = revision;
        } catch (error) {
          writeError = error;
          throw error;
        }
      });
    },
    removeItem: (name) =>
      enqueue(async () => {
        try {
          await getInner().removeItem(name);
        } catch (error) {
          writeError = error;
          throw error;
        }
      }),
    drain: () => chain.then(() => {}),
    consumeWriteError: () => {
      const error = writeError;
      writeError = null;
      return error;
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory double (tests)
// ---------------------------------------------------------------------------

/** An in-memory `StateStorage` double with a readable snapshot, for tests. */
export interface MemoryStateStorage extends StateStorage {
  /** The underlying key → serialized-value map, as a plain object. */
  snapshot(): Record<string, string>;
}

/**
 * Build an async in-memory `StateStorage`. Operations resolve asynchronously so
 * they exercise the same async paths as Dexie; seed with `initial` to simulate a
 * previously-persisted record (e.g. migration/corrupt-record fixtures).
 */
export function createMemoryStorage(initial?: Record<string, string>): MemoryStateStorage {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    async getItem(name) {
      return map.has(name) ? (map.get(name) as string) : null;
    },
    async setItem(name, value) {
      map.set(name, value);
    },
    async removeItem(name) {
      map.delete(name);
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}
