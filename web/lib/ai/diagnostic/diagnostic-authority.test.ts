// The diagnostic runtime's EFFECT boundaries, proved by absence.
//
// The tool handler's before/after guard was never the problem: a search is the
// longest thing the assistant does, and the effects that matter -- a solver POST, a
// durable row, a card publication -- all happen INSIDE it. Withholding the eventual
// sentence while those already landed is not fencing, it is an apology. So every
// assertion here is about a call that must not have been made.

import { beforeEach, describe, expect, it, vi } from "vitest";

const putDiagnosticSearch = vi.fn(async () => {});
const putOptimizeBasis = vi.fn(async () => {});
const bindOptimizeBasisJob = vi.fn(async () => null);
const postOptimizeJob = vi.fn(async () => ({ id: "job-1" }));
const postCancelOptimizeJob = vi.fn(async () => {});
const registerOwnedDiagnosticJob = vi.fn();
const unregisterOwnedDiagnosticJob = vi.fn();

vi.mock("@/lib/store/spine", () => ({
  getScenarioAuthority: () => ({
    putDiagnosticSearch,
    putOptimizeBasis,
    bindOptimizeBasisJob,
    captureGenerationsForDiagnostics: async () => [],
    readOptimizeBasis: async () => null,
  }),
}));

vi.mock("@/lib/query/optimize", () => ({
  postOptimizeJob,
  pollOptimizeJobUntilTerminal: async () => ({}),
  postCancelOptimizeJob,
}));

vi.mock("./diagnostic-canceller", () => ({
  registerOwnedDiagnosticJob,
  unregisterOwnedDiagnosticJob,
}));

const { createDiagnosticRuntime, DiagnosticAuthorityRevokedError } =
  await import("./diagnostic-runtime");

const SEARCH = { searchId: "search-1" } as never;
const BASIS = { basisId: "basis-1" } as never;

/** A runtime whose authority can be revoked between calls. */
function runtimeWith(authorized: { value: boolean }, publish = vi.fn()) {
  return {
    runtime: createDiagnosticRuntime({
      turnEpoch: 1,
      threadId: "thread-1",
      scenarioId: "scenario-1",
      isTurnActive: () => authorized.value,
      authorize: () => authorized.value,
      publish,
    }),
    publish,
  };
}

beforeEach(() => {
  putDiagnosticSearch.mockClear();
  putOptimizeBasis.mockClear();
  bindOptimizeBasisJob.mockClear();
  postOptimizeJob.mockClear();
  postCancelOptimizeJob.mockClear();
  registerOwnedDiagnosticJob.mockClear();
  unregisterOwnedDiagnosticJob.mockClear();
});

