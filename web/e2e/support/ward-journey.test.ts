// G5 — the pure half of the assembled real-Ward-8 roster journey.
//
// Everything here exists to stop the browser journey passing for the wrong reason.
// Three classes of silent drift are closed:
//
//   * an assertion about the scenario that the scenario file no longer supports,
//   * a storage probe pointed at a key production stopped using (which reads as
//     "clean" rather than as "not measured"),
//   * a phase added to the journey with no bound, running under Playwright's 30s
//     default instead of the advertised ceiling.

import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SCENARIO_DB_NAME, ScenarioPersistenceDb } from "@/lib/store/dexie-storage";
import { SCENARIO_PERSIST_KEY } from "@/lib/store/persistence";
import {
  candidateRosterKey,
  createRosterStorageForDb,
  submissionSnapshotKey,
  WORKING_ROSTER_KEY,
} from "@/lib/store/roster-storage";
import {
  OPTIMIZE_RETIRE_PENDING_STORAGE_KEY,
  OPTIMIZE_SESSION_KEY_PREFIX,
  OPTIMIZE_SESSION_STORAGE_KEY,
  optimizeSessionKeyFor,
} from "@/lib/optimize/session-transaction";
import { ROSTER_VIEW_PREFERENCE_KEY } from "@/lib/roster-viewer/view-preference";
import {
  deriveWardFacts,
  EDITED_PROVENANCE_SHEET,
  isLoadableSolverStatus,
  judgeResidue,
  judgeReplacement,
  judgeResiduePresent,
  judgeVisitAbandoned,
  resumingCallsFor,
  judgeWardDocument,
  judgeWardWorkbook,
  readWardDocumentFacts,
  readWardDocumentMatrices,
  readWardWorkbook,
  readWardYaml,
  STORAGE_KEYS,
  wardDocumentDigest,
  WARD_BOUND_KEYS,
  WARD_BOUNDS,
  WARD_EXPECTED,
  WARD_EXPECTED_CALENDAR,
  WARD_EXPECTED_CELL_COUNT,
  WARD_EXPECTED_COORDINATE_MAP,
  WARD_EXPECTED_WEEKDAYS,
  WARD_WORKBOOK_ROWS,
  WARD_SOLVER_TIMEOUT_SECONDS,
  WARD_TEST_TIMEOUT,
  WARD_YAML_FILENAME,
  WARD_YAML_PATH,
  type RosterResidueProbe,
  type WardWorkbookFacts,
} from "./ward-journey";

