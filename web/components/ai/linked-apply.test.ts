import { describe, expect, it, vi } from "vitest";
import { priyaRosterDocument } from "@/lib/roster-viewer/swap-fixtures";
import { applyLinkedChange, type LinkedApplyDeps } from "./linked-apply";

const document = priyaRosterDocument();
const REQUEST = {
  solvedBaselineId: document.provenance.solvedBaselineId,
  cells: [
    {
      personIdx: 0,
      dateIdx: 1,
      before: { kind: "shift", shiftId: "N" } as const,
      after: { kind: "off" } as const,
    },
  ],
};
const CHANGE = { request: REQUEST, linked: { proposalId: "p-1" } };

function deps(overrides: Partial<LinkedApplyDeps> = {}) {
  const calls: string[] = [];
  const d: LinkedApplyDeps = {
    readRoster: vi.fn(async () => {
      calls.push("readRoster");
      return document;
    }),
    applyProposal: vi.fn(async () => {
      calls.push("applyProposal");
      return { ok: true as const, receiptId: "r-1" };
    }),
    undoReceipt: vi.fn(async () => {
      calls.push("undoReceipt");
      return true;
    }),
    navigate: vi.fn(async () => {
      calls.push("navigate");
      return true;
    }),
    requestRosterChange: vi.fn(() => {
      calls.push("requestRosterChange");
    }),
    awaitRosterChangeOutcome: vi.fn(async () => {
      calls.push("await");
      return "applied" as const;
    }),
    ...overrides,
  };
  return { d, calls };
}

describe("applyLinkedChange", () => {
  it("checks the roster, applies the schedule, then the roster", async () => {
    const { d, calls } = deps();
    await expect(applyLinkedChange(CHANGE, d)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      "readRoster",
      "applyProposal",
      "navigate",
      "requestRosterChange",
      "await",
    ]);
  });

  it("touches nothing when the roster changed since the card", async () => {
    const { d } = deps({
      readRoster: async () => ({
        ...document,
        edits: [{ personIdx: 0, dateIdx: 1, day: { kind: "off" } }],
      }),
    });
    const result = await applyLinkedChange(CHANGE, d);
    expect(result).toEqual({
      ok: false,
      message: "Nothing was changed: the roster changed after this was prepared. Ask again.",
    });
    expect(d.applyProposal).not.toHaveBeenCalled();
  });

  it("stops before the roster when the schedule refuses", async () => {
    const { d } = deps({
      applyProposal: async () => ({ ok: false as const, reason: "confirmation-missing" }),
    });
    const result = await applyLinkedChange(CHANGE, d);
    expect(result.ok).toBe(false);
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it("undoes the leave move when the roster refuses", async () => {
    const { d } = deps({ awaitRosterChangeOutcome: async () => "roster-changed" as const });
    const result = await applyLinkedChange(CHANGE, d);
    expect(d.undoReceipt).toHaveBeenCalledWith("r-1");
    expect(result).toEqual({
      ok: false,
      message:
        "Nothing was changed: the roster changed at the last moment. The leave record was put back too.",
    });
  });

  it("says so plainly when that undo is refused", async () => {
    const { d } = deps({
      awaitRosterChangeOutcome: async () => "expired" as const,
      undoReceipt: async () => false,
    });
    const result = await applyLinkedChange(CHANGE, d);
    expect(result).toEqual({
      ok: false,
      message:
        "The leave record was changed, but the roster was not: the Roster screen did not open in time. Undo the leave change from the change list, or ask me again.",
    });
  });
});
