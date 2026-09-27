import { afterEach, describe, expect, it, vi } from "vitest";
import { priyaRosterDocument } from "@/lib/roster-viewer/swap-fixtures";
import { clearChangeHighlight, useChangeHighlightStore } from "@/lib/change-highlight/store";
import type { CoverEditRun } from "@/lib/scenario/cover-edit-request";
import type { ProposalDiffEntry } from "@/lib/proposal";
import { applyLinkedChange, type LinkedApplyDeps, type LinkedProposal } from "./linked-apply";

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

const COVER_KEY = "cover:Haseena (Ward 3)|2026-10-14|N";
const LEAVE_KEY = "cell:priya|2026-10-14";
function entry(key: string, scope: ProposalDiffEntry["scope"]): ProposalDiffEntry {
  return { key, scope, label: key, before: null, after: "x", kind: "created" };
}
/** A plain leave proposal: no cover, so it applies without the Staff screen. */
const LEAVE_PROPOSAL: LinkedProposal = {
  scenarioId: "s-1",
  baseDocumentRevision: 4,
  baseCommitId: "c-4",
  status: "preview_ready",
  commands: [
    { type: "add_leave", personId: "priya", startDate: "2026-10-14", endDate: "2026-10-14" },
  ],
  diff: {
    direct: [entry(LEAVE_KEY, "leave-and-requests")],
    cascade: [],
    capabilityIds: [],
    needsReview: [],
  },
};
/** The cover ladder's linked proposal: a cover plus the asking nurse's leave. */
const COVER_PROPOSAL: LinkedProposal = {
  ...LEAVE_PROPOSAL,
  commands: [
    {
      type: "add_temporary_cover",
      name: "Haseena (Ward 3)",
      date: "2026-10-14",
      shiftType: "N",
      groups: [],
    },
    ...LEAVE_PROPOSAL.commands,
  ],
  diff: {
    ...LEAVE_PROPOSAL.diff,
    direct: [entry(COVER_KEY, "staff-list"), entry(LEAVE_KEY, "leave-and-requests")],
  },
};
const BASIS = { scenarioId: "s-1", documentRevision: 4, topCommitId: "c-4" };

afterEach(() => clearChangeHighlight());

function deps(overrides: Partial<LinkedApplyDeps> = {}, proposal = LEAVE_PROPOSAL) {
  const calls: string[] = [];
  let run: CoverEditRun | null = null;
  const d: LinkedApplyDeps = {
    readRoster: vi.fn(async () => {
      calls.push("readRoster");
      return document;
    }),
    readProposal: vi.fn(async () => {
      calls.push("readProposal");
      return proposal;
    }),
    readBasis: vi.fn(async () => BASIS),
    requestCoverEdit: vi.fn((next: CoverEditRun) => {
      calls.push("requestCoverEdit");
      run = next;
    }),
    // The Staff form presses its own Save, which runs the proposal's one Apply.
    awaitCoverEditOutcome: vi.fn(async () => {
      calls.push("awaitCover");
      const saved = await run!.commit();
      return saved.ok ? ("applied" as const) : ("rejected" as const);
    }),
    applyProposal: vi.fn(async () => {
      calls.push("applyProposal");
      return { ok: true as const, receiptId: "r-1" };
    }),
    undoReceipt: vi.fn(async () => {
      calls.push("undoReceipt");
      return true;
    }),
    navigate: vi.fn(async (capabilityId: string) => {
      calls.push(`navigate:${capabilityId}`);
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
      "readProposal",
      "applyProposal",
      "navigate:roster-viewer",
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

  it("names the temporary cover for a borrowed nurse", async () => {
    const undone = deps({ awaitRosterChangeOutcome: async () => "rejected" as const });
    await expect(applyLinkedChange(BORROW, undone.d)).resolves.toEqual({
      ok: false,
      message:
        "Nothing was changed: the Roster screen refused the change. The temporary cover was put back too.",
    });
    const refused = deps({
      awaitRosterChangeOutcome: async () => "rejected" as const,
      undoReceipt: async () => false,
    });
    await expect(applyLinkedChange(BORROW, refused.d)).resolves.toEqual({
      ok: false,
      message:
        "The temporary cover was changed, but the roster was not: the Roster screen refused the change. Undo the temporary cover from the change list, or ask me again.",
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
    expect(calls).toEqual(["readProposal", "applyProposal"]);
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

  it("a linked cover + leave proposal walks Staff then Requests, then the roster", async () => {
    const { d, calls } = deps({}, COVER_PROPOSAL);
    await expect(applyLinkedChange(BORROW, d)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      "readRoster",
      "readProposal",
      "navigate:staff-list",
      "requestCoverEdit",
      "awaitCover",
      "applyProposal",
      "navigate:leave-and-requests",
      "navigate:roster-viewer",
      "requestRosterChange",
      "await",
    ]);
    expect(run(d).edits).toEqual([
      {
        kind: "add",
        entry: { name: "Haseena (Ward 3)", date: "2026-10-14", shiftType: "N", groups: [] },
      },
    ]);
    // The last screen walked before the roster outlines its own rows.
    expect([...useChangeHighlightStore.getState().keys]).toEqual([LEAVE_KEY]);
  });

  it("a stale Preview writes nothing and never opens Staff", async () => {
    const { d } = deps(
      { readBasis: async () => ({ ...BASIS, documentRevision: 5 }) },
      COVER_PROPOSAL,
    );
    await expect(applyLinkedChange(BORROW, d)).resolves.toEqual({
      ok: false,
      message: "Nothing was changed: the schedule changed after this was prepared. Ask again.",
    });
    expect(d.navigate).not.toHaveBeenCalled();
    expect(d.applyProposal).not.toHaveBeenCalled();
  });

  it("a Staff form that refuses the cover writes nothing", async () => {
    const { d } = deps({ awaitCoverEditOutcome: async () => "rejected" as const }, COVER_PROPOSAL);
    await expect(applyLinkedChange(BORROW, d)).resolves.toEqual({
      ok: false,
      message:
        "Nothing was changed: the Staff screen did not save the temporary cover. The reason is shown there.",
    });
    expect(d.applyProposal).not.toHaveBeenCalled();
    expect(d.requestRosterChange).not.toHaveBeenCalled();
  });
});

function run(d: LinkedApplyDeps): CoverEditRun {
  return vi.mocked(d.requestCoverEdit).mock.calls[0][0];
}
