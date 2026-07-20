import { describe, expect, it } from "vitest";
import { findUncreditedLeaveFindings, type LeaveGuardInput } from "./detector";
import type { ContractedHoursCountCardBody, UiRequestCell } from "../types";

const RANGE_START = "2026-05-14";
const RANGE_END = "2026-05-16"; // 3 inclusive days: 14, 15, 16

function markedCount(
  overrides: Partial<ContractedHoursCountCardBody> = {},
): ContractedHoursCountCardBody {
  return {
    tag: "contracted_hours",
    policy: "exact",
    person: "ALL",
    countDates: "ALL",
    countShiftTypes: "D",
    expression: "==",
    target: 1,
    weight: -1,
    ...overrides,
  };
}

/** A minimal, valid base input: Alice/Bob, one shift "D", a "mixed" group reaching LEAVE. */
function baseInput(overrides: Partial<LeaveGuardInput> = {}): LeaveGuardInput {
  return {
    staff: [{ id: "Alice" }, { id: "Bob" }],
    staffGroups: [],
    shifts: [{ id: "D" }],
    shiftGroups: [{ id: "mixed", members: ["D", "LEAVE"] }],
    rangeStart: RANGE_START,
    rangeEnd: RANGE_END,
    dateGroups: [],
    reqData: [],
    counts: [],
    ...overrides,
  };
}

const leaveCell = (person: string, date: string): UiRequestCell => ({
  kind: "leave",
  person,
  date,
});

const requestCell = (person: string, date: string, shiftType: string): UiRequestCell => ({
  kind: "request",
  person,
  date,
  shiftType,
  weight: 1,
});

describe("findUncreditedLeaveFindings — marker, enablement, and safe expansions", () => {
  it("emits a finding for a marked, enabled count overlapping a direct LEAVE pin", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-15")],
        counts: [{ body: markedCount(), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([{ countIndex: 0, affectedPersonIndices: [0] }]);
  });

  it("never warns an ordinary (unmarked) count, even with a full overlap", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-15")],
        counts: [
          {
            body: {
              person: "ALL",
              countDates: "ALL",
              countShiftTypes: "D",
              expression: "==",
              target: 1,
              weight: -1,
            },
            isEnabled: true,
          },
        ],
      }),
    );
    expect(findings).toEqual([]);
  });

  it("never warns a disabled marked count", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-15")],
        counts: [{ body: markedCount(), isEnabled: false }],
      }),
    );
    expect(findings).toEqual([]);
  });

  it("is already safe when the count's expanded shift types reach LEAVE directly", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-15")],
        counts: [{ body: markedCount({ countShiftTypes: "LEAVE" }), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([]);
  });

  it("is already safe when the count's expansion reaches LEAVE through a group", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-15")],
        counts: [{ body: markedCount({ countShiftTypes: "mixed" }), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([]);
  });
});

describe("findUncreditedLeaveFindings — leave-pin candidates", () => {
  it("treats a kind:'request' cell whose shift selector expands to LEAVE as a leave pin", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [requestCell("Alice", "2026-05-15", "LEAVE")],
        counts: [{ body: markedCount(), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([{ countIndex: 0, affectedPersonIndices: [0] }]);
  });

  it("treats a kind:'request' cell whose group expands to LEAVE as a leave pin", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [requestCell("Alice", "2026-05-15", "mixed")],
        counts: [{ body: markedCount(), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([{ countIndex: 0, affectedPersonIndices: [0] }]);
  });

  it("does not treat an ordinary worked-shift request as a leave pin", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [requestCell("Alice", "2026-05-15", "D")],
        counts: [{ body: markedCount(), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([]);
  });

  it("does not treat a kind:'off' cell as a leave pin", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [{ kind: "off", person: "Alice", date: "2026-05-15", weight: 1 }],
        counts: [{ body: markedCount(), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([]);
  });
});

describe("findUncreditedLeaveFindings — overlap requirement", () => {
  it("requires people overlap: no finding when the leave pin is outside the counted people", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-15")],
        counts: [{ body: markedCount({ person: "Bob" }), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([]);
  });

  it("requires date overlap: no finding when the leave pin falls outside counted dates", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-16")],
        counts: [{ body: markedCount({ countDates: "2026-05-14~2026-05-15" }), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([]);
  });

  it("unions overlapping people from multiple leave pins into one finding", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-14"), leaveCell("Bob", "2026-05-15")],
        counts: [{ body: markedCount(), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([{ countIndex: 0, affectedPersonIndices: [0, 1] }]);
  });

  it("orders affected people ascending by staff index (staff declaration order)", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        staff: [{ id: "Alice" }, { id: "Bob" }, { id: "Cara" }],
        reqData: [
          leaveCell("Cara", "2026-05-14"),
          leaveCell("Alice", "2026-05-14"),
          leaveCell("Bob", "2026-05-14"),
        ],
        counts: [{ body: markedCount(), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([{ countIndex: 0, affectedPersonIndices: [0, 1, 2] }]);
  });
});

describe("findUncreditedLeaveFindings — unresolved-safe suppression", () => {
  it("suppresses the whole count when its own selector is unresolved (unknown countShiftTypes)", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-15")],
        counts: [{ body: markedCount({ countShiftTypes: "ZZZ" }), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([]);
  });

  it("suppresses the whole count when its people selector is unresolved (unknown group)", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-15")],
        counts: [{ body: markedCount({ person: "NoSuchGroup" }), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([]);
  });

  it("suppresses the whole count when its dates selector is unresolved (malformed token)", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-15")],
        counts: [{ body: markedCount({ countDates: "not-a-date" }), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([]);
  });

  it("discards only the unresolved leave-pin candidate — an independent resolved pin still triggers", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [
          // Unresolvable: references an unknown people-group as the pin's person.
          leaveCell("NoSuchGroup", "2026-05-14"),
          // Resolvable and overlapping.
          leaveCell("Bob", "2026-05-14"),
        ],
        counts: [{ body: markedCount(), isEnabled: true }],
      }),
    );
    expect(findings).toEqual([{ countIndex: 0, affectedPersonIndices: [1] }]);
  });

  it("one unresolved count does not hide an independent valid finding on another count", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-15")],
        counts: [
          { body: markedCount({ countShiftTypes: "ZZZ" }), isEnabled: true },
          { body: markedCount(), isEnabled: true },
        ],
      }),
    );
    expect(findings).toEqual([{ countIndex: 1, affectedPersonIndices: [0] }]);
  });
});

describe("findUncreditedLeaveFindings — per-count identity across duplicate cards", () => {
  it("evaluates duplicate identical marked cards independently by countIndex", () => {
    const findings = findUncreditedLeaveFindings(
      baseInput({
        reqData: [leaveCell("Alice", "2026-05-15")],
        counts: [
          { body: markedCount(), isEnabled: true },
          { body: markedCount(), isEnabled: true },
        ],
      }),
    );
    expect(findings).toEqual([
      { countIndex: 0, affectedPersonIndices: [0] },
      { countIndex: 1, affectedPersonIndices: [0] },
    ]);
  });
});
