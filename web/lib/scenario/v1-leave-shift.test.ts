import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { toCanonicalScenarioDocument } from "./canonical";
import { prepareScenarioLoad } from "./prepare-scenario-load";
import { makeValidUiState } from "./test-fixtures";
import { planV1LeaveShiftConversion } from "./v1-leave-shift";

type Doc = Record<string, any>;

/** A v1-style document with its own worked shift type named `id`. */
function v1Doc(id = "Leave"): Doc {
  const doc = structuredClone(toCanonicalScenarioDocument(makeValidUiState())) as Doc;
  doc.shiftTypes.items.push({ id, description: "Annual leave" });
  doc.people.items[0].history = [id, "D"];
  doc.preferences.push(
    { type: "shift request", person: "Bob", date: "2026-05-17", shiftType: id }, // default +1
    { type: "shift request", person: "Alice", date: ["2026-05-18"], shiftType: [id], weight: 3 },
    { type: "shift request", person: "Bob", date: "2026-05-19", shiftType: id, weight: -2 },
    { type: "shift request", person: "Bob", date: "2026-05-20", shiftType: id, weight: 0 },
  );
  return doc;
}

describe("planV1LeaveShiftConversion", () => {
  it("returns null when there is no Leave shift type", () => {
    expect(planV1LeaveShiftConversion(toCanonicalScenarioDocument(makeValidUiState()))).toBeNull();
    expect(planV1LeaveShiftConversion("not a doc")).toBeNull();
  });

  it.each(["Leave", "leave", "LEAVE"])("detects %s case-insensitively", (id) => {
    expect(planV1LeaveShiftConversion(v1Doc(id))?.shiftId).toBe(id);
  });

  it("counts converted and dropped requests by weight, and history entries", () => {
    const plan = planV1LeaveShiftConversion(v1Doc())!;
    expect(plan).toMatchObject({
      shiftIndex: 3,
      convertedRequests: 2,
      droppedRequests: 2,
      historyEntries: 1,
      blockers: [],
    });
    const doc = plan.doc as Doc;
    expect(doc.shiftTypes.items.map((s: Doc) => s.id)).toEqual(["D", "E", "N"]);
    expect(doc.people.items[0].history).toEqual(["LEAVE", "D"]);
    const leaveRequests = doc.preferences.filter((p: Doc) => p.shiftType === "LEAVE");
    // The fixture's own leave cell plus the two converted requests.
    expect(leaveRequests).toHaveLength(3);
    expect(JSON.stringify(doc.preferences)).not.toContain('"Leave"');
  });

  it("does not mutate the input document", () => {
    const doc = v1Doc();
    const before = JSON.stringify(doc);
    planV1LeaveShiftConversion(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("lists rules, groups, export entries and mixed requests that use it as a worked shift", () => {
    const doc = v1Doc();
    doc.shiftTypes.groups.push({ id: "Anything", members: ["D", "Leave"] });
    doc.preferences.push(
      {
        type: "shift count",
        description: "Max leave",
        person: "ALL",
        countDates: "ALL",
        countShiftTypes: ["Leave"],
        expression: "x",
        target: 2,
      },
      { type: "shift type successions", person: "ALL", pattern: ["N", ["Leave", "E"]] },
      { type: "shift request", person: "Bob", date: "2026-05-14", shiftType: ["D", "Leave"] },
    );
    doc.export = {
      extraColumns: [
        { type: "count", header: "L", countShiftTypes: ["Leave"], countDates: ["ALL"] },
      ],
    };
    const plan = planV1LeaveShiftConversion(doc)!;
    const n = doc.preferences.length;
    expect(plan.blockers).toEqual([
      'shift type group "Anything"',
      'shift count "Max leave"',
      `shift type successions #${n - 1}`,
      `shift request #${n} (asks for it alongside other shifts)`,
      "export layout",
    ]);
  });

  it("counts rules, requests and export counts that use the ALL shift selector", () => {
    const doc = v1Doc();
    const before = planV1LeaveShiftConversion(doc)!.allShiftRules;
    doc.preferences.push(
      {
        type: "shift count",
        person: "ALL",
        countDates: "ALL",
        countShiftTypes: "ALL",
        expression: "x",
        target: 5,
      },
      { type: "shift request", person: "Bob", date: "2026-05-14", shiftType: "ALL" },
      { type: "shift type successions", person: "ALL", pattern: ["N", "D"] },
    );
    doc.export = {
      extraRows: [
        { type: "count", header: "Worked", countShiftTypes: ["ALL"], countPeople: ["ALL"] },
      ],
    };
    expect(planV1LeaveShiftConversion(doc)!.allShiftRules).toBe(before + 3);
  });

  it("refuses two leave-like ids and names both in the error", () => {
    const doc = v1Doc();
    doc.shiftTypes.items.push({ id: "LEAVE" });
    const plan = planV1LeaveShiftConversion(doc)!;
    expect(plan.leaveLikeIds).toEqual(["Leave", "LEAVE"]);
    expect(plan.convertible).toBe(false);
    const result = prepareScenarioLoad(stringify(doc), { convertV1LeaveShift: true });
    expect(result.target).toBeNull();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toMatch(/Shift types "Leave" and "LEAVE" both clash/);
    expect(result.issues[0].message).not.toMatch(/reserved value/);
  });

  it("ignores a person or date that happens to be named Leave", () => {
    const doc = v1Doc();
    doc.preferences.push({
      type: "shift affinity",
      people1: ["Leave"],
      people2: ["Bob"],
      shiftTypes: ["D"],
    });
    expect(planV1LeaveShiftConversion(doc)!.blockers).toEqual([]);
  });
});

describe("prepareScenarioLoad with a v1 Leave shift", () => {
  it("blocks by default with an issue naming the shift and the Edit YAML rename", () => {
    const result = prepareScenarioLoad(stringify(v1Doc()));
    expect(result.target).toBeNull();
    expect(result.v1LeaveShift?.convertedRequests).toBe(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].path).toBe("shiftTypes.items.3.id");
    expect(result.issues[0].message).toMatch(/Shift type "Leave" clashes with the built-in LEAVE/);
    expect(result.issues[0].message).toMatch(/open Edit YAML/);
  });

  it("loads the converted scenario when conversion is requested", () => {
    const result = prepareScenarioLoad(stringify(v1Doc()), { convertV1LeaveShift: true });
    expect(result.issues).toEqual([]);
    const cells = result.target!.reqData.filter((c) => c.kind === "leave");
    expect(cells.map((c) => `${c.person}@${c.date}`)).toEqual(["Alice@14", "Bob@17", "Alice@18"]);
    expect(
      result.target!.reqData.some((c) => c.kind === "request" && c.shiftType === "Leave"),
    ).toBe(false);
    expect(result.target!.staff[0].history).toEqual(["LEAVE", "D"]);
  });

  it("still refuses conversion when a rule depends on it, naming the rule", () => {
    const doc = v1Doc();
    doc.preferences.push({
      type: "shift type requirement",
      shiftType: "Leave",
      requiredNumPeople: 1,
      qualifiedPeople: "ALL",
      date: "ALL",
    });
    const result = prepareScenarioLoad(stringify(doc), { convertV1LeaveShift: true });
    expect(result.target).toBeNull();
    expect(result.issues[0].message).toMatch(
      /used as a worked shift by: shift type requirement #\d+/,
    );
  });
});
