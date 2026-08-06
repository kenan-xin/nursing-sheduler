// Whole-document fail-closed validation (F3) — the adversarial matrix.
//
// Every case below is a MUTATION of a document that validates, so none of them can
// pass because the input was broken in some unrelated way: the accepting control at
// the top of the file is the same builder every mutation starts from.
//
// The cases are grouped by the invariant they attack, and the interesting ones are
// the cross-field ones — a document can be perfectly well-shaped and still be a
// lie about what was solved.

import { describe, expect, it } from "vitest";
import { computeSolvedBaselineId } from "./baseline";
import { MAX_FROZEN_XLSX_BYTES, validateRosterDocument } from "./validate";
import {
  cloneDocument,
  fixtureCanonicalDocument,
  fixtureContainer,
  fixtureFrozenXlsx,
  fixtureRosterDocument,
  fixtureSubmission,
  mutableDocument,
  withContractedHours,
  withEdits,
  type Mutable,
} from "./test-fixtures";
import type { RosterDocument } from "./types";

/** A JSON-mutable copy of a document — validated documents are frozen. */
function mutable(document: RosterDocument): Mutable<RosterDocument> {
  return mutableDocument(document);
}

/**
 * A field-loose view, for the tamper cases that add, remove, or wrongly type a field.
 * Those are exactly the shapes the typed model forbids, so they need an escape hatch
 * to be constructed at all — which is the point: the validator has to reject values
 * TypeScript would never have let a caller build.
 */
function loose(subject: Mutable<RosterDocument>): Record<string, unknown> {
  return subject as unknown as Record<string, unknown>;
}

/** Re-stamp the baseline hash so a mutation is tested for its OWN reason. */
async function restamp(subject: Mutable<RosterDocument>): Promise<Mutable<RosterDocument>> {
  subject.provenance.solvedBaselineId = await computeSolvedBaselineId({
    people: subject.context.people,
    dates: subject.context.calendar,
    solvedDays: subject.solvedDays,
  });
  return subject;
}

describe("validateRosterDocument — accepting controls", () => {
  it("accepts a freshly assembled document", async () => {
    const result = await validateRosterDocument(await fixtureRosterDocument());
    expect(result).toMatchObject({ ok: true });
  });

  it("accepts a document carrying a normalized overlay", async () => {
    const document = withEdits(await fixtureRosterDocument(), [
      { personIdx: 0, dateIdx: 1, day: { kind: "shift", shiftId: "N" } },
      { personIdx: 1, dateIdx: 3, day: { kind: "leave" } },
    ]);
    expect(await validateRosterDocument(document)).toMatchObject({ ok: true });
  });

  it("survives the structured-clone boundary IndexedDB puts it through", async () => {
    const document = await fixtureRosterDocument();
    const cloned = cloneDocument(document);
    const result = await validateRosterDocument(cloned);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.document.frozenXlsx.size).toBe(document.frozenXlsx.size);
  });

  it("accepts a plain (non-anonymized) submission with an empty reverse map", async () => {
    const plain = fixtureCanonicalDocument();
    plain.people = { items: [{ id: "Alice Ng", history: ["D"] }, { id: 7 }] };
    // A plain submission carries its real ids, so the container's axis does too —
    // including the NUMERIC `7`, which must not arrive as the string `"7"`.
    const document = await fixtureRosterDocument({
      document: plain,
      reverseMap: [],
      container: { ...fixtureContainer(), people: [{ id: "Alice Ng" }, { id: 7 }] },
    });
    expect(document.context.people.map((person) => person.id)).toEqual(["Alice Ng", 7]);
    expect(await validateRosterDocument(document)).toMatchObject({ ok: true });
  });

  it("accepts a submission that fixes a leave credit", async () => {
    const document = await fixtureRosterDocument({
      document: withContractedHours(fixtureCanonicalDocument()),
    });
    expect(document.context.leaveCreditMinutes).toBe(480);
    expect(await validateRosterDocument(document)).toMatchObject({ ok: true });
  });
});

