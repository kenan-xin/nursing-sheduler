// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RosterDocument } from "@/lib/roster";
import {
  fixtureCanonicalDocument,
  fixtureRosterDocument,
  withEdits,
} from "@/lib/roster/test-fixtures";
import {
  requestRosterChange,
  useRosterChangeStore,
  type RosterChangeRequest,
} from "@/lib/roster/change-request";
import { applyRosterChange, useRosterChangeRequest } from "./use-roster-change-request";

const D = { kind: "shift", shiftId: "D" } as const;
const N = { kind: "shift", shiftId: "N" } as const;

// Fixture grid (test-fixtures.ts): P0 = [D, OFF, N, LEAVE], P1 = [N, D, OFF, D].
function swapDayZero(document: RosterDocument): RosterChangeRequest {
  return {
    solvedBaselineId: document.provenance.solvedBaselineId,
    cells: [
      { personIdx: 0, dateIdx: 0, before: D, after: N },
      { personIdx: 1, dateIdx: 0, before: N, after: D },
    ],
  };
}

beforeEach(() => useRosterChangeStore.setState({ pending: null, last: null }));

describe("applyRosterChange", () => {
  it("applies every cell as one batch when the roster still matches", async () => {
    const document = await fixtureRosterDocument();
    const applyCells = vi.fn(() => true);
    expect(applyRosterChange(document, swapDayZero(document), applyCells)).toBe("applied");
    expect(applyCells).toHaveBeenCalledWith(
      [
        { personIdx: 0, dateIdx: 0, day: N },
        { personIdx: 1, dateIdx: 0, day: D },
      ],
      undefined,
    );
  });

  it("refuses a request prepared on a different roster", async () => {
    const document = await fixtureRosterDocument();
    const applyCells = vi.fn(() => true);
    const request = { ...swapDayZero(document), solvedBaselineId: "0".repeat(64) };
    expect(applyRosterChange(document, request, applyCells)).toBe("roster-changed");
    expect(applyCells).not.toHaveBeenCalled();
  });

  it("refuses when a before cell changed", async () => {
    const document = await fixtureRosterDocument();
    const edited = withEdits(document, [{ personIdx: 0, dateIdx: 0, day: { kind: "off" } }]);
    const applyCells = vi.fn(() => true);
    expect(applyRosterChange(edited, swapDayZero(document), applyCells)).toBe("roster-changed");
    expect(applyCells).not.toHaveBeenCalled();
  });

  it("adds a borrowed nurse's row with her cells in the same batch (bead g1p)", async () => {
    // Her row is valid only against a scenario that declares the group it names
    // (bead 6yn), so the fixture's submitted people gain an `RN` group.
    const base = fixtureCanonicalDocument();
    const document = await fixtureRosterDocument({
      document: { ...base, people: { ...base.people, groups: [{ id: "RN", members: ["P1"] }] } },
    });
    const OFF = { kind: "off" } as const;
    const mei = { id: "Mei", groups: ["RN"], days: [OFF, OFF, OFF, OFF] };
    const request: RosterChangeRequest = {
      solvedBaselineId: document.provenance.solvedBaselineId,
      addPeople: [mei],
      peopleCount: 2,
      cells: [
        { personIdx: 0, dateIdx: 2, before: N, after: { kind: "leave" } },
        { personIdx: 2, dateIdx: 2, before: OFF, after: N },
      ],
    };
    const applyCells = vi.fn(() => true);
    expect(applyRosterChange(document, request, applyCells)).toBe("applied");
    expect(applyCells).toHaveBeenCalledWith(
      [
        { personIdx: 0, dateIdx: 2, day: { kind: "leave" } },
        { personIdx: 2, dateIdx: 2, day: N },
      ],
      [mei],
    );
    // Applied twice: she is already on the roster, so the card is stale.
    const withMei = { ...document, borrowed: [mei] };
    expect(applyRosterChange(withMei, request, applyCells)).toBe("roster-changed");
  });

  it("reports a batch the edit session rejected", async () => {
    const document = await fixtureRosterDocument();
    expect(applyRosterChange(document, swapDayZero(document), () => false)).toBe("rejected");
  });
});

describe("useRosterChangeRequest", () => {
  it("waits for the edit session to be ready, then applies once", async () => {
    const document = await fixtureRosterDocument();
    const applyCells = vi.fn(() => true);
    requestRosterChange(swapDayZero(document));
    const { rerender } = renderHook(
      ({ ready }) => useRosterChangeRequest({ ready, editedDocument: document, applyCells }),
      { initialProps: { ready: false } },
    );
    expect(applyCells).not.toHaveBeenCalled();
    expect(useRosterChangeStore.getState().pending).not.toBeNull();

    rerender({ ready: true });
    expect(applyCells).toHaveBeenCalledTimes(1);
    expect(useRosterChangeStore.getState()).toMatchObject({ pending: null, last: "applied" });
  });
});
