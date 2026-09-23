// G5 — shared authorities for the ASSEMBLED real-Ward-8 roster journey.
//
// The spec that consumes this (`e2e/roster-real-ward-assembled.spec.ts`) drives the
// PRODUCTION routes against the live direct Compose stack. Everything here is either
// a constant that spec needs, or a pure judgement over evidence the browser produced —
// so the judgement itself is unit-testable (`ward-journey.test.ts`) instead of being
// buried in an assertion that only ever runs behind Docker.
//
// Three drift seams are closed by the sibling unit suite rather than by convention:
//
//   1. `WARD_EXPECTED` is checked against the REAL scenario file, so a scenario edit
//      cannot leave the journey asserting facts the file no longer states.
//   2. `STORAGE_KEYS` is checked against the production constants, so a renamed key
//      cannot turn a residue probe into a vacuous "nothing found".
//   3. `WARD_BOUNDS` has its key set pinned and its total derived, so a phase added
//      to the journey without a bound fails the suite instead of silently running
//      under Playwright's 30s default.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
// THE PRODUCT'S OWN CODECS, not reimplementations. `dayStateDisplay` is the exact
// function the edited-XLSX patcher writes cells with, and `deriveCurrentDays` is
// the exact overlay application the viewer renders — so a workbook is compared
// against what the product itself says the roster is, rather than against a second
// opinion that could drift into agreeing with a bug.
import { dayStateDisplay } from "@/lib/roster/day-state";
import { deriveCurrentDays } from "@/lib/roster/overlay";
import type { RosterDayGrid, RosterEdit } from "@/lib/roster/types";

/** Repo root, from `web/e2e/support`. */
const REPO_ROOT = resolve(__dirname, "../../..");

/**
 * THE authoritative scenario. The ticket names this exact file and forbids
 * substituting a smaller fixture, so the path is a constant and the spec uploads the
 * file itself through the picker — never a re-serialized copy of its contents.
 */
export const WARD_YAML_PATH = resolve(
  REPO_ROOT,
  "core/tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml",
);

/** The uploaded filename, which the `.yaml` extension gate in the picker requires. */
export const WARD_YAML_FILENAME = "ward-8-shift-patterns-senior-on-every-shift.yaml";

/**
 * The visible facts the imported scenario must show. Derived from the file by
 * `deriveWardFacts` in the unit suite, stated here so the browser assertions read as
 * product claims rather than as a second parse.
 */
export const WARD_EXPECTED = {
  startDate: "2026-10-01",
  endDate: "2026-10-28",
  dayCount: 28,
  peopleCount: 32,
  /**
   * The authored people, in definition order — the identity the roster must carry
   * end to end. The submission is anonymised to `P#` on the wire, so seeing these
   * back in the captured document, the export and the workbook is simultaneously
   * the proof that de-anonymisation put the right person back on the right row.
   */
  peopleIds: [
    "SSN-Siti",
    "SSN-MeiLing",
    "SSN-Priya",
    "SSN-Nurul",
    "SSN-JiaHui",
    "SSN-Kavitha",
    "SSN-Aishah",
    "SSN-WeiLing",
    "SSN-Devi",
    "SSN-Farah",
    "SN-HuiMin",
    "SSN-Lakshmi",
    "SSN-Rohana",
    "SN-XiuMei",
    "SN-Zainab",
    "SN-Anitha",
    "SN-Suhaila",
    "SN-Ramani",
    "SN-YanLing",
    "SN-Noraini",
    "SN-ShuFen",
    "SN-Kamala",
    "SN-Halimah",
    "SN-PeiShan",
    "SN-Vimala",
    "SN-Sabariah",
    "SN-LiPing",
    "SN-Geetha",
    "SN-Junaidah",
    "SN-XinYi",
    "SN-Suriani",
    "SN-Nadia",
  ],
  /** The eight patterns, each declared twice (open + senior-only `+`). */
  shiftTypeIds: [
    "am1",
    "am1+",
    "am2",
    "am2+",
    "am3",
    "am3+",
    "pm1",
    "pm1+",
    "pm2",
    "pm2+",
    "pm3",
    "pm3+",
    "long",
    "long+",
    "night",
    "night+",
  ],
} as const;

/** Editable grid cells: one per person per day. */
export const WARD_EXPECTED_CELL_COUNT = WARD_EXPECTED.peopleCount * WARD_EXPECTED.dayCount;

/**
 * The `SeniorStaffNurses` people group, stated explicitly.
 *
 * Deliberately NOT derived from the `SSN-` prefix: that would be an inference
 * about the naming convention rather than a statement of what the scenario
 * declares, and a scenario edit that moved one nurse in or out of the group
 * would silently move the expectation with it.
 */
export const WARD_SENIOR_STAFF_NURSES: readonly string[] = [
  "SSN-Siti",
  "SSN-MeiLing",
  "SSN-Priya",
  "SSN-Nurul",
  "SSN-JiaHui",
  "SSN-Kavitha",
  "SSN-Aishah",
  "SSN-WeiLing",
  "SSN-Devi",
  "SSN-Farah",
  "SSN-Lakshmi",
  "SSN-Rohana",
];

/**
 * Ward 8's EIGHT staffing equations, exactly as the scenario authors them.
 *
 * Six are shift-type GROUPS and two name a single `+` pattern under a
 * qualification scope; not one of them is a per-shift headcount. Stated here as
 * an independent restatement of the YAML so the browser oracle can check the
 * displayed numbers against the scenario rather than against the app's own
 * derivation of it.
 *
 * `shifts` is the resolved member set; `qualified` marks the two shapes that
 * BOTH filter the numerator and forbid every unqualified assignment on their
 * selected shifts.
 */
