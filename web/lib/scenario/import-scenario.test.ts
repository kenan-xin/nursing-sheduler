import { describe, expect, it } from "vitest";
import { importScenarioYaml, importScenarioValue } from "./import-scenario";

const BACKEND_YAML = `apiVersion: alpha
description: imported
dates:
  range:
    startDate: 2026-05-14
    endDate: 2026-05-16
  groups:
    - id: FirstTwo
      members: [2026-05-14, 2026-05-15]
people:
  items:
    - id: Alice
    - id: Bob
  groups:
    - id: Seniors
      members: [Alice, Bob]
shiftTypes:
  items:
    - id: D
    - id: E
  groups:
    - id: DayOrEvening
      members: [D, E]
preferences:
  - type: at most one shift per day
  # omitted type — the backend union infers "shift request"
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
    weight: -1
  - type: shift count
    person: ALL
    countDates: ALL
    countShiftTypes: [D, E]
    countShiftTypeCoefficients: [[D, 1], [E, 1]]
    expression: x = T
    target: 5
    weight: .inf
    hoursContract:
      unit: half-hour
      policy: exact
`;

describe("importScenarioYaml (lenient Load path)", () => {
  it("accepts backend-valid YAML (omitted type, scalar/list, nested, .inf)", () => {
    const result = importScenarioYaml(BACKEND_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = result.target;

    expect(t.meta.apiVersion).toBe("alpha");
    expect(t.rangeStart).toBe("2026-05-14");
    expect(t.rangeEnd).toBe("2026-05-16");
    expect(t.staff.map((p) => p.id)).toEqual(["Alice", "Bob"]);
    expect(t.staffGroups[0].members).toEqual(["Alice", "Bob"]);
    expect(t.dateGroups[0].members).toEqual(["2026-05-14", "2026-05-15"]);
    expect(t.maxOneShiftPerDay).toEqual({});
  });

  it("folds the omitted-type LEAVE request into a leave matrix cell", () => {
    const r = importScenarioYaml(BACKEND_YAML);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const leaveCell = r.target.reqData.find((c) => c.kind === "leave");
    expect(leaveCell).toMatchObject({ kind: "leave", person: "Alice", date: "2026-05-14" });
    expect("weight" in (leaveCell as object)).toBe(false);
  });

  it("expands a list shift request cartesian into per-cell requests", () => {
    const r = importScenarioYaml(BACKEND_YAML);
    if (!r.ok) throw new Error("expected ok");
    const requests = r.target.reqData.filter((c) => c.kind === "request");
    // 2 people × 2 dates × 1 shiftType = 4 cells.
    expect(requests).toHaveLength(4);
    expect(
      requests.every((c) => c.kind === "request" && c.shiftType === "D" && c.weight === 2),
    ).toBe(true);
  });

  it("normalizes a nested requirement and a contracted-hours count", () => {
    const r = importScenarioYaml(BACKEND_YAML);
    if (!r.ok) throw new Error("expected ok");
    expect(r.target.cardsByKind.requirements[0].shiftType).toEqual([["D", "E"]]);
    const count = r.target.cardsByKind.counts[0];
    expect(count).toMatchObject({
      tag: "contracted_hours",
      policy: "exact",
      expression: "x = T",
      target: 5,
    });
  });

  it("applies the backend default weight when omitted on a shift request", () => {
    const r = importScenarioYaml(`apiVersion: alpha
dates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}
people: {items: [{id: P1}]}
shiftTypes: {items: [{id: D}]}
preferences:
  - type: at most one shift per day
  - person: P1
    date: 2026-05-14
    shiftType: D
`);
    if (!r.ok) throw new Error("expected ok");
    const request = r.target.reqData.find((c) => c.kind === "request");
    expect(request && request.kind === "request" && request.weight).toBe(1);
  });

  it("reports structural issues for malformed input", () => {
    const r = importScenarioValue({ apiVersion: "alpha" });
    expect(r.ok).toBe(false);
  });

  const BASE = `apiVersion: alpha
dates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}
people: {items: [{id: P1}]}
shiftTypes: {items: [{id: D}]}
`;

  it("rejects an unknown explicit preference type (never silently drops it)", () => {
    const r = importScenarioYaml(
      `${BASE}preferences:\n  - type: at most one shift per day\n  - type: future preference\n    importantField: keep-me\n`,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a known preference missing a required field", () => {
    // A shift request without date/shiftType must not become a malformed cell.
    const r = importScenarioYaml(
      `${BASE}preferences:\n  - type: at most one shift per day\n  - type: shift request\n    person: P1\n`,
    );
    expect(r.ok).toBe(false);
  });

  it("returns an ImportResult failure (not a throw) for malformed YAML", () => {
    const r = importScenarioYaml("apiVersion: [unterminated");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].message).toMatch(/YAML parse error/);
  });

  // Backend-invalid values that the Pydantic models reject (models.py). The
  // lenient import schema must reject them too — "lenient" is about FORMS
  // (omitted type, scalar-vs-list), not about accepting values the backend
  // rejects. Each case was probed against the vendored `load_data` and rejected.
  describe("rejects backend-invalid values (mirrors models.py)", () => {
    it("rejects a fractional preference weight (validate_weight: int | ±inf only)", () => {
      const r = importScenarioYaml(
        `${BASE}preferences:\n  - type: at most one shift per day\n  - person: P1\n    date: 2026-05-14\n    shiftType: D\n    weight: 1.5\n`,
      );
      expect(r.ok).toBe(false);
    });

    it("rejects a fractional shift-type durationMinutes (int only)", () => {
      const r = importScenarioYaml(
        `apiVersion: alpha\ndates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}\npeople: {items: [{id: P1}]}\nshiftTypes: {items: [{id: D, durationMinutes: 30.5}]}\npreferences: [{type: at most one shift per day}]\n`,
      );
      expect(r.ok).toBe(false);
    });

    it("rejects an off-grid shift-type clock time (30-minute grid only)", () => {
      const r = importScenarioYaml(
        `apiVersion: alpha\ndates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}\npeople: {items: [{id: P1}]}\nshiftTypes: {items: [{id: D, startTime: "09:15", endTime: "17:00", durationMinutes: 465}]}\npreferences: [{type: at most one shift per day}]\n`,
      );
      expect(r.ok).toBe(false);
    });

    // Working-time WHOLE SHAPES — mirrors ShiftType._validate_working_time
    // (models.py:94-150). The shared refinement (./working-time) is the same one
    // the producer uses; these prove the import applies it too.
    it("rejects startTime without endTime (partial working-time shape)", () => {
      const r = importScenarioYaml(
        `apiVersion: alpha\ndates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}\npeople: {items: [{id: P1}]}\nshiftTypes: {items: [{id: D, startTime: "09:00"}]}\npreferences: [{type: at most one shift per day}]\n`,
      );
      expect(r.ok).toBe(false);
    });

    it("rejects equal startTime and endTime", () => {
      const r = importScenarioYaml(
        `apiVersion: alpha\ndates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}\npeople: {items: [{id: P1}]}\nshiftTypes: {items: [{id: D, startTime: "09:00", endTime: "09:00", durationMinutes: 480}]}\npreferences: [{type: at most one shift per day}]\n`,
      );
      expect(r.ok).toBe(false);
    });

    it("rejects durationMinutes disagreeing with the clock span", () => {
      const r = importScenarioYaml(
        `apiVersion: alpha\ndates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}\npeople: {items: [{id: P1}]}\nshiftTypes: {items: [{id: D, startTime: "09:00", endTime: "17:00", durationMinutes: 400}]}\npreferences: [{type: at most one shift per day}]\n`,
      );
      expect(r.ok).toBe(false);
    });

    it("rejects restMinutes without startTime/endTime (rest-only)", () => {
      const r = importScenarioYaml(
        `apiVersion: alpha\ndates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}\npeople: {items: [{id: P1}]}\nshiftTypes: {items: [{id: D, restMinutes: 30}]}\npreferences: [{type: at most one shift per day}]\n`,
      );
      expect(r.ok).toBe(false);
    });

    it("rejects restMinutes exceeding the clock span", () => {
      const r = importScenarioYaml(
        `apiVersion: alpha\ndates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}\npeople: {items: [{id: P1}]}\nshiftTypes: {items: [{id: D, startTime: "09:00", endTime: "17:00", restMinutes: 480, durationMinutes: 0}]}\npreferences: [{type: at most one shift per day}]\n`,
      );
      expect(r.ok).toBe(false);
    });

    it("rejects an impossible range date (calendar-valid via z.iso.date)", () => {
      const r = importScenarioYaml(
        `apiVersion: alpha\ndates: {range: {startDate: 2026-99-99, endDate: 2026-99-99}}\npeople: {items: [{id: P1}]}\nshiftTypes: {items: [{id: D}]}\npreferences: [{type: at most one shift per day}]\n`,
      );
      expect(r.ok).toBe(false);
    });

    it("rejects a non-empty dates.items (auto-generated, rejected by the backend)", () => {
      const r = importScenarioYaml(
        `apiVersion: alpha\ndates:\n  range: {startDate: 2026-05-14, endDate: 2026-05-14}\n  items: [2026-05-14]\npeople: {items: [{id: P1}]}\nshiftTypes: {items: [{id: D}]}\npreferences: [{type: at most one shift per day}]\n`,
      );
      expect(r.ok).toBe(false);
    });

    it("rejects null on a list container (groups) the backend rejects", () => {
      const r = importScenarioYaml(
        `apiVersion: alpha\ndates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}\npeople: {items: [{id: P1}], groups: null}\nshiftTypes: {items: [{id: D}]}\npreferences: [{type: at most one shift per day}]\n`,
      );
      expect(r.ok).toBe(false);
    });

    it("rejects null on a weight field the backend rejects", () => {
      const r = importScenarioYaml(
        `${BASE}preferences:\n  - type: at most one shift per day\n  - person: P1\n    date: 2026-05-14\n    shiftType: D\n    weight: null\n`,
      );
      expect(r.ok).toBe(false);
    });
  });

  // Export rules use extra="forbid" + a type-discriminated union in the Pydantic
  // models (models.py). The import schema mirrors them as strict objects so a
  // missing discriminator or an unknown key is rejected, not silently kept.
  describe("export config (strict, mirrors Pydantic extra=forbid + discriminated union)", () => {
    const EXPORT_BASE = `apiVersion: alpha
dates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}
people: {items: [{id: P1}]}
shiftTypes: {items: [{id: D}]}
preferences:
  - type: at most one shift per day
`;

    it("accepts a backend-valid export formatting + extra-column + extra-row", () => {
      const r = importScenarioYaml(
        `${EXPORT_BASE}export:
  formatting:
    - type: cell
      people: [P1]
      dates: [ALL]
      shiftTypes: [D]
      backgroundColor: "#00ff00"
  extraColumns:
    - type: count
      header: hrs
      countShiftTypes: [D]
      countDates: [ALL]
  extraRows:
    - type: count
      header: total
      countShiftTypes: [D]
      countPeople: [P1]
`,
      );
      expect(r.ok).toBe(true);
    });

    it("rejects an export formatting rule with an unknown key (extra=forbid)", () => {
      const r = importScenarioYaml(
        `${EXPORT_BASE}export:\n  formatting:\n    - unknownRule: silently-kept\n`,
      );
      expect(r.ok).toBe(false);
    });

    it("rejects an export formatting rule missing the type discriminator", () => {
      const r = importScenarioYaml(`${EXPORT_BASE}export:\n  formatting:\n    - people: [P1]\n`);
      expect(r.ok).toBe(false);
    });

    it("rejects an export extra-column missing a required field (header)", () => {
      const r = importScenarioYaml(
        `${EXPORT_BASE}export:\n  extraColumns:\n    - type: count\n      countShiftTypes: [D]\n      countDates: [ALL]\n`,
      );
      expect(r.ok).toBe(false);
    });
  });
});