describe("validateRosterDocument — structure and versions", () => {
  it("rejects a non-object, an array, and null", async () => {
    for (const value of [null, undefined, 42, "roster", []]) {
      expect(await validateRosterDocument(value)).toMatchObject({ ok: false });
    }
  });

  it("rejects an unexpected top-level field", async () => {
    const subject = mutable(await fixtureRosterDocument());
    loose(subject).currentDays = [];
    const result = await validateRosterDocument(subject);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("currentDays");
  });

  it("rejects a missing top-level field", async () => {
    const subject = mutable(await fixtureRosterDocument());
    delete loose(subject).coordinateMap;
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });

  it.each(["roster-file/2", "roster-file/0", "roster-container/1", "", 1, null])(
    "rejects document schema version %p",
    async (schemaVersion) => {
      const subject = mutable(await fixtureRosterDocument());
      loose(subject).schemaVersion = schemaVersion;
      expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
    },
  );

  it("rejects an unknown submission envelope version", async () => {
    const subject = mutable(await fixtureRosterDocument());
    (subject.submission as Record<string, unknown>).schemaVersion = "roster-submission/2";
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });

  it("rejects a submission carrying an unexpected field", async () => {
    const subject = mutable(await fixtureRosterDocument());
    (subject.submission as Record<string, unknown>).peopleCount = 2;
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });

  it("rejects an empty or unparseable submission", async () => {
    for (const canonicalYaml of ["", "not: a scenario\n", "{["]) {
      const subject = mutable(await fixtureRosterDocument());
      (subject.submission as Record<string, unknown>).canonicalYaml = canonicalYaml;
      expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
    }
  });

  it("rejects a reverse map that is not a valid people reverse map", async () => {
    const subject = mutable(await fixtureRosterDocument());
    // Well-formed enough to de-anonymize, but not a valid map: a malformed
    // anonymized key must not pass merely because lookup happened to succeed.
    (subject.submission as Record<string, unknown>).reverseMap = [
      ["P1", "Alice Ng"],
      ["P2", 7],
      ["P3", "Ghost"],
    ];
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });
});

describe("validateRosterDocument — context must agree with the submission", () => {
  it("rejects a fabricated baseline minimum", async () => {
    // The most dangerous single tamper: an invented `required` would drive fake
    // "Short" warnings that look exactly like real ones.
    const subject = mutable(await fixtureRosterDocument());
    subject.context.baselineMinimums[0] = { shiftId: "D", required: 99, source: "preferences[1]" };
    const result = await validateRosterDocument(subject);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("derived from submission");
  });

  it("rejects a baseline claimed for a shift the submission leaves unavailable", async () => {
    const subject = mutable(await fixtureRosterDocument());
    subject.context.baselineMinimums[1] = { shiftId: "N", required: 1, source: "preferences[1]" };
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });

  it("rejects an invented leave credit", async () => {
    const subject = mutable(await fixtureRosterDocument());
    subject.context.leaveCreditMinutes = 480;
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });

  it("rejects a renamed or invented person, even with the hash restamped", async () => {
    const subject = mutable(await fixtureRosterDocument());
    subject.context.people[0].id = "Someone Else";
    expect(await validateRosterDocument(await restamp(subject))).toMatchObject({ ok: false });
  });

  it("rejects an added display field on a person", async () => {
    const subject = mutable(await fixtureRosterDocument());
    (subject.context.people[0] as Record<string, unknown>).role = "senior";
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });

  it("rejects a calendar day whose weekend/holiday marks were flipped", async () => {
    for (const field of ["weekend", "holiday"] as const) {
      const subject = mutable(await fixtureRosterDocument());
      const calendar = subject.context.calendar;
      calendar[0][field] = !calendar[0][field];
      expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
    }
  });

  it("rejects an extra or missing date on the calendar axis", async () => {
    const shortened = mutable(await fixtureRosterDocument());
    shortened.context.calendar.pop();
    expect(await validateRosterDocument(shortened)).toMatchObject({ ok: false });

    const lengthened = mutable(await fixtureRosterDocument());
    const calendar = lengthened.context.calendar;
    calendar.push({ ...calendar[3], iso: "2026-07-07" });
    expect(await validateRosterDocument(lengthened)).toMatchObject({ ok: false });
  });

  it("rejects a shift type the submission does not declare", async () => {
    const subject = mutable(await fixtureRosterDocument());
    subject.context.shiftTypes.push({ id: "X" });
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });
});

