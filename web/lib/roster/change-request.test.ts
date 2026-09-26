import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureRosterDocument, withEdits } from "./test-fixtures";
import {
  ROSTER_CHANGE_TTL_MS,
  awaitRosterChangeOutcome,
  readRosterChangeOutcome,
  reportRosterChange,
  requestRosterChange,
  requestStillMatches,
  takeRosterChangeRequest,
  useRosterChangeStore,
  type RosterChangeRequest,
} from "./change-request";

const REQUEST: RosterChangeRequest = {
  solvedBaselineId: "b".repeat(64),
  cells: [
    { personIdx: 0, dateIdx: 1, before: { kind: "shift", shiftId: "N" }, after: { kind: "off" } },
  ],
};

beforeEach(() => useRosterChangeStore.setState({ pending: null, last: null }));

describe("the roster change request seam", () => {
  it("hands a fresh request to the Roster screen exactly once", () => {
    requestRosterChange(REQUEST, 1_000);
    expect(takeRosterChangeRequest(2_000)).toEqual(REQUEST);
    expect(takeRosterChangeRequest(2_001)).toBeNull();
  });

  it("expires rather than applying on a later visit", () => {
    requestRosterChange(REQUEST, 1_000);
    expect(takeRosterChangeRequest(1_000 + ROSTER_CHANGE_TTL_MS + 1)).toBeNull();
    expect(useRosterChangeStore.getState().last).toBe("expired");
  });

  it("reports a request nobody took as expired when read late", () => {
    requestRosterChange(REQUEST, 1_000);
    expect(readRosterChangeOutcome(1_000 + ROSTER_CHANGE_TTL_MS + 1)).toBe("expired");
    expect(useRosterChangeStore.getState().pending).toBeNull();
  });

  it("records what the screen did, and a new request clears it", () => {
    reportRosterChange("applied");
    expect(readRosterChangeOutcome()).toBe("applied");
    requestRosterChange(REQUEST);
    expect(useRosterChangeStore.getState().last).toBeNull();
  });
});

describe("requestStillMatches", () => {
  it("is true only while every before cell and the baseline still hold", async () => {
    const document = await fixtureRosterDocument();
    const request = {
      solvedBaselineId: document.provenance.solvedBaselineId,
      cells: [
        {
          personIdx: 0,
          dateIdx: 0,
          before: { kind: "shift", shiftId: "D" } as const,
          after: { kind: "off" } as const,
        },
      ],
    };
    expect(requestStillMatches(document, request)).toBe(true);
    expect(
      requestStillMatches(
        withEdits(document, [{ personIdx: 0, dateIdx: 0, day: { kind: "off" } }]),
        request,
      ),
    ).toBe(false);
    expect(requestStillMatches(document, { ...request, solvedBaselineId: "0".repeat(64) })).toBe(
      false,
    );
  });

  it("refuses a temporary-nurse card when another temporary nurse was added first (bead g1p)", async () => {
    const document = await fixtureRosterDocument();
    const OFF = { kind: "off" } as const;
    const N = { kind: "shift", shiftId: "N" } as const;
    const row = (id: string) => ({ id, groups: [], days: [OFF, OFF, OFF, OFF] });
    // Both cards read a 2-person roster, so both address row 2 for their nurse.
    const card = (id: string): RosterChangeRequest => ({
      solvedBaselineId: document.provenance.solvedBaselineId,
      peopleCount: 2,
      addPeople: [row(id)],
      cells: [{ personIdx: 2, dateIdx: 1, before: OFF, after: N }],
    });
    expect(requestStillMatches(document, card("Mei"))).toBe(true);
    // Mei is applied: row 2 is now Mei, all off. Lin's stale card would put her
    // night on Mei's row, so it must be refused.
    const withMei = { ...document, borrowed: [row("Mei")] };
    expect(requestStillMatches(withMei, card("Lin"))).toBe(false);
    // A card rebuilt on the new roster addresses row 3 and is accepted.
    const fresh = {
      ...card("Lin"),
      peopleCount: 3,
      cells: [{ personIdx: 3, dateIdx: 1, before: OFF, after: N }],
    };
    expect(requestStillMatches(withMei, fresh)).toBe(true);
  });
});

describe("awaitRosterChangeOutcome", () => {
  it("resolves with what the Roster screen reported", async () => {
    requestRosterChange(REQUEST);
    const outcome = awaitRosterChangeOutcome();
    reportRosterChange("applied");
    await expect(outcome).resolves.toBe("applied");
  });

  it("resolves expired when nobody took the request", async () => {
    vi.useFakeTimers();
    requestRosterChange(REQUEST, Date.now());
    const outcome = awaitRosterChangeOutcome();
    vi.advanceTimersByTime(ROSTER_CHANGE_TTL_MS + 100);
    await expect(outcome).resolves.toBe("expired");
    vi.useRealTimers();
  });
});
