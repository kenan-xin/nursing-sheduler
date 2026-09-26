// Container parsing and document assembly (F3).
//
// The container is the ONLY authority for assignments and worksheet coordinates,
// so the adversarial cases here are the ones that would otherwise let a subtly
// wrong container become a plausible-looking roster: a ragged grid, an axis that
// silently disagrees with the submission, coordinates that do not follow the
// exporter's own rule.

import { describe, expect, it } from "vitest";
import { parseRosterContainer } from "./container";
import { assembleRosterDocument } from "./assemble";
import { computeSolvedBaselineId } from "./baseline";
import { validateRosterDocument } from "./validate";
import {
  FIXTURE_APP_BUILD,
  FIXTURE_DATES,
  fixtureCanonicalDocument,
  fixtureContainer,
  fixtureFrozenXlsx,
  fixtureRosterDocument,
  fixtureSolvedDays,
  fixtureSubmission,
} from "./test-fixtures";
import { ROSTER_SUBMISSION_SCHEMA_VERSION } from "./types";

function assemble(container: unknown, overrides: Record<string, unknown> = {}) {
  return assembleRosterDocument({
    container,
    submission: fixtureSubmission(),
    frozenXlsx: fixtureFrozenXlsx(),
    appBuild: FIXTURE_APP_BUILD,
    ...overrides,
  } as never);
}

/** A mutable clone of the fixture container. */
function container(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixtureContainer())) as Record<string, unknown>;
}

describe("parseRosterContainer", () => {
  it("accepts the fixture container", () => {
    expect(parseRosterContainer(fixtureContainer())).toMatchObject({ ok: true });
  });

  it.each([
    [
      "an unknown schema version",
      (c: Record<string, unknown>) => (c.schemaVersion = "roster-container/2"),
    ],
    ["an unexpected top-level field", (c: Record<string, unknown>) => (c.extra = 1)],
    ["a missing top-level field", (c: Record<string, unknown>) => delete c.score],
    ["an empty people axis", (c: Record<string, unknown>) => (c.people = [])],
    ["an empty dates axis", (c: Record<string, unknown>) => (c.dates = [])],
    [
      "a duplicated person",
      (c: Record<string, unknown>) => (c.people = [{ id: "P1" }, { id: "P1" }]),
    ],
    [
      "a duplicated date",
      (c: Record<string, unknown>) =>
        (c.dates = [
          { iso: FIXTURE_DATES[0] },
          { iso: FIXTURE_DATES[0] },
          { iso: FIXTURE_DATES[2] },
          { iso: FIXTURE_DATES[3] },
        ]),
    ],
    [
      "an unusable person id",
      (c: Record<string, unknown>) => (c.people = [{ id: "" }, { id: "P2" }]),
    ],
    [
      "a non-calendar date",
      (c: Record<string, unknown>) => ((c.dates as { iso: string }[])[0].iso = "2026-7-3"),
    ],
    [
      "a person carrying an extra field",
      (c: Record<string, unknown>) => (c.people = [{ id: "P1", name: "Alice" }, { id: "P2" }]),
    ],
    ["a non-finite score", (c: Record<string, unknown>) => (c.score = Number.POSITIVE_INFINITY)],
    ["a non-solved status", (c: Record<string, unknown>) => (c.solverStatus = "INFEASIBLE")],
    [
      "a ragged solved grid",
      (c: Record<string, unknown>) => (c.solvedDays as unknown[][])[0].pop(),
    ],
    ["a missing solved row", (c: Record<string, unknown>) => (c.solvedDays as unknown[]).pop()],
    [
      "a multi-shift cell",
      (c: Record<string, unknown>) =>
        ((c.solvedDays as unknown[][])[0][0] = { kind: "shift", shiftId: ["D", "N"] }),
    ],
    [
      "an unknown day-state kind",
      (c: Record<string, unknown>) => ((c.solvedDays as unknown[][])[0][0] = { kind: "holiday" }),
    ],
    [
      "an OFF cell carrying a shift id",
      (c: Record<string, unknown>) =>
        ((c.solvedDays as unknown[][])[0][1] = { kind: "off", shiftId: "D" }),
    ],
    [
      "a people-row axis of the wrong length",
      (c: Record<string, unknown>) =>
        ((c.coordinateMap as { peopleRows: number[] }).peopleRows = [3]),
    ],
    [
      "a non-increasing row axis",
      (c: Record<string, unknown>) =>
        ((c.coordinateMap as { peopleRows: number[] }).peopleRows = [3, 3]),
    ],
    [
      "a row axis not starting at firstPeopleRow",
      (c: Record<string, unknown>) =>
        ((c.coordinateMap as { peopleRows: number[] }).peopleRows = [5, 6]),
    ],
    [
      "date columns not starting after the leading and history columns",
      (c: Record<string, unknown>) =>
        ((c.coordinateMap as { dateColumns: number[] }).dateColumns = [2, 3, 4, 5]),
    ],
    [
      "history columns without prettify",
      (c: Record<string, unknown>) => ((c.coordinateMap as { prettify: boolean }).prettify = false),
    ],
    [
      "a zero-based worksheet coordinate",
      (c: Record<string, unknown>) => {
        const map = c.coordinateMap as { peopleRows: number[]; firstPeopleRow: number };
        map.peopleRows = [0, 1];
        map.firstPeopleRow = 0;
      },
    ],
    // The exporter's axes are CONTIGUOUS. Checking only cardinality, monotonicity,
    // and the first entry accepted gapped axes that the exporter cannot produce —
    // and coordinates are neither derived from `submission` nor covered by
    // `solvedBaselineId`, so nothing else would have caught them.
    [
      "a gap in the people-row axis after the first entry",
      (c: Record<string, unknown>) =>
        ((c.coordinateMap as { peopleRows: number[] }).peopleRows = [3, 5]),
    ],
    [
      "a gap in the date-column axis after the first entry",
      (c: Record<string, unknown>) =>
        ((c.coordinateMap as { dateColumns: number[] }).dateColumns = [3, 5, 6, 7]),
    ],
    [
      "a gap at the END of the date-column axis",
      (c: Record<string, unknown>) =>
        ((c.coordinateMap as { dateColumns: number[] }).dateColumns = [3, 4, 5, 9]),
    ],
    [
      "a workbook name that is not an .xlsx",
      (c: Record<string, unknown>) => ((c.xlsx as { name: string }).name = "schedule.csv"),
    ],
    [
      "a workbook media type that is not the XLSX type",
      (c: Record<string, unknown>) => ((c.xlsx as { mime: string }).mime = "application/json"),
    ],
    [
      "embedded workbook bytes the /roster view should have stripped",
      (c: Record<string, unknown>) => ((c.xlsx as Record<string, unknown>).base64 = "AAAA"),
    ],
  ])("fails closed on %s", (_label, mutate) => {
    const subject = container();
    mutate(subject);
    expect(parseRosterContainer(subject)).toMatchObject({ ok: false });
  });
});