describe("validateRosterDocument — solvedDays and the baseline hash", () => {
  it("rejects a mutated assignment when the hash still names the original", async () => {
    const subject = mutable(await fixtureRosterDocument());
    subject.solvedDays[0][0] = { kind: "off" };
    const result = await validateRosterDocument(subject);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("solvedBaselineId");
  });

  it("still rejects a mutated assignment whose hash was restamped, via the overlay rule", async () => {
    // Restamping defeats the hash, so the OTHER invariants have to hold the line:
    // here the surviving overlay entry now equals its "solved" value.
    const document = withEdits(await fixtureRosterDocument(), [
      { personIdx: 0, dateIdx: 1, day: { kind: "shift", shiftId: "N" } },
    ]);
    const subject = mutable(document);
    subject.solvedDays[0][1] = { kind: "shift", shiftId: "N" };
    expect(await validateRosterDocument(await restamp(subject))).toMatchObject({ ok: false });
  });

  it.each<[string, (subject: Mutable<RosterDocument>) => void]>([
    ["a ragged row", (s) => void s.solvedDays[0].pop()],
    ["a missing row", (s) => void s.solvedDays.pop()],
    ["an extra row", (s) => void s.solvedDays.push(s.solvedDays[0])],
    ["a null cell", (s) => ((s.solvedDays[1] as unknown[])[2] = null)],
    [
      "a multi-shift cell",
      (s) => ((s.solvedDays[1] as unknown[])[2] = { kind: "shift", shiftId: ["D"] }),
    ],
    ["an unresolvable shift id", (s) => (s.solvedDays[1][2] = { kind: "shift", shiftId: "X" })],
    [
      "a grid that is not an array",
      (s) => ((s as unknown as Record<string, unknown>).solvedDays = { "0": [] }),
    ],
  ])("rejects %s", async (_label, mutate) => {
    const subject = mutable(await fixtureRosterDocument());
    mutate(subject);
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });
});

describe("validateRosterDocument — provenance", () => {
  it.each([
    ["a non-solved status", { solverStatus: "INFEASIBLE" }],
    ["a missing status", { solverStatus: undefined }],
    ["a NaN score", { score: Number.NaN }],
    ["an infinite score", { score: Number.POSITIVE_INFINITY }],
    ["a string score", { score: "-12" }],
    ["a truncated baseline id", { solvedBaselineId: "abc" }],
    ["an upper-case baseline id", { solvedBaselineId: "A".repeat(64) }],
    ["an empty appBuild", { appBuild: "" }],
    ["a non-string appBuild", { appBuild: 3 }],
  ])("rejects %s", async (_label, overrides) => {
    const subject = mutable(await fixtureRosterDocument());
    Object.assign(subject.provenance, overrides);
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });

  it("rejects an unexpected provenance field", async () => {
    const subject = mutable(await fixtureRosterDocument());
    (subject.provenance as Record<string, unknown>).editedSinceSolve = true;
    const result = await validateRosterDocument(subject);
    // `editedSinceSolve` is DERIVED; storing it would create a second, mutable
    // truth that could disagree with the overlay.
    expect(result).toMatchObject({ ok: false });
  });
});

