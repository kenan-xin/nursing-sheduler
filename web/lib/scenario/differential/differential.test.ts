// Differential CI harness (T05, tech-plan §6.2) — the AUTHORITY the tech-plan
// designates over zod preflight. Each check runs bytes/scenarios through the
// vendored Python backend via `oracle.py` and asserts against a DECLARED expected
// outcome ("mutated" is never itself an oracle). Covers C1 (load_data + exact
// canonical model dump), C3 (scheduler/context setup + group_map + producer-reject
// vs backend-accept + contracted-hours coverage), C5 (exporter — exact workbook
// cells/fills/notes), the import round-trip semantic-equivalence invariant (through
// the producer boundary), and both the normal AND anonymized paths.
//
// Fail-closed: the suite runs only when `RUN_DIFFERENTIAL=1` (the `test:differential`
// script sets it) so the default `pnpm test` never shells out to Python — but when
// gated, a missing/broken Python backend is a HARD FAILURE, not a silent skip.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { serializeScenario, validateScenario } from "../serialize";
import { importScenarioYaml } from "../import-scenario";
import { currentAppVersion } from "../app-version";
import { toCanonicalScenarioDocument } from "../canonical";
import { anonymizeDocument, buildIdMap } from "../anonymize";
import { prepareOptimizeSubmission } from "../prepare-optimize-submission";
import { buildShiftTypeIndexMap } from "../schemas/shift-type-map";
import {
  buildPeopleIndexMap,
  buildScenarioResolutionContext,
  toTypedKeyRecords,
  type Resolution,
  type TypedKeyRecord,
} from "../leave-guard/resolution";
import { makeValidUiState } from "../test-fixtures";
import type { CardsByKind, ImportNormalizationTarget, ScenarioUiState } from "../types";

const ORACLE = resolve(dirname(fileURLToPath(import.meta.url)), "oracle.py");
const PYTHON = process.env.PYTHON ?? "python3";
const GATED = !!process.env.RUN_DIFFERENTIAL;

interface OracleResponse {
  ok: boolean;
  error?: string;
  errorType?: string;
  status?: string;
  model?: Record<string, unknown>;
  map?: Record<string, number[]>;
  records?: TypedKeyRecord[];
  resolved?: boolean;
  indices?: number[];
  equivalent?: boolean;
  appVersion?: { raw: unknown; roundtrip: unknown };
  csv?: string | null;
  xlsxBytes?: number;
  cells?: Record<string, unknown>;
  fills?: Record<string, string>;
  notes?: unknown[] | null;
  frozen?: string;
}