describe("assembleRosterDocument", () => {
  it("builds a document whose axes are de-anonymized and index-aligned", async () => {
    const document = await fixtureRosterDocument();
    expect(document.schemaVersion).toBe("roster-file/1");
    expect(document.context.people.map((person) => person.id)).toEqual(["Alice Ng", 7]);
    expect(document.context.calendar.map((day) => day.iso)).toEqual([...FIXTURE_DATES]);
    expect(document.solvedDays).toEqual(fixtureSolvedDays());
    expect(document.coordinateMap).toEqual(fixtureContainer().coordinateMap);
    expect(document.edits).toEqual([]);
  });

  it("carries provenance from the container plus the supplied build stamp", async () => {
    const document = await fixtureRosterDocument();
    expect(document.provenance.solverStatus).toBe("OPTIMAL");
    expect(document.provenance.score).toBe(-12);
    expect(document.provenance.appBuild).toBe(FIXTURE_APP_BUILD);
    expect(document.provenance.solvedBaselineId).toBe(
      await computeSolvedBaselineId({
        people: document.context.people,
        dates: document.context.calendar,
        solvedDays: document.solvedDays,
      }),
    );
  });

  it("preserves the exact submission bytes rather than re-serializing them", async () => {
    const submission = fixtureSubmission();
    const result = await assemble(fixtureContainer(), { submission });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.document.submission.canonicalYaml).toBe(submission.canonicalYaml);
    expect(result.document.submission.schemaVersion).toBe(ROSTER_SUBMISSION_SCHEMA_VERSION);
  });

  it("rejects a container whose people axis diverges from the submission", async () => {
    const subject = container();
    subject.people = [{ id: "P2" }, { id: "P1" }];
    expect(await assemble(subject)).toMatchObject({ ok: false });
  });

  it("rejects a container whose date axis diverges from the submission range", async () => {
    const subject = container();
    (subject.dates as { iso: string }[])[3].iso = "2026-07-07";
    expect(await assemble(subject)).toMatchObject({ ok: false });
  });

  it("rejects a container with a different number of people than were submitted", async () => {
    const subject = container();
    subject.people = [{ id: "P1" }];
    (subject.solvedDays as unknown[]).pop();
    (subject.coordinateMap as { peopleRows: number[] }).peopleRows = [3];
    expect(await assemble(subject)).toMatchObject({ ok: false });
  });

  it("rejects an assignment code no submitted shift type resolves", async () => {
    // The container check alone cannot catch this — it runs before any shift-type
    // set is known — so assembly re-checks the grid against the derived context.
    const subject = container();
    (subject.solvedDays as unknown[][])[0][0] = { kind: "shift", shiftId: "X" };
    const result = await assemble(subject);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("unknown shift type");
  });

  it.each([
    [
      "a wrong submission envelope version",
      { submission: { ...fixtureSubmission(), schemaVersion: "roster-submission/9" } },
    ],
    ["an empty frozen workbook", { frozenXlsx: new Blob([]) }],
    ["a non-Blob frozen workbook", { frozenXlsx: "not-a-blob" }],
    ["an empty appBuild", { appBuild: "" }],
  ])("fails closed on %s", async (_label, overrides) => {
    expect(await assemble(fixtureContainer(), overrides)).toMatchObject({ ok: false });
  });

  it("fails closed when the submission YAML no longer parses", async () => {
    const result = await assemble(fixtureContainer(), {
      submission: { ...fixtureSubmission(), canonicalYaml: "people: {}\n" },
    });
    expect(result).toMatchObject({ ok: false });
  });
});

