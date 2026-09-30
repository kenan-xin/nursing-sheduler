import { beforeAll, describe, expect, it } from "vitest";
import { generateDateItems } from "@/lib/dates";
import type { RosterContext } from "@/lib/roster";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import type { UiRequestCell } from "@/lib/scenario";
import { DEFAULT_OFF_WEIGHT } from "@/components/requests/cell-preference-editor";
import {
  isRecorded,
  recordCandidates,
  resolveRecordCandidates,
  type RecordScenario,
} from "./record-as-request";

let context: RosterContext;
beforeAll(async () => {
  context = (await fixtureRosterDocument()).context;
});

const range = { start: "2026-07-03", end: "2026-07-06" };
const [d0, d1] = generateDateItems(range).map((d) => d.id);

function scenario(reqData: UiRequestCell[] = []): RecordScenario {
  return {
    staff: [{ id: "Alice Ng", history: [] }, { id: 7 }],
    rangeStart: range.start,
    rangeEnd: range.end,
    reqData,
  };
}

describe("resolveRecordCandidates", () => {
  it("maps a roster coordinate to the scenario's person and date id", () => {
    const [c] = resolveRecordCandidates(
      [{ personIdx: 1, dateIdx: 1, kind: "off" }],
      context,
      scenario(),
    );
    expect(c).toMatchObject({ kind: "off", person: 7, date: d1, recorded: false });
    expect(c.label).toContain("7");
  });

  it("drops edits whose nurse or date is not in the current scenario", () => {
    const edits = [{ personIdx: 0, dateIdx: 0, kind: "leave" as const }];
    expect(resolveRecordCandidates(edits, context, { ...scenario(), staff: [{ id: 7 }] })).toEqual(
      [],
    );
    expect(
      resolveRecordCandidates(edits, context, {
        ...scenario(),
        rangeStart: "2026-08-01",
        rangeEnd: "2026-08-03",
      }),
    ).toEqual([]);
  });

  it("marks a coordinate that already holds the request as recorded", () => {
    const [c] = resolveRecordCandidates(
      [{ personIdx: 0, dateIdx: 0, kind: "leave" }],
      context,
      scenario([{ kind: "leave", person: "Alice Ng", date: d0 }]),
    );
    expect(c.recorded).toBe(true);
  });
});

describe("isRecorded — LEAVE > OFF > request", () => {
  const leave: UiRequestCell = { kind: "leave", person: "Alice Ng", date: d0 };
  const off: UiRequestCell = { kind: "off", person: "Alice Ng", date: d0, weight: 5 };
  const req: UiRequestCell = {
    kind: "request",
    person: "Alice Ng",
    date: d0,
    shiftType: "D",
    weight: 3,
  };
  it("leave covers both LV and OFF; OFF covers only OFF; a shift request covers neither", () => {
    expect(isRecorded([leave], "Alice Ng", d0, "off")).toBe(true);
    expect(isRecorded([leave], "Alice Ng", d0, "leave")).toBe(true);
    expect(isRecorded([off], "Alice Ng", d0, "off")).toBe(true);
    expect(isRecorded([off], "Alice Ng", d0, "leave")).toBe(false);
    expect(isRecorded([req], "Alice Ng", d0, "off")).toBe(false);
  });
});

describe("recordCandidates", () => {
  const cand = (kind: "leave" | "off", person: string | number = "Alice Ng", date = d0) => ({
    kind,
    person,
    date,
    label: "",
    recorded: false,
  });

  it("writes LV as a leave pin and OFF as a day-off wish at the nurse-wish default", () => {
    const out = recordCandidates([], [cand("leave"), cand("off", 7, d1)]);
    expect(out).toEqual([
      expect.objectContaining({ kind: "leave", person: "Alice Ng", date: d0 }),
      expect.objectContaining({ kind: "off", person: 7, date: d1, weight: DEFAULT_OFF_WEIGHT }),
    ]);
    expect(DEFAULT_OFF_WEIGHT).toBe(20);
  });

  it("replaces shift requests at the coordinate, upgrades OFF to leave, keeps other cells", () => {
    const other: UiRequestCell = { kind: "off", person: 7, date: d0, weight: 7 };
    const out = recordCandidates(
      [
        { kind: "request", person: "Alice Ng", date: d0, shiftType: "D", weight: 3 },
        { kind: "off", person: "Alice Ng", date: d1, weight: 9, uid: "keep-me" },
        other,
      ],
      [cand("off"), cand("leave", "Alice Ng", d1)],
    );
    expect(out).toContainEqual(other);
    expect(out.filter((c) => c.person === "Alice Ng" && c.date === d0)).toEqual([
      expect.objectContaining({ kind: "off", weight: DEFAULT_OFF_WEIGHT }),
    ]);
    expect(out.filter((c) => c.person === "Alice Ng" && c.date === d1)).toEqual([
      expect.objectContaining({ kind: "leave" }),
    ]);
  });

  it("never downgrades existing leave to an OFF", () => {
    const leave: UiRequestCell = { kind: "leave", person: "Alice Ng", date: d0, uid: "L" };
    expect(recordCandidates([leave], [cand("off")])).toEqual([leave]);
  });
});
