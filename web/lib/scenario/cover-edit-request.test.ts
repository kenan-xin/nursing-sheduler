import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COVER_EDIT_TTL_MS,
  awaitCoverEditOutcome,
  reportCoverEdit,
  requestCoverEdit,
  takeCoverEditRequest,
  useCoverEditStore,
  type CoverEditRun,
} from "./cover-edit-request";

const RUN: CoverEditRun = {
  edits: [
    {
      kind: "add",
      entry: { name: "Haseena (Ward 3)", date: "2026-10-14", shiftType: "N", groups: [] },
    },
  ],
  commit: async () => ({ ok: true }),
};

beforeEach(() => {
  vi.useRealTimers();
  useCoverEditStore.setState({ pending: null, taken: false, last: null });
});

describe("the cover edit request seam", () => {
  it("hands a fresh request to the Staff screen exactly once", () => {
    requestCoverEdit(RUN, 1_000);
    expect(takeCoverEditRequest(2_000)).toEqual(RUN);
    expect(takeCoverEditRequest(2_001)).toBeNull();
  });

  it("expires rather than editing on a later visit", () => {
    requestCoverEdit(RUN, 1_000);
    expect(takeCoverEditRequest(1_000 + COVER_EDIT_TTL_MS + 1)).toBeNull();
    expect(useCoverEditStore.getState().last).toBe("expired");
  });

  it("resolves with what the form reported", async () => {
    requestCoverEdit(RUN);
    const outcome = awaitCoverEditOutcome(1_000);
    takeCoverEditRequest();
    reportCoverEdit("rejected");
    await expect(outcome).resolves.toBe("rejected");
  });

  it("expires when nobody took the request in time", async () => {
    vi.useFakeTimers();
    requestCoverEdit(RUN);
    const outcome = awaitCoverEditOutcome(1_000);
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(outcome).resolves.toBe("expired");
    expect(useCoverEditStore.getState().pending).toBeNull();
  });

  it("keeps waiting once the form took the request, so a slow Save is never called expired", async () => {
    vi.useFakeTimers();
    requestCoverEdit(RUN);
    const outcome = awaitCoverEditOutcome(1_000);
    takeCoverEditRequest();
    await vi.advanceTimersByTimeAsync(5_000);
    reportCoverEdit("applied");
    await expect(outcome).resolves.toBe("applied");
  });
});