describe("assembly finishes through the whole-document gate", () => {
  it("returns a document that immediately passes validateRosterDocument", async () => {
    // F1's `commitCandidate` stores documents OPAQUELY, so anything assembly waves
    // through would persist as a candidate that only fails at promotion — by which
    // time the server job may be gone and capture is unrecoverable.
    const document = await fixtureRosterDocument();
    expect(await validateRosterDocument(document)).toMatchObject({ ok: true });
  });

  it("returns a FROZEN document, so a captured candidate cannot drift after the gate", async () => {
    const document = await fixtureRosterDocument();
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.solvedDays)).toBe(true);
    expect(Object.isFrozen(document.solvedDays[0][0])).toBe(true);
    expect(Object.isFrozen(document.context)).toBe(true);
    expect(Object.isFrozen(document.coordinateMap.peopleRows)).toBe(true);
  });

  it("rejects a reverse map whose identifiers are not well-formed P# ids", async () => {
    // Local de-anonymization only needs the container's keys to be LOOKUP-able, so
    // this passed assembly while the whole-document validator rejected it via
    // `validatePeopleReverseMap`. Assembly now shares that gate.
    const document = fixtureCanonicalDocument();
    document.people = { items: [{ id: "Q1", history: ["D"] }, { id: "Q2" }] };
    const result = await assemble(
      { ...fixtureContainer(), people: [{ id: "Q1" }, { id: "Q2" }] },
      {
        submission: fixtureSubmission(document, [
          ["Q1", "Alice Ng"],
          ["Q2", 7],
        ]),
      },
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("reverse map");
  });

  it("rejects a P#-shaped identifier that is not WELL-FORMED", async () => {
    // Sharper than the wrong-prefix case: `P01` looks anonymized and de-anonymizes
    // fine, but a leading zero is not a generated id, so `validatePeopleReverseMap`
    // rejects it. Assembly's own lookup could not tell the difference.
    const document = fixtureCanonicalDocument();
    document.people = { items: [{ id: "P01", history: ["D"] }, { id: "P2" }] };
    const result = await assemble(
      { ...fixtureContainer(), people: [{ id: "P01" }, { id: "P2" }] },
      {
        submission: fixtureSubmission(document, [
          ["P01", "Alice Ng"],
          ["P2", 7],
        ]),
      },
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("reverse map");
  });

  it("still accepts the ordinary anonymized fixture, so the gate is not vacuous", async () => {
    expect(await assemble(fixtureContainer())).toMatchObject({ ok: true });
  });
});