export const WARD_REQUIREMENTS: readonly {
  scope: string;
  shifts: readonly string[];
  required: number;
  preferred: number | null;
  qualified: boolean;
}[] = [
  {
    scope: "AllMornings",
    shifts: ["am1", "am1+", "am2", "am2+", "am3", "am3+"],
    required: 6,
    preferred: 7,
    qualified: false,
  },
  {
    scope: "MorningSeniorSlots",
    shifts: ["am1+", "am2+", "am3+"],
    required: 1,
    preferred: null,
    qualified: true,
  },
  {
    scope: "AllAfternoons",
    shifts: ["pm1", "pm1+", "pm2", "pm2+", "pm3", "pm3+"],
    required: 6,
    preferred: 7,
    qualified: false,
  },
  {
    scope: "AfternoonSeniorSlots",
    shifts: ["pm1+", "pm2+", "pm3+"],
    required: 1,
    preferred: null,
    qualified: true,
  },
  {
    scope: "AllLongDays",
    shifts: ["long", "long+"],
    required: 1,
    preferred: 2,
    qualified: false,
  },
  { scope: "long+", shifts: ["long+"], required: 1, preferred: null, qualified: true },
  {
    scope: "AllNights",
    shifts: ["night", "night+"],
    required: 3,
    preferred: 4,
    qualified: false,
  },
  { scope: "night+", shifts: ["night+"], required: 1, preferred: null, qualified: true },
];

/** One equation's expected verdict on one day, computed from the roster itself. */
export interface WardEquationVerdict {
  units: number;
  required: number;
  short: number;
  over: number;
  unqualified: number;
}

/**
 * Evaluate one Ward equation on one day directly from the assignment matrix.
 *
 * This is the INDEPENDENT half of the oracle: it re-derives the backend's own
 * arithmetic — the qualified numerator, the separate `unqualified_n_people == 0`
 * exclusion, the lower bound and the `preferredNumPeople` upper bound — from the
 * roster and the scenario constants above, with no reference to the app's model.
 */
export function evaluateWardEquation(
  requirement: (typeof WARD_REQUIREMENTS)[number],
  currentMatrix: readonly (readonly string[])[],
  dateIdx: number,
): WardEquationVerdict {
  const seniors = new Set(WARD_SENIOR_STAFF_NURSES);
  const selected = new Set(requirement.shifts);
  let units = 0;
  let unqualified = 0;
  WARD_EXPECTED.peopleIds.forEach((personId, personIdx) => {
    const assigned = currentMatrix[personIdx]?.[dateIdx];
    if (assigned === undefined || !selected.has(assigned)) return;
    if (requirement.qualified && !seniors.has(personId)) {
      unqualified += 1;
      return;
    }
    units += 1;
  });
  const upper = requirement.preferred ?? requirement.required;
  return {
    units,
    required: requirement.required,
    short: Math.max(0, requirement.required - units),
    over: Math.max(0, units - upper),
    unqualified,
  };
}

/** The authored ids on one exact shift for one day, in people-axis order. */
export function wardPeopleOnShift(
  currentMatrix: readonly (readonly string[])[],
  shiftId: string,
  dateIdx: number,
): string[] {
  return WARD_EXPECTED.peopleIds.filter(
    (_personId, personIdx) => currentMatrix[personIdx]?.[dateIdx] === shiftId,
  );
}

