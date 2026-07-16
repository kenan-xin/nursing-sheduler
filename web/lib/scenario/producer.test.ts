import { describe, expect, it } from "vitest";
import { validateScenario } from "./serialize";
import { toCanonicalScenarioDocument } from "./canonical";
import { makeValidUiState } from "./test-fixtures";
import type { CanonicalScenarioDocument } from "./types";

function docFrom(
  mutate?: (s: ReturnType<typeof makeValidUiState>) => void,
): CanonicalScenarioDocument {
  const state = makeValidUiState();
  mutate?.(state);
  return toCanonicalScenarioDocument(state);
}

function issuesFor(doc: CanonicalScenarioDocument): string[] {
  const result = validateScenario(doc);
  return result.ok ? [] : result.issues.map((i) => i.message);
}

describe("producer schema — accept", () => {
  it("accepts the valid fixture", () => {
    expect(validateScenario(docFrom()).ok).toBe(true);
  });
});

describe("producer schema — working-time (review findings 6/7)", () => {
  it("rejects equal start/end", () => {
    const doc = docFrom((s) => (s.shifts[1] = { id: "E", startTime: "09:00", endTime: "09:00" }));
    expect(issuesFor(doc).some((m) => /must differ/.test(m))).toBe(true);
  });

  it("rejects partial clock (start only)", () => {
    const doc = docFrom((s) => (s.shifts[1] = { id: "E", startTime: "09:00" }));
    expect(issuesFor(doc).some((m) => /provided together/.test(m))).toBe(true);
  });

  it("rejects partial clock (end only)", () => {
    const doc = docFrom((s) => (s.shifts[1] = { id: "E", endTime: "17:00" }));
    expect(issuesFor(doc).some((m) => /provided together/.test(m))).toBe(true);
  });

  it("rejects an off-grid bare duration", () => {
    const doc = docFrom((s) => (s.shifts[1] = { id: "E", durationMinutes: 45 }));
    expect(issuesFor(doc).some((m) => /multiple of 30/.test(m))).toBe(true);
  });
});

describe("producer schema — ids and structure", () => {
  it("rejects a reserved shift-type id", () => {
    const doc = docFrom((s) => (s.shifts[1] = { id: "OFF" }));
    expect(issuesFor(doc).some((m) => /reserved value/.test(m))).toBe(true);
  });

  it("rejects a duplicate person id", () => {
    const doc = docFrom((s) => (s.staff = [{ id: "Alice" }, { id: "Alice" }]));
    expect(issuesFor(doc).some((m) => /Duplicated person/.test(m))).toBe(true);
  });

  it("rejects an out-of-order date range", () => {
    const doc = docFrom((s) => {
      s.rangeStart = "2026-05-20";
      s.rangeEnd = "2026-05-14";
    });
    expect(issuesFor(doc).some((m) => /after or equal/.test(m))).toBe(true);
  });

  it("rejects an unknown history shift-type id", () => {
    const doc = docFrom((s) => (s.staff[0] = { id: "Alice", history: ["ZZZ"] }));
    expect(issuesFor(doc).some((m) => /Unknown shift type ID in history/.test(m))).toBe(true);
  });

  it("rejects a fractional person id (backend requires int|str)", () => {
    const doc = docFrom((s) => (s.staff = [{ id: 1.5 }, { id: "Bob" }]));
    expect(validateScenario(doc).ok).toBe(false);
  });

  it("rejects an impossible calendar date", () => {
    const doc = docFrom((s) => {
      s.rangeStart = "2026-99-99";
      s.rangeEnd = "2026-99-99";
    });
    expect(validateScenario(doc).ok).toBe(false);
  });
});

describe("producer schema — reserved group expansion (T18 carry-forward)", () => {
  it("rejects a shift-request selector naming a group expanding to LEAVE", () => {
    const doc = docFrom((s) => {
      s.shiftGroups = [{ id: "mixed", members: ["D", "LEAVE"] }];
      s.reqData = [
        {
          uid: "x",
          kind: "request",
          person: "Bob",
          date: "2026-05-15",
          shiftType: "mixed",
          weight: 1,
        },
      ];
    });
    expect(issuesFor(doc).some((m) => /silently pin leave/.test(m))).toBe(true);
  });

  it("allows a shift-request selector of ALL (worked-day request)", () => {
    const doc = docFrom((s) => {
      s.reqData = [
        {
          uid: "x",
          kind: "request",
          person: "Bob",
          date: "2026-05-15",
          shiftType: "ALL",
          weight: 1,
        },
      ];
    });
    expect(validateScenario(doc).ok).toBe(true);
  });
});

describe("producer schema — contracted hours coverage (DL09 D4)", () => {
  it("rejects incomplete coefficient coverage", () => {
    const doc = docFrom((s) => {
      s.cardsByKind.counts = [
        {
          uid: "h1",
          person: "ALL",
          countDates: "ALL",
          countShiftTypes: ["D", "E"],
          countShiftTypeCoefficients: [["D", 1]], // missing E — incomplete
          expression: "x = T",
          target: 5,
          weight: Infinity,
          tag: "contracted_hours",
          policy: "exact",
        },
      ];
    });
    expect(issuesFor(doc).some((m) => /coverage is incomplete/.test(m))).toBe(true);
  });

  it("accepts complete coefficient coverage", () => {
    const doc = docFrom((s) => {
      s.cardsByKind.counts = [
        {
          uid: "h1",
          person: "ALL",
          countDates: "ALL",
          countShiftTypes: ["D", "E"],
          countShiftTypeCoefficients: [
            ["D", 1],
            ["E", 1],
          ],
          expression: "x = T",
          target: 5,
          weight: Infinity,
          tag: "contracted_hours",
          policy: "exact",
        },
      ];
    });
    expect(validateScenario(doc).ok).toBe(true);
  });
});

describe("producer schema — required preference", () => {
  it("rejects a document missing max-one-shift-per-day", () => {
    const doc = docFrom();
    doc.preferences = doc.preferences.filter((p) => p.type !== "at most one shift per day");
    expect(issuesFor(doc).some((m) => /Missing required preference/.test(m))).toBe(true);
  });
});
