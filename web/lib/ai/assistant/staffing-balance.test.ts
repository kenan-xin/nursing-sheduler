import { describe, expect, it } from "vitest";
import { cards, leave, people, requirement, ward } from "@/lib/rules/ward-fixtures.test-support";
import type { RequirementCard } from "@/lib/scenario";
import { computeStaffingBalance } from "./staffing-balance";

// The 2026-09-28 transcript ward, neutral ids: 13 nurses, 6 shifts, 8 people a day at
// the minimums (M 2, M_sup 1, A 2, A_sup 0, N 2, N_sup 1).
const transcriptWard = (
  end: string,
  extra: Partial<Record<string, Partial<RequirementCard>>> = {},
) =>
  ward({
    rangeStart: "2026-10-01",
    rangeEnd: end,
    staff: people("S1", "S2", "S3", "S4", "S5", "R1", "R2", "R3", "R4", "R5", "R6", "E1", "E2"),
    shifts: ["M", "M_sup", "A", "A_sup", "N", "N_sup"].map((id) => ({ id })),
    cardsByKind: cards({
      requirements: (
        [
          ["M", 2],
          ["M_sup", 1],
          ["A", 2],
          ["A_sup", 0],
          ["N", 2],
          ["N_sup", 1],
        ] as const
      ).map(([shift, n]) => requirement(shift, shift, n, extra[shift])),
    }),
  });

describe("computeStaffingBalance (4h5a)", () => {
  it("shows the transcript's exact counts leave 38 shifts spare and make 8 days off impossible", () => {
    const balance = computeStaffingBalance(transcriptWard("2026-10-31"))!;
    expect(balance).toMatchObject({
      days: 31,
      staff: 13,
      minimumShifts: 248,
      mostShifts: 248,
      shiftsEach: 22,
      capacity: 286,
      spareShifts: 38,
      fewestOffDaysEach: 11.9,
      estimated: true,
    });
    // No contracts yet: the capacity is an assumption, said as "about".
    expect(balance.sentence).toContain("about 286 shifts of working time");
    expect(balance.sentence).toContain("13 nurses assumed full time (22 shifts each");
    expect(balance.sentence).toContain("at least 248 shifts (8 a day)");
    expect(balance.sentence).toContain("about 38 shifts spare");
    expect(balance.sentence).toContain("31 − 248 ÷ 13 = 11.9 days off");
  });

  it("takes each nurse's leave and hard days off out of her working time", () => {
    const state = transcriptWard("2026-10-31");
    state.reqData = [
      ...["01", "02", "03", "04", "05"].map((d) => leave("S1", `2026-10-${d}`)),
      { uid: "r1-off-1", person: "R1", date: "2026-10-10", kind: "off", weight: Infinity },
      { uid: "r1-off-2", person: "R1", date: "2026-10-11", kind: "off", weight: Infinity },
      { uid: "r2-soft", person: "R2", date: "2026-10-12", kind: "off", weight: 5 },
    ];
    // S1: 26 days x 5/7 = 19; R1: 29 x 5/7 = 21; a soft day off is not away.
    expect(computeStaffingBalance(state)).toMatchObject({ capacity: 11 * 22 + 19 + 21 });
  });

  it("uses each nurse's contract instead of the full-time guess", () => {
    const state = transcriptWard("2026-10-31");
    const ids = state.staff.map((p) => String(p.id));
    state.cardsByKind.counts = [
      {
        uid: "contract",
        description: "Contract",
        person: ids,
        countDates: ["ALL"],
        countShiftTypes: [...state.shifts.map((s) => String(s.id)), "LEAVE"],
        countShiftTypeCoefficients: [...state.shifts.map((s) => String(s.id)), "LEAVE"].map(
          (id) => [id, 16] as [string, number],
        ),
        expression: ["x >= T", "x <= T"],
        target: [21 * 16, 23 * 16],
        weight: Infinity,
        tag: "contracted_hours",
        policy: "range",
        unit: "half-hour",
      },
    ];
    state.reqData = ["01", "02", "03", "04", "05"].map((d) => leave("S1", `2026-10-${d}`));
    const balance = computeStaffingBalance(state)!;
    // 22 days each; S1's 5 leave days count toward her contract, so she works 17.
    expect(balance).toMatchObject({ capacity: 12 * 22 + 17, estimated: false });
    expect(balance.sentence).not.toMatch(/about|assumed/);
    expect(balance.sentence).toContain("281 shifts of working time");
  });

  it("lets 'ideally' counts raise the most shifts the numbers allow", () => {
    const balance = computeStaffingBalance(
      transcriptWard("2026-10-28", {
        M: { preferredNumPeople: 3, weight: -200 },
        A_sup: { preferredNumPeople: 1, weight: -300 },
      }),
    )!;
    expect(balance).toMatchObject({
      days: 28,
      minimumShifts: 224,
      mostShifts: 280,
      shiftsEach: 20,
      capacity: 260,
      spareShifts: 36,
      fewestOffDaysEach: 6.5,
    });
  });

  it("has no ceiling while a worked shift has no staffing requirement", () => {
    const state = transcriptWard("2026-10-31");
    state.cardsByKind.requirements = state.cardsByKind.requirements.filter(
      (card) => card.uid !== "N_sup",
    );
    const balance = computeStaffingBalance(state)!;
    expect(balance.minimumShifts).toBe(217);
    expect(balance.mostShifts).toBeNull();
    expect(balance.fewestOffDaysEach).toBeNull();
  });

  it("skips a turned-off requirement, and is null before there are dates, staff and numbers", () => {
    const state = transcriptWard("2026-10-31");
    state.cardsByKind.requirements[0] = { ...state.cardsByKind.requirements[0], disabled: true };
    expect(computeStaffingBalance(state)!.minimumShifts).toBe(248 - 62);
    expect(computeStaffingBalance(ward())).toBeNull();
  });
});
