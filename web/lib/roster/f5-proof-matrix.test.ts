// F5 proof matrix — discriminating executable assertions mapping every load-bearing
// Verify sentence and authority/race cut to a test that cannot pass vacuously.
//
// These run against a REAL IndexedDB (fake-indexeddb) through F1's actual storage
// repositories, so the autosave CAS queue, the Clear epoch fence, and the roster
// promotion primitive are exercised end to end — not mocked. Each proof carries
// a negative control where practical so a broad green count is never the evidence.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioPersistenceDb } from "@/lib/store/dexie-storage";
import { createRosterStorageForDb, type RosterStorage } from "@/lib/store/roster-storage";
import { rosterStorage as defaultStorage } from "@/lib/store/roster-storage";
import {
  buildStagedSubmission,
  getRosterCaptureGate,
  OPTIMIZE_RETIRE_PENDING_STORAGE_KEY,
  OPTIMIZE_SESSION_STORAGE_KEY,
  resetRosterCaptureGate,
  ROSTER_SUBMISSION_VERSION,
  stageSubmissionSnapshot,
  type SessionTransactionStorage,
} from "@/lib/optimize";
import {
  clearRosterDataAndNotify,
  createAutosaveQueue,
  decodeRosterFileBytes,
  deriveEditedSinceSolve,
  encodeRosterFile,
  withRosterCellEdit,
  type EditCoordinate,
  type RosterDocument,
} from "@/lib/roster";
import {
  fixtureContainer,
  fixtureFrozenXlsx,
  fixtureRosterDocument,
  fixtureSubmission,
} from "./test-fixtures";

let dbCounter = 0;
function freshDbName() {
  return `f5-proof-${dbCounter++}`;
}
function openTab(): { storage: RosterStorage } {
  const db = new ScenarioPersistenceDb(freshDbName());
  return { storage: createRosterStorageForDb(() => db) };
}

const SHIFT_N = { kind: "shift", shiftId: "N" } as const;

/** Promote a fixture document to working so the autosave queue has a CAS baseline. */
async function promoteFixture(
  storage: RosterStorage,
): Promise<{ document: RosterDocument; revision: number }> {
  const document = await fixtureRosterDocument();
  const epoch = await storage.getClearEpoch();
  const outcome = await storage.promoteDocumentToWorking<RosterDocument>({
    document,
    validate: (doc) => ({ ok: true, document: doc as RosterDocument }),
    expectedWorkingRevision: null,
    expectedClearEpoch: epoch,
  });
  expect(outcome.status).toBe("promoted");
  if (outcome.status !== "promoted") throw new Error("promote failed");
  return { document, revision: outcome.revision };
}

// ---------------------------------------------------------------------------
// 1. set/swap/undo → immediate reload after commit
// ---------------------------------------------------------------------------

describe("F5 proof · set/swap/undo then reload", () => {
  it("a set enqueued through the autosave queue persists and reloads", async () => {
    const { storage } = openTab();
    const { document, revision } = await promoteFixture(storage);
    const epoch = await storage.getClearEpoch();

    const queue = createAutosaveQueue({ storage, clearEpoch: epoch, initialRevision: revision });
    // Simulate a "set cell (0,0) to N" edit: build the next overlay + document.
    const bounds = {
      solvedDays: document.solvedDays,
      shiftTypeIds: document.context.shiftTypes.map((s) => s.id),
    };
    const overlay = withRosterCellEdit(
      document.edits,
      { personIdx: 0, dateIdx: 0 },
      SHIFT_N,
      bounds,
    );
    expect(overlay.ok).toBe(true);
    if (!overlay.ok) return;
    const nextDocument: RosterDocument = { ...document, edits: overlay.edits };
    const outcome = await queue.enqueue(nextDocument);
    expect(outcome.status).toBe("written");

    // Reload: read working back from storage and confirm the edit persisted.
    const reloaded = await storage.readWorking<RosterDocument>();
    expect(reloaded?.document.edits).toEqual(overlay.edits);
    expect(reloaded?.revision).toBe(outcome.status === "written" ? outcome.revision : revision);
    queue.dispose();
  });

  it("undo enqueues the prior overlay and it persists on reload", async () => {
    const { storage } = openTab();
    const { document, revision } = await promoteFixture(storage);
    const epoch = await storage.getClearEpoch();
    const queue = createAutosaveQueue({ storage, clearEpoch: epoch, initialRevision: revision });

    const bounds = {
      solvedDays: document.solvedDays,
      shiftTypeIds: document.context.shiftTypes.map((s) => s.id),
    };
    // Set, then undo (re-enqueue the original document).
    const set = withRosterCellEdit(document.edits, { personIdx: 0, dateIdx: 0 }, SHIFT_N, bounds);
    if (!set.ok) return;
    await queue.enqueue({ ...document, edits: set.edits });
    // Undo: re-enqueue the document with the ORIGINAL (pre-edit) overlay.
    await queue.enqueue({ ...document, edits: document.edits });

    const reloaded = await storage.readWorking<RosterDocument>();
    // The overlay is back to the original (empty in the fixture).
    expect(reloaded?.document.edits).toEqual(document.edits);
    expect(deriveEditedSinceSolve(reloaded?.document.edits ?? [])).toBe(false);
    queue.dispose();
  });
});