function callOracle(request: object): OracleResponse {
  const result = spawnSync(PYTHON, [ORACLE], { input: JSON.stringify(request), encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`oracle exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as OracleResponse;
}

function backendAvailable(): boolean {
  if (!GATED) return false;
  try {
    return callOracle({ op: "shift_map", items: ["D"], groups: [] }).ok === true;
  } catch {
    return false;
  }
}

const AVAILABLE = GATED && backendAvailable();

/** Serialize an already-canonical (e.g. anonymized) document through the producer
 *  boundary — validate, then dump exactly what was validated. Mirrors production. */
function serializeDocument(doc: ReturnType<typeof toCanonicalScenarioDocument>): string {
  const result = validateScenario(doc);
  if (!result.ok) throw new Error(`producer rejected: ${JSON.stringify(result.issues)}`);
  return stringify(result.document, { version: "1.2" });
}

/** Dump WITHOUT the producer (to prove backend accepts what the producer rejects). */
function rawDump(doc: ReturnType<typeof toCanonicalScenarioDocument>): string {
  return stringify(doc, { version: "1.2" });
}

function hydrate(target: ImportNormalizationTarget): ScenarioUiState {
  let counter = 0;
  const uid = () => `u${counter++}`;
  const cardsByKind: CardsByKind = {
    requirements: target.cardsByKind.requirements.map((b) => ({ uid: uid(), ...b })),
    successions: target.cardsByKind.successions.map((b) => ({ uid: uid(), ...b })),
    counts: target.cardsByKind.counts.map((b) => ({ uid: uid(), ...b })),
    affinities: target.cardsByKind.affinities.map((b) => ({ uid: uid(), ...b })),
    coverings: target.cardsByKind.coverings.map((b) => ({ uid: uid(), ...b })),
  };
  return { ...target, guidedRulePins: [], cardsByKind };
}

// Fail-closed guard: when gated, the backend MUST be reachable, else the whole
// differential command fails (never a green skip).
describe.skipIf(!GATED)("differential — backend availability (fail-closed)", () => {
  it("Python + vendored core/ are importable", () => {
    expect(AVAILABLE).toBe(true);
  });
});

describe.skipIf(!AVAILABLE)("differential — C1 (bytes → load_data, exact model dump)", () => {
  it("accepts the serialized fixture and canonicalizes (zero-rest omitted, implicit ALL)", () => {
    const state = makeValidUiState();
    // Force the two canonicalizations to be *applied*, not merely already-absent:
    state.shifts[0] = {
      id: "D",
      startTime: "09:00",
      endTime: "17:00",
      restMinutes: 0,
      durationMinutes: 480,
    };
    state.cardsByKind.requirements = [
      { uid: "r", shiftType: "D", requiredNumPeople: 1, weight: -1 },
    ];
    const yaml = serializeScenario(state);
    // Emitted YAML must not carry restMinutes: 0.
    expect(yaml).not.toMatch(/restMinutes/);

    const res = callOracle({ op: "load", yaml });
    expect(res.ok).toBe(true);
    const model = res.model!;
    const shiftTypes = model.shiftTypes as { items: Record<string, unknown>[] };
    expect(shiftTypes.items[0].restMinutes).toBeNull(); // backend canonicalizes 0 → None
    const prefs = model.preferences as Record<string, unknown>[];
    const requirement = prefs.find((p) => p.type === "shift type requirement")!;
    expect(requirement.qualifiedPeople).toBe("ALL"); // implicit → explicit ALL
    expect(requirement.date).toBe("ALL");
    const leave = prefs.find((p) => p.type === "shift request" && p.shiftType === "LEAVE")!;
    expect(leave.weight).toBe("Infinity"); // LEAVE pin, sanitized .inf
  });

  it("rejects a reserved shift-type id (declared: load_data ValueError)", () => {
    const yaml = `apiVersion: alpha
dates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}
people: {items: [{id: P1}]}
shiftTypes: {items: [{id: OFF}]}
preferences: [{type: at most one shift per day}]
`;
    const res = callOracle({ op: "load", yaml });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/reserved value/);
  });

  // MAJOR 2 declared rejects: producer-invalid primitives are also backend-invalid.
  it("rejects a fractional person id and an impossible date (declared: ValidationError)", () => {
    const badId = `apiVersion: alpha
dates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}
people: {items: [{id: 1.5}]}
shiftTypes: {items: [{id: D}]}
preferences: [{type: at most one shift per day}]
`;
    expect(callOracle({ op: "load", yaml: badId }).ok).toBe(false);
    const badDate = `apiVersion: alpha
dates: {range: {startDate: 2026-99-99, endDate: 2026-99-99}}
people: {items: [{id: P1}]}
shiftTypes: {items: [{id: D}]}
preferences: [{type: at most one shift per day}]
`;
    expect(callOracle({ op: "load", yaml: badDate }).ok).toBe(false);
  });

  // Working-time whole shapes: real load_data must reject the same partial /
  // disagreeing shapes the shared zod refinement (./working-time) rejects —
  // zod and backend agree by construction.
  it("rejects working-time whole shapes (declared: ValidationError)", () => {
    const head = `apiVersion: alpha
dates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}
people: {items: [{id: P1}]}
preferences: [{type: at most one shift per day}]
`;
    const cases: Record<string, string> = {
      "startTime without endTime": `${head}shiftTypes: {items: [{id: D, startTime: "09:00"}]}\n`,
      "equal start/end": `${head}shiftTypes: {items: [{id: D, startTime: "09:00", endTime: "09:00", durationMinutes: 480}]}\n`,
      "duration/clock-span mismatch": `${head}shiftTypes: {items: [{id: D, startTime: "09:00", endTime: "17:00", durationMinutes: 400}]}\n`,
      "restMinutes without clocks": `${head}shiftTypes: {items: [{id: D, restMinutes: 30}]}\n`,
      "restMinutes exceeds span": `${head}shiftTypes: {items: [{id: D, startTime: "09:00", endTime: "17:00", restMinutes: 480, durationMinutes: 0}]}\n`,
    };
    for (const [, yaml] of Object.entries(cases)) {
      expect(callOracle({ op: "load", yaml }).ok).toBe(false);
    }
  });
});

describe.skipIf(!AVAILABLE)("differential — C3 (scheduler/context setup + group_map)", () => {
  it("group_map: JS port matches the backend, incl. mixed group → [-2, 0]", () => {
    const items = ["D", "E"];
    const groups = [{ id: "mixed", members: ["D", "LEAVE"] }];
    const backend = callOracle({ op: "shift_map", items, groups });
    expect(backend.ok).toBe(true);
    const js = buildShiftTypeIndexMap(
      items.map((id) => ({ id })),
      groups,
    );
    const jsAsRecord = Object.fromEntries([...js.entries()].map(([k, v]) => [String(k), v]));
    expect(jsAsRecord).toEqual(backend.map);
    expect(backend.map!.mixed).toEqual([-2, 0]);
  });

  it("group_map: forward reference fails in both backend and JS port", () => {
    const groups = [
      { id: "g", members: ["later"] },
      { id: "later", members: ["D"] },
    ];
    expect(callOracle({ op: "shift_map", items: ["D"], groups }).ok).toBe(false);
    expect(() => buildShiftTypeIndexMap([{ id: "D" }], groups)).toThrow();
  });

  // producer-reject / backend-accept divergence: the mixed group→LEAVE request is
  // the exact silent-footgun the producer guards. Assert BOTH sides.
  it("mixed-group→LEAVE request: producer rejects, backend silently schedules OPTIMAL", () => {
    const state = makeValidUiState();
    state.shiftGroups = [{ id: "mixed", members: ["D", "LEAVE"] }];
    state.reqData = [
      {
        uid: "x",
        kind: "request",
        person: "Bob",
        date: "2026-05-15",
        shiftType: "mixed",
        weight: 1,
      },
    ];
    const doc = toCanonicalScenarioDocument(state);
    // Producer (frontend guard) rejects…
    expect(validateScenario(doc).ok).toBe(false);
    // …but the raw document schedules fine on the backend (the whole reason the
    // producer rule exists).
    const res = callOracle({ op: "schedule", yaml: rawDump(doc) });
    expect(res.ok).toBe(true);
    expect(res.status).toBe("OPTIMAL");
  });

  it("rejects OFF in a shift type requirement (declared: ValueError)", () => {
    const yaml = `apiVersion: alpha
