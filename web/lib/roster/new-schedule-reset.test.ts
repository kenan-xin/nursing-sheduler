// @vitest-environment jsdom
//
// `New schedule` full-reset proofs (G4 closure).
//
// The defect these exist for: `New schedule` reset only the scenario, so the
// previous run's roster, candidates, submission snapshots and optimize session
// record all survived it — and the Optimize route went on announcing
// `The roster for this run could not be saved … Not Found` inside what the user
// had been told was a brand-new schedule.
//
// So the assertions are about STORED STATE, read back from a real IndexedDB
// (fake-indexeddb) and a real sessionStorage through the PRODUCTION Clear
// orchestrator — not about whether a notice was hidden. `clearStoredData` is bound
// to a per-tab database, exactly as the F5 proof matrix does it, so a regression in
// `clearRosterDataAndNotify` turns these red.
//
// `resetScenario` is the one injected half: the real scenario reset against the
// live stores is proved at the component level (`new-schedule-button.test.tsx`),
// while here it is a spy, which is what lets the ORDER and the fail-closed
// "scenario untouched" guarantee be asserted at all.

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioPersistenceDb } from "@/lib/store/dexie-storage";
import { createRosterStorageForDb, type RosterStorage } from "@/lib/store/roster-storage";
import {
  OPTIMIZE_RETIRE_PENDING_STORAGE_KEY,
  OPTIMIZE_SESSION_STORAGE_KEY,
  resetRosterCaptureGate,
  type SessionTransactionStorage,
} from "@/lib/optimize";
import type { CommandFailureReason, CommandOutcome } from "@/lib/store";
import { clearRosterDataAndNotify } from "./roster-clear";
import { resetToNewSchedule } from "./new-schedule-reset";
import { fixtureRosterDocument } from "./test-fixtures";
import type { RosterDocument } from "./types";

let dbCounter = 0;
function openTab(): RosterStorage {
  const db = new ScenarioPersistenceDb(`new-schedule-reset-${dbCounter++}`);
  return createRosterStorageForDb(() => db);
}

function fakeSessionStorage(seed: Record<string, string> = {}): SessionTransactionStorage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    // Enumerable: Clear sweeps every optimize key by prefix now, not one named key.
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
  };
}

/** The session residue a completed run leaves behind, including the reverse map. */
function seededSession(): SessionTransactionStorage {
  return fakeSessionStorage({
    [OPTIMIZE_SESSION_STORAGE_KEY]: JSON.stringify({
      schemaVersion: 1,
      ownerId: "owner-1",
      reverseMap: [["P1", "Real Name"]],
      phase: "active",
      jobId: "job-1",
    }),
    [OPTIMIZE_RETIRE_PENDING_STORAGE_KEY]: JSON.stringify({ schemaVersion: 1, ownerId: "owner-1" }),
  });
}

/**
 * Seed every surface the previous run leaves behind: a working roster, a durable
 * candidate + pointer, and a staged submission snapshot.
 */
async function seedPreviousRun(storage: RosterStorage) {
  const document = await fixtureRosterDocument();
  const epoch = await storage.getClearEpoch();
  await storage.allocateSubmissionSnapshot({
    ownerId: "owner-1",
    payload: { canonicalYaml: "people: [P1]", reverseMap: [["P1", "Real Name"]] },
    expectedClearEpoch: epoch,
  });
  // The commit fills the empty working slot itself, which is exactly the state a
  // completed run leaves: a populated viewer AND a durable candidate.
  const commit = await storage.commitCandidate<RosterDocument>({
    jobId: "job-1",
    submissionOrdinal: 1,
    document,
    expectedClearEpoch: epoch,
  });
  expect(commit).toMatchObject({ status: "committed", working: { kind: "loaded-empty" } });
  return { jobId: "job-1", ownerId: "owner-1" };
}

/** The production Clear orchestrator, bound to this test's storage and session. */
function boundClear(storage: RosterStorage, session: SessionTransactionStorage) {
  return () =>
    clearRosterDataAndNotify({
      rosterStorage: storage,
      sessionStorage: session,
      clearViewMetadata: () => true,
    });
}

/**
 * The T03 scenario reset's SUCCESS answer.
 *
 * The pre-integration seam was typed `Promise<void>`, so "the scenario was reset" and
 * "the scenario refused to reset" were the same value. The repository command reports
 * refusal as a resolved `{ ok: false, reason }` rather than by throwing, which is
 * exactly why the seam is typed {@link CommandOutcome} here: a stub that cannot say
 * `ok: false` cannot prove the wrapper distinguishes them.
 */
const committed = (): CommandOutcome => ({
  ok: true,
  committed: true,
  documentRevision: 1,
  commitId: "commit-1",
});

/** A refusal: e.g. another tab holds the lease, so this tab's reset was declined. */
const refused = (reason: CommandFailureReason): CommandOutcome => ({
  ok: false,
  reason,
  code: "unknown",
});

beforeEach(() => {
  resetRosterCaptureGate();
  window.localStorage.clear();
});