describe("a revoked turn reaches no effect", () => {
  it("submits no solver job", async () => {
    const { runtime } = runtimeWith({ value: false });

    await expect(
      runtime.submitDiagnostic({ yaml: "x", timeoutSeconds: 90, basis: {} } as never),
    ).rejects.toBeInstanceOf(DiagnosticAuthorityRevokedError);

    // The whole point: backend capacity is never spent on a document nobody is
    // waiting for any more.
    expect(postOptimizeJob).not.toHaveBeenCalled();
  });

  it("writes no durable search row and publishes no card", async () => {
    const { runtime, publish } = runtimeWith({ value: false });

    await expect(runtime.putSearch(SEARCH, undefined as never)).rejects.toBeInstanceOf(
      DiagnosticAuthorityRevokedError,
    );

    expect(putDiagnosticSearch).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("writes no basis row", async () => {
    const { runtime } = runtimeWith({ value: false });

    await expect(runtime.putBasis(BASIS)).rejects.toBeInstanceOf(DiagnosticAuthorityRevokedError);

    expect(putOptimizeBasis).not.toHaveBeenCalled();
  });

  it("publishes no card when authority is lost DURING the durable write", async () => {
    // The narrow window the boundary checks exist for: the write was authorised, the
    // await gave the user time to take the schedule over, and the card must not then
    // animate a search belonging to a turn that is gone.
    const authorized = { value: true };
    const publish = vi.fn();
    putDiagnosticSearch.mockImplementationOnce(async () => {
      authorized.value = false;
    });
    const { runtime } = runtimeWith(authorized, publish);

    await expect(runtime.putSearch(SEARCH, undefined as never)).rejects.toBeInstanceOf(
      DiagnosticAuthorityRevokedError,
    );

    // The write happened -- it was authorised when it was made.
    expect(putDiagnosticSearch).toHaveBeenCalledTimes(1);
    // The publication did not.
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("revocation while the Optimize POST is in flight", () => {
  /** Revoke authority from inside the POST, i.e. while it is pending. */
  function revokingDuringPost(authorized: { value: boolean }) {
    postOptimizeJob.mockImplementationOnce(async () => {
      authorized.value = false;
      return { id: "job-1" };
    });
  }

  it.each(["a revision change", "a takeover", "Stop", "Disable", "Clear"])(
    "owns and cancels the accepted job, and writes nothing, after %s",
    async () => {
      // Every one of these causes reaches the runtime the same way -- as `authorize()`
      // turning false -- so they are one boundary with five names. What matters is that
      // the job the backend already accepted is neither orphaned nor built upon.
      const authorized = { value: true };
      revokingDuringPost(authorized);
      const { runtime, publish } = runtimeWith(authorized);

      await expect(
        runtime.submitDiagnostic({ yaml: "x", timeoutSeconds: 90, basis: {} } as never),
      ).rejects.toBeInstanceOf(DiagnosticAuthorityRevokedError);

      // Owned the instant it was accepted -- before the authority decision, so it can
      // never be a job nothing in this browser knows about.
      expect(registerOwnedDiagnosticJob).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-1" }),
      );
      // And cancellation was requested for it.
      expect(postCancelOptimizeJob).toHaveBeenCalledWith("job-1");
      // Nothing was recorded or shown.
      expect(putOptimizeBasis).not.toHaveBeenCalled();
      expect(putDiagnosticSearch).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("keeps the job owned when cancellation itself fails, rather than orphaning it", async () => {
    // A cancellation that cannot be confirmed is exactly the case the interruption
    // contract calls detached-but-owned. Dropping ownership here would turn it into a
    // job no Stop can ever reach.
    const authorized = { value: true };
    revokingDuringPost(authorized);
    postCancelOptimizeJob.mockRejectedValueOnce(new Error("backend unreachable"));
    const { runtime } = runtimeWith(authorized);

    await expect(
      runtime.submitDiagnostic({ yaml: "x", timeoutSeconds: 90, basis: {} } as never),
    ).rejects.toBeInstanceOf(DiagnosticAuthorityRevokedError);

    expect(registerOwnedDiagnosticJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1" }),
    );
    expect(unregisterOwnedDiagnosticJob).not.toHaveBeenCalled();
  });

  it("binds no accepted basis after revocation", async () => {
    // The write the orchestrator makes immediately after an accepted job.
    const { runtime } = runtimeWith({ value: false });

    await expect(
      runtime.bindAcceptedCandidateBasis("basis-1", (() => true) as never),
    ).rejects.toBeInstanceOf(DiagnosticAuthorityRevokedError);

    expect(bindOptimizeBasisJob).not.toHaveBeenCalled();
  });
});

describe("an authorised turn still reaches every effect", () => {
  it("submits, writes and publishes -- so the assertions above are not vacuous", async () => {
    const { runtime, publish } = runtimeWith({ value: true });

    await runtime.submitDiagnostic({ yaml: "x", timeoutSeconds: 90, basis: {} } as never);
    await runtime.putSearch(SEARCH, undefined as never);
    await runtime.putBasis(BASIS);

    expect(postOptimizeJob).toHaveBeenCalledTimes(1);
    expect(putDiagnosticSearch).toHaveBeenCalledTimes(1);
    expect(putOptimizeBasis).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