/** Inclusive UTC day sequence between two ISO dates. Independent of app code. */
function isoSequence(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${endDate}T00:00:00Z`);
  for (let at = Date.parse(`${startDate}T00:00:00Z`); at <= end; at += 86_400_000) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * THE roster's exact date axis. Computed here rather than copied from the app so
 * the journey's expectation is an independent statement about the scenario, not a
 * restatement of `generateDateItems`; the unit suite pins its endpoints, length,
 * ordering and month.
 */
export const WARD_EXPECTED_CALENDAR: readonly string[] = isoSequence(
  WARD_EXPECTED.startDate,
  WARD_EXPECTED.endDate,
);

/** The three-letter weekday of each day on that axis, as the workbook writes it. */
export const WARD_EXPECTED_WEEKDAYS: readonly string[] = WARD_EXPECTED_CALENDAR.map(
  (iso) => WEEKDAY_NAMES[new Date(`${iso}T00:00:00Z`).getUTCDay()],
);

/**
 * The exact worksheet geometry this scenario produces at the product's default
 * `prettify` setting: one leading label column, five history columns (every Ward 8
 * nurse carries five days of history), then 28 date columns, over 32 people rows
 * starting at row 3.
 *
 * Stated as a constant so a workbook can be read at EXACT coordinates instead of
 * being scanned for something that looks like a person. It is not taken on trust:
 * the journey asserts the captured document's own `coordinateMap` equals it, so a
 * layout change fails loudly rather than silently retargeting every cell assertion.
 */
export const WARD_EXPECTED_COORDINATE_MAP = {
  firstPeopleRow: 3,
  leadingCols: 1,
  historyCols: 5,
  prettify: true,
  peopleRows: Array.from({ length: WARD_EXPECTED.peopleCount }, (_, index) => 3 + index),
  dateColumns: Array.from({ length: WARD_EXPECTED.dayCount }, (_, index) => 7 + index),
} as const;

/** The workbook's own label rows, immediately below the people block. */
export const WARD_WORKBOOK_ROWS = {
  dayNumberRow: 1,
  weekdayRow: 2,
  scoreRow: WARD_EXPECTED_COORDINATE_MAP.firstPeopleRow + WARD_EXPECTED.peopleCount,
  statusRow: WARD_EXPECTED_COORDINATE_MAP.firstPeopleRow + WARD_EXPECTED.peopleCount + 1,
} as const;

/** The dedicated sheet `patchFrozenXlsxWithEdits` adds to an edited export. */
export const EDITED_PROVENANCE_SHEET = "Roster provenance";

/**
 * The solver timeout the journey types into the real run-options field.
 *
 * NOT the form's 300s default. The ticket requires bounded timeouts derived from the
 * configured run limits, and this is the run limit the journey configures: the job
 * cannot outlive it, so `completionPoll` below is a real ceiling rather than a hope.
 * It stays far above the measured solve (this scenario reaches OPTIMAL in ~10s on the
 * assembled stack), so a slower host degrades to a FEASIBLE incumbent — still a
 * loadable completion — instead of turning into a flake.
 */
export const WARD_SOLVER_TIMEOUT_SECONDS = 120;

/**
 * The production storage surfaces the journey reads directly.
 *
 * Read RAW, not through a fixture page: the ticket forbids a fixture-only page on the
 * tested path, and a probe that goes through the app's own storage module would be
 * asking the code under test whether it did its job. The unit suite pins every value
 * to the production constant it mirrors.
 */
export const STORAGE_KEYS = {
  databaseName: "nurse-scheduler",
  workingRosterKey: "working",
  candidateKeyPrefix: "candidate:",
  snapshotKeyPrefix: "snapshot:",
  currentCandidateMetaKey: "currentCandidate",
  scenarioPersistKey: "nurse-scheduler/scenario",
  /** The LEGACY single slot. Still swept by Clear, so still observed. */
  optimizeSessionKey: "nurse.optimize.session",
  /** G6.2: records are `nurse.optimize.session.<ownerId>`, so the probe reads a
   *  PREFIX. A probe that kept reading the one legacy key would report "nothing
   *  found" for every owner-keyed record and turn every residue claim vacuous. */
  optimizeSessionKeyPrefix: "nurse.optimize.session.",
  optimizeRetirePendingKey: "nurse.optimize.retire-pending",
  rosterViewPreferenceKey: "nursing-scheduler.roster-view",
} as const;

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * EVERY sequential bound the journey spends, one named key per phase.
 *
 * The assembled config declares no suite timeout and Playwright's default is 30s, so
 * a journey this long needs its own `test.setTimeout`. Summing an enumerated object
 * (rather than picking a round number) is what makes the advertised ceiling the
 * schedule the test can actually run — the same derivation the sibling assembled
 * budgets use.
 */
export const WARD_BOUNDS = {
  /** Reach Save & Load and see the hydrated workspace. */
  saveAndLoadReady: 30_000,
  /** Open the upload modal, hand the real file to the picker, clear the version gate. */
  importFile: 30_000,
  /** Dates / People / Shift types / Optimize stat grid, all four screens. */
  scenarioFacts: 60_000,
  /** Reach Optimize with the backend online and the submit control armed. */
  optimizeReady: 40_000,
  /** Explicit: the default action timeout is 0, i.e. bounded only by the total. */
  submitClick: 5_000,
  /** The accepted 202 reaches the Node-side tracker. */
  acceptedIdPoll: 15_000,
  /**
   * The terminal auto-chain for ONE run: solve (capped by the configured solver
   * timeout), roster-container fetch, people-id restore, candidate commit, XLSX
   * download and the release DELETE.
   */
  completionPoll: 150_000,
  /** The release DELETE freed the single slot, so a second run is permitted. */
  slotFreedAssertion: 30_000,
  /** The guarded CTA navigation to the dedicated route. */
  rosterNavigation: 30_000,
  /** The viewer paints the real 32 x 28 document. */
  rosterLoaded: 40_000,
  /** Grid / Coverage / Day, plus the structural invariants on each. */
  lensAssertions: 45_000,
  /** Select a cell, set it, and see autosave settle. */
  editAndSave: 30_000,
  /** Full reload, then the edit is still on screen. */
  reloadDurability: 45_000,
  /** A second edit, Undo, and the restored value saved. */
  undoRestore: 30_000,
  /** Roster-file and edited-XLSX browser downloads, both read back. */
  exportDownloads: 60_000,
  /** THE SECOND RUN. Same chain, own bound — it is a second real solve. */
  secondSubmitClick: 5_000,
  secondAcceptedIdPoll: 15_000,
  secondCompletionPoll: 150_000,
  /**
   * A THIRD run, deliberately walked away from while it is still solving, so the
   * session record and submission snapshot it leaves behind are genuinely present
   * when New schedule is confirmed.
   */
  thirdSubmitClick: 5_000,
  thirdAcceptedIdPoll: 15_000,
  inFlightHandoff: 30_000,
  /** The candidate offer appears above the preserved roster. */
  candidateOffer: 30_000,
  /** Open the replacement confirm and cancel it. */
  replaceCancelled: 25_000,
  /** Open it again and confirm; the promotion settles. */
  replaceConfirmed: 45_000,
  /** New schedule: the verified cut plus the scenario reset. */
  newScheduleReset: 60_000,
  /** Optimize and /roster both start from a genuinely fresh view. */
  freshStartAssertions: 40_000,
  /**
   * Allowance for the raw storage probes. `page.evaluate` accepts no timeout of
   * its own, so the test total is their only ceiling — this keeps that total
   * honest rather than pretending each probe is separately bounded.
   */
  storageProbes: 45_000,
  /** Worker startup and OS scheduling jitter between phases. */
  schedulerAllowance: 30_000,
} as const;

/** The exact key set of `WARD_BOUNDS`, pinned so an omission fails loudly. */
export const WARD_BOUND_KEYS = Object.keys(WARD_BOUNDS) as ReadonlyArray<keyof typeof WARD_BOUNDS>;

/** The journey's whole ceiling, derived from the bounds above and nothing else. */
export const WARD_TEST_TIMEOUT = Object.values(WARD_BOUNDS).reduce(
  (total, bound) => total + bound,
  0,
);

// ---------------------------------------------------------------------------
// Evidence types
// ---------------------------------------------------------------------------

/**
 * One working-roster row, as RAW MATERIAL rather than as a verdict.
 *
 * The browser hands back the stored bytes; every judgement over them — the digest,
 * the Ward identity, the workbook — is made in Node by the pure functions below,
 * which the unit suite can therefore drive with mutated inputs. The previous shape
 * returned a finished digest computed in-page, which nothing could contradict.
 *
 * `revision` is deliberately NOT part of the digest input: confirmed replacement is
 * independently required to bump it, so folding it in made a digest-change assertion
 * unfalsifiable. Content and row metadata are now two separate observations.
 */
export interface WorkingRosterEvidence {
  revision: number;
  /** The exact `{jobId, candidateVersion}` the row was promoted from, if any. */
  candidateSource: { jobId: string; candidateVersion: number } | null;
  /** Overlay entries — non-zero once the journey has edited the roster. */
  editCount: number;
  /** The stored document as canonical JSON, with the workbook elided. */
  documentJson: string;
  /** The stored frozen workbook's exact bytes, base64. */
  workbookBase64: string;
}

/** The two things a document digest is allowed to depend on. */
export interface RosterDocumentBytes {
  documentJson: string;
  workbookBase64: string;
}

/**
 * SHA-256 over the document's content ONLY — its canonical JSON and its workbook
 * bytes, length-prefixed so the two fields cannot be confused for one another.
 *
 * No revision, no row key, no clear epoch. That is the whole point: "the roster was
 * not replaced" and "the roster row was not rewritten" are different claims, and
 * mixing them let the weaker one masquerade as the stronger.
 */
export function wardDocumentDigest(bytes: RosterDocumentBytes): string {
  return createHash("sha256")
    .update(`${bytes.documentJson.length}:`)
    .update(bytes.documentJson, "utf8")
    .update(`|${bytes.workbookBase64.length}:`)
    .update(bytes.workbookBase64, "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Document identity
// ---------------------------------------------------------------------------

/** The identity-bearing facts of a roster document, in whichever form it arrives. */
export interface WardDocumentFacts {
  calendarIsos: string[];
  peopleIds: string[];
  shiftTypeIds: string[];
  solverStatus: string | null;
  score: number | null;
  solvedBaselineId: string;
  appBuild: string;
  editCount: number;
  coordinateMap: {
    firstPeopleRow: number;
    leadingCols: number;
    historyCols: number;
    prettify: boolean;
    peopleRows: number[];
    dateColumns: number[];
  } | null;
}

/**
 * Project a parsed roster document (stored form or exported-file form — they differ
 * only in how the workbook travels) onto the facts that identify WHICH roster it is.
 */
export function readWardDocumentFacts(parsed: unknown): WardDocumentFacts {
  const doc = parsed as {
    context?: {
      calendar?: Array<{ iso?: unknown }>;
      people?: Array<{ id?: unknown }>;
      shiftTypes?: Array<{ id?: unknown }>;
    };
    provenance?: {
      solverStatus?: unknown;
      score?: unknown;
      solvedBaselineId?: unknown;
      appBuild?: unknown;
    };
    edits?: unknown[];
    coordinateMap?: Record<string, unknown>;
  };
  const map = doc.coordinateMap;
  return {
    calendarIsos: (doc.context?.calendar ?? []).map((day) => String(day.iso)),
    peopleIds: (doc.context?.people ?? []).map((person) => String(person.id)),
    shiftTypeIds: (doc.context?.shiftTypes ?? []).map((shift) => String(shift.id)),
    solverStatus:
      typeof doc.provenance?.solverStatus === "string" ? doc.provenance.solverStatus : null,
    score: typeof doc.provenance?.score === "number" ? doc.provenance.score : null,
    solvedBaselineId: String(doc.provenance?.solvedBaselineId ?? ""),
    appBuild: String(doc.provenance?.appBuild ?? ""),
    editCount: doc.edits?.length ?? 0,
    coordinateMap:
      map === undefined
        ? null
        : {
            firstPeopleRow: Number(map.firstPeopleRow),
            leadingCols: Number(map.leadingCols),
            historyCols: Number(map.historyCols),
            prettify: map.prettify === true,
            peopleRows: (map.peopleRows as number[] | undefined) ?? [],
            dateColumns: (map.dateColumns as number[] | undefined) ?? [],
          },
  };
}

/** A judgement that names what is wrong rather than collapsing to a boolean. */
export interface WardVerdict {
  ok: boolean;
  problems: string[];
}

/** The two assignment matrices a roster document defines, as workbook text. */
export interface WardDocumentMatrices {
  /** The immutable solve, which the frozen workbook must reproduce exactly. */
  solved: string[][];
  /** Solve plus overlay — what an edited export must reproduce exactly. */
  current: string[][];
}

/**
 * Project a roster document onto the cell text its workbooks must carry.
 *
 * Both projections go through the product's own authorities so this cannot quietly
 * become a second, more forgiving definition of the roster.
 */
export function readWardDocumentMatrices(parsed: unknown): WardDocumentMatrices {
  const doc = parsed as { solvedDays?: RosterDayGrid; edits?: readonly RosterEdit[] };
  const solvedDays = doc.solvedDays ?? [];
  const edits = doc.edits ?? [];
  const toText = (grid: RosterDayGrid): string[][] =>
    grid.map((row) => row.map((day) => dayStateDisplay(day)));
  return { solved: toText(solvedDays), current: toText(deriveCurrentDays(solvedDays, edits)) };
}

function sameSequence(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, i) => value === expected[i]);
}

/**
 * Is this document THE Ward 8 roster?
 *
 * Lengths are not identity. A capture regression that produced a different 32x28
 * calendar, or restored the wrong person into a row, satisfies every count the
 * viewer can show — so the axis is compared element by element, in order, and the
 * solve provenance has to be a real one.
 */
export function judgeWardDocument(facts: WardDocumentFacts): WardVerdict {
  const problems: string[] = [];
  if (!sameSequence(facts.calendarIsos, WARD_EXPECTED_CALENDAR)) {
    problems.push(
      `calendar is not 2026-10-01..2026-10-28 (${facts.calendarIsos.length} day(s), first ${
        facts.calendarIsos[0] ?? "none"
      }, last ${facts.calendarIsos[facts.calendarIsos.length - 1] ?? "none"})`,
    );
  }
  if (!sameSequence(facts.peopleIds, WARD_EXPECTED.peopleIds)) {
    problems.push("people are not the 32 authored Ward 8 identities, in order");
  }
  if (!sameSequence(facts.shiftTypeIds, WARD_EXPECTED.shiftTypeIds)) {
    problems.push("shift types are not the 16 Ward 8 patterns, in order");
  }
  if (!isLoadableSolverStatus(facts.solverStatus)) {
    problems.push(`solver status ${JSON.stringify(facts.solverStatus)} is not a loadable result`);
  }
  if (facts.score === null || !Number.isFinite(facts.score)) {
    problems.push("provenance carries no finite solved score");
  }
  if (!/^[0-9a-f]{64}$/.test(facts.solvedBaselineId)) {
    problems.push("solvedBaselineId is not a SHA-256 hex digest");
  }
  if (facts.appBuild.length === 0) {
    problems.push("provenance carries no app build stamp");
  }
  const map = facts.coordinateMap;
  if (map === null) {
    problems.push("document carries no coordinate map");
  } else if (
    map.firstPeopleRow !== WARD_EXPECTED_COORDINATE_MAP.firstPeopleRow ||
    map.leadingCols !== WARD_EXPECTED_COORDINATE_MAP.leadingCols ||
    map.historyCols !== WARD_EXPECTED_COORDINATE_MAP.historyCols ||
    map.prettify !== WARD_EXPECTED_COORDINATE_MAP.prettify ||
    map.peopleRows.join(",") !== WARD_EXPECTED_COORDINATE_MAP.peopleRows.join(",") ||
    map.dateColumns.join(",") !== WARD_EXPECTED_COORDINATE_MAP.dateColumns.join(",")
  ) {
    problems.push("coordinate map does not match the expected Ward 8 worksheet geometry");
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Workbooks
// ---------------------------------------------------------------------------

/** What a Ward 8 schedule workbook says, read at the exact expected coordinates. */
export interface WardWorkbookFacts {
  sheetNames: string[];
  /** The label column, one per people row. */
  personLabels: string[];
  /** The day-number header over each date column. */
  dayNumbers: string[];
  /** The three-letter weekday under each day number. */
  weekdays: string[];
  scoreLabel: string;
  score: number | null;
  statusLabel: string;
  solverStatus: string | null;
  /** `[personIdx][dateIdx]` cell text; `""` for an unworked day. */
  assignments: string[][];
}

export type ReadWardWorkbookResult =
  | { ok: true; facts: WardWorkbookFacts }
  | { ok: false; reason: string };

/**
 * The Score cell as a number, or `null` when there isn't one.
 *
 * NOT `Number(text)`: that turns a BLANK cell into `0`, so a workbook carrying no
 * score at all reported a perfectly finite one and the “missing score” check could
 * never fire on the real parser path.
 */
function parseScoreCell(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = cellText(value);
  if (text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ExcelJS cell values are a union; the schedule sheet only ever holds text or a number. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const rich = value as {
      text?: unknown;
      result?: unknown;
      richText?: Array<{ text?: unknown }>;
    };
    if (typeof rich.text === "string") return rich.text.trim();
    if (typeof rich.result === "string" || typeof rich.result === "number") {
      return String(rich.result).trim();
    }
    if (Array.isArray(rich.richText)) {
      return rich.richText
        .map((run) => String(run.text ?? ""))
        .join("")
        .trim();
    }
  }
  return String(value).trim();
}

/**
 * Parse a downloaded or embedded workbook with the project's own maintained parser.
 *
 * FAIL-CLOSED, never throwing: bytes that are not a workbook return a reason, which
 * is what lets the same helper serve as the discriminating control. ZIP magic is not
 * checked here at all — checking four bytes was exactly the weakness this replaces.
 */
export async function readWardWorkbook(
  bytes: Buffer | Uint8Array,
): Promise<ReadWardWorkbookResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS ships its own `Buffer` declaration, which no longer structurally
    // matches Node's generic `Buffer<ArrayBufferLike>`. The runtime contract is
    // unchanged — it consumes exactly these bytes — so the parameter type is taken
    // from the method itself rather than restated.
    await workbook.xlsx.load(bytes as unknown as Parameters<ExcelJS.Xlsx["load"]>[0]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `the bytes are not a readable workbook: ${reason}` };
  }

  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  const sheet = workbook.worksheets[0];
  if (sheet === undefined) {
    return { ok: false, reason: "the workbook contains no worksheet" };
  }

  const map = WARD_EXPECTED_COORDINATE_MAP;
  const rows = WARD_WORKBOOK_ROWS;
  return {
    ok: true,
    facts: {
      sheetNames,
      personLabels: map.peopleRows.map((row) =>
        cellText(sheet.getCell(row, map.leadingCols).value),
      ),
      dayNumbers: map.dateColumns.map((col) =>
        cellText(sheet.getCell(rows.dayNumberRow, col).value),
      ),
      weekdays: map.dateColumns.map((col) => cellText(sheet.getCell(rows.weekdayRow, col).value)),
      scoreLabel: cellText(sheet.getCell(rows.scoreRow, map.leadingCols).value),
      score: parseScoreCell(sheet.getCell(rows.scoreRow, map.dateColumns[0]).value),
      statusLabel: cellText(sheet.getCell(rows.statusRow, map.leadingCols).value),
      solverStatus: cellText(sheet.getCell(rows.statusRow, map.dateColumns[0]).value),
      assignments: map.peopleRows.map((row) =>
        map.dateColumns.map((col) => cellText(sheet.getCell(row, col).value)),
      ),
    },
  };
}

export interface WardWorkbookExpectation {
  /** An edited export additionally carries the dedicated provenance sheet. */
  requireProvenanceSheet?: boolean;
  /** One coordinate whose exact text is known — used to prove the edit landed. */
  expectCell?: { personIdx: number; dateIdx: number; text: string };
  /**
   * The full `[personIdx][dateIdx]` text the corresponding roster document says
   * this workbook must carry.
   *
   * Vocabulary was not enough. A workbook whose 896 cells were all blank, or all
   * swapped for other perfectly valid ward shifts, satisfied every axis and every
   * allowed value — it just wasn't the roster that was solved. This ties the two
   * real authorities together WITHOUT pinning one optimal schedule: whatever the
   * solver produced, the workbook and the document have to agree on it.
   */
  matrix?: readonly (readonly string[])[];
  /** How many mismatching cells to name before summarising. */
  maxReportedCells?: number;
}

/** The value a rest day takes in a workbook: absent, or blanked by the edit patcher. */
const EMPTY_CELL_TEXTS = new Set([""]);

/** Is this workbook the Ward 8 schedule, with a real solve behind it? */
export function judgeWardWorkbook(
  facts: WardWorkbookFacts,
  expectation: WardWorkbookExpectation = {},
): WardVerdict {
  const problems: string[] = [];
  if (facts.sheetNames.length === 0) problems.push("the workbook has no sheets");
  if (!sameSequence(facts.personLabels, WARD_EXPECTED.peopleIds)) {
    problems.push("the label column is not the 32 authored Ward 8 people, in order");
  }
  const expectedDayNumbers = WARD_EXPECTED_CALENDAR.map((iso) => String(Number(iso.slice(8, 10))));
  if (!sameSequence(facts.dayNumbers, expectedDayNumbers)) {
    problems.push("the day-number header is not 1..28");
  }
  if (!sameSequence(facts.weekdays, WARD_EXPECTED_WEEKDAYS)) {
    problems.push("the weekday header does not match October 2026");
  }
  if (facts.scoreLabel !== "Score") problems.push("the Score row is missing");
  if (facts.score === null || !Number.isFinite(facts.score)) {
    problems.push("the Score row carries no finite score");
  }
  if (facts.statusLabel !== "Status") problems.push("the Status row is missing");
  if (!isLoadableSolverStatus(facts.solverStatus)) {
    problems.push(`the Status row reads ${JSON.stringify(facts.solverStatus)}`);
  }

  const allowed = new Set<string>([...WARD_EXPECTED.shiftTypeIds, "Leave"]);
  const unexpected = new Set<string>();
  for (const row of facts.assignments) {
    for (const text of row) {
      if (EMPTY_CELL_TEXTS.has(text) || allowed.has(text)) continue;
      unexpected.add(text);
    }
  }
  if (unexpected.size > 0) {
    problems.push(`assignment cells hold values outside this ward: ${[...unexpected].join(", ")}`);
  }

  if (
    expectation.requireProvenanceSheet === true &&
    !facts.sheetNames.includes(EDITED_PROVENANCE_SHEET)
  ) {
    problems.push(`the edited export has no "${EDITED_PROVENANCE_SHEET}" sheet`);
  }
  const cell = expectation.expectCell;
  if (cell !== undefined) {
    const actual = facts.assignments[cell.personIdx]?.[cell.dateIdx];
    if (actual !== cell.text) {
      problems.push(
        `cell [${cell.personIdx}][${cell.dateIdx}] is ${JSON.stringify(actual)}, expected ${JSON.stringify(cell.text)}`,
      );
    }
  }

  const matrix = expectation.matrix;
  if (matrix !== undefined) {
    const limit = expectation.maxReportedCells ?? 5;
    const mismatches: string[] = [];
    let total = 0;
    if (matrix.length !== facts.assignments.length) {
      problems.push(
        `the workbook has ${facts.assignments.length} people rows, the document has ${matrix.length}`,
      );
    }
    for (let person = 0; person < matrix.length; person += 1) {
      const expectedRow = matrix[person];
      const actualRow = facts.assignments[person] ?? [];
      if (expectedRow.length !== actualRow.length) {
        problems.push(
          `row ${person} has ${actualRow.length} date columns, the document has ${expectedRow.length}`,
        );
        continue;
      }
      for (let date = 0; date < expectedRow.length; date += 1) {
        if (actualRow[date] === expectedRow[date]) continue;
        total += 1;
        if (mismatches.length < limit) {
          mismatches.push(
            `[${person}][${date}] workbook ${JSON.stringify(actualRow[date])} vs document ${JSON.stringify(expectedRow[date])}`,
          );
        }
      }
    }
    if (total > 0) {
      problems.push(
        `${total} assignment cell(s) disagree with the roster document: ${mismatches.join("; ")}${
          total > mismatches.length ? ", ..." : ""
        }`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Everything the origin is still holding, read straight out of the browser. */
export interface RosterResidueProbe {
  databasePresent: boolean;
  working: WorkingRosterEvidence | null;
  candidatePointer: { jobId: string; candidateVersion: number } | null;
  candidateRowKeys: string[];
  snapshotRowKeys: string[];
  scenarioRecordPresent: boolean;
  /** Every optimize session key present: the legacy slot and every owner record. */
  optimizeSessionKeys: string[];
  retireMarkerPresent: boolean;
  viewMetadataPresent: boolean;
}

/**
 * What a confirmed `New schedule` promises to have removed.
 *
 * The scenario record is deliberately NOT in this set: the reset REPLACES it with an
 * empty default rather than deleting it, so requiring its absence would assert the
 * wrong contract. The scenario's emptiness is proved on screen instead (the Optimize
 * stat grid reads zero), which is the claim the user actually cares about.
 */
export interface ResidueVerdict {
  ok: boolean;
  /** Plain names of every surface that survived, for the failure message. */
  remaining: string[];
}

/**
 * The calls that would mean a route entry RESUMED `jobId`, drawn from a window of
 * observed `METHOD /path STATUS` lines.
 *
 * WHY THIS IS NOT “any line mentioning the job”, which is what the journey asserted
 * first: leaving abandons the run, and abandonment fires a best-effort exact-job
 * `cancel` WITHOUT awaiting it — deliberately, so the local privacy cuts never wait
 * on the network. Its RESPONSE can therefore be recorded after the next navigation
 * has begun, and a “mentions the job” filter reads the abandonment's own request as
 * evidence that arriving resumed something.
 *
 * That is a false positive, and a racy one: the journey passed it twice in a row on
 * one run of this machine and failed it on the next. Pure and unit-tested here for
 * exactly the reason this module exists — a judgement buried in an assertion that
 * only runs behind Docker is a judgement nothing can check.
 *
 * The forbidden shapes are ENUMERATED rather than expressed as “everything except
 * cancel”, so a resuming call added later is caught instead of quietly tolerated.
 * `cancel` is the one call the retirement lane is contractually allowed to make.
 */
export function resumingCallsFor(lines: readonly string[], jobId: string): string[] {
  const forbidden = [
    `GET /api/optimize/${jobId} `, // the authoritative poll
    `GET /api/optimize/${jobId}/events`,
    `GET /api/optimize/${jobId}/xlsx`,
    `GET /api/optimize/${jobId}/roster`,
    `DELETE /api/optimize/${jobId} `,
    `POST /api/optimize/${jobId}/finish-now`,
  ];
  return lines.filter((line) => forbidden.some((shape) => line.includes(shape)));
}

/** Judge a post-reset probe. Anything still present is named, never summarised away. */
export function judgeResidue(probe: RosterResidueProbe): ResidueVerdict {
  const remaining: string[] = [];
  if (probe.working !== null) remaining.push("the working roster");
  if (probe.candidatePointer !== null) remaining.push("the latest-result pointer");
  if (probe.candidateRowKeys.length > 0) {
    remaining.push(`${probe.candidateRowKeys.length} saved result row(s)`);
  }
  if (probe.snapshotRowKeys.length > 0) {
    remaining.push(`${probe.snapshotRowKeys.length} submission snapshot row(s)`);
  }
  if (probe.optimizeSessionKeys.length > 0) {
    remaining.push(`${probe.optimizeSessionKeys.length} optimisation session record(s)`);
  }
  if (probe.retireMarkerPresent) remaining.push("the retirement marker");
  if (probe.viewMetadataPresent) remaining.push("the roster view metadata");
  return { ok: remaining.length === 0, remaining };
}

/**
 * Judge what a visit left behind after the user navigated away from a live run.
 *
 * G6.2's abandonment contract, stated as evidence rather than as copy: leaving
 * revokes the run's audience, and the retirement lane then removes the exact
 * things that only existed to serve it — this owner's session record and the
 * submission snapshot it named. Nothing here looks at the screen, because the
 * claim is about what the origin is still holding, not about what it renders.
 *
 * Deliberately NOT in this set: the working roster, the candidate pointer and the
 * candidate rows. Those are committed product data. A run that got far enough to
 * commit a candidate produced something the user owns, and walking away from the
 * route is not a decision to destroy it.
 */
export function judgeVisitAbandoned(probe: RosterResidueProbe): ResidueVerdict {
  const remaining: string[] = [];
  if (probe.optimizeSessionKeys.length > 0) {
    remaining.push(`${probe.optimizeSessionKeys.length} optimisation session record(s)`);
  }
  if (probe.snapshotRowKeys.length > 0) {
    remaining.push(`${probe.snapshotRowKeys.length} submission snapshot row(s)`);
  }
  if (probe.retireMarkerPresent) remaining.push("the retirement marker");
  return { ok: remaining.length === 0, remaining };
}

/**
 * Judge the pre-reset probe that makes the absence assertions non-vacuous.
 *
 * WHAT THIS DOES AND DOES NOT CLAIM. An absence proof is worth exactly as much as the
 * presence that preceded it, so this requires the four surfaces the successful journey
 * can genuinely establish through production behaviour: the working roster, the
 * latest-result pointer, a saved candidate row, and the roster view metadata.
 *
 * G6.2 REMOVED TWO. It used to also require the optimisation session record and a
 * submission snapshot, and the journey earned them by leaving a third run in flight —
 * because a run that finished released both, so on the tidy path they were already
 * gone. That is no longer a way to earn them: leaving abandons the run, and the
 * retirement lane removes the record and purges the snapshot precisely BECAUSE the
 * user walked away. There is now no honest production sequence that leaves either
 * standing until an unrelated reset, so requiring them here would force the journey
 * to fabricate a state the product does not produce.
 *
 * Both are still proved, in the place that can drive them honestly: `judgeResidue`
 * still refuses to let either survive a reset, and `judgeVisitAbandoned` proves the
 * ABANDONMENT is what removes them — which is the stronger claim, since it names the
 * cause rather than only the eventual absence.
 *
 * The RETIREMENT MARKER is likewise not required. Its mechanism is deleted; only the
 * key survives, for Clear to remove.
 */
export function judgeResiduePresent(probe: RosterResidueProbe): ResidueVerdict {
  const remaining: string[] = [];
  if (probe.working === null) remaining.push("the working roster");
  if (probe.candidatePointer === null) remaining.push("the latest-result pointer");
  if (probe.candidateRowKeys.length === 0) remaining.push("a saved result row");
  if (!probe.viewMetadataPresent) remaining.push("the roster view metadata");
  return { ok: remaining.length === 0, remaining };
}

/**
 * The terminal solver verdicts that count as a loadable completion.
 *
 * The journey asserts a real optimisation ran to a usable result, NOT one exact
 * nondeterministic schedule. A host slow enough to exhaust the configured timeout
 * still yields a FEASIBLE incumbent, and that is a genuine product success; anything
 * else (INFEASIBLE, UNKNOWN, a blank) is a different terminal result and must fail.
 */
export const LOADABLE_SOLVER_STATUSES = ["OPTIMAL", "FEASIBLE"] as const;

/** Whether a rendered solver-status string is one the journey accepts. */
export function isLoadableSolverStatus(text: string | null): boolean {
  if (text === null) return false;
  const normalized = text.trim().toUpperCase();
  return (LOADABLE_SOLVER_STATUSES as readonly string[]).includes(normalized);
}

// ---------------------------------------------------------------------------
// Replacement
// ---------------------------------------------------------------------------

/** The durable pointer that names one exact capture. */
export interface CandidatePointer {
  jobId: string;
  candidateVersion: number;
}

/** A stored candidate row, read raw, as the material a Replace must promote. */
export interface CandidateEvidence {
  pointer: CandidatePointer;
  documentJson: string;
  workbookBase64: string;
}

/** One side of the replacement: what the working row held at a moment in time. */
export interface WorkingSnapshot {
  digest: string;
  revision: number;
  candidateSource: CandidatePointer | null;
}

export interface ReplacementEvidence {
  /** The roster on screen before the user confirmed. */
  before: WorkingSnapshot;
  /** The exact candidate they chose, read from storage before the click. */
  candidate: { digest: string; pointer: CandidatePointer };
  /** The roster after the confirmed Replace settled. */
  after: WorkingSnapshot;
}

function samePointer(a: CandidatePointer | null, b: CandidatePointer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.jobId === b.jobId && a.candidateVersion === b.candidateVersion;
}

function pointerText(pointer: CandidatePointer | null): string {
  return pointer === null ? "none" : `${pointer.jobId}@v${pointer.candidateVersion}`;
}

/**
 * Did the confirmed Replace load EXACTLY the candidate the user chose?
 *
 * WHY THIS IS NOT “the digest changed”. Two runs of the same scenario may honestly
 * solve to the same assignment and the same workbook — G5 asserts a real result,
 * not a nondeterministic one — so requiring the bytes to differ would fail a
 * perfectly correct replacement. The right oracle is not difference, it is
 * IDENTITY: the working roster must now be the candidate's bytes, stamped with the
 * candidate's exact pointer, on a rewritten row whose source genuinely moved.
 *
 * That also closes the converse hole: the pointer pair alone proved only what the
 * row was STAMPED with, not what was promoted into it, so A's bytes carrying B's
 * source would have passed.
 */
export function judgeReplacement(evidence: ReplacementEvidence): WardVerdict {
  const problems: string[] = [];
  const { before, candidate, after } = evidence;

  if (after.digest !== candidate.digest) {
    problems.push(
      "the promoted roster is not the chosen candidate's content" +
        (after.digest === before.digest ? " (it is still the previous roster's)" : ""),
    );
  }
  if (!samePointer(after.candidateSource, candidate.pointer)) {
    problems.push(
      `candidateSource is ${pointerText(after.candidateSource)}, expected exactly ${pointerText(
        candidate.pointer,
      )}`,
    );
  }
  if (after.revision <= before.revision) {
    problems.push(
      `the working row was not rewritten (revision ${before.revision} -> ${after.revision})`,
    );
  }
  if (samePointer(before.candidateSource, candidate.pointer)) {
    // Otherwise the roster on screen was ALREADY this candidate and nothing was
    // replaced — the whole assertion would be self-satisfying.
    problems.push("the roster was already stamped with this candidate before the Replace");
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Scenario-file facts
// ---------------------------------------------------------------------------

/** The facts a scenario file states about itself, as the journey needs them. */
export interface WardFacts {
  startDate: string;
  endDate: string;
  peopleCount: number;
  peopleIds: string[];
  shiftTypeIds: string[];
}

/**
 * Read the facts back out of a scenario document.
 *
 * Used by the unit suite to prove `WARD_EXPECTED` still describes the real file. It
 * takes the PARSED document rather than raw text so the caller owns the YAML parser
 * (the web package already depends on `yaml`), keeping this a pure projection.
 */
export function deriveWardFacts(document: unknown): WardFacts {
  const doc = document as {
    dates?: { range?: { startDate?: unknown; endDate?: unknown } };
    people?: { items?: Array<{ id?: unknown }> };
    shiftTypes?: { items?: Array<{ id?: unknown }> };
  };
  const peopleIds = (doc.people?.items ?? []).map((item) => String(item.id));
  return {
    startDate: String(doc.dates?.range?.startDate ?? ""),
    endDate: String(doc.dates?.range?.endDate ?? ""),
    peopleCount: peopleIds.length,
    peopleIds,
    shiftTypeIds: (doc.shiftTypes?.items ?? []).map((item) => String(item.id)),
  };
}

/** The exact bytes of the authoritative scenario, for a byte-equality check. */
export function readWardYaml(): string {
  return readFileSync(WARD_YAML_PATH, "utf-8");
}
