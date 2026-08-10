"use client";

// G6.2 — the visit/attempt authority.
//
// The problem this exists for: `useOptimizeTerminal` guarded its work with a
// `mountedRef`, which only suppresses React state after unmount. Everything else
// in the asynchronous terminal chain — the XLSX fetch, `saveBlob`, the `/roster`
// fetch, the candidate commit, the DELETE — carried on regardless. So leaving the
// route mid-run could still hand the user a file download for a run they had
// walked away from, and the app-lifetime capture gate is keyed only by job, so it
// had no way to know the visit that started the work was over.
//
// An attempt is the unit of user-facing authority. It is created when a visit
// starts a run and revoked SYNCHRONOUSLY on unmount or on a later deliberate
// click. Revocation is the linearization point: after it returns, no user-facing
// effect may be started. Two lanes follow from that, and only one is fenced:
//
//   • USER-FACING — state dispatch, polling, `saveBlob`, roster fetch/assembly,
//     candidate commit, capture notices, result/CTA publication. Forbidden after
//     revocation, without exception.
//   • RETIREMENT — an exact-job cancel, joining a DELETE that already holds a
//     token, and removing that exact owner's record/snapshot. Allowed to
//     continue, because it is invisible and scoped to the run being abandoned.
//
// The `AbortSignal` is the transport half of the same idea. Aborting is not a
// failure to report: a stale attempt's abort is silence, because the user has
// already moved on and an error card for work they abandoned is noise at best.
//
// One thing no browser API can undo: a download that has already been invoked.
// The contract is therefore stated precisely — no call to the download primitive
// may be made after revocation linearizes; a call already made is not retracted.

/** The authority one visit's run holds over user-facing effects. */
export interface VisitAttempt {
  /** Monotonic within the registry — higher always means newer. */
  readonly id: number;
  /** Aborted synchronously by `revoke`. Thread through cancellable transport. */
  readonly signal: AbortSignal;
  /** True only while this is still the registry's current attempt. */
  isCurrent(): boolean;
  /** The owner this attempt staged, once staging has allocated one. */
  ownerId(): string | null;
  claimOwner(ownerId: string): void;
}

export interface AttemptRegistry {
  /**
   * Revoke the current attempt (if any) and become the new current one.
   *
   * Synchronous by contract: a caller must be able to say "after this returns,
   * nothing the old attempt does can reach the user", with no await in between.
   */
  start(): VisitAttempt;
  /** The live attempt, or null when none is running. */
  current(): VisitAttempt | null;
  /** Revoke the current attempt without starting a successor (route exit). */
  revoke(): VisitAttempt | null;
}

/**
 * Whether an error is a stale-attempt abort rather than a real failure.
 *
 * `fetch` rejects with a `DOMException` named `AbortError`; some environments
 * surface a plain `Error` with the same name, so the name is what is matched.
 * Callers use this to stay SILENT instead of rendering a capture/download error
 * for work the user deliberately walked away from.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: unknown }).name === "AbortError";
}

export function createAttemptRegistry(): AttemptRegistry {
  let counter = 0;
  let live: { attempt: VisitAttempt; controller: AbortController } | null = null;

  function revokeLive(): VisitAttempt | null {
    if (live === null) return null;
    const revoked = live.attempt;
    const { controller } = live;
    // Clear the slot BEFORE aborting. `abort()` runs listeners synchronously, and
    // a listener that asks `isCurrent()` must already see the truth — otherwise
    // the very handler reacting to revocation could still believe it is live.
    live = null;
    controller.abort();
    return revoked;
  }

  return {
    start() {
      revokeLive();
      counter += 1;
      const id = counter;
      const controller = new AbortController();
      let owner: string | null = null;
      const attempt: VisitAttempt = {
        id,
        signal: controller.signal,
        isCurrent: () => live !== null && live.attempt.id === id,
        ownerId: () => owner,
        claimOwner: (ownerId: string) => {
          // Write-once: an attempt owns exactly one staged submission, and a second
          // claim would silently re-point retirement at the wrong record.
          if (owner === null) owner = ownerId;
        },
      };
      live = { attempt, controller };
      return attempt;
    },
    current: () => live?.attempt ?? null,
    revoke: revokeLive,
  };
}
