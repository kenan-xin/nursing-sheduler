// The quick-paint reconciliation, without the store (extracted from `paint.ts`).
//
// `paint.test.ts` still proves the gesture end to end through the command bus; this
// suite pins the pure fold the assistant's leave/request arms share with the page,
// including the one seam the extraction added: new cells get their uid from the
// injected minter.

import { describe, expect, it } from "vitest";
import type { UiRequestCell } from "@/lib/scenario";
import { foldPaintIntents, type MintCellUid } from "./paint-fold";
import { paintCellKey, type StagedCoordinate } from "./types";

const mint: MintCellUid = (person, date, selector) =>
  `new:${String(person)}:${String(date)}:${selector}`;

function stage(entries: [person: string, date: string, intent: StagedCoordinate][]) {
  return new Map(entries.map(([person, date, intent]) => [paintCellKey(person, date), intent]));
}

describe("foldPaintIntents", () => {
  it("mints brand-new cells through the injected minter and keeps a prior day-state uid", () => {
    const reqData: UiRequestCell[] = [
      { uid: "old-leave", kind: "leave", person: "ana", date: "02" },
    ];
    const next = foldPaintIntents(
      reqData,
      stage([
        ["ana", "02", { mode: "day-state", dayState: { kind: "off", weight: 5 } }],
        ["ana", "03", { mode: "day-state", dayState: { kind: "leave" } }],
        ["bo", "03", { mode: "requests", deltas: new Map([["N", -5]]) }],
      ]),
      mint,
    );
    expect(next).toEqual([
      { uid: "old-leave", kind: "off", person: "ana", date: "02", weight: 5 },
      { uid: "new:ana:03:leave", kind: "leave", person: "ana", date: "03" },
      {
        uid: "new:bo:03:request:N",
        kind: "request",
        person: "bo",
        date: "03",
        shiftType: "N",
        weight: -5,
      },
    ]);
  });

  it("skips request deltas on a leave day, and weight 0 removes a request", () => {
    const reqData: UiRequestCell[] = [
      { uid: "l", kind: "leave", person: "ana", date: "02" },
      { uid: "r", kind: "request", person: "ana", date: "03", shiftType: "D", weight: 3 },
    ];
    const next = foldPaintIntents(
      reqData,
      stage([
        ["ana", "02", { mode: "requests", deltas: new Map([["N", 5]]) }],
        ["ana", "03", { mode: "requests", deltas: new Map([["D", 0]]) }],
      ]),
      mint,
    );
    expect(next).toEqual([{ uid: "l", kind: "leave", person: "ana", date: "02" }]);
  });

  it("erases a whole coordinate and leaves other coordinates verbatim", () => {
    const reqData: UiRequestCell[] = [
      { uid: "l", kind: "leave", person: "ana", date: "02" },
      { uid: "o", kind: "off", person: "bo", date: "02", weight: 1 },
    ];
    const next = foldPaintIntents(reqData, stage([["ana", "02", { mode: "erase" }]]), mint);
    expect(next).toEqual([{ uid: "o", kind: "off", person: "bo", date: "02", weight: 1 }]);
  });
});