dates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}
people: {items: [{id: P1}]}
shiftTypes: {items: [{id: D}]}
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: OFF
    requiredNumPeople: 0
    weight: .inf
`;
    const res = callOracle({ op: "schedule", yaml });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/'OFF' is not allowed in shift type requirement/);
  });

  it("catches an unknown selector that zod preflight accepts (zod-pass ≠ backend-accept)", () => {
    const state = makeValidUiState();
    state.cardsByKind.requirements = [
      { uid: "r", shiftType: "ZZZ", requiredNumPeople: 1, weight: -1 },
    ];
    expect(() => serializeScenario(state)).not.toThrow(); // preflight passes…
    const res = callOracle({ op: "schedule", yaml: serializeScenario(state) });
    expect(res.ok).toBe(false); // …backend rejects.
    expect(res.error).toMatch(/Unknown shift type ID/);
  });

  it("distinguishes date omitted (all) from date:[] (no-op)", () => {
    const body = (dateLine: string) => `apiVersion: alpha
dates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}
people: {items: [{id: P1}]}
shiftTypes: {items: [{id: D}]}
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: D
    requiredNumPeople: 2
${dateLine}    weight: .inf
`;
    expect(callOracle({ op: "schedule", yaml: body("") }).status).toBe("INFEASIBLE");
    expect(callOracle({ op: "schedule", yaml: body("    date: []\n") }).status).toBe("OPTIMAL");
  });

  // Contracted-hours coefficient-set equality through Python (DL09 D4).
  it("contracted-hours incomplete coverage: producer rejects and backend rejects at load", () => {
    const state = makeValidUiState();
    state.cardsByKind.counts = [
      {
        uid: "h1",
        person: "ALL",
        countDates: "ALL",
        countShiftTypes: ["D", "E"],
        countShiftTypeCoefficients: [["D", 1]], // missing E
        expression: "x = T",
        target: 5,
        weight: Infinity,
        tag: "contracted_hours",
        policy: "exact",
      },
    ];
    const doc = toCanonicalScenarioDocument(state);
    expect(validateScenario(doc).ok).toBe(false);
    const res = callOracle({ op: "load", yaml: rawDump(doc) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/coverage is incomplete/);
  });
});

// qq0.23a — lossless people/date resolution parity. Tagged ordered records
// preserve numeric/string identity across JSON (no `String(k)` collision), and
// the dedicated resolve ops compare sorted indices + resolved/unresolved status
// to the vendored `parse_pids` / `parse_dates` without any transport-level
// stringification. The date op's `str(...)` boundary lives inside `parse_dates`.
describe.skipIf(!AVAILABLE)("differential — qq0.23a (lossless people/date resolution)", () => {
  const RANGE = { startDate: "2026-05-14", endDate: "2026-05-20" };

  /** Extract the sorted indices for a resolved TS result; null when unresolved. */
  function tsValues(result: Resolution<number>): number[] | null {
    return result.resolved ? [...result.values].sort((a, b) => a - b) : null;
  }

  it('people map: numeric 1 vs string "1" stay two distinct tagged records', () => {
    const staff = [1, "1"] as const;
    const backend = callOracle({ op: "people_map", staff: [...staff], groups: [] });
    expect(backend.ok).toBe(true);
    const js = toTypedKeyRecords(buildPeopleIndexMap(staff.map((id) => ({ id }))));
    // Tagged records compared WITHOUT any String(...) coercion on either side.
    expect(js).toEqual(backend.records);
    // The typed collision is observable: two entries with different keyType.
    expect(backend.records!.slice(0, 2)).toEqual([
      { keyType: "number", key: 1, indices: [0] },
      { keyType: "string", key: "1", indices: [1] },
    ]);
  });

  it("people resolution: numeric and string selectors resolve independently", () => {
    const staff = [1, "1"] as const;
    const ctx = buildScenarioResolutionContext({
      staff: staff.map((id) => ({ id })),
      staffGroups: [],
      shifts: [],
      shiftGroups: [],
      rangeStart: RANGE.startDate,
      rangeEnd: RANGE.endDate,
      dateGroups: [],
    });
    for (const [selector, expected] of [
      [1, [0]],
      ["1", [1]],
    ] as const) {
      const backend = callOracle({
        op: "resolve_people",
        staff: [1, "1"],
        groups: [],
        selector,
      });
      expect(backend.resolved).toBe(true);
      expect(backend.indices).toEqual(expected);
      expect(tsValues(ctx.resolvePeople(selector))).toEqual(expected);
    }
  });

  it("people resolution: an unknown id and a forward-group both fail closed", () => {
    const unknown = callOracle({ op: "resolve_people", staff: ["A"], groups: [], selector: "Z" });
    expect(unknown.resolved).toBe(false);
    const ctxUnknown = buildScenarioResolutionContext({
      staff: [{ id: "A" }],
      staffGroups: [],
      shifts: [],
      shiftGroups: [],
      rangeStart: RANGE.startDate,
      rangeEnd: RANGE.endDate,
      dateGroups: [],
    });
    expect(ctxUnknown.resolvePeople("Z").resolved).toBe(false);

    const forwardGroups = [
      { id: "g", members: ["later"] },
      { id: "later", members: ["A"] },
    ];
    const forward = callOracle({
      op: "resolve_people",
      staff: ["A"],
      groups: forwardGroups,
      selector: "g",
    });
    expect(forward.resolved).toBe(false);
    const ctxForward = buildScenarioResolutionContext({
      staff: [{ id: "A" }],
      staffGroups: forwardGroups,
      shifts: [],
      shiftGroups: [],
      rangeStart: RANGE.startDate,
      rangeEnd: RANGE.endDate,
      dateGroups: [],
    });
    // Observable behavior only — the domain maps are closed over, not public.
    expect(ctxForward.resolvePeople("g").resolved).toBe(false);
  });

  it("date resolution: direct key, numeric fallback, ranges, keywords, and failures", () => {
    const ctx = buildScenarioResolutionContext({
      staff: [],
      staffGroups: [],
      shifts: [],
      shiftGroups: [],
      rangeStart: RANGE.startDate,
      rangeEnd: RANGE.endDate,
      dateGroups: [],
    });
    const cases: Array<[string | number, number[] | null]> = [
      ["2026-05-15", [1]], // direct ISO key precedence
      [16, [2]], // numeric member stringified through parse_dates
      ["14~16", [0, 1, 2]], // inclusive range
      ["16~14", []], // reversed range → empty resolved set
      ["WEEKEND", [2, 3]], // C3 keyword
      ["05-15", [1]], // MM-DD literal
      ["nonsense", null], // malformed → unresolved
      ["2026-06-01", null], // out-of-range → unresolved
    ];
    for (const [selector, expected] of cases) {
      const backend = callOracle({
        op: "resolve_dates",
        startDate: RANGE.startDate,
        endDate: RANGE.endDate,
        groups: [],
        selector,
      });
      if (expected === null) {
        expect(backend.resolved).toBe(false);
        expect(ctx.resolveDates(selector).resolved).toBe(false);
      } else {
        expect(backend.resolved).toBe(true);
        expect(backend.indices).toEqual(expected);
        expect(tsValues(ctx.resolveDates(selector))).toEqual(expected);
      }
    }
  });

  it("year-zero range fails closed on both sides without crashing the oracle", () => {
    // ISO `0000` is a valid JS date but has no Python `datetime.date`; the backend
    // must return a data-level unresolved result (not exit non-zero) and TS must
    // match. `callOracle` throws on a non-zero exit, so a crash fails this test.
    const backend = callOracle({
      op: "resolve_dates",
      startDate: "0000-01-01",
      endDate: "0000-01-02",
      groups: [],
      selector: "0000-01-01",
    });
    expect(backend.ok).toBe(true);
    expect(backend.resolved).toBe(false);
    const ctx = buildScenarioResolutionContext({
      staff: [],
      staffGroups: [],
      shifts: [],
      shiftGroups: [],
      rangeStart: "0000-01-01",
      rangeEnd: "0000-01-02",
      dateGroups: [],
    });
    expect(ctx.resolveDates("0000-01-01").resolved).toBe(false);
  });

  it("date group: direct-key precedence before parse, then group is addressable", () => {
    const groups = [{ id: "picks", members: ["2026-05-14", 16, "18~19"] }];
    const backend = callOracle({
      op: "resolve_dates",
      startDate: RANGE.startDate,
      endDate: RANGE.endDate,
      groups,
      selector: "picks",
    });
    expect(backend.resolved).toBe(true);
    expect(backend.indices).toEqual([0, 2, 4, 5]);
    const ctx = buildScenarioResolutionContext({
      staff: [],
      staffGroups: [],
      shifts: [],
      shiftGroups: [],
      rangeStart: RANGE.startDate,
      rangeEnd: RANGE.endDate,
      dateGroups: groups,
    });
    expect(tsValues(ctx.resolveDates("picks"))).toEqual([0, 2, 4, 5]);
  });
});

describe.skipIf(!AVAILABLE)("differential — C5 (exporter, exact workbook)", () => {
  it("produces exact cells, a painted cell fill, frozen panes, and export notes", () => {
    const yaml = `apiVersion: alpha
