// The app-lifetime owner of the production roster capture gate (F2).
//
// The gate holds per-job state that MUST outlive any React tree: the coalesced
// in-flight promise, the already-fetched container a `commit-failed` retry reuses
// instead of spending a second `/roster` call, and the cleanup tokens that are the
// sole DELETE authority. Owning it in a component ref survives rerenders but NOT
// navigation away from and back to the Optimize route — the remount would build a
// second gate that knows nothing about the first, so an open flight could be
// duplicated and a retryable failure would silently lose its bytes-in-hand state.
//
// Module scope is the correct lifetime here: it is the app, and it is reachable
// from non-React callers (F5's Clear) without a handle on any component.
//
// This module is React-free on purpose so F5 can import the Clear entry point
// without pulling in the hook.

import {
  createRosterCapture,
  type RosterCaptureDeps,
  type RosterCaptureGate,
} from "./roster-capture";
import { productionCandidateBuilder } from "./roster-candidate-builder";

/** The collaborators a caller may substitute when the gate is first created. */
export interface RosterCaptureGateDeps {
  /** Defaults to F3's assembler through `./roster-candidate-builder`. */
  buildCandidate?: RosterCaptureDeps["buildCandidate"];
  /** Defaults to the app-wide F1 repositories. */
  store?: RosterCaptureDeps["store"];
  /** Defaults to the B3 `/roster` proxy client. */
  fetchRoster?: RosterCaptureDeps["fetchRoster"];
}

/**
 * Per-job terminal-cleanup coordination, owned at the SAME lifetime as the
 * capture tokens it consumes.
 *
 * The cleanup token survives navigation because the gate does. If the DELETE
 * coalescer did not, an unmount/remount would leave two coalescers that cannot
 * see each other: the old route's async chain finishing its cleanup and the
 * remounted route's manual Download/Dismiss would each read the same still-valid
 * token and each start a DELETE. Authority and consumption therefore live
 * together.
 */
export interface CleanupCoordinator {
  /**
   * Run, join, or replay the single cleanup for one job.
   *
   * A settled TERMINAL result is replayed without re-running; an in-flight one is
   * joined; anything else starts a new attempt. `isTerminal` decides which results
   * are final (a failed cleanup must stay retryable). Generic over the result so
   * this module stays independent of the terminal hook's phase type.
   */
  run<TResult>(
    jobId: string,
    perform: () => Promise<TResult>,
    isTerminal: (result: TResult) => boolean,
  ): Promise<TResult>;
  /** The settled terminal result for a job, or null when none has been reached. */
  settled<TResult>(jobId: string): TResult | null;
  /**
   * Record that the SERVER half of `jobId`'s cleanup is confirmed.
   *
   * Cleanup is two required halves and only the pair is terminal, so a run whose
   * DELETE succeeded but whose local record removal could not be proven stays
   * retryable — and without this, every retry would re-issue a DELETE the server
   * has already confirmed. Kept at the same app lifetime as the tokens so the
   * memory survives the remount a retry usually arrives from.
   */
  markServerDeleted(jobId: string): void;
  /** Whether this job's server DELETE has already been confirmed. */
  serverDeleted(jobId: string): boolean;
}

function createCleanupCoordinator(): CleanupCoordinator {
  const inFlight = new Map<string, Promise<unknown>>();
  const done = new Map<string, unknown>();
  const serverDeleted = new Set<string>();
  return {
    run(jobId, perform, isTerminal) {
      if (done.has(jobId)) return Promise.resolve(done.get(jobId) as never);
      const running = inFlight.get(jobId);
      if (running) return running as Promise<never>;

      const attempt = (async () => {
        const result = await perform();
        if (isTerminal(result)) done.set(jobId, result);
        return result;
      })().finally(() => {
        inFlight.delete(jobId);
      });
      inFlight.set(jobId, attempt);
      return attempt as Promise<never>;
    },
    settled(jobId) {
      return (done.get(jobId) ?? null) as never;
    },
    markServerDeleted(jobId) {
      serverDeleted.add(jobId);
    },
    serverDeleted(jobId) {
      return serverDeleted.has(jobId);
    },
  };
}

let appGate: RosterCaptureGate | null = null;
let appCleanup: CleanupCoordinator | null = null;

/**
 * The one app-lifetime capture gate, created on first use.
 *
 * FIRST CALL WINS for `deps`: later calls return the existing gate and ignore
 * their arguments, because swapping a live gate's storage or assembler underneath
 * an open flight is never what a caller wants. In production every call passes
 * nothing anyway; a test that needs different collaborators resets first.
 */
export function getRosterCaptureGate(deps?: RosterCaptureGateDeps): RosterCaptureGate {
  if (appGate === null) {
    appGate = createRosterCapture({
      buildCandidate: deps?.buildCandidate ?? productionCandidateBuilder,
      store: deps?.store,
      fetchRoster: deps?.fetchRoster,
    });
  }
  return appGate;
}

/** The one app-lifetime cleanup coordinator, created on first use. */
export function getCleanupCoordinator(): CleanupCoordinator {
  if (appCleanup === null) appCleanup = createCleanupCoordinator();
  return appCleanup;
}

/**
 * Drop ALL app-lifetime capture state — the gate and the cleanup coordinator.
 *
 * TEST ISOLATION ONLY. Neither has a production teardown: per-job tokens and
 * cleanup results must survive every unmount so a remounted screen cannot
 * re-authorize a DELETE for a job it already cleaned up. Tests call this between
 * cases so one test's captured jobs are not visible to the next.
 */
export function resetRosterCaptureGate(): void {
  appGate = null;
  appCleanup = null;
}

/**
 * Invalidate every unresolved capture after a VERIFIED Clear.
 *
 * F5 calls this immediately after `rosterStorage.clearRosterData()` reports
 * `cleared`. Order matters: F1 advances the epoch in its own committed transaction
 * first, so any capture still in flight is already fenced at the storage layer;
 * this settles the gate's in-memory states so the UI stops offering Retry on data
 * that no longer exists. A no-op when no capture has ever run.
 *
 * It reaches the gate directly rather than through a mounted component, so a Clear
 * triggered while the Optimize route is unmounted still takes effect.
 */
export async function notifyRosterCaptureCleared(): Promise<void> {
  await appGate?.notifyCleared();
}
