// The repository-owned, bounded, session-scoped Undo/Redo history.
//
// WHY NOT ZUNDO. zundo's stack lives in process memory in one tab. It cannot
// survive a reload, cannot be checked against a durable revision, and cannot be
// written in the same transaction as the change it reverses — so a receipt saying
// "Undo available" could be describing a stack another tab already invalidated.
// This history is durable, fenced, and written transactionally with its commit.
//
// THE MODEL. Commits are append-only facts. Undo/Redo are NEW commits, never a
// rewind of a counter. Position is a CURSOR on the envelope:
//
//     content = commits in the current session where `isContent` and not superseded
//     historyCursor = how many of them are currently applied
//
//   • Undo    — revert content[cursor-1], cursor--
//   • Redo    — reapply content[cursor],   cursor++
//   • Commit  — supersede content[cursor..] (they stay as facts, they leave the
//               cursor list), append, cursor = new length
//
// TWO SEPARATE BOUNDS, and they are not the same thing:
//   • the 50-entry session bound evicts old reversal PAYLOADS (`pruned`);
//   • a reload mints a new session and invalidates every prior payload
//     (`expired-session`).
// Both leave the commit facts, the history links, and every receipt intact. That
// is the whole point: "you can no longer undo this" and "this never happened" must
// never be the same durable state.

import { Dexie } from "dexie";
import type { NurseSchedulerDb } from "./schema";
import type { ScenarioCommitV1 } from "./types";

/** Reversal payloads retained per history session (tech plan: 50 entries). */
export const HISTORY_LIMIT = 50;

/**
 * Every commit of one session, ordered by `sessionSeq`. Ordering comes from the
 * compound index range scan, so it is never re-derived from timestamps (which can
 * tie) or insertion order (which IndexedDB does not promise).
 */
export async function readSessionCommits(
  db: NurseSchedulerDb,
  scenarioId: string,
  historySessionId: string,
): Promise<ScenarioCommitV1[]> {
  return db.scenarioCommits
    .where("[scenarioId+historySessionId+sessionSeq]")
    .between(
      [scenarioId, historySessionId, Dexie.minKey],
      [scenarioId, historySessionId, Dexie.maxKey],
    )
    .toArray();
}

/** The cursor list: live content commits of the session, in order. */
export function contentCommits(commits: readonly ScenarioCommitV1[]): ScenarioCommitV1[] {
  return commits.filter((commit) => commit.isContent && commit.supersededAt === null);
}

/** The next `sessionSeq` for a session (0 for its first commit). */
export function nextSessionSeq(commits: readonly ScenarioCommitV1[]): number {
  return commits.reduce((max, commit) => Math.max(max, commit.sessionSeq + 1), 0);
}

/** What Undo/Redo a caller may currently offer for a session. */
export interface HistoryAvailability {
  undoAvailable: boolean;
  redoAvailable: boolean;
  /** The commit Undo would revert — the receipt "Undo available" test. */
  undoTargetCommitId: string | null;
  redoTargetCommitId: string | null;
  contentCount: number;
  historyCursor: number;
}

/**
 * Derive availability rather than store it, so it can never drift from the facts.
 *
 * Availability requires a LIVE payload, not merely a commit at the cursor: a
 * pruned or session-expired entry is a real commit whose reversal material is
 * gone, and reporting it as undoable would promise a restore the repository
 * cannot perform.
 */
export function describeHistory(
  commits: readonly ScenarioCommitV1[],
  historyCursor: number,
): HistoryAvailability {
  const content = contentCommits(commits);
  const undoTarget = historyCursor > 0 ? content[historyCursor - 1] : undefined;
  const redoTarget = historyCursor < content.length ? content[historyCursor] : undefined;
  return {
    undoAvailable: undoTarget?.payloadState === "live",
    redoAvailable: redoTarget?.payloadState === "live",
    undoTargetCommitId: undoTarget?.payloadState === "live" ? undoTarget.commitId : null,
    redoTargetCommitId: redoTarget?.payloadState === "live" ? redoTarget.commitId : null,
    contentCount: content.length,
    historyCursor,
  };
}

/**
 * Enforce the per-session payload bound after a content commit landed. Only the
 * oldest payloads beyond the limit are dropped; the commit rows themselves are
 * never deleted, so the cursor arithmetic above is unaffected and history reads
 * stay complete.
 */
export async function pruneSessionPayloads(
  db: NurseSchedulerDb,
  content: readonly ScenarioCommitV1[],
  limit: number,
): Promise<void> {
  const live = content.filter((commit) => commit.payloadState === "live");
  const excess = live.length - limit;
  if (excess <= 0) return;
  for (const commit of live.slice(0, excess)) {
    await db.scenarioCommits.update(commit.commitId, {
      reversiblePayload: null,
      payloadState: "pruned",
    });
  }
}
