// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RosterDocument } from "@/lib/roster";
import { fixtureRosterDocument, withEdits } from "@/lib/roster/test-fixtures";
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
    expect(applyCells).toHaveBeenCalledWith([
      { personIdx: 0, dateIdx: 0, day: N },
      { personIdx: 1, dateIdx: 0, day: D },
    ]);
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
