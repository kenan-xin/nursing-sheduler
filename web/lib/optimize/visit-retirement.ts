"use client";

// G6.2 — the retirement lane.
//
// When a visit ends, its run is abandoned FROM THE USER'S POINT OF VIEW
// immediately: the attempt is revoked synchronously and no user-facing effect may
// follow. What is left over is invisible housekeeping, and this is it.
//
// The distinction that matters is authority. Everything here is scoped to the
// EXACT job and the EXACT owner the ending visit created, because those are the
// only two things it can name without guessing. Notably absent:
//
//   • no origin-wide sweep — `sessionStorage` is tab-scoped, but even within a tab
//     another run's record is not ours to touch;
//   • no guessed DELETE — destroying the server's sole artifact needs a capture
//     token, and an abandoned run that never captured has none;
//   • no promotion of failure — every step is best-effort and silent. A failed
//     retirement leaves residue that verified Clear owns, and it can never come
//     back as a message, a blocked button, or a resumed run.

import { purgeRetiredSubmissionSnapshot } from "./submission-snapshot";
import {
  removeOwnerSession,
  type RemoveOwnerSessionOutcome,
  type SessionTransactionStorage,
} from "./session-transaction";

export interface RetireAbandonedRunInput {
  /** The exact job the ending visit had accepted, or null when it never got one. */
  jobId: string | null;
  /** The exact transaction owner the ending visit staged, or null. */
  ownerId: string | null;
  /** Whether the run was still non-terminal when the visit ended. */
  stillRunning: boolean;
}

/** What the retirement actually managed to do. Reported, never rendered. */
export interface RetirementReport {
  cancel: "requested" | "skipped";
  snapshot: "purged" | "retained" | "none";
  record: RemoveOwnerSessionOutcome["status"] | "none";
}

export interface RetireAbandonedRunDeps {
  storage: SessionTransactionStorage;
  /** Best-effort exact-job cancel. Defaults to the same-origin control endpoint. */
  cancelJob?: (jobId: string) => Promise<void>;
  /** Defaults to the epoch-fenced exact-owner snapshot purge. */
  purgeSnapshot?: (ownerId: string) => Promise<{ status: "purged" | "pending" }>;
}

async function defaultCancelJob(jobId: string): Promise<void> {
  try {
    await fetch(`/api/optimize/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      cache: "no-store",
      // The visit is over; nothing is waiting on the answer, and the request must
      // survive the unmount that triggered it.
      keepalive: true,
    });
  } catch {
    // A cancel that does not land costs the backend one run it will finish and
    // then expire on its own retention. It is not worth a user-facing anything.
  }
}

/**
 * Retire one abandoned run. Total: it never throws and never rejects.
 *
 * Ordering is deliberate, and it is the OPPOSITE of the document-exit ordering
 * below. Here the snapshot is purged BEFORE the record is removed, because the
 * record's `capture.snapshotRef` is the only durable handle to that row — remove
 * the record first and a failed purge would leave the exact canonical YAML and the
 * real-identity reverse map in IndexedDB with nothing left able to name them.
 * Purge-first means a failure at either step leaves a residue that is still
 * addressable, and verified Clear can still reach it.
 *
 * That reasoning depends on the page surviving long enough to finish. When it does
 * not, use `retireOnDocumentExit`.
 */
export async function retireAbandonedRun(
  input: RetireAbandonedRunInput,
  deps: RetireAbandonedRunDeps,
): Promise<RetirementReport> {
  const report: RetirementReport = { cancel: "skipped", snapshot: "none", record: "none" };

  if (input.jobId !== null && input.stillRunning) {
    report.cancel = "requested";
    // Deliberately not awaited before the local work: the local cuts are what
    // protect the user's data, and they must not wait on the network.
    void (deps.cancelJob ?? defaultCancelJob)(input.jobId);
  }

  if (input.ownerId === null) return report;

  try {
    const purged = await (deps.purgeSnapshot ?? purgeRetiredSubmissionSnapshot)(input.ownerId);
    report.snapshot = purged.status === "purged" ? "purged" : "retained";
  } catch {
    report.snapshot = "retained";
  }

  try {
    report.record = removeOwnerSession(deps.storage, input.ownerId).status;
  } catch {
    report.record = "unverified";
  }

  return report;
}

/**
 * Retire an abandoned run when the DOCUMENT is going away — a reload, a typed
 * URL, a closed tab. Synchronous by construction; it returns a report, not a
 * promise, because nothing may depend on a continuation that will not run.
 *
 * THE ORDERING IS INVERTED, and that is the entire point. `retireAbandonedRun`
 * purges the snapshot first so the record can still name it on failure. On this
 * path there is no "on failure" — an awaited IndexedDB purge is simply not
 * guaranteed to resume once the page is being torn down, so putting it first
 * means the owner-keyed session record, and the real-identity reverse map it
 * carries, can survive a reload entirely. Between "the reverse map may outlive the
 * visit" and "the snapshot row may outlive the visit", only the first is a
 * surprise: verified Clear already owns unproven snapshot residue, and says so.
 *
 * So: cut the record synchronously, then FIRE the purge without awaiting it. It
 * often completes; when it does not, what is left is exactly the residue Clear is
 * documented to reclaim. `ownerId` is captured by the fired call, so the purge
 * still names the right row even though nothing is holding the record any more.
 */
export function retireOnDocumentExit(
  input: RetireAbandonedRunInput,
  deps: RetireAbandonedRunDeps,
): RetirementReport {
  const report: RetirementReport = { cancel: "skipped", snapshot: "none", record: "none" };

  if (input.ownerId !== null) {
    // FIRST, and synchronously. Everything else on this path is best-effort.
    try {
      report.record = removeOwnerSession(deps.storage, input.ownerId).status;
    } catch {
      report.record = "unverified";
    }

    // Fired, never awaited. A `pagehide` handler that awaits is a handler that
    // does not finish.
    report.snapshot = "retained";
    try {
      void (deps.purgeSnapshot ?? purgeRetiredSubmissionSnapshot)(input.ownerId).catch(() => {});
    } catch {
      // Storage unreachable. Clear reclaims the row.
    }
  }

  if (input.jobId !== null && input.stillRunning) {
    report.cancel = "requested";
    // `keepalive` is what gives this a chance of leaving at all during teardown.
    void (deps.cancelJob ?? defaultCancelJob)(input.jobId);
  }

  return report;
}