dates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}
people: {items: [{id: P1}]}
shiftTypes: {items: [{id: D}]}
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: D
    requiredNumPeople: 1
    date: ALL
    weight: .inf
  # A shift request that the solver satisfies (P1 works D) so the cell rule's
  # "when" condition matches and a Note row is emitted.
  - person: P1
    date: 2026-05-14
    shiftType: D
    weight: 2
export:
  formatting:
    - type: cell
      people: [P1]
      dates: [ALL]
      shiftTypes: [D]
      backgroundColor: "#00ff00"
      when:
        preference:
          types: [shift request]
      note:
        text: "Requested {shiftType} / {weight}"
`;
    const res = callOracle({ op: "export", yaml });
    expect(res.ok).toBe(true);
    expect(res.frozen).toBe("B3");
    expect(res.cells).toMatchObject({
      A3: "P1",
      B3: "D",
      A4: "Score",
      A5: "Status",
      B5: "OPTIMAL",
    });
    // The painted cell (P1 × the single date, working D) carries the ARGB fill.
    expect(res.fills).toEqual({ B3: "FF00FF00" });
    // The Notes sheet: the satisfied shift request produces an exact annotation
    // row. A regression that drops export notes fails this assertion.
    expect(res.notes).toEqual([
      ["Cell", "Schedule Value", "Note"],
      ["B3", "D", "Requested D / 2"],
    ]);
  });

  it("rejects an uncovered export extra-column coefficient (declared: ValueError)", () => {
    const yaml = `apiVersion: alpha
