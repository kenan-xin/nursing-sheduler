"use client";

// A revocable identity for an in-flight Settings probe (C2F1, over T04 setup and
// T05 clear fencing).
//
// THE RACE THIS MODULE EXISTS TO CLOSE. "Save and test" contacts OpenRouter and then
// writes the probed pair to the settings row. Between those two moments the user can
// Remove the key, Clear all, turn AI off, or start a different replacement -- and
// every one of those is a promise that the credential is gone. Without an identity to
// compare, a probe that succeeds afterwards writes the captured key back, and the
// generation fence cannot help: the fence guards CONTENT writes, while this is a
// configuration write that no turn owns.
//
// SO A PROBE IS AN OPERATION, NOT A FETCH. {@link beginProbeOperation} mints one and
// supersedes any earlier one; {@link revokeProbeOperations} is called synchronously
// by every action that invalidates a pending probe, BEFORE it awaits anything. The
// activation write then compares the captured operation inside its own transaction
// (see `./settings-repo`), so a check that passed a moment earlier cannot authorise
// a write that lands after the revocation.
//
// IN-MEMORY ON PURPOSE. An operation only has to outlive a fetch, and a reload kills
// the fetch with it -- a durable operation table would be one more thing Clear all
// had to delete, for no case it could actually cover.

/** A claim on the right to activate a probed configuration. */
export interface ProbeOperation {
  /** Monotonic per page lifetime. Only the newest operation may activate. */
  epoch: number;
  /** Aborts when this operation is superseded or revoked. Pass it to the fetch. */
  signal: AbortSignal;
}

let epoch = 0;
let live: AbortController | null = null;

/**
 * Claim the next probe operation, revoking any earlier one.
 *
 * Synchronous, and it must stay that way: the caller mints the operation before its
 * first `await`, so nothing can slip between "the user asked to test" and "this is the
 * operation that asking created".
 */
export function beginProbeOperation(): ProbeOperation {
  revokeProbeOperations();
  live = new AbortController();
  return { epoch, signal: live.signal };
}

/**
 * Invalidate every in-flight probe and abort its request.
 *
 * Called by Remove key, Clear all, Disable and a fresh replacement. Synchronous by
 * contract: those actions all await durable work, and a revocation that only took
 * effect after that await would leave exactly the window it exists to close.
 */
export function revokeProbeOperations(): void {
  epoch += 1;
  live?.abort();
  live = null;
}

/** Whether `operation` is still the live claim. */
export function isProbeOperationCurrent(operation: ProbeOperation): boolean {
  return operation.epoch === epoch && !operation.signal.aborted;
}

/** Test seam: return the authority to its never-probed state. */
export function resetProbeAuthorityForTest(): void {
  live?.abort();
  live = null;
  epoch = 0;
}
