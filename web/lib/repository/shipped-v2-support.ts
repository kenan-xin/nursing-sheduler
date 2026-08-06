// A FROZEN transcript of the database the app actually shipped at commit c283b72,
// plus the legacy rows a browser sitting on that build really holds. Not a test
// file (vitest collects `*.test.ts` only), so it may be imported freely.
//
// WHY IT IS NOT `NurseSchedulerDb`. That class declares version 3 today, so
// opening it creates a v3 database outright and the 2 -> 3 upgrade never runs. A
// test built that way proves only that the current declaration is self-consistent
// — exactly the thing that cannot fail. Seeding through the historical
// declaration is what makes an upgrade test an upgrade test.
//
// It lives here, shared, so there is exactly ONE frozen transcript: a second copy
// would drift, and a drifted "shipped" shape proves nothing about real browsers.

import { Dexie } from "dexie";
import type { OptimizeBasisRecordV1 } from "@/lib/optimize/basis/basis-row";

/** Verbatim transcript of the shipped v2 store declaration (commit c283b72). */
export const SHIPPED_V2_STORES: Readonly<Record<string, string>> = {
  scenarioEnvelopes: "scenarioId, updatedAt",
  tabSelections: "tabId, scenarioId",
  writerLeases: "scenarioId, ownerTabId, expiresAt",
  scenarioCommits:
    "commitId, scenarioId, [scenarioId+historySessionId+sessionSeq], [scenarioId+documentRevision], &idempotencyKey",
  historyLinks: "++seq, scenarioId, sourceCommitId, linkCommitId",
  assistantGenerations: "scopeKey",
  assistantProposals: "proposalId, scenarioId, status",
  assistantReceipts: "receiptId, scenarioId, proposalId, commitId",
  optimizeBases: "basisId, scenarioId, [scenarioId+documentRevision], expiresAt",
  repositoryMeta: "key",
};

/**
 * A basis row exactly as a pre-T08 build wrote it: `schemaVersion: 1`, carrying
 * `semanticBasisDigest` and none of the V2 fields — no `ownerKind`, no `basis`, no
 * `submittedYaml`. This shape is the whole reason readers must discriminate: the
 * upgrade deliberately does not rewrite rows, so it survives byte for byte.
 */
export function shippedV1BasisRow(
  over: Partial<OptimizeBasisRecordV1> & { basisId: string },
): OptimizeBasisRecordV1 {
  return {
    schemaVersion: 1,
    scenarioId: "scenario-1",
    documentRevision: 7,
    submissionDigest: "a".repeat(64),
    semanticBasisDigest: "sha256:legacy-semantic-basis",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * Open `dbName` at the historical v1+v2 declaration so a caller can seed genuinely
 * legacy rows. The caller closes it: two live Dexie connections to one database
 * would let a write land after a later reader's snapshot.
 */
export async function openShippedV2Database(
  dbName: string,
  stores: Readonly<Record<string, string>> = SHIPPED_V2_STORES,
): Promise<Dexie> {
  const db = new Dexie(dbName);
  db.version(1).stores({ keyval: "key" });
  db.version(2).stores({ ...stores });
  await db.open();
  if (db.verno !== 2) {
    throw new Error(`seeded database must really be at version 2, got ${db.verno}`);
  }
  return db;
}