describe("New schedule — a confirmed reset leaves the previous run behind", () => {
  it("clears the roster, candidate, snapshot and session residue, then resets the scenario", async () => {
    const storage = openTab();
    const session = seededSession();
    const seeded = await seedPreviousRun(storage);

    // ACCEPTING PRE-STATE — every surface is genuinely non-empty beforehand, so the
    // absence assertions below cannot pass against a store that was always empty.
    expect(await storage.readWorking<RosterDocument>()).not.toBeNull();
    expect(await storage.readCandidate<RosterDocument>(seeded.jobId)).not.toBeNull();
    expect(await storage.readCurrentCandidate()).toMatchObject({ jobId: seeded.jobId });
    expect(await storage.readSubmissionSnapshot(seeded.ownerId)).not.toBeNull();
    expect(session.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).not.toBeNull();

    const order: string[] = [];
    const clearStoredData = boundClear(storage, session);
    const outcome = await resetToNewSchedule({
      clearStoredData: async () => {
        order.push("stored-data");
        return clearStoredData();
      },
      resetScenario: async () => {
        order.push("scenario");
        return committed();
      },
    });

    expect(outcome.status).toBe("reset");

    // The state the stale capture notice is a projection of is genuinely gone.
    expect(await storage.readWorking<RosterDocument>()).toBeNull();
    expect(await storage.readCandidate<RosterDocument>(seeded.jobId)).toBeNull();
    expect(await storage.readCurrentCandidate()).toBeNull();
    expect(await storage.readSubmissionSnapshot(seeded.ownerId)).toBeNull();
    expect(session.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBeNull();
    expect(session.getItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY)).toBeNull();

    // ORDER: the verified cut runs FIRST, so a failure can still be retried from an
    // intact workspace. The reverse order would destroy the scenario and only then
    // discover the residue.
    expect(order).toEqual(["stored-data", "scenario"]);
  });

  it("fails CLOSED when the cut cannot be verified: no scenario reset, no success claim", async () => {
    const storage = openTab();
    await seedPreviousRun(storage);
    // A sessionStorage whose removeItem silently no-ops, so the record carrying the
    // real-identity reverse map survives and the privacy promise is NOT kept.
    const poisoned: SessionTransactionStorage = {
      getItem: () => "survives",
      setItem: () => {},
      removeItem: () => {},
      length: 1,
      key: (index) => (index === 0 ? OPTIMIZE_SESSION_STORAGE_KEY : null),
    };
    const resetScenario = vi.fn(async () => committed());

    const outcome = await resetToNewSchedule({
      clearStoredData: boundClear(storage, poisoned),
      resetScenario,
    });

    expect(outcome).toMatchObject({ status: "failed", failure: "stored-data" });
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.storedData?.sessionResidue.sessionCleared).toBe(false);
    // The scenario is untouched, so the retry starts from the same place.
    expect(resetScenario).not.toHaveBeenCalled();
  });

  it("treats a THROWING cut as unverified rather than as done", async () => {
    const resetScenario = vi.fn(async () => committed());

    const outcome = await resetToNewSchedule({
      clearStoredData: async () => {
        throw new Error("IndexedDB is unavailable");
      },
      resetScenario,
    });

    expect(outcome).toEqual({ status: "failed", failure: "stored-data", storedData: null });
    expect(resetScenario).not.toHaveBeenCalled();
  });

  it("reports a scenario-reset failure as its own outcome, not as a success", async () => {
    const storage = openTab();
    await seedPreviousRun(storage);

    const outcome = await resetToNewSchedule({
      clearStoredData: boundClear(storage, seededSession()),
      resetScenario: async () => {
        throw new Error("the persisted record could not be dropped");
      },
    });

    expect(outcome).toMatchObject({ status: "failed", failure: "scenario" });
    // The cut itself DID complete — the report says so honestly rather than
    // implying the browser data survived.
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.storedData?.status).toBe("cleared");
  });

  it("reports a REFUSED scenario reset as a failure, carrying the reason", async () => {
    // INTEGRATION (T03). The defect this exists for is a TYPE that could not express
    // the truth: the pre-integration seam returned `Promise<void>`, so the commonest
    // real refusal — `not-owner`, another tab holds the lease — resolved successfully
    // and `resetToNewSchedule` announced `New schedule created` over a scenario it had
    // not reset. A refusal is a resolved value here, never a throw, so the throwing
    // case above cannot stand in for it.
    const storage = openTab();
    await seedPreviousRun(storage);

    const outcome = await resetToNewSchedule({
      clearStoredData: boundClear(storage, seededSession()),
      resetScenario: async () => refused("not-owner"),
    });

    expect(outcome).toMatchObject({ status: "failed", failure: "scenario" });
    if (outcome.status !== "failed") throw new Error("unreachable");
    // The reason is CARRIED, not flattened: the button says which of the two things
    // happened, and `not-owner` is the one the user can act on.
    expect(outcome.scenarioReason).toBe("not-owner");
    // The cut ran first and completed, exactly as on the throwing path.
    expect(outcome.storedData?.status).toBe("cleared");
  });

  it("ACCEPTING CONTROL: with nothing seeded the reset still completes", async () => {
    // Without this, the fail-closed cases above could be passing because the
    // orchestrator refuses everything.
    const storage = openTab();
    const resetScenario = vi.fn(async () => committed());

    const outcome = await resetToNewSchedule({
      clearStoredData: boundClear(storage, fakeSessionStorage()),
      resetScenario,
    });

    expect(outcome.status).toBe("reset");
    expect(resetScenario).toHaveBeenCalledOnce();
  });
});
