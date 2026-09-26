// @vitest-environment jsdom

// Deterministic tests for the roster editing hook's authority transitions (F5
// fixup): the pre-initialization buffer (P1 — an edit before the queue is ready
// is buffered and flushed, never lost), the replacement-coordinator settlement,
// and the clear-time invalidation.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { rosterStorage } from "@/lib/store";
import {
  resetSession,
  type EditCoordinate,
  type RosterDayState,
  type RosterDocument,
} from "@/lib/roster";
import type { RosterChangeRequest } from "@/lib/roster/change-request";
import { fixtureCanonicalDocument, fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import { applyRosterChange } from "./use-roster-change-request";
import { useRosterEditing } from "./use-roster-editing";

let dbSeq = 0;

async function seedWorking(): Promise<{ document: RosterDocument; revision: number }> {
  // The borrowed (temporary) nurse's row names the RN group, so the fixture's own
  // submitted scenario declares it — a group the staffing rules can count (bead 6yn).
  const base = fixtureCanonicalDocument();
  const document = await fixtureRosterDocument({
    document: { ...base, people: { ...base.people, groups: [{ id: "RN", members: ["P1"] }] } },
  });
  const epoch = await rosterStorage.getClearEpoch();
  // A whole document is a replacement, so it goes through promotion; the edit
  // operation is for later revisions of this same roster.
  const outcome = await rosterStorage.promoteDocumentToWorking({
    document,
    validate: (value) => ({ ok: true as const, document: value as RosterDocument }),
    expectedWorkingRevision: null,
    expectedClearEpoch: epoch,
  });
  if (outcome.status !== "promoted") throw new Error("seed failed");
  return { document, revision: outcome.revision };
}

beforeEach(async () => {
  // Clear the singleton so each test starts from a clean epoch + empty working row.
  await rosterStorage.clearRosterData();
  dbSeq += 1;
  void dbSeq;
});

afterEach(cleanup);

describe("useRosterEditing — pre-initialization buffer (P1 guard)", () => {
  it("an edit committed before the queue is ready is buffered and flushed, never lost", async () => {
    const { document, revision } = await seedWorking();
    const reload = async () => {};

    const { result } = renderHook(() => useRosterEditing({ document, revision, reload }));

    // The queue is not ready yet (the async epoch read has not completed).
    expect(result.current.ready).toBe(false);

    // A fast edit before readiness: the visible session updates, and the document
    // is BUFFERED (not dropped — the P1 closure finding).
    const coord: EditCoordinate = { personIdx: 0, dateIdx: 0 };
    const day: RosterDayState = { kind: "shift", shiftId: "N" };
    act(() => {
      result.current.setCell(coord, day);
    });
    // The visible document reflects the edit even before the queue is ready.
    expect(result.current.editedDocument.edits.length).toBeGreaterThan(0);

    // Once the queue becomes ready, the buffered edit is flushed to storage.
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    // The edit persisted — it was not lost while the authority was initializing.
    await waitFor(async () => {
      const reloaded = await rosterStorage.readWorking<RosterDocument>();
      expect(reloaded?.document.edits.length).toBeGreaterThan(0);
    });
  });

  it("ready flips true once the autosave authority is initialized", async () => {
    const { document, revision } = await seedWorking();
    const { result } = renderHook(() =>
      useRosterEditing({ document, revision, reload: async () => {} }),
    );
    expect(result.current.ready).toBe(false);
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    // Once ready, the editing surface is interactive (no visible-but-unsaved cut).
    expect(result.current.selectedCell).toBeNull();
  });
});

describe("useRosterEditing — replacement coordinator settlement", () => {
  it("settleReplacement resolves 'clean' when the queue is idle", async () => {
    const { document, revision } = await seedWorking();
    const { result } = renderHook(() =>
      useRosterEditing({ document, revision, reload: async () => {} }),
    );
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    const settled = await result.current.settleReplacement();
    expect(settled).toBe("clean");
  });

  it("resetAfterReplacement clears the cell selection", async () => {
    const { document, revision } = await seedWorking();
    const { result } = renderHook(() =>
      useRosterEditing({ document, revision, reload: async () => {} }),
    );
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    act(() => {
      result.current.selectCell({ personIdx: 0, dateIdx: 0 });
    });
    expect(result.current.selectedCell).toEqual({ personIdx: 0, dateIdx: 0 });
    act(() => {
      result.current.resetAfterReplacement();
    });
    expect(result.current.selectedCell).toBeNull();
  });

  it("invalidateForClear disposes the queue (no dirty state, no loss guard)", async () => {
    const { document, revision } = await seedWorking();
    const { result } = renderHook(() =>
      useRosterEditing({ document, revision, reload: async () => {} }),
    );
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    act(() => {
      result.current.invalidateForClear();
    });
    // After invalidation, a subsequent edit buffers again (the queue is gone) —
    // the authority was torn down, matching the pre-initialization state.
    act(() => {
      result.current.setCell({ personIdx: 0, dateIdx: 0 }, { kind: "shift", shiftId: "N" });
    });
    expect(result.current.ready).toBe(false);
    void resetSession;
  });
});

describe("applyCells", () => {
  it("applies a batch as one undo step", async () => {
    const { document, revision } = await seedWorking();
    const { result } = renderHook(() =>
      useRosterEditing({ document, revision, reload: async () => {} }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    let applied = false;
    act(() => {
      applied = result.current.applyCells([
        { personIdx: 0, dateIdx: 0, day: { kind: "shift", shiftId: "N" } },
        { personIdx: 1, dateIdx: 0, day: { kind: "shift", shiftId: "D" } },
      ]);
    });
    expect(applied).toBe(true);
    expect(result.current.editedDocument.edits).toHaveLength(2);
    act(() => result.current.undo());
    expect(result.current.editedDocument.edits).toEqual([]);
  });

  it("adds a borrowed row and its cells in one autosaved revision (bead g1p)", async () => {
    const { document, revision } = await seedWorking();
    const { result } = renderHook(() =>
      useRosterEditing({ document, revision, reload: async () => {} }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    const OFF = { kind: "off" } as const;
    const N = { kind: "shift", shiftId: "N" } as const;
    const mei = { id: "Mei", groups: ["RN"], days: [OFF, OFF, OFF, OFF] };
    act(() => {
      expect(result.current.applyCells([{ personIdx: 2, dateIdx: 1, day: N }], [mei])).toBe(true);
    });
    expect(result.current.editedDocument.borrowed).toEqual([mei]);
    expect(result.current.editedDocument.edits).toEqual([{ personIdx: 2, dateIdx: 1, day: N }]);
    await waitFor(async () => {
      const saved = await rosterStorage.readWorking<RosterDocument>();
      expect(saved?.document.borrowed).toEqual([mei]);
      expect(saved?.document.edits).toHaveLength(1);
    });
    // Her cells are ordinary edits: a hand edit on her row works like any other.
    act(() => result.current.setCell({ personIdx: 2, dateIdx: 1 }, OFF));
    expect(result.current.editedDocument.edits).toEqual([]);
  });

  it("undo of the Apply that added a borrowed row removes the row too (bead 2rp)", async () => {
    const { document, revision } = await seedWorking();
    const { result } = renderHook(() =>
      useRosterEditing({ document, revision, reload: async () => {} }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    const OFF = { kind: "off" } as const;
    const N = { kind: "shift", shiftId: "N" } as const;
    const mei = { id: "Mei", groups: ["RN"], days: [OFF, OFF, OFF, OFF] };
    const request: RosterChangeRequest = {
      solvedBaselineId: document.provenance.solvedBaselineId,
      addPeople: [mei],
      peopleCount: 2,
      cells: [{ personIdx: 2, dateIdx: 1, before: OFF, after: N }],
    };
    act(() => {
      expect(
        applyRosterChange(result.current.editedDocument, request, result.current.applyCells),
      ).toBe("applied");
    });
    act(() => result.current.undo());
    expect(result.current.editedDocument.borrowed).toEqual([]);
    expect(result.current.editedDocument.edits).toEqual([]);
    await waitFor(async () => {
      const saved = await rosterStorage.readWorking<RosterDocument>();
      expect(saved?.document.borrowed).toEqual([]);
      expect(saved?.document.edits).toEqual([]);
    });
    // Asking again for her is not refused as "roster changed".
    act(() => {
      expect(
        applyRosterChange(result.current.editedDocument, request, result.current.applyCells),
      ).toBe("applied");
    });
    expect(result.current.editedDocument.borrowed).toEqual([mei]);
  });

  it("undo of a hand edit after the Apply keeps the borrowed row", async () => {
    const { document, revision } = await seedWorking();
    const { result } = renderHook(() =>
      useRosterEditing({ document, revision, reload: async () => {} }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    const OFF = { kind: "off" } as const;
    const N = { kind: "shift", shiftId: "N" } as const;
    const mei = { id: "Mei", groups: ["RN"], days: [OFF, OFF, OFF, OFF] };
    act(() => {
      result.current.applyCells([{ personIdx: 2, dateIdx: 1, day: N }], [mei]);
    });
    act(() => result.current.setCell({ personIdx: 2, dateIdx: 2 }, N));
    act(() => result.current.undo());
    expect(result.current.editedDocument.borrowed).toEqual([mei]);
    expect(result.current.editedDocument.edits).toEqual([{ personIdx: 2, dateIdx: 1, day: N }]);
  });

  it("rejects cells on a row that does not exist", async () => {
    const { document, revision } = await seedWorking();
    const { result } = renderHook(() =>
      useRosterEditing({ document, revision, reload: async () => {} }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => {
      expect(result.current.applyCells([{ personIdx: 2, dateIdx: 1, day: { kind: "off" } }])).toBe(
        false,
      );
    });
  });
});