dates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}
people: {items: [{id: P1}]}
shiftTypes: {items: [{id: D}, {id: E}]}
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: D
    requiredNumPeople: 0
    date: ALL
    weight: .inf
export:
  extraColumns:
    - type: count
      header: hrs
      countShiftTypes: [D]
      countShiftTypeCoefficients: [[E, 1]]
      countDates: [ALL]
`;
    const res = callOracle({ op: "export", yaml });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/covered by countShiftTypes|Unknown shift type/);
  });
});

describe.skipIf(!AVAILABLE)("differential — anonymized path", () => {
  it("an anonymized document (incl. a person named OFF) still loads and carries P#/G# ids", () => {
    const state = makeValidUiState();
    state.staff = [{ id: "OFF" }, { id: "Bob" }]; // person literally named OFF (backend-valid)
    state.staffGroups = [{ id: "Seniors", members: ["OFF", "Bob"] }];
    state.reqData = [
      { uid: "c", kind: "request", person: "OFF", date: "2026-05-15", shiftType: "D", weight: 1 },
    ];
    state.exportLayout.formatting = [{ uid: "f", type: "row", people: ["OFF"] }];
    state.cardsByKind.requirements = [
      {
        uid: "r",
        shiftType: "D",
        requiredNumPeople: 1,
        qualifiedPeople: "ALL",
        date: "ALL",
        weight: -1,
      },
    ];

    const doc = toCanonicalScenarioDocument(state);
    const anon = anonymizeDocument(doc, buildIdMap(doc));
    // The OFF-named person is anonymized, not leaked.
    expect(anon.people.items.map((p) => p.id)).toEqual(["P1", "P2"]);
    expect(anon.people.groups?.[0].id).toBe("G1");

    const res = callOracle({ op: "load", yaml: serializeDocument(anon) });
    expect(res.ok).toBe(true);
    const model = res.model as { people: { items: { id: string }[] } };
    expect(model.people.items.map((p) => p.id)).toEqual(["P1", "P2"]);
  });

  // T16q: the co-derived submission YAML and reverse map come from ONE validated
  // transform. Prove the anonymized bytes load in the backend AND that every
  // person id the backend sees maps, via the reverse map, back to the exact
  // original id — including a Unicode id and a numeric (typed) id.
  it("co-derived submission YAML loads in the backend and its reverse map restores the originals", () => {
    const state = makeValidUiState();
    state.staff = [{ id: "Zoë 张三" }, { id: 42 as unknown as string }];
    state.staffGroups = [{ id: "Seniors", members: ["Zoë 张三", 42 as unknown as string] }];
    state.reqData = [
      {
        uid: "c",
        kind: "request",
        person: "Zoë 张三",
        date: "2026-05-15",
        shiftType: "D",
        weight: 1,
      },
    ];
    state.exportLayout.formatting = [{ uid: "f", type: "row", people: ["Zoë 张三"] }];

    const document = toCanonicalScenarioDocument(state);
    const result = prepareOptimizeSubmission(document, { anonymize: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const res = callOracle({ op: "load", yaml: result.prep.yaml });
    expect(res.ok).toBe(true);
    const model = res.model as { people: { items: { id: string }[] } };
    // The backend sees only anonymized ids...
    const backendIds = model.people.items.map((p) => p.id);
    expect(backendIds).toEqual(["P1", "P2"]);
    // ...and each maps back through the reverse map to a real original id.
    const lookup = new Map(result.prep.reverseMap.map(([anon, original]) => [anon, original]));
    expect(backendIds.map((id) => lookup.get(id))).toEqual(["Zoë 张三", 42]);
    expect(result.prep.peopleCount).toBe(2);
  });

  // T16q: descriptions must never leave for the solver on the anonymized path.
  it("co-derived anonymized submission loads in the backend with all descriptions stripped", () => {
    const state = makeValidUiState();
    state.meta.description = "PRIVATE-NOTE scenario";
    state.staff = [{ id: "Alice", description: "PRIVATE-NOTE person" }, { id: "Bob" }];
    state.staffGroups = [
      { id: "Seniors", members: ["Alice", "Bob"], description: "PRIVATE-NOTE group" },
    ];

    const document = toCanonicalScenarioDocument(state);
    const result = prepareOptimizeSubmission(document, { anonymize: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prep.yaml).not.toContain("PRIVATE-NOTE");

    const res = callOracle({ op: "load", yaml: result.prep.yaml });
    expect(res.ok).toBe(true);
  });
});

describe.skipIf(!AVAILABLE)(
  "differential — import round-trip semantic equivalence (through producer)",
  () => {
    const FIXTURES: Record<string, string> = {
      "scalar + list + nested + omitted-type + contracted-hours": `apiVersion: alpha
