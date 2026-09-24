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
const CHANGE = { request: REQUEST, linked: { proposalId: "p-1", record: "leave" as const } };
const BORROW = { request: REQUEST, linked: { proposalId: "p-1", record: "staff" as const } };

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

  it("names the staff list for a borrowed nurse", async () => {
    const undone = deps({ awaitRosterChangeOutcome: async () => "rejected" as const });
    await expect(applyLinkedChange(BORROW, undone.d)).resolves.toEqual({
      ok: false,
      message:
        "Nothing was changed: the Roster screen refused the change. The staff list was put back too.",
    });
    const refused = deps({
      awaitRosterChangeOutcome: async () => "rejected" as const,
      undoReceipt: async () => false,
    });
    await expect(applyLinkedChange(BORROW, refused.d)).resolves.toEqual({
      ok: false,
      message:
        "The staff list was changed, but the roster was not: the Roster screen refused the change. Undo the added temporary nurse from the change list, or ask me again.",
    });
  });

  it("treats a thrown undo as a refused one", async () => {
    const { d } = deps({
      awaitRosterChangeOutcome: async () => "roster-changed" as const,
      undoReceipt: async () => {
        throw new Error("idb");
      },
    });
    const result = await applyLinkedChange(CHANGE, d);
    expect(result).toEqual({
      ok: false,
      message:
        "The leave record was changed, but the roster was not: the roster changed at the last moment. Undo the leave change from the change list, or ask me again.",
    });
  });

  it("undoes the schedule when the Roster screen does not open", async () => {
    const { d } = deps({ navigate: async () => false });
    const result = await applyLinkedChange(CHANGE, d);
    expect(d.requestRosterChange).not.toHaveBeenCalled();
    expect(d.undoReceipt).toHaveBeenCalledWith("r-1");
    expect(result).toEqual({
      ok: false,
      message:
        "Nothing was changed: the Roster screen could not be opened. The leave record was put back too.",
    });
  });

  it("undoes the schedule when opening the Roster screen throws", async () => {
    const { d } = deps({
      navigate: async () => {
        throw new Error("router");
      },
    });
    const result = await applyLinkedChange(CHANGE, d);
    expect(d.undoReceipt).toHaveBeenCalledWith("r-1");
    expect(result.ok).toBe(false);
  });

  it("applies a schedule-only change without the Roster screen", async () => {
    const { d, calls } = deps();
    await expect(applyLinkedChange({ ...BORROW, request: null }, d)).resolves.toEqual({
      ok: true,
    });
    expect(calls).toEqual(["applyProposal"]);
  });

  it("has nothing to put back when there is no linked change", async () => {
    const { d } = deps({ awaitRosterChangeOutcome: async () => "rejected" as const });
    const result = await applyLinkedChange({ request: REQUEST, linked: null }, d);
    expect(d.applyProposal).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      message: "Nothing was changed: the Roster screen refused the change.",
    });
  });
});