describe("the authoritative Ward 8 scenario", () => {
  it("is the exact file the ticket names, and the upload filename matches it", () => {
    expect(WARD_YAML_PATH).toMatch(
      /core\/tests\/testcases\/real\/ward-8-shift-patterns-senior-on-every-shift\.yaml$/,
    );
    expect(WARD_YAML_PATH.endsWith(`/${WARD_YAML_FILENAME}`)).toBe(true);
    // The picker only accepts `.yaml`/`.yml`; an extension change here would make
    // the import silently `alert()` instead of loading.
    expect(WARD_YAML_FILENAME).toMatch(/\.ya?ml$/);
  });

  it("states exactly the facts the journey asserts on screen", () => {
    const facts = deriveWardFacts(parse(readWardYaml()));
    expect(facts.startDate).toBe(WARD_EXPECTED.startDate);
    expect(facts.endDate).toBe(WARD_EXPECTED.endDate);
    expect(facts.peopleCount).toBe(WARD_EXPECTED.peopleCount);
    expect(facts.shiftTypeIds).toEqual([...WARD_EXPECTED.shiftTypeIds]);
  });

  it("names exactly the 32 authored people, in definition order", () => {
    // The identity half of the qualification. If the file's roll changes, the
    // journey must stop claiming to have seen these nurses come back.
    expect(deriveWardFacts(parse(readWardYaml())).peopleIds).toEqual([...WARD_EXPECTED.peopleIds]);
    expect(new Set(WARD_EXPECTED.peopleIds).size).toBe(WARD_EXPECTED.peopleCount);
  });

  it("spans exactly the declared number of days, inclusive", () => {
    const start = Date.parse(`${WARD_EXPECTED.startDate}T00:00:00Z`);
    const end = Date.parse(`${WARD_EXPECTED.endDate}T00:00:00Z`);
    expect((end - start) / 86_400_000 + 1).toBe(WARD_EXPECTED.dayCount);
    expect(WARD_EXPECTED_CELL_COUNT).toBe(32 * 28);
  });

  it("declares each of the eight patterns twice — open and senior-only", () => {
    const ids = [...WARD_EXPECTED.shiftTypeIds];
    const open = ids.filter((id) => !id.endsWith("+"));
    const senior = ids.filter((id) => id.endsWith("+"));
    expect(open).toHaveLength(8);
    expect(senior.map((id) => id.slice(0, -1)).sort()).toEqual([...open].sort());
  });

  it("keeps the configured solver timeout inside the product's own bounds", () => {
    // The form accepts 1..3600; the journey types a value well inside that, and the
    // completion bound has to be able to outlast it or the ceiling is a fiction.
    expect(WARD_SOLVER_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(WARD_BOUNDS.completionPoll).toBeGreaterThan(WARD_SOLVER_TIMEOUT_SECONDS * 1000);
    expect(WARD_BOUNDS.secondCompletionPoll).toBeGreaterThan(WARD_SOLVER_TIMEOUT_SECONDS * 1000);
  });
});

describe("the storage keys the residue probe reads", () => {
  it("mirrors every production constant it stands in for", () => {
    expect(STORAGE_KEYS.databaseName).toBe(SCENARIO_DB_NAME);
    expect(STORAGE_KEYS.workingRosterKey).toBe(WORKING_ROSTER_KEY);
    expect(candidateRosterKey("job-x")).toBe(`${STORAGE_KEYS.candidateKeyPrefix}job-x`);
    expect(submissionSnapshotKey("owner-x")).toBe(`${STORAGE_KEYS.snapshotKeyPrefix}owner-x`);
    expect(STORAGE_KEYS.scenarioPersistKey).toBe(SCENARIO_PERSIST_KEY);
    expect(STORAGE_KEYS.optimizeSessionKey).toBe(OPTIMIZE_SESSION_STORAGE_KEY);
    // The owner-keyed prefix is the seam a residue probe now depends on. Pinned to
    // the production constant AND to a real key the production helper builds, so a
    // rename cannot leave the probe enumerating a namespace nothing writes.
    expect(STORAGE_KEYS.optimizeSessionKeyPrefix).toBe(OPTIMIZE_SESSION_KEY_PREFIX);
    expect(optimizeSessionKeyFor("owner-x")).toBe(
      `${STORAGE_KEYS.optimizeSessionKeyPrefix}owner-x`,
    );
    expect(STORAGE_KEYS.optimizeRetirePendingKey).toBe(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY);
    expect(STORAGE_KEYS.rosterViewPreferenceKey).toBe(ROSTER_VIEW_PREFERENCE_KEY);
  });

  it("names the object stores and the pointer row production actually writes", async () => {
    // BEHAVIOURAL, not a constant compare: the current-candidate meta key is
    // module-private, so the only honest pin is to drive the real commit and read
    // the row back the way the browser probe will.
    const db = new ScenarioPersistenceDb("ward-journey-key-pin");
    const storage = createRosterStorageForDb(() => db);
    const committed = await storage.commitCandidate({
      jobId: "job-pin",
      submissionOrdinal: 1,
      document: { tag: "pin" },
      expectedClearEpoch: await storage.getClearEpoch(),
    });
    expect(committed.status).toBe("committed");

    const storeNames = db.tables.map((table) => table.name).sort();
    // INTEGRATION — CONTAINMENT, not equality. This used to assert the database held
    // exactly these four stores, which was true while the roster foundation owned its
    // own Dexie class. `ScenarioPersistenceDb` is now an ALIAS of `NurseSchedulerDb`:
    // the two version ladders were merged into a single owner, so the repository's
    // tables are deliberately co-resident with the roster's. An equality pin would
    // therefore fail for the reason the merge succeeded, and would fail again on every
    // future additive schema version.
    //
    // What the probe actually needs from this test is that the four stores it reads are
    // present under these exact names, so that is what is asserted — and the co-residency
    // is asserted POSITIVELY beside it, so the single-owner decision is a stated fact
    // here rather than the silent reason an equality assertion had to be loosened.
    for (const store of ["keyval", "meta", "roster", "snapshot"]) {
      expect(storeNames, store).toContain(store);
    }
    for (const store of ["scenarioEnvelopes", "scenarioCommits", "writerLeases"]) {
      expect(storeNames, store).toContain(store);
    }

    const pointerRow = await db.meta.get(STORAGE_KEYS.currentCandidateMetaKey);
    expect(pointerRow?.value).toMatchObject({ jobId: "job-pin" });
    expect(await db.roster.get(candidateRosterKey("job-pin"))).toBeDefined();
    // The commit filled the proven-empty working slot, under the same key the
    // probe reads.
    expect(await db.roster.get(STORAGE_KEYS.workingRosterKey)).toBeDefined();
    db.close();
  });
});

describe("WARD_BOUNDS", () => {
  it("enumerates every phase of the journey", () => {
    expect([...WARD_BOUND_KEYS].sort()).toEqual(
      [
        "acceptedIdPoll",
        "candidateOffer",
        "completionPoll",
        "editAndSave",
        "exportDownloads",
        "freshStartAssertions",
        "importFile",
        "lensAssertions",
        "newScheduleReset",
        "optimizeReady",
        "reloadDurability",
        "replaceCancelled",
        "replaceConfirmed",
        "rosterLoaded",
        "rosterNavigation",
        "saveAndLoadReady",
        "scenarioFacts",
        "schedulerAllowance",
        "inFlightHandoff",
        "secondAcceptedIdPoll",
        "secondCompletionPoll",
        "secondSubmitClick",
        "slotFreedAssertion",
        "storageProbes",
        "submitClick",
        "thirdAcceptedIdPoll",
        "thirdSubmitClick",
        "undoRestore",
      ].sort(),
    );
  });

  it("derives the test ceiling from the sum, with nothing left implicit", () => {
    const sum = WARD_BOUND_KEYS.reduce((total, key) => total + WARD_BOUNDS[key], 0);
    expect(WARD_TEST_TIMEOUT).toBe(sum);
    // The whole point of the derivation: the ceiling must exceed Playwright's
    // default, which is what governed the schedule before it existed.
    expect(WARD_TEST_TIMEOUT).toBeGreaterThan(30_000);
  });

  it("gives every phase a positive bound", () => {
    for (const key of WARD_BOUND_KEYS) {
      expect(WARD_BOUNDS[key], key).toBeGreaterThan(0);
    }
  });
});

const EMPTY_PROBE: RosterResidueProbe = {
  databasePresent: true,
  working: null,
  candidatePointer: null,
  candidateRowKeys: [],
  snapshotRowKeys: [],
  scenarioRecordPresent: true,
  optimizeSessionKeys: [],
  retireMarkerPresent: false,
  viewMetadataPresent: false,
};

const SOME_WORKING = {
  revision: 3,
  candidateSource: null,
  editCount: 1,
  documentJson: '{"tag":"x"}',
  workbookBase64: "AAAA",
};

const FULL_PROBE: RosterResidueProbe = {
  databasePresent: true,
  working: SOME_WORKING,
  candidatePointer: { jobId: "job-b", candidateVersion: 2 },
  candidateRowKeys: ["candidate:job-b"],
  snapshotRowKeys: ["snapshot:owner-1"],
  scenarioRecordPresent: true,
  optimizeSessionKeys: ["nurse.optimize.session.owner-1"],
  retireMarkerPresent: true,
  viewMetadataPresent: true,
};

describe("judgeResidue", () => {
  it("passes only when every surface the reset promises to remove is gone", () => {
    expect(judgeResidue(EMPTY_PROBE)).toEqual({ ok: true, remaining: [] });
  });

  it("does not count the replaced scenario record as residue", () => {
    // The reset REPLACES the record with an empty default rather than deleting it;
    // demanding its absence would assert a contract the product does not make.
    expect(judgeResidue({ ...EMPTY_PROBE, scenarioRecordPresent: true }).ok).toBe(true);
    expect(judgeResidue({ ...EMPTY_PROBE, scenarioRecordPresent: false }).ok).toBe(true);
  });

  it.each([
    ["working", { working: FULL_PROBE.working }, "the working roster"],
    ["pointer", { candidatePointer: FULL_PROBE.candidatePointer }, "the latest-result pointer"],
    ["candidate row", { candidateRowKeys: ["candidate:job-b"] }, "1 saved result row(s)"],
    ["snapshot row", { snapshotRowKeys: ["snapshot:o"] }, "1 submission snapshot row(s)"],
    [
      "session record",
      { optimizeSessionKeys: ["nurse.optimize.session.owner-1"] },
      "1 optimisation session record(s)",
    ],
    ["retire marker", { retireMarkerPresent: true }, "the retirement marker"],
    ["view metadata", { viewMetadataPresent: true }, "the roster view metadata"],
  ])("fails and NAMES a surviving %s", (_label, override, expected) => {
    const verdict = judgeResidue({ ...EMPTY_PROBE, ...override });
    expect(verdict.ok).toBe(false);
    expect(verdict.remaining).toContain(expected);
  });
});

describe("judgeResiduePresent", () => {
  it("accepts an origin that genuinely holds the committed data the reset will remove", () => {
    expect(judgeResiduePresent(FULL_PROBE)).toEqual({ ok: true, remaining: [] });
  });

  it("refuses an empty origin, so the later absence proof cannot be vacuous", () => {
    const verdict = judgeResiduePresent(EMPTY_PROBE);
    expect(verdict.ok).toBe(false);
    expect(verdict.remaining).toEqual([
      "the working roster",
      "the latest-result pointer",
      "a saved result row",
      "the roster view metadata",
    ]);
  });

  it.each([
    ["the optimisation session record", { optimizeSessionKeys: [] }],
    ["a submission snapshot row", { snapshotRowKeys: [] }],
  ])("no longer requires %s in the pre-state", (_name, override) => {
    // G6.2 INVERTED THIS. It used to REFUSE a pre-state missing either, which is
    // what forced the journey to leave a run in flight so both would survive. That
    // survival is the defect the ticket removed: leaving now abandons the run and
    // the retirement lane takes both with it. Requiring them here would demand a
    // state the product no longer produces. `judgeVisitAbandoned` proves the
    // abandonment removes them, which names the cause rather than the absence.
    expect(judgeResiduePresent({ ...FULL_PROBE, ...override })).toEqual({
      ok: true,
      remaining: [],
    });
  });

  it("does not require the retirement marker it cannot honestly establish", () => {
    expect(judgeResiduePresent({ ...FULL_PROBE, retireMarkerPresent: false }).ok).toBe(true);
    // ...but the post-reset judgement still refuses to let one survive.
    expect(judgeResidue({ ...EMPTY_PROBE, retireMarkerPresent: true }).ok).toBe(false);
  });
});

describe("judgeVisitAbandoned", () => {
  it("accepts an origin holding nothing that existed only to serve the abandoned run", () => {
    expect(judgeVisitAbandoned(EMPTY_PROBE)).toEqual({ ok: true, remaining: [] });
  });

  it.each([
    [
      "a surviving session record",
      { optimizeSessionKeys: ["nurse.optimize.session.owner-1"] },
      "1 optimisation session record(s)",
    ],
    [
      "a surviving snapshot row",
      { snapshotRowKeys: ["snapshot:owner-1"] },
      "1 submission snapshot row(s)",
    ],
    ["a surviving retirement marker", { retireMarkerPresent: true }, "the retirement marker"],
  ])("fails and NAMES %s", (_label, override, expected) => {
    const verdict = judgeVisitAbandoned({ ...EMPTY_PROBE, ...override });
    expect(verdict.ok).toBe(false);
    expect(verdict.remaining).toContain(expected);
  });

  it("does NOT treat committed product data as something abandonment should remove", () => {
    // The boundary that matters. A run that got far enough to commit a candidate
    // produced something the user owns; walking away from the route is not a
    // decision to destroy it. Only New schedule and verified Clear do that.
    const verdict = judgeVisitAbandoned({
      ...EMPTY_PROBE,
      working: SOME_WORKING,
      candidatePointer: { jobId: "job-b", candidateVersion: 2 },
      candidateRowKeys: ["candidate:job-b"],
      viewMetadataPresent: true,
    });
    expect(verdict).toEqual({ ok: true, remaining: [] });
  });
});

// ---------------------------------------------------------------------------
// Date axis and worksheet geometry
// ---------------------------------------------------------------------------

describe("WARD_EXPECTED_CALENDAR", () => {
  it("is the exact inclusive October 2026 span the scenario declares", () => {
    expect(WARD_EXPECTED_CALENDAR).toHaveLength(WARD_EXPECTED.dayCount);
    expect(WARD_EXPECTED_CALENDAR[0]).toBe(WARD_EXPECTED.startDate);
    expect(WARD_EXPECTED_CALENDAR[WARD_EXPECTED_CALENDAR.length - 1]).toBe(WARD_EXPECTED.endDate);
    expect(new Set(WARD_EXPECTED_CALENDAR).size).toBe(WARD_EXPECTED.dayCount);
    expect(WARD_EXPECTED_CALENDAR.every((iso) => iso.startsWith("2026-10-"))).toBe(true);
    // Strictly ascending, one day apart — no gap and no repeat could hide here.
    for (let i = 1; i < WARD_EXPECTED_CALENDAR.length; i += 1) {
      const gap =
        Date.parse(`${WARD_EXPECTED_CALENDAR[i]}T00:00:00Z`) -
        Date.parse(`${WARD_EXPECTED_CALENDAR[i - 1]}T00:00:00Z`);
      expect(gap).toBe(86_400_000);
    }
  });

  it("carries the real weekdays of that span", () => {
    // 2026-10-01 is a Thursday; 28 days later the axis ends on a Wednesday.
    expect(WARD_EXPECTED_WEEKDAYS[0]).toBe("Thu");
    expect(WARD_EXPECTED_WEEKDAYS[WARD_EXPECTED_WEEKDAYS.length - 1]).toBe("Wed");
    expect(WARD_EXPECTED_WEEKDAYS).toHaveLength(WARD_EXPECTED.dayCount);
  });
});

describe("WARD_EXPECTED_COORDINATE_MAP", () => {
  it("describes one label column, five history columns and 28 contiguous date columns", () => {
    const map = WARD_EXPECTED_COORDINATE_MAP;
    expect(map.peopleRows).toHaveLength(WARD_EXPECTED.peopleCount);
    expect(map.dateColumns).toHaveLength(WARD_EXPECTED.dayCount);
    expect(map.peopleRows[0]).toBe(map.firstPeopleRow);
    // The first date column sits immediately after the label + history columns.
    expect(map.dateColumns[0]).toBe(map.leadingCols + map.historyCols + 1);
    expect(map.peopleRows.every((row, i) => row === map.firstPeopleRow + i)).toBe(true);
    expect(map.dateColumns.every((col, i) => col === map.dateColumns[0] + i)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The document digest
// ---------------------------------------------------------------------------

const DIGEST_INPUT = { documentJson: '{"a":1,"b":"two"}', workbookBase64: "UEsDBAoAAAA=" };

describe("wardDocumentDigest", () => {
  it("is stable for identical content", () => {
    expect(wardDocumentDigest(DIGEST_INPUT)).toBe(wardDocumentDigest({ ...DIGEST_INPUT }));
    expect(wardDocumentDigest(DIGEST_INPUT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("moves for a one-character document change", () => {
    expect(wardDocumentDigest({ ...DIGEST_INPUT, documentJson: '{"a":2,"b":"two"}' })).not.toBe(
      wardDocumentDigest(DIGEST_INPUT),
    );
  });

  it("moves for a one-character workbook change", () => {
    expect(wardDocumentDigest({ ...DIGEST_INPUT, workbookBase64: "UEsDBAoAAAB=" })).not.toBe(
      wardDocumentDigest(DIGEST_INPUT),
    );
  });

  it("does NOT move for a revision-only bump — the whole point of the split", () => {
    // The finding this closes: confirmed replacement is independently required to
    // increment `revision`, so a digest that folded it in could not fail even when
    // the document bytes were identical.
    const before = { ...SOME_WORKING, revision: 3 };
    const after = { ...SOME_WORKING, revision: 9 };
    expect(wardDocumentDigest(after)).toBe(wardDocumentDigest(before));
  });

  it("cannot be fooled by moving bytes across the field boundary", () => {
    // Length-prefixed, so `ab|c` and `a|bc` are different inputs.
    expect(wardDocumentDigest({ documentJson: "ab", workbookBase64: "c" })).not.toBe(
      wardDocumentDigest({ documentJson: "a", workbookBase64: "bc" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Ward identity over a roster document
// ---------------------------------------------------------------------------

function wardDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    context: {
      calendar: WARD_EXPECTED_CALENDAR.map((iso) => ({ iso })),
      people: WARD_EXPECTED.peopleIds.map((id) => ({ id })),
      shiftTypes: WARD_EXPECTED.shiftTypeIds.map((id) => ({ id })),
    },
    provenance: {
      solverStatus: "OPTIMAL",
      score: 724,
      solvedBaselineId: "a".repeat(64),
      appBuild: "v0.1.1-149",
    },
    edits: [],
    coordinateMap: {
      firstPeopleRow: WARD_EXPECTED_COORDINATE_MAP.firstPeopleRow,
      leadingCols: WARD_EXPECTED_COORDINATE_MAP.leadingCols,
      historyCols: WARD_EXPECTED_COORDINATE_MAP.historyCols,
      prettify: WARD_EXPECTED_COORDINATE_MAP.prettify,
      peopleRows: [...WARD_EXPECTED_COORDINATE_MAP.peopleRows],
      dateColumns: [...WARD_EXPECTED_COORDINATE_MAP.dateColumns],
    },
    ...overrides,
  };
}

function judgeDoc(overrides: Record<string, unknown> = {}) {
  return judgeWardDocument(readWardDocumentFacts(wardDocument(overrides)));
}

describe("judgeWardDocument", () => {
  it("accepts the real Ward 8 shape", () => {
    expect(judgeDoc()).toEqual({ ok: true, problems: [] });
  });

  it("rejects a same-shape 32 x 28 roster whose FIRST date differs", () => {
    const calendar = WARD_EXPECTED_CALENDAR.map((iso) => ({ iso }));
    calendar[0] = { iso: "2026-09-30" };
    const verdict = judgeDoc({
      context: {
        calendar,
        people: WARD_EXPECTED.peopleIds.map((id) => ({ id })),
        shiftTypes: WARD_EXPECTED.shiftTypeIds.map((id) => ({ id })),
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("calendar is not");
  });

  it("rejects a same-shape roster whose LAST date differs", () => {
    const calendar = WARD_EXPECTED_CALENDAR.map((iso) => ({ iso }));
    calendar[calendar.length - 1] = { iso: "2026-10-29" };
    expect(
      judgeDoc({
        context: {
          calendar,
          people: WARD_EXPECTED.peopleIds.map((id) => ({ id })),
          shiftTypes: WARD_EXPECTED.shiftTypeIds.map((id) => ({ id })),
        },
      }).ok,
    ).toBe(false);
  });

  it("rejects a roster with 32 people where ONE identity is wrong", () => {
    const people = WARD_EXPECTED.peopleIds.map((id): { id: string } => ({ id }));
    people[17] = { id: "SN-Impostor" };
    const verdict = judgeDoc({
      context: {
        calendar: WARD_EXPECTED_CALENDAR.map((iso) => ({ iso })),
        people,
        shiftTypes: WARD_EXPECTED.shiftTypeIds.map((id) => ({ id })),
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("32 authored Ward 8 identities");
  });

  it("rejects the RIGHT people in the WRONG order", () => {
    const people = WARD_EXPECTED.peopleIds.map((id) => ({ id }));
    [people[0], people[1]] = [people[1], people[0]];
    expect(
      judgeDoc({
        context: {
          calendar: WARD_EXPECTED_CALENDAR.map((iso) => ({ iso })),
          people,
          shiftTypes: WARD_EXPECTED.shiftTypeIds.map((id) => ({ id })),
        },
      }).ok,
    ).toBe(false);
  });

  it.each([
    [
      "an infeasible solve",
      { solverStatus: "INFEASIBLE", score: 1, solvedBaselineId: "a".repeat(64), appBuild: "v" },
    ],
    [
      "a missing score",
      { solverStatus: "OPTIMAL", score: null, solvedBaselineId: "a".repeat(64), appBuild: "v" },
    ],
    [
      "a short baseline id",
      { solverStatus: "OPTIMAL", score: 1, solvedBaselineId: "abc", appBuild: "v" },
    ],
    [
      "a missing app build",
      { solverStatus: "OPTIMAL", score: 1, solvedBaselineId: "a".repeat(64), appBuild: "" },
    ],
  ])("rejects %s", (_label, provenance) => {
    expect(judgeDoc({ provenance }).ok).toBe(false);
  });

  it("rejects a document whose worksheet geometry drifted", () => {
    expect(
      judgeDoc({
        coordinateMap: {
          ...(wardDocument().coordinateMap as Record<string, unknown>),
          historyCols: 4,
        },
      }).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Workbooks
// ---------------------------------------------------------------------------

/** CRC-32 (IEEE), so the hand-built archive below is a genuinely valid ZIP. */
function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/**
 * A REAL, valid, stored-entry ZIP holding one text file.
 *
 * This is the control the review asked for. A truncated workbook would also defeat
 * a magic-byte check, but it is a broken archive; this one is a perfectly good
 * archive that simply is not a spreadsheet — exactly the case a four-byte sniff
 * cannot tell apart from a workbook.
 */
function buildValidZip(name: string, content: string): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const data = Buffer.from(content, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

/** A real workbook that exists in this repo — and is emphatically not Ward 8. */
const FOREIGN_WORKBOOK = resolve(
  __dirname,
  "../../lib/optimize/__fixtures__/c5/c5-plain-3people.xlsx",
);

describe("readWardWorkbook", () => {
  it("parses a genuine workbook rather than sniffing its first four bytes", async () => {
    const result = await readWardWorkbook(readFileSync(FOREIGN_WORKBOOK));
    expect(result.ok).toBe(true);
  });

  it("REJECTS a valid ZIP that is not a workbook", async () => {
    const zip = buildValidZip("hello.txt", "not a spreadsheet");
    // It really is ZIP-shaped: the old check would have waved this through.
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
    const result = await readWardWorkbook(zip);
    expect(result.ok).toBe(false);
  });

  it("REJECTS a truncated workbook whose ZIP magic survives", async () => {
    const truncated = readFileSync(FOREIGN_WORKBOOK).subarray(0, 512);
    expect(truncated.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect((await readWardWorkbook(truncated)).ok).toBe(false);
  });

  it("REJECTS bytes that are not an archive at all, without throwing", async () => {
    const result = await readWardWorkbook(Buffer.from('{"not":"a workbook"}', "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a readable workbook|no worksheet/);
  });
});

function workbookFacts(overrides: Partial<WardWorkbookFacts> = {}): WardWorkbookFacts {
  return {
    sheetNames: ["Sheet1"],
    personLabels: [...WARD_EXPECTED.peopleIds],
    dayNumbers: WARD_EXPECTED_CALENDAR.map((iso) => String(Number(iso.slice(8, 10)))),
    weekdays: [...WARD_EXPECTED_WEEKDAYS],
    scoreLabel: "Score",
    score: 724,
    statusLabel: "Status",
    solverStatus: "OPTIMAL",
    assignments: WARD_EXPECTED.peopleIds.map(() => WARD_EXPECTED_CALENDAR.map(() => "")),
    ...overrides,
  };
}

describe("judgeWardWorkbook", () => {
  it("accepts a Ward 8 schedule sheet", () => {
    expect(judgeWardWorkbook(workbookFacts())).toEqual({ ok: true, problems: [] });
  });

  it("rejects a real but FOREIGN workbook", async () => {
    const parsed = await readWardWorkbook(readFileSync(FOREIGN_WORKBOOK));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const verdict = judgeWardWorkbook(parsed.facts);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.length).toBeGreaterThan(0);
  });

  it.each([
    ["wrong people", { personLabels: ["someone else"] }],
    ["wrong day numbers", { dayNumbers: ["1"] }],
    ["wrong weekdays", { weekdays: WARD_EXPECTED_WEEKDAYS.map(() => "Mon") }],
    ["a missing Score row", { scoreLabel: "" }],
    ["a non-numeric score", { score: Number.NaN }],
    ["a missing Status row", { statusLabel: "" }],
    ["an infeasible status", { solverStatus: "INFEASIBLE" }],
  ])("rejects %s", (_label, override) => {
    expect(judgeWardWorkbook(workbookFacts(override as Partial<WardWorkbookFacts>)).ok).toBe(false);
  });

  it("rejects assignment cells holding a shift this ward does not have", () => {
    const assignments = workbookFacts().assignments;
    assignments[4][9] = "twilight";
    const verdict = judgeWardWorkbook(workbookFacts({ assignments }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("twilight");
  });

  it("accepts this ward's own shift ids and Leave in assignment cells", () => {
    const assignments = workbookFacts().assignments;
    assignments[0][0] = "am1+";
    assignments[1][1] = "Leave";
    assignments[2][2] = "night";
    expect(judgeWardWorkbook(workbookFacts({ assignments })).ok).toBe(true);
  });

  it("requires the dedicated provenance sheet only when the caller asks for it", () => {
    expect(judgeWardWorkbook(workbookFacts(), { requireProvenanceSheet: true }).ok).toBe(false);
    expect(
      judgeWardWorkbook(workbookFacts({ sheetNames: ["Sheet1", EDITED_PROVENANCE_SHEET] }), {
        requireProvenanceSheet: true,
      }).ok,
    ).toBe(true);
  });

  it("pins one exact coordinate when asked — and fails on the wrong text", () => {
    const assignments = workbookFacts().assignments;
    assignments[0][0] = "pm2";
    const facts = workbookFacts({ assignments });
    expect(
      judgeWardWorkbook(facts, { expectCell: { personIdx: 0, dateIdx: 0, text: "pm2" } }).ok,
    ).toBe(true);
    const wrong = judgeWardWorkbook(facts, {
      expectCell: { personIdx: 0, dateIdx: 0, text: "" },
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.problems.join(" ")).toContain("[0][0]");
  });
});

// ---------------------------------------------------------------------------
// The real parser path
// ---------------------------------------------------------------------------

const BLANK_MATRIX = (): string[][] =>
  WARD_EXPECTED.peopleIds.map(() => WARD_EXPECTED_CALENDAR.map(() => ""));

/**
 * Write a real XLSX with this ward's exact geometry.
 *
 * The controls below have to run through ExcelJS and `readWardWorkbook`, not just
 * hand-written facts — a blank Score cell was being coerced to `0` inside the
 * parser, so a synthetic `NaN` fact could never have caught it.
 */
async function buildWardWorkbookBytes(
  options: {
    score?: number | string | null;
    status?: string;
    assignments?: string[][];
    extraSheet?: string;
  } = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  const map = WARD_EXPECTED_COORDINATE_MAP;
  const rows = WARD_WORKBOOK_ROWS;

  WARD_EXPECTED_CALENDAR.forEach((iso, index) => {
    sheet.getCell(rows.dayNumberRow, map.dateColumns[index]).value = Number(iso.slice(8, 10));
    sheet.getCell(rows.weekdayRow, map.dateColumns[index]).value = WARD_EXPECTED_WEEKDAYS[index];
  });

  const assignments = options.assignments ?? BLANK_MATRIX();
  WARD_EXPECTED.peopleIds.forEach((id, person) => {
    sheet.getCell(map.peopleRows[person], map.leadingCols).value = id;
    WARD_EXPECTED_CALENDAR.forEach((_iso, date) => {
      const text = assignments[person][date];
      // A rest day is an ABSENT cell in the real workbook, not an empty string.
      if (text !== "") sheet.getCell(map.peopleRows[person], map.dateColumns[date]).value = text;
    });
  });

  sheet.getCell(rows.scoreRow, map.leadingCols).value = "Score";
  const score = options.score === undefined ? 724 : options.score;
  if (score !== null) sheet.getCell(rows.scoreRow, map.dateColumns[0]).value = score;
  sheet.getCell(rows.statusRow, map.leadingCols).value = "Status";
  sheet.getCell(rows.statusRow, map.dateColumns[0]).value = options.status ?? "OPTIMAL";

  if (options.extraSheet !== undefined) workbook.addWorksheet(options.extraSheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("readWardWorkbook + judgeWardWorkbook over a real written workbook", () => {
  it("accepts a Ward 8 workbook and agrees with its matrix", async () => {
    const assignments = BLANK_MATRIX();
    assignments[0][0] = "am1+";
    assignments[3][17] = "Leave";
    const parsed = await readWardWorkbook(await buildWardWorkbookBytes({ assignments }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.facts.score).toBe(724);
    expect(judgeWardWorkbook(parsed.facts, { matrix: assignments })).toEqual({
      ok: true,
      problems: [],
    });
  });

  it("parses a BLANK Score cell as null and rejects it — the coercion bug", async () => {
    const parsed = await readWardWorkbook(await buildWardWorkbookBytes({ score: null }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // `Number("")` is 0. A workbook with no score at all must not report one.
    expect(parsed.facts.score).toBeNull();
    const verdict = judgeWardWorkbook(parsed.facts);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("no finite score");
  });

  it("parses a non-numeric Score cell as null rather than NaN", async () => {
    const parsed = await readWardWorkbook(await buildWardWorkbookBytes({ score: "n/a" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.facts.score).toBeNull();
  });

  it("REJECTS a one-cell, in-vocabulary disagreement with the document", async () => {
    // The exact gap content parity closes: same axes, same allowed values, one
    // cell holding a different but perfectly valid ward shift.
    const document = BLANK_MATRIX();
    document[6][11] = "pm2";
    const workbookAssignments = BLANK_MATRIX();
    workbookAssignments[6][11] = "pm3";

    const parsed = await readWardWorkbook(
      await buildWardWorkbookBytes({ assignments: workbookAssignments }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Vocabulary alone still passes — which is why it was not enough.
    expect(judgeWardWorkbook(parsed.facts).ok).toBe(true);
    const verdict = judgeWardWorkbook(parsed.facts, { matrix: document });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("[6][11]");
    expect(verdict.problems.join(" ")).toContain("disagree with the roster document");
  });

  it("REJECTS an all-blank workbook against a solved document", async () => {
    const document = BLANK_MATRIX();
    document[0][0] = "night";
    const parsed = await readWardWorkbook(await buildWardWorkbookBytes());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(judgeWardWorkbook(parsed.facts, { matrix: document }).ok).toBe(false);
  });

  it("finds the dedicated provenance sheet when the export carries one", async () => {
    const parsed = await readWardWorkbook(
      await buildWardWorkbookBytes({ extraSheet: EDITED_PROVENANCE_SHEET }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(judgeWardWorkbook(parsed.facts, { requireProvenanceSheet: true }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Document matrices
// ---------------------------------------------------------------------------

describe("readWardDocumentMatrices", () => {
  const document = {
    solvedDays: [
      [{ kind: "shift", shiftId: "am1" }, { kind: "off" }],
      [{ kind: "leave" }, { kind: "shift", shiftId: "night" }],
    ],
    edits: [{ personIdx: 0, dateIdx: 1, day: { kind: "shift", shiftId: "pm2" } }],
  };

  it("renders the solved baseline the way the workbook writes it", () => {
    expect(readWardDocumentMatrices(document).solved).toEqual([
      ["am1", ""],
      ["Leave", "night"],
    ]);
  });

  it("applies the overlay through the product's own codec for the current matrix", () => {
    expect(readWardDocumentMatrices(document).current).toEqual([
      ["am1", "pm2"],
      ["Leave", "night"],
    ]);
  });

  it("leaves the two identical when there are no edits", () => {
    const matrices = readWardDocumentMatrices({ ...document, edits: [] });
    expect(matrices.current).toEqual(matrices.solved);
  });
});

// ---------------------------------------------------------------------------
// Replacement
// ---------------------------------------------------------------------------

const POINTER_A = { jobId: "job-a", candidateVersion: 1 };
const POINTER_B = { jobId: "job-b", candidateVersion: 2 };

function replacement(
  overrides: {
    beforeDigest?: string;
    candidateDigest?: string;
    afterDigest?: string;
    afterSource?: { jobId: string; candidateVersion: number } | null;
    beforeSource?: { jobId: string; candidateVersion: number } | null;
    afterRevision?: number;
  } = {},
) {
  return judgeReplacement({
    before: {
      digest: overrides.beforeDigest ?? "digest-A",
      revision: 3,
      candidateSource: overrides.beforeSource === undefined ? POINTER_A : overrides.beforeSource,
    },
    candidate: { digest: overrides.candidateDigest ?? "digest-B", pointer: POINTER_B },
    after: {
      digest: overrides.afterDigest ?? "digest-B",
      revision: overrides.afterRevision ?? 4,
      candidateSource: overrides.afterSource === undefined ? POINTER_B : overrides.afterSource,
    },
  });
}

describe("judgeReplacement", () => {
  it("accepts a Replace that promoted exactly the chosen candidate", () => {
    expect(replacement()).toEqual({ ok: true, problems: [] });
  });

  it("ACCEPTS a candidate whose content is identical to the roster it replaces", () => {
    // Two honest solves of one scenario may coincide. Requiring the bytes to
    // differ would fail a correct replacement; identity plus an advanced exact
    // version is what actually has to hold.
    expect(
      replacement({ beforeDigest: "same", candidateDigest: "same", afterDigest: "same" }),
    ).toEqual({ ok: true, problems: [] });
  });

  it("rejects A's bytes stamped with B's source — the pointer-only hole", () => {
    const verdict = replacement({ afterDigest: "digest-A" });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("still the previous roster's");
  });

  it("rejects bytes that are neither A's nor the chosen candidate's", () => {
    const verdict = replacement({ afterDigest: "digest-something-else" });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("not the chosen candidate's content");
  });

  it("rejects the WRONG candidate version, specifically at the pair comparison", () => {
    const verdict = replacement({
      afterSource: { jobId: POINTER_B.jobId, candidateVersion: 99 },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual(["candidateSource is job-b@v99, expected exactly job-b@v2"]);
  });

  it("rejects a source stamped with the right version but the wrong job", () => {
    expect(replacement({ afterSource: { jobId: "job-z", candidateVersion: 2 } }).ok).toBe(false);
  });

  it("rejects an unstamped source", () => {
    expect(replacement({ afterSource: null }).ok).toBe(false);
  });

  it("rejects a row that was never rewritten", () => {
    const verdict = replacement({ afterRevision: 3 });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("not rewritten");
  });

  it("rejects a roster that was ALREADY this candidate — nothing was replaced", () => {
    const verdict = replacement({ beforeSource: POINTER_B });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("already stamped with this candidate");
  });

  it("accepts a previously imported roster, which carries no source at all", () => {
    expect(replacement({ beforeSource: null }).ok).toBe(true);
  });
});

describe("isLoadableSolverStatus", () => {
  it.each(["OPTIMAL", "FEASIBLE", " optimal ", "feasible"])("accepts %o", (text) => {
    expect(isLoadableSolverStatus(text)).toBe(true);
  });

  it.each([null, "", "—", "INFEASIBLE", "UNKNOWN", "MODEL_INVALID", "OPTIMAL-ish"])(
    "rejects %o",
    (text) => {
      expect(isLoadableSolverStatus(text)).toBe(false);
    },
  );
});

describe("resumingCallsFor", () => {
  const JOB = "job_abc";

  it.each([
    ["the authoritative poll", `GET /api/optimize/${JOB} 200`],
    ["the events stream", `GET /api/optimize/${JOB}/events 200`],
    ["the workbook", `GET /api/optimize/${JOB}/xlsx 200`],
    ["the roster capture", `GET /api/optimize/${JOB}/roster 200`],
    ["the terminal DELETE", `DELETE /api/optimize/${JOB} 204`],
    ["finish-now", `POST /api/optimize/${JOB}/finish-now 200`],
  ])("names %s as a resume", (_label, line) => {
    expect(resumingCallsFor([line], JOB)).toEqual([line]);
  });

  it("does NOT name the abandonment's own best-effort cancel", () => {
    // The false positive this helper exists for. The cancel is fired unawaited by
    // the retirement lane, so its response can land after the next navigation has
    // begun — and it is the one call that lane is contractually allowed to make.
    const cancel = `POST /api/optimize/${JOB}/cancel 202`;
    expect(resumingCallsFor([cancel], JOB)).toEqual([]);
  });

  it("ignores calls about a DIFFERENT job", () => {
    // Job ids are opaque and one is not a prefix of another by construction, but
    // the filter must be exact rather than substring-lucky.
    expect(resumingCallsFor([`GET /api/optimize/job_other 200`], JOB)).toEqual([]);
    expect(resumingCallsFor(["POST /api/optimize 202", "GET /api/info 200"], JOB)).toEqual([]);
  });

  it("returns every offending line, not just the first", () => {
    const lines = [
      `POST /api/optimize/${JOB}/cancel 202`,
      `GET /api/optimize/${JOB} 200`,
      "GET /api/info 200",
      `GET /api/optimize/${JOB}/events 200`,
    ];
    expect(resumingCallsFor(lines, JOB)).toEqual([
      `GET /api/optimize/${JOB} 200`,
      `GET /api/optimize/${JOB}/events 200`,
    ]);
  });
});