describe("validateRosterDocument — overlay, coordinates, and workbook", () => {
  it("rejects an unsorted, duplicated, or solved-equal overlay", async () => {
    const cases = [
      [
        { personIdx: 1, dateIdx: 3, day: { kind: "leave" } },
        { personIdx: 0, dateIdx: 1, day: { kind: "shift", shiftId: "N" } },
      ],
      [
        { personIdx: 0, dateIdx: 1, day: { kind: "shift", shiftId: "N" } },
        { personIdx: 0, dateIdx: 1, day: { kind: "leave" } },
      ],
      // solvedDays[0][0] is shift D.
      [{ personIdx: 0, dateIdx: 0, day: { kind: "shift", shiftId: "D" } }],
      [{ personIdx: 2, dateIdx: 0, day: { kind: "off" } }],
      [{ personIdx: 0, dateIdx: 9, day: { kind: "off" } }],
      [{ personIdx: 0, dateIdx: 1, day: { kind: "shift", shiftId: "X" } }],
    ];
    for (const edits of cases) {
      const subject = mutable(await fixtureRosterDocument());
      subject.edits = edits as Mutable<RosterDocument>["edits"];
      expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
    }
  });

  it("rejects coordinates that no longer match the axes", async () => {
    const subject = mutable(await fixtureRosterDocument());
    subject.coordinateMap.dateColumns = [3, 4, 5];
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });

  it("rejects coordinates that break the exporter's own column rule", async () => {
    const subject = mutable(await fixtureRosterDocument());
    subject.coordinateMap.leadingCols = 2;
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });

  it.each([
    ["a NON-FIRST people row", (s: Mutable<RosterDocument>) => (s.coordinateMap.peopleRows[1] = 5)],
    [
      "a NON-FIRST date column",
      (s: Mutable<RosterDocument>) => (s.coordinateMap.dateColumns[2] = 7),
    ],
    [
      "a last date column pushed past its formula",
      (s: Mutable<RosterDocument>) => (s.coordinateMap.dateColumns[3] = 9),
    ],
  ])("rejects %s even though length and ordering stay valid", async (_label, mutate) => {
    // The original check only verified the FIRST entry plus monotonicity, so each of
    // these passed — and would have made F5 patch an unrelated worksheet cell for a
    // perfectly valid edit coordinate.
    const subject = mutable(await fixtureRosterDocument());
    mutate(subject);
    expect(subject.coordinateMap.peopleRows).toEqual(
      [...subject.coordinateMap.peopleRows].sort((a, b) => a - b),
    );
    const result = await validateRosterDocument(subject);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("exporter layout");
  });

  it.each([
    ["a non-Blob workbook", "AAAA"],
    ["an empty workbook", new Blob([])],
  ])("rejects %s", async (_label, frozenXlsx) => {
    const subject = mutable(await fixtureRosterDocument());
    loose(subject).frozenXlsx = frozenXlsx;
    expect(await validateRosterDocument(subject)).toMatchObject({ ok: false });
  });

  it("accepts a workbook at the size cap and rejects one byte more", async () => {
    // The cap is checked from `Blob.size`, so a stub blob proves the boundary
    // without allocating 32 MiB of test data.
    const stub = (size: number) =>
      Object.defineProperty(new Blob([new Uint8Array(1)]), "size", { value: size }) as Blob;
    const atCap = mutable(await fixtureRosterDocument());
    atCap.frozenXlsx = stub(MAX_FROZEN_XLSX_BYTES);
    expect(await validateRosterDocument(atCap)).toMatchObject({ ok: true });

    const overCap = mutable(await fixtureRosterDocument());
    overCap.frozenXlsx = stub(MAX_FROZEN_XLSX_BYTES + 1);
    expect(await validateRosterDocument(overCap)).toMatchObject({ ok: false });
  });

  it("returns a frozen validated document, not the caller's object", async () => {
    const document = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(8) });
    const result = await validateRosterDocument({ ...document, submission: fixtureSubmission() });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // The returned value is what F1 stores, so it must be the normalized document.
    expect(result.document.schemaVersion).toBe("roster-file/1");
    expect(result.document.frozenXlsx.size).toBe(8);
  });
});