dates:
  range: {startDate: 2026-05-14, endDate: 2026-05-16}
  groups: [{id: FirstTwo, members: [2026-05-14, 2026-05-15]}]
people:
  items: [{id: Alice}, {id: Bob}]
  groups: [{id: Seniors, members: [Alice, Bob]}]
shiftTypes:
  items: [{id: D}, {id: E}]
  groups: [{id: DayOrEvening, members: [D, E]}]
preferences:
  - type: at most one shift per day
  - person: Alice
    date: 2026-05-14
    shiftType: LEAVE
    weight: .inf
  - type: shift request
    person: [Alice, Bob]
    date: [2026-05-15, 2026-05-16]
    shiftType: D
    weight: 2
  - type: shift type requirement
    shiftType: [[D, E]]
    requiredNumPeople: 1
    date: ALL
    weight: -1
  - type: shift count
    person: ALL
    countDates: ALL
    countShiftTypes: [D, E]
    countShiftTypeCoefficients: [[D, 1], [E, 1]]
    expression: x = T
    target: 5
    weight: .inf
    hoursContract: {unit: half-hour, policy: exact}
`,
    };

    for (const [name, raw] of Object.entries(FIXTURES)) {
      it(`raw → import → normalize → canonical → producer → YAML ≈ raw (${name})`, () => {
        const imported = importScenarioYaml(raw);
        expect(imported.ok).toBe(true);
        if (!imported.ok) return;
        // Route through the producer boundary (serializeScenario), NOT a raw dump.
        const roundtripYaml = serializeScenario(hydrate(imported.target));
        const res = callOracle({ op: "roundtrip", raw, roundtrip: roundtripYaml });
        expect(res.ok).toBe(true);
        // `appVersion` is provenance metadata (C1 CON-YAML-03; FR-SL-02): the
        // producer re-stamps the current build version on every serialize, so it
        // is the one field a round-trip may mutate. The oracle excludes it from
        // the semantic comparison and surfaces it separately; pin it exactly so
        // a dropped stamp or a forwarded stale version fails here by name.
        const rawAppVersion = (parse(raw) as { appVersion?: string }).appVersion ?? null;
        expect(res.appVersion).toEqual({ raw: rawAppVersion, roundtrip: currentAppVersion() });
        expect(res.equivalent).toBe(true);
      });
    }
  },
);
