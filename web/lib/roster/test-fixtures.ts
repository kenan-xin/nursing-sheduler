// Shared fixtures for the F3 roster-document suite. Not exported from `index.ts`.
//
// The submission is built as a real ANONYMIZED canonical document (`P1`/`P2` ids,
// no descriptions) and serialized through the production strict path
// (`serializeCanonicalDocument`), so every test that derives context is reading
// bytes the backend would actually have received — not a hand-shaped stand-in.
// The reverse map deliberately mixes a string and a numeric original id so the
// typed-identity rules are exercised by default rather than only in a special case.

import {
  PREFERENCE_TYPE,
  serializeCanonicalDocument,
  type CanonicalScenarioDocument,
  type ReverseMapTuple,
} from "@/lib/scenario";
import { XLSX_MEDIA_TYPE, type RosterContainerView } from "./container";
import { assembleRosterDocument } from "./assemble";
import {
  ROSTER_SUBMISSION_SCHEMA_VERSION,
  type RosterDayState,
  type RosterDocument,
  type RosterEdit,
  type RosterSubmission,
} from "./types";

export const FIXTURE_APP_BUILD = "0.0.0-test";
export const FIXTURE_RANGE = { startDate: "2026-07-03", endDate: "2026-07-06" };
/** The four expanded days of `FIXTURE_RANGE`, in axis order. */
export const FIXTURE_DATES = ["2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06"] as const;
/** The one date the fixture's own `PH` group names. */
export const FIXTURE_HOLIDAY = "2026-07-06";

export const FIXTURE_REVERSE_MAP: ReverseMapTuple[] = [
  ["P1", "Alice Ng"],
  // A numeric original id: `7` must never be confused with the string `"7"`.
  ["P2", 7],
];

/**
 * The submitted document. `D` carries exactly one unscoped, uncoefficiented
 * requirement (a usable baseline); `N` carries none (explicitly unavailable), so
 * both coverage branches are live in the default fixture.
 */
export function fixtureCanonicalDocument(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: {
      range: { ...FIXTURE_RANGE },
      groups: [{ id: "PH", members: [FIXTURE_HOLIDAY] }],
    },
    people: { items: [{ id: "P1", history: ["D"] }, { id: "P2" }] },
    shiftTypes: {
      items: [
        { id: "D", startTime: "09:00", endTime: "17:00", durationMinutes: 480 },
        { id: "N", startTime: "21:00", endTime: "07:00", durationMinutes: 600 },
      ],
    },
    preferences: [
      { type: PREFERENCE_TYPE.maxOneShiftPerDay },
      {
        type: PREFERENCE_TYPE.shiftTypeRequirement,
        shiftType: "D",
        requiredNumPeople: 1,
        qualifiedPeople: "ALL",
        date: "ALL",
        weight: -1,
      },
    ],
  };
}

/** A contracted-hours count fixing the LEAVE credit at 16 half-hours (480 min). */
export function withContractedHours(
  document: CanonicalScenarioDocument,
  leaveHalfHours = 16,
): CanonicalScenarioDocument {
  return {
    ...document,
    preferences: [
      ...document.preferences,
      {
        type: PREFERENCE_TYPE.shiftCount,
        person: "ALL",
        countDates: "ALL",
        countShiftTypes: ["D", "N", "LEAVE"],
        countShiftTypeCoefficients: [
          ["D", 16],
          ["N", 20],
          ["LEAVE", leaveHalfHours],
        ],
        expression: "x = T",
        target: 320,
        hoursContract: { unit: "half-hour", policy: "exact" },
        weight: Infinity,
      },
    ],
  };
}

/** Serialize a canonical document exactly as the submission path would. */
export function fixtureSubmission(
  document: CanonicalScenarioDocument = fixtureCanonicalDocument(),
  reverseMap: ReverseMapTuple[] = FIXTURE_REVERSE_MAP,
): RosterSubmission {
  return {
    canonicalYaml: serializeCanonicalDocument(document),
    reverseMap: reverseMap.map(([anonymized, original]) => [anonymized, original]),
    schemaVersion: ROSTER_SUBMISSION_SCHEMA_VERSION,
  };
}

