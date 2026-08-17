// Per-scenario writer-lease validation — the fence every durable write passes.
//
// The lease is authoritative because it is PERSISTED and checked inside the same
// IndexedDB transaction as the write it guards. A BroadcastChannel takeover
// message is only a hint; a frozen or disconnected former owner never sees it, and
// that is exactly the case these checks exist for. Its next write presents a stale
// epoch and fails closed.
//
// Timing follows the tech plan: heartbeat every 5s, expiry at 20s. Fast enough
// that an active owner is obvious, bounded enough that a crashed tab's lease
// recovers without a user having to know what a lease is.

import { RepositoryError } from "./errors";
import type { LeaseOwner, ScenarioEnvelopeV3, WriterLeaseV2 } from "./types";

/** How often an owner is expected to renew (tech plan: 5 seconds). */
export const LEASE_HEARTBEAT_MS = 5_000;

/** How long a lease survives without a heartbeat (tech plan: 20 seconds). */
export const LEASE_TTL_MS = 20_000;

/** Whether a lease is still live at `now`. */
export function isLeaseLive(lease: WriterLeaseV2 | undefined, now: Date): lease is WriterLeaseV2 {
  return lease !== undefined && Date.parse(lease.expiresAt) > now.getTime();
}

/**
 * Assert that `owner` may write to `envelope`, throwing a typed failure otherwise.
 * Callers run this INSIDE the write transaction, never before it: a check that
 * happens outside the transaction is a race, not a fence.
 *
 * The rejections are deliberately distinct, because they need different
 * recoveries: no lease or another tab's lease means "reacquire or go read-only";
 * an expired own lease means "recover explicitly"; a stale epoch means "you were
 * taken over, drop every derived draft"; a scenario mismatch means the caller is
 * writing to something it did not read.
 *
 * ORDERING. The epoch-stale check runs BEFORE the tab-ownership check. A takeover
 * both changes `ownerTabId` AND increments `epoch`; if the tab check ran first, a
 * frozen former owner would learn only "another tab owns now" (`not_owner`) and
 * never the actionable "you were superseded" (`lease_epoch_stale`). The tech plan
 * requires that a taken-over owner's next persisted write "fails the epoch check",
 * so the caller learns to drop its drafts rather than attempt a reacquire.
 */
export function assertLeaseOwnership(
  lease: WriterLeaseV2 | undefined,
  envelope: ScenarioEnvelopeV3,
  owner: LeaseOwner,
  now: Date,
): WriterLeaseV2 {
  if (owner.scenarioId !== envelope.scenarioId) {
    throw new RepositoryError(
      "scenario_mismatch",
      "the presented lease names a different scenario than the envelope being written",
      { presented: owner.scenarioId, envelope: envelope.scenarioId },
    );
  }
  // A persisted epoch ahead of the caller's means the caller was superseded — by a
  // takeover or by an expiry-then-reacquire. This must be reported before the tab
  // check so the former owner gets the right recovery signal. (A random tab that
  // never owned anything also presents an epoch behind the persisted one; reporting
  // it as stale is harmless — it has no drafts to drop, and it still cannot write.)
  if (lease !== undefined && owner.epoch < lease.epoch) {
    throw new RepositoryError(
      "lease_epoch_stale",
      "the presented lease epoch has been superseded",
      {
        scenarioId: owner.scenarioId,
        presented: owner.epoch,
        persisted: lease.epoch,
      },
    );
  }
  if (envelope.acceptedLeaseEpoch > owner.epoch) {
    throw new RepositoryError(
      "lease_epoch_stale",
      "the envelope has accepted a newer lease epoch",
      {
        scenarioId: owner.scenarioId,
        presented: owner.epoch,
        accepted: envelope.acceptedLeaseEpoch,
      },
    );
  }
  if (lease === undefined || lease.ownerTabId !== owner.tabId) {
    throw new RepositoryError("not_owner", "this tab does not hold the scenario's writer lease", {
      scenarioId: owner.scenarioId,
      tabId: owner.tabId,
      heldBy: lease?.ownerTabId ?? null,
    });
  }
  if (lease.epoch !== owner.epoch) {
    // owner.epoch > lease.epoch here (the < branch above caught the other side).
    // The caller presents an epoch the persisted lease never granted — impossible
    // in normal flow. Fail closed rather than trusting a self-asserted epoch.
    throw new RepositoryError(
      "lease_epoch_stale",
      "the presented lease epoch has been superseded",
      {
        scenarioId: owner.scenarioId,
        presented: owner.epoch,
        persisted: lease.epoch,
      },
    );
  }
  if (Date.parse(lease.expiresAt) <= now.getTime()) {
    throw new RepositoryError("lease_expired", "the writer lease expired before this write", {
      scenarioId: owner.scenarioId,
      expiresAt: lease.expiresAt,
    });
  }
  return lease;
}

/** Build the renewed lease row for `now` (heartbeat, acquire, and takeover alike). */
export function renewedLease(
  lease: Omit<WriterLeaseV2, "heartbeatAt" | "expiresAt">,
  now: Date,
  ttlMs: number,
): WriterLeaseV2 {
  return {
    ...lease,
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}
