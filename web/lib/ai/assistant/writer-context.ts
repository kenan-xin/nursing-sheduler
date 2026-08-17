// The authoritative writer context a send must present (T04).
//
// A scenario thread may not send until its tab OWNS scenario editing. This module
// answers that question the same way the Optimize preflight does -- from PERSISTED
// state, never from the projection -- because a peer takeover whose
// BroadcastChannel hint was delayed leaves the projection still claiming
// ownership, and only the lease row disagrees.
//
// It additionally reads the lease EPOCH, which the ownership helper does not
// expose, because the turn record has to be stamped with the fencing token that
// authorised it: that is what lets a late tool result be refused after a takeover
// rather than published against a document this tab no longer owns.

import { readAuthoritativeScenarioOwnership, resolveTabId } from "@/lib/store";
import { isLeaseLive } from "@/lib/repository";
import type { ScenarioUiState } from "@/lib/scenario";
import { getAssistantDb } from "./db";

export interface WriterContext {
  scenarioId: string;
  documentRevision: number;
  leaseEpoch: number;
  /**
   * The scenario content as PERSISTED, read in the same pass as the revision it
   * is labelled with.
   *
   * Deliberately not the live projection: the projection is published after a
   * commit, so reading content from one place and the revision from another could
   * send a document under a revision that does not describe it. Taking both from
   * the envelope makes that mismatch unrepresentable.
   */
  scenario: ScenarioUiState;
}

export interface WriterContextDeps {
  readOwnership?: typeof readAuthoritativeScenarioOwnership;
  tabId?: () => string;
  now?: () => Date;
}

/**
 * The scenario identity, revision and lease epoch this tab may currently write
 * under, or `null` when it may not.
 *
 * `null` covers every refusal for one reason: from the caller's point of view
 * "there is no scenario selected", "another tab owns it", "the lease expired" and
 * "the lease row names a different tab" all mean the same thing -- do not send.
 * The UI reports the distinction from the ownership banner the app already has.
 */
export async function readWriterContext(
  deps: WriterContextDeps = {},
): Promise<WriterContext | null> {
  const readOwnership = deps.readOwnership ?? readAuthoritativeScenarioOwnership;
  const tabId = (deps.tabId ?? resolveTabId)();
  const at = deps.now?.() ?? new Date();

  const ownership = await readOwnership();
  if (!ownership || !ownership.isOwner) return null;

  const db = getAssistantDb();
  // One transaction over the lease and the envelope, so the epoch, the revision
  // and the content cannot come from three different moments. `isOwner` above is
  // re-checked here rather than trusted: the two reads are separate transactions,
  // and a takeover landing between them must fail the send.
  return db.transaction("r", ["writerLeases", "scenarioEnvelopes"], async () => {
    const lease = await db.writerLeases.get(ownership.scenarioId);
    if (!lease || lease.ownerTabId !== tabId || !isLeaseLive(lease, at)) return null;

    const envelope = await db.scenarioEnvelopes.get(ownership.scenarioId);
    if (!envelope) return null;

    return {
      scenarioId: envelope.scenarioId,
      documentRevision: envelope.documentRevision,
      leaseEpoch: lease.epoch,
      scenario: envelope.scenario,
    };
  });
}