const SHIFT_D: RosterDayState = { kind: "shift", shiftId: "D" };
const SHIFT_N: RosterDayState = { kind: "shift", shiftId: "N" };
const OFF: RosterDayState = { kind: "off" };
const LEAVE: RosterDayState = { kind: "leave" };

/** A complete 2×4 solved grid covering all three day-state kinds. */
export function fixtureSolvedDays(): RosterDayState[][] {
  return [
    [SHIFT_D, OFF, SHIFT_N, LEAVE],
    [SHIFT_N, SHIFT_D, OFF, SHIFT_D],
  ];
}

/**
 * A valid `/roster` container view. `prettify` is on with one history column, so
 * the date columns start at `leadingCols + historyCols + 1` — the exact rule the
 * exporter uses and the coordinate check re-verifies.
 */
export function fixtureContainer(): RosterContainerView {
  return {
    schemaVersion: "roster-container/1",
    people: [{ id: "P1" }, { id: "P2" }],
    dates: FIXTURE_DATES.map((iso) => ({ iso })),
    solvedDays: fixtureSolvedDays(),
    score: -12,
    solverStatus: "OPTIMAL",
    coordinateMap: {
      peopleRows: [3, 4],
      dateColumns: [3, 4, 5, 6],
      firstPeopleRow: 3,
      leadingCols: 1,
      historyCols: 1,
      prettify: true,
    },
    xlsx: { name: "nurse-scheduling-fixture.xlsx", mime: XLSX_MEDIA_TYPE },
  };
}

/**
 * Stand-in frozen workbook bytes. The roster document treats the workbook as
 * opaque bytes it must carry losslessly; patching a REAL C5 workbook is F5's
 * edited-XLSX path, so a byte pattern is the honest fixture here — it makes
 * base64 fidelity assertions exact rather than incidental.
 */
export function fixtureFrozenXlsx(byteLength = 61): Blob {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index++) bytes[index] = (index * 37 + 11) % 256;
  return new Blob([bytes], { type: XLSX_MEDIA_TYPE });
}

/** Assemble the canonical fixture document, failing loudly if it does not validate. */
export async function fixtureRosterDocument(
  overrides: {
    document?: CanonicalScenarioDocument;
    reverseMap?: ReverseMapTuple[];
    container?: RosterContainerView;
    frozenXlsx?: Blob;
  } = {},
): Promise<RosterDocument> {
  const result = await assembleRosterDocument({
    container: overrides.container ?? fixtureContainer(),
    submission: fixtureSubmission(overrides.document, overrides.reverseMap),
    frozenXlsx: overrides.frozenXlsx ?? fixtureFrozenXlsx(),
    appBuild: FIXTURE_APP_BUILD,
  });
  if (!result.ok) throw new Error(`fixture roster document is invalid: ${result.reason}`);
  return result.document;
}

/** Structured-clone a document the way IndexedDB would, Blob included. */
export function cloneDocument(document: RosterDocument): RosterDocument {
  return structuredClone(document);
}

/**
 * A deeply-mutable mirror of a roster type. Validated documents are deeply readonly
 * AND frozen, so a tamper test has to work on a real copy rather than reaching into
 * the original — which is the guarantee under test, not an inconvenience.
 */
export type Mutable<T> = T extends Blob
  ? T
  : T extends readonly (infer Element)[]
    ? Mutable<Element>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;

/**
 * A JSON-mutable copy of a document, with the `Blob` carried across by reference
 * (JSON cannot represent it, and its bytes are not what tamper tests target).
 */
export function mutableDocument(document: RosterDocument): Mutable<RosterDocument> {
  const { frozenXlsx, ...rest } = document;
  return {
    ...(JSON.parse(JSON.stringify(rest)) as Omit<Mutable<RosterDocument>, "frozenXlsx">),
    frozenXlsx,
  };
}

/** Replace the overlay of a frozen document, returning a new document. */
export function withEdits(document: RosterDocument, edits: readonly RosterEdit[]): RosterDocument {
  return { ...document, edits };
}

/** Patch provenance on a frozen document, returning a new document. */
export function withProvenance(
  document: RosterDocument,
  patch: Partial<Mutable<RosterDocument["provenance"]>>,
): RosterDocument {
  return {
    ...document,
    provenance: { ...document.provenance, ...patch } as RosterDocument["provenance"],
  };
}