// ---------------------------------------------------------------------------
// 2. CAS conflict during autosave: the rival NEVER gets silently overwritten
// ---------------------------------------------------------------------------

describe("F5 proof · autosave CAS conflict never silently overwrites the rival", () => {
  it("a rival promotion wins the CAS; the stale local edit stays failed and NEVER overwrites the rival", async () => {
    const { storage } = openTab();
    const { document, revision } = await promoteFixture(storage);
    const epoch = await storage.getClearEpoch();

    // Another writer (a promotion) commits between the queue's read and write,
    // bumping the revision. The queue's expectedRevision is now stale.
    const rivalOutcome = await storage.promoteDocumentToWorking<RosterDocument>({
      document: { ...document, edits: [] },
      validate: (doc) => ({ ok: true, document: doc as RosterDocument }),
      expectedWorkingRevision: revision,
      expectedClearEpoch: epoch,
    });
    expect(rivalOutcome.status).toBe("promoted");
    const rivalRevision = rivalOutcome.status === "promoted" ? rivalOutcome.revision : revision;

    const queue = createAutosaveQueue({ storage, clearEpoch: epoch, initialRevision: revision });
    const overlay = withRosterCellEdit([], { personIdx: 0, dateIdx: 0 }, SHIFT_N, {
      solvedDays: document.solvedDays,
      shiftTypeIds: document.context.shiftTypes.map((s) => s.id),
    });
    if (!overlay.ok) return;
    const outcome = await queue.enqueue({ ...document, edits: overlay.edits });

    // The conflict is NOT auto-reconciled: the stale whole document did NOT land.
    expect(outcome.status).toBe("conflict");
    expect(queue.snapshot().status).toBe("failed");
    expect(queue.snapshot().failure?.reason).toBe("cas-conflict");
    // The expected revision is UNCHANGED — Retry cannot silently rebase.
    expect(queue.expectedRevision).toBe(revision);

    // NEGATIVE CONTROL — the durable winner is the RIVAL, untouched. The stale
    // local edit did not overwrite it. This is the exact cut the old behavior got
    // backwards: it adopted the rival's revision and retried the stale document
    // over it, then celebrated the overwrite as "reconciled".
    const reloaded = await storage.readWorking<RosterDocument>();
    expect(reloaded?.revision).toBe(rivalRevision);
    expect(reloaded?.document.edits).toEqual([]);
    queue.dispose();
  });

  it("Retry cannot silently rebase: a continuing conflict stays failed against the original revision", async () => {
    const { storage } = openTab();
    const { document, revision } = await promoteFixture(storage);
    const epoch = await storage.getClearEpoch();
    // Rival commits.
    await storage.promoteDocumentToWorking<RosterDocument>({
      document: { ...document, edits: [] },
      validate: (doc) => ({ ok: true, document: doc as RosterDocument }),
      expectedWorkingRevision: revision,
      expectedClearEpoch: epoch,
    });

    const queue = createAutosaveQueue({ storage, clearEpoch: epoch, initialRevision: revision });
    const overlay = withRosterCellEdit([], { personIdx: 0, dateIdx: 0 }, SHIFT_N, {
      solvedDays: document.solvedDays,
      shiftTypeIds: document.context.shiftTypes.map((s) => s.id),
    });
    if (!overlay.ok) return;
    await queue.enqueue({ ...document, edits: overlay.edits });
    expect(queue.snapshot().status).toBe("failed");

    // Retry against the ORIGINAL revision conflicts again — no silent rebase.
    const retry = await queue.retry();
    expect(retry.status).toBe("retried");
    expect(queue.snapshot().status).toBe("failed");
    expect(queue.expectedRevision).toBe(revision);

    // The rival document still wins.
    const reloaded = await storage.readWorking<RosterDocument>();
    expect(reloaded?.document.edits).toEqual([]);
    queue.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. Clear: no sensitive residue anywhere, capture invalidated first, fail-closed
// ---------------------------------------------------------------------------

/** A minimal in-memory SessionTransactionStorage for deterministic Clear proofs. */
function fakeSessionStorage(initial: Record<string, string> = {}): SessionTransactionStorage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

/**
 * Seed every sensitive F1 row Clear promises to remove: the working roster, a
 * committed durable candidate, the current-candidate pointer it moves, and a
 * staged submission snapshot (the row carrying the canonical YAML and the
 * real-identity reverse map).
 *
 * The candidate and snapshot go in through the PRODUCTION primitives
 * (`commitCandidate`, `stageSubmissionSnapshot`) rather than raw table writes, so
 * the pre-state is one production could actually reach.
 */
async function seedEverySensitiveRow(
  storage: RosterStorage,
): Promise<{ jobId: string; ownerId: string }> {
  const jobId = "job-seeded";
  const ownerId = "own-seeded";
  const document = await fixtureRosterDocument();
  const epoch = await storage.getClearEpoch();

  const promoted = await storage.promoteDocumentToWorking<RosterDocument>({
    document,
    validate: (doc) => ({ ok: true, document: doc as RosterDocument }),
    expectedWorkingRevision: null,
    expectedClearEpoch: epoch,
  });
  expect(promoted.status).toBe("promoted");

  const staged = await stageSubmissionSnapshot({
    ownerId,
    payload: buildStagedSubmission({
      canonicalYaml: "people: [P1]",
      reverseMap: [["P1", "Real Name"]],
      schemaVersion: ROSTER_SUBMISSION_VERSION,
    }),
    store: storage,
  });
  expect(staged.status).toBe("staged");

  const committed = await storage.commitCandidate({
    jobId,
    submissionOrdinal: staged.status === "staged" ? staged.submissionOrdinal : 1,
    document,
    expectedClearEpoch: epoch,
  });
  expect(committed.status).toBe("committed");

  return { jobId, ownerId };
}

describe("F5 proof · Clear leaves no residue and invalidates authority first", () => {
  beforeEach(() => {
    // Reset the default singleton's session residue so each proof starts clean.
    try {
      defaultSessionStorage.removeItem(OPTIMIZE_SESSION_STORAGE_KEY);
      defaultSessionStorage.removeItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY);
    } catch {
      // ignore — jsdom sessionStorage may be unavailable in some envs
    }
  });

  it("Clear removes the working roster, candidates, snapshots, pointer, optimize session, retirement marker, and view metadata; reports zero residue", async () => {
    const { storage } = openTab();
    // Seed EVERY load-bearing F1 row, not just the working roster. Asserting that
    // candidates/pointer/snapshots are absent afterwards proves nothing if they
    // were never there: the assertion would hold against a Clear that stopped
    // removing them entirely.
    const seeded = await seedEverySensitiveRow(storage);

    // ACCEPTING PRE-STATE — each surface is genuinely non-empty before the action.
    expect(await storage.readWorking<RosterDocument>()).not.toBeNull();
    expect(await storage.readCandidate<RosterDocument>(seeded.jobId)).not.toBeNull();
    expect(await storage.readCurrentCandidate()).toMatchObject({ jobId: seeded.jobId });
    expect(await storage.readSubmissionSnapshot(seeded.ownerId)).not.toBeNull();

    // Seed session residue: the optimize session (carrying the reverse map) and a
    // retirement marker. Clear must provably remove BOTH.
    const session = fakeSessionStorage({
      [OPTIMIZE_SESSION_STORAGE_KEY]: JSON.stringify({
        schemaVersion: 1,
        ownerId: "owner-1",
        anonymized: true,
        runOptions: { weightedObjectives: false },
        peopleCount: 2,
        reverseMap: [["P1", "Real Name"]],
        capture: { status: "staged", snapshotRef: "owner-1", submissionOrdinal: 1 },
        phase: "active",
        jobId: "job-1",
      }),
      [OPTIMIZE_RETIRE_PENDING_STORAGE_KEY]: JSON.stringify({
        schemaVersion: 1,
        ownerId: "owner-1",
      }),
    });

    let captureCalled = false;
    let viewCalled = false;
    const outcome = await clearRosterDataAndNotifyStorage(storage, {
      notifyCapture: async () => {
        captureCalled = true;
      },
      clearViewMetadata: () => {
        viewCalled = true;
        return true;
      },
      sessionStorage: session,
    });

    expect(outcome.status).toBe("cleared");
    expect(outcome.remaining).toEqual({ roster: 0, snapshot: 0 });
    expect(outcome.captureNotified).toBe(true);
    expect(outcome.sessionResidue.sessionCleared).toBe(true);
    expect(outcome.sessionResidue.retireMarkerCleared).toBe(true);
    expect(captureCalled).toBe(true);
    expect(viewCalled).toBe(true);

    // NEGATIVE CONTROL — every sensitive surface is provably empty, read back from
    // storage rather than inferred from the outcome object.
    expect(await storage.readWorking<RosterDocument>()).toBeNull();
    expect(await storage.readCurrentCandidate()).toBeNull();
    expect(await storage.readCandidate<RosterDocument>(seeded.jobId)).toBeNull();
    expect(await storage.readSubmissionSnapshot(seeded.ownerId)).toBeNull();
    expect(session.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBeNull();
    expect(session.getItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY)).toBeNull();
  });

  it("Clear is fail-closed: a session-residue cut that survives leaves status 'failed' (no privacy success)", async () => {
    const { storage } = openTab();
    const document = await fixtureRosterDocument();
    const epoch = await storage.getClearEpoch();
    await storage.promoteDocumentToWorking<RosterDocument>({
      document,
      validate: (doc) => ({ ok: true, document: doc as RosterDocument }),
      expectedWorkingRevision: null,
      expectedClearEpoch: epoch,
    });

    // A sessionStorage whose removeItem silently no-ops: the session key survives,
    // so the privacy promise is NOT kept. Clear must report failure.
    const poisonedSession: SessionTransactionStorage = {
      getItem: () => "survives",
      setItem: () => {},
      removeItem: () => {},
    };

    const outcome = await clearRosterDataAndNotifyStorage(storage, {
      notifyCapture: async () => {},
      clearViewMetadata: () => true,
      sessionStorage: poisonedSession,
    });

    // The F1 purge succeeded, but the session residue survived → overall FAILED.
    expect(outcome.status).toBe("failed");
    expect(outcome.sessionResidue.sessionCleared).toBe(false);
    expect(outcome.remaining).toEqual({ roster: 0, snapshot: 0 });
  });

  it("a stale autosave after Clear is fenced by the epoch (no repopulation)", async () => {
    const { storage } = openTab();
    const { document, revision } = await promoteFixture(storage);
    const epochBefore = await storage.getClearEpoch();

    await storage.clearRosterData();
    const epochAfter = await storage.getClearEpoch();
    expect(epochAfter).toBe(epochBefore + 1);

    // A write that still carries the OLD epoch is fenced — it cannot repopulate.
    const stale = await storage.writeWorking({
      document: { ...document, edits: [{ personIdx: 0, dateIdx: 0, day: SHIFT_N }] },
      expectedRevision: revision,
      expectedClearEpoch: epochBefore,
    });
    expect(stale.status).toBe("stale-epoch");

    // The working roster stays empty.
    expect(await storage.readWorking<RosterDocument>()).toBeNull();
  });

  it("capture is invalidated BEFORE the purge: the gate is notified first", async () => {
    // The ordering directive: invalidate authority before destructive storage
    // work. Record the order of the two cuts and assert capture precedes purge.
    const { storage } = openTab();
    const document = await fixtureRosterDocument();
    const epoch = await storage.getClearEpoch();
    await storage.promoteDocumentToWorking<RosterDocument>({
      document,
      validate: (doc) => ({ ok: true, document: doc as RosterDocument }),
      expectedWorkingRevision: null,
      expectedClearEpoch: epoch,
    });

    // Record BOTH cuts, not just the first: an ordering regression that moved the
    // purge ahead of capture invalidation has to be able to make this fail.
    const order: string[] = [];
    const observed: RosterStorage = {
      ...storage,
      clearRosterData: async () => {
        order.push("purge");
        return storage.clearRosterData();
      },
    };
    const outcome = await clearRosterDataAndNotifyStorage(observed, {
      notifyCapture: async () => {
        order.push("capture");
      },
      clearViewMetadata: () => true,
      sessionStorage: fakeSessionStorage(),
    });
    expect(outcome.status).toBe("cleared");
    expect(order).toEqual(["capture", "purge"]);
  });
});

// ---------------------------------------------------------------------------
// 3b. A REAL F2 capture parked mid-flight across a production Clear
//
// The proofs above drive Clear's ordering with an injected `notifyCapture`. That
// shows the orchestrator's sequence but never opens an actual capture, so it
// cannot show what the sequence is FOR: a real in-flight capture, holding real
// de-anonymized bytes, must not land a candidate on the far side of the purge.
//
// These run the production app gate (`getRosterCaptureGate`, which defaults to
// F3's `productionCandidateBuilder`) over real F1 storage, and let production
// Clear reach it through its OWN default `notifyCapture` — `notifyRosterCaptureCleared`
// — with nothing injected. The flight is parked at the gate's real suspension
// point: `await fetchRoster(jobId)`, the last boundary before the invalidation
// checkpoint that precedes assembly and commit.
// ---------------------------------------------------------------------------

interface ParkedCapture {
  gate: ReturnType<typeof getRosterCaptureGate>;
  flight: Promise<{ state: { status: string } }>;
  release: () => void;
  jobId: string;
  ownerId: string;
}

/**
 * Start a real capture and leave it suspended inside `/roster`, with a real
 * staged snapshot behind it and F3's production builder in front of it.
 */
type CaptureGateStore = NonNullable<Parameters<typeof getRosterCaptureGate>[0]>["store"];

/** The parked flight's live gate state, for the ordering assertions. */
function captureState(parked: ParkedCapture): string {
  return parked.gate.getState(parked.jobId).status;
}

async function parkCaptureAtRosterFetch(
  storage: RosterStorage,
  store: CaptureGateStore = storage,
): Promise<ParkedCapture> {
  const jobId = "job-capture";
  const ownerId = "own-capture";

  const staged = await stageSubmissionSnapshot({
    ownerId,
    // The exact envelope F3 owns, staged verbatim — the production builder
    // rejects anything else, so this is what makes the flight genuinely commit-able.
    payload: fixtureSubmission(),
    store: storage,
  });
  if (staged.status !== "staged") throw new Error("fixture failed to stage a snapshot");

  const roster = Promise.withResolvers<unknown>();
  const gate = getRosterCaptureGate({
    store,
    fetchRoster: () => roster.promise,
    // buildCandidate deliberately omitted: the app gate installs F3's real
    // `productionCandidateBuilder`.
  });

  const flight = gate.capture({ jobId, capture: staged, frozenXlsx: fixtureFrozenXlsx() });

  // Wait until the flight is genuinely suspended IN the fetch, not merely started.
  await vi.waitFor(() => {
    expect(gate.getState(jobId).status).toBe("fetching-roster");
  });

  return {
    gate,
    flight: flight as ParkedCapture["flight"],
    release: () => roster.resolve(JSON.parse(JSON.stringify(fixtureContainer())) as unknown),
    jobId,
    ownerId,
  };
}

describe("F5 proof · a real in-flight capture cannot repopulate across Clear", () => {
  beforeEach(() => {
    resetRosterCaptureGate();
  });
  afterEach(() => {
    resetRosterCaptureGate();
  });

  it("ACCEPTING CONTROL: with no Clear, the same parked capture commits a real candidate", async () => {
    // Without this the Clear cases below could pass by never opening a flight that
    // was capable of committing anything in the first place.
    const { storage } = openTab();
    const parked = await parkCaptureAtRosterFetch(storage);

    parked.release();
    const outcome = await parked.flight;

    expect(outcome.state.status).toBe("committed");
    expect(await storage.readCurrentCandidate()).toMatchObject({ jobId: parked.jobId });
    expect(await storage.readCandidate<RosterDocument>(parked.jobId)).not.toBeNull();
    // The staging row was consumed by the commit — the real-identity bytes moved
    // into the candidate rather than being left behind.
    expect(await storage.readSubmissionSnapshot(parked.ownerId)).toBeNull();
  });

  it("Clear invalidates the parked capture FIRST, and the released flight commits nothing", async () => {
    const { storage } = openTab();
    // Seed the rest of the sensitive state too, so this is the full cut and not a
    // capture-only one.
    const seeded = await seedEverySensitiveRow(storage);
    const parked = await parkCaptureAtRosterFetch(storage);
    const session = fakeSessionStorage({
      [OPTIMIZE_SESSION_STORAGE_KEY]: JSON.stringify({ reverseMap: [["P1", "Real Name"]] }),
      [OPTIMIZE_RETIRE_PENDING_STORAGE_KEY]: JSON.stringify({ schemaVersion: 1, ownerId: "o" }),
    });

    // Production Clear, with its OWN default capture invalidation (nothing injected
    // for `notifyCapture`), started while the capture is still suspended.
    const clearing = clearRosterDataAndNotify({
      rosterStorage: storage,
      sessionStorage: session,
      clearViewMetadata: () => true,
    });

    // ORDERING, PROVEN BY BLOCKING: Clear's first act is capture invalidation, and
    // that act AWAITS the open flight. So while the fetch is parked the purge
    // cannot have run — the working roster and the candidate are still there.
    expect(captureState(parked)).toBe("fetching-roster");
    expect(await storage.readWorking<RosterDocument>()).not.toBeNull();
    expect(await storage.readCandidate<RosterDocument>(seeded.jobId)).not.toBeNull();

    // Release the flight. It resumes past the fetch, hits the invalidation
    // checkpoint, and finalizes WITHOUT assembling or committing.
    parked.release();
    const [outcome, captured] = await Promise.all([clearing, parked.flight]);

    expect(captured.state).toEqual({ status: "dismissed", reason: "cleared" });
    expect(outcome.status).toBe("cleared");

    // NOTHING repopulated: not the capture's own candidate, not the seeded one,
    // not the pointer, snapshot, or working roster.
    expect(await storage.readCandidate<RosterDocument>(parked.jobId)).toBeNull();
    expect(await storage.readCandidate<RosterDocument>(seeded.jobId)).toBeNull();
    expect(await storage.readCurrentCandidate()).toBeNull();
    expect(await storage.readSubmissionSnapshot(parked.ownerId)).toBeNull();
    expect(await storage.readSubmissionSnapshot(seeded.ownerId)).toBeNull();
    expect(await storage.readWorking<RosterDocument>()).toBeNull();
  });

  it("DEFENCE IN DEPTH: with capture invalidation removed, F1's epoch fence still refuses the stale commit", async () => {
    // The same interleaving with Clear's capture invalidation disabled. The flight
    // now runs all the way to `commitCandidate` AFTER the purge — and F1 refuses it
    // because the epoch it captured before the purge is stale.
    const { storage } = openTab();
    const parked = await parkCaptureAtRosterFetch(storage);

    const outcome = await clearRosterDataAndNotify({
      rosterStorage: storage,
      sessionStorage: fakeSessionStorage(),
      clearViewMetadata: () => true,
      notifyCapture: async () => {},
    });
    expect(outcome.status).toBe("cleared");
    // The flight really did survive the purge unbroken — it is still parked.
    expect(captureState(parked)).toBe("fetching-roster");

    parked.release();
    const captured = await parked.flight;

    // It assembled and attempted a real commit, and F1 turned it away.
    expect(captured.state).toEqual({ status: "dismissed", reason: "cleared" });
    expect(await storage.readCandidate<RosterDocument>(parked.jobId)).toBeNull();
    expect(await storage.readCurrentCandidate()).toBeNull();
  });

  it("MUTATION EMULATION: with BOTH cuts removed, the stale capture DOES repopulate", async () => {
    // The discriminating control for the two cases above. Disable capture
    // invalidation AND defeat the epoch fence (by rewriting the expected epoch to
    // the post-purge one), and the parked capture writes a real candidate and
    // pointer into a store the user was told had been cleared. That is what the
    // absence assertions above are actually ruling out; without this, they could
    // be passing because nothing was ever capable of writing.
    const { storage } = openTab();
    const fenceDefeated = {
      ...storage,
      commitCandidate: async (input: Parameters<RosterStorage["commitCandidate"]>[0]) =>
        storage.commitCandidate({ ...input, expectedClearEpoch: await storage.getClearEpoch() }),
    };
    const parked = await parkCaptureAtRosterFetch(storage, fenceDefeated);

    await clearRosterDataAndNotify({
      rosterStorage: storage,
      sessionStorage: fakeSessionStorage(),
      clearViewMetadata: () => true,
      notifyCapture: async () => {},
    });
    expect(await storage.readCurrentCandidate()).toBeNull();

    parked.release();
    const captured = await parked.flight;

    expect(captured.state.status).toBe("committed");
    expect(await storage.readCandidate<RosterDocument>(parked.jobId)).not.toBeNull();
    expect(await storage.readCurrentCandidate()).toMatchObject({ jobId: parked.jobId });
  });
});

/**
 * The PRODUCTION orchestrator, bound to a specific per-tab storage.
 *
 * This used to re-implement `clearRosterDataAndNotify`'s ordering and
 * fail-closed aggregation inside the test, because the orchestrator read the app
 * storage singleton and a per-tab proof could not rebind it. That made every
 * Clear proof below non-discriminating: the production function could regress in
 * any way at all and these tests would still pass, since they never called it.
 * The orchestrator now takes an injectable `rosterStorage`, so this is a thin
 * pass-through and a production regression turns the proofs red.
 */
async function clearRosterDataAndNotifyStorage(
  storage: RosterStorage,
  deps: {
    notifyCapture?: () => Promise<void>;
    clearViewMetadata?: () => boolean;
    sessionStorage?: SessionTransactionStorage;
  },
) {
  return clearRosterDataAndNotify({
    rosterStorage: storage,
    notifyCapture: deps.notifyCapture ?? (async () => {}),
    clearViewMetadata: deps.clearViewMetadata ?? (() => true),
    sessionStorage: deps.sessionStorage ?? fakeSessionStorage(),
  });
}

/** The live default sessionStorage (jsdom), guarded for envs without it. */
const defaultSessionStorage: SessionTransactionStorage = {
  getItem: (key) => {
    try {
      return globalThis.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      globalThis.sessionStorage.setItem(key, value);
    } catch {
      // ignore
    }
  },
  removeItem: (key) => {
    try {
      globalThis.sessionStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

// ---------------------------------------------------------------------------
// 4. Edited roster-file round-trip → return-to-solved removes the overlay
// ---------------------------------------------------------------------------

describe("F5 proof · roster-file round-trip + return-to-solved", () => {
  it("an edited document exports, re-imports, and preserves the overlay", async () => {
    const document = await fixtureRosterDocument();
    const bounds = {
      solvedDays: document.solvedDays,
      shiftTypeIds: document.context.shiftTypes.map((s) => s.id),
    };
    const overlay = withRosterCellEdit(
      document.edits,
      { personIdx: 0, dateIdx: 0 },
      SHIFT_N,
      bounds,
    );
    if (!overlay.ok) return;
    const edited: RosterDocument = { ...document, edits: overlay.edits };

    const encoded = await encodeRosterFile(edited);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    const decoded = await decodeRosterFileBytes(encoded.file.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // The overlay survived the round-trip.
    expect(decoded.document.edits).toEqual(overlay.edits);
    expect(deriveEditedSinceSolve(decoded.document.edits)).toBe(true);
  });

  it("returning an edited cell to its solved value removes the overlay entry (editedSinceSolve clears)", async () => {
    const document = await fixtureRosterDocument();
    const bounds = {
      solvedDays: document.solvedDays,
      shiftTypeIds: document.context.shiftTypes.map((s) => s.id),
    };
    const coordinate: EditCoordinate = { personIdx: 0, dateIdx: 0 };
    const solved = document.solvedDays[coordinate.personIdx][coordinate.dateIdx];

    // Edit the cell, then set it BACK to its solved value.
    const edited = withRosterCellEdit(document.edits, coordinate, SHIFT_N, bounds);
    if (!edited.ok) return;
    expect(edited.edits).toHaveLength(1);
    expect(deriveEditedSinceSolve(edited.edits)).toBe(true);

    const restored = withRosterCellEdit(edited.edits, coordinate, solved, bounds);
    if (!restored.ok) return;
    // The overlay is empty again: the edit was removed by normalization.
    expect(restored.edits).toEqual([]);
    expect(deriveEditedSinceSolve(restored.edits)).toBe(false);
  });

  it("an edited XLSX with the overlay removed reproduces the unedited workbook surfaces (no-op patch)", async () => {
    // When the overlay is empty, the patcher returns the frozen bytes UNCHANGED
    // — the "restores unedited XLSX behavior for that coordinate" guarantee.
    const document = await fixtureRosterDocument();
    // The fixture's stand-in bytes are not a real workbook, so an empty overlay
    // returns them verbatim (no ExcelJS round-trip).
    const { tryPatchFrozenXlsxWithEdits } = await import("./edited-xlsx");
    const result = await tryPatchFrozenXlsxWithEdits({
      frozenXlsx: document.frozenXlsx,
      edits: [],
      coordinateMap: document.coordinateMap,
      provenance: document.provenance,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(
      new Uint8Array(await document.frozenXlsx.arrayBuffer()),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Clear orchestrator (default storage): cleared status + full residue report
// ---------------------------------------------------------------------------

describe("F5 proof · clearRosterDataAndNotify orchestrator (default storage)", () => {
  it("returns a cleared status with zero residue across every named surface", async () => {
    // The orchestrator uses the default singleton storage; promote then clear.
    const document = await fixtureRosterDocument();
    const epoch = await defaultStorage.getClearEpoch();
    await defaultStorage.promoteDocumentToWorking<RosterDocument>({
      document,
      validate: (doc) => ({ ok: true, document: doc as RosterDocument }),
      expectedWorkingRevision: null,
      expectedClearEpoch: epoch,
    });

    let captureCalled = false;
    let viewCalled = false;
    const outcome = await clearRosterDataAndNotify({
      notifyCapture: async () => {
        captureCalled = true;
      },
      clearViewMetadata: () => {
        viewCalled = true;
        return true;
      },
      sessionStorage: fakeSessionStorage({
        [OPTIMIZE_SESSION_STORAGE_KEY]: '{"phase":"active"}',
        [OPTIMIZE_RETIRE_PENDING_STORAGE_KEY]: '{"ownerId":"o"}',
      }),
    });
    expect(outcome.status).toBe("cleared");
    expect(outcome.remaining).toEqual({ roster: 0, snapshot: 0 });
    expect(captureCalled).toBe(true);
    expect(viewCalled).toBe(true);
    expect(outcome.sessionResidue.sessionCleared).toBe(true);
    expect(outcome.sessionResidue.retireMarkerCleared).toBe(true);

    // The working roster is gone.
    expect(await defaultStorage.readWorking<RosterDocument>()).toBeNull();
  });
});
