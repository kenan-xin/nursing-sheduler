// F2 capture-state-machine tests against a REAL IndexedDB (fake-indexeddb) and
// F1's actual transactions, so supersession, exact-version dismissal, and epoch
// fencing are proven through the code that will run in production rather than a
// double that could encode the same mistake as the implementation.
//
// The discriminating cases here are the ones the old boolean gate got wrong:
// concurrent auto/manual entry, retry-by-failure-mode, dismissal racing a commit,
// an older completion landing after a newer one, and DELETE authority. Each has a
// negative control proving the same path DOES succeed when the hazard is absent.

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OptimizeApiError } from "@/lib/bff/errors";
import { ScenarioPersistenceDb } from "@/lib/store/dexie-storage";
import { createRosterStorageForDb, type RosterStorage } from "@/lib/store/roster-storage";
import {
  createRosterCapture,
  type BuildCandidateDocument,
  type CaptureCleanupToken,
  type CaptureRequest,
  type RosterCaptureDeps,
  type RosterCaptureGate,
} from "./roster-capture";
import { stageSubmissionSnapshot, buildStagedSubmission } from "./submission-snapshot";
import { productionCandidateBuilder, ROSTER_SUBMISSION_VERSION } from "./roster-candidate-builder";
import { fixtureContainer, fixtureFrozenXlsx, fixtureSubmission } from "@/lib/roster/test-fixtures";
import type { RosterDocument } from "@/lib/roster";

let dbCounter = 0;
function openTab(databaseName: string): RosterStorage {
  const db = new ScenarioPersistenceDb(databaseName);
  return createRosterStorageForDb(() => db);
}
function freshStore(): RosterStorage {
  return openTab(`roster-capture-test-${dbCounter++}`);
}

const FROZEN = new Blob(["xlsx-bytes"], { type: "application/octet-stream" });

/** Stage a real snapshot and return the session capture authority for it. */
async function stage(store: RosterStorage, ownerId: string, yaml = "people: [P1]") {
  const state = await stageSubmissionSnapshot({
    ownerId,
    payload: buildStagedSubmission({
      canonicalYaml: yaml,
      reverseMap: [["P1", "Alice"]],
      schemaVersion: ROSTER_SUBMISSION_VERSION,
    }),
    store,
  });
  if (state.status !== "staged") throw new Error("fixture failed to stage a snapshot");
  return state;
}

function request(
  jobId: string,
  capture: CaptureRequest["capture"],
  frozenXlsx: Blob | null = FROZEN,
): CaptureRequest {
  return { jobId, capture, frozenXlsx };
}

/** A deferred so a test can hold a fetch or a build genuinely in flight. */
function deferred<T>() {
  return Promise.withResolvers<T>();
}

interface Harness {
  gate: RosterCaptureGate;
  fetchRoster: ReturnType<typeof vi.fn>;
  buildCandidate: ReturnType<typeof vi.fn>;
}

function harness(
  store: RosterStorage,
  over: Partial<Pick<RosterCaptureDeps, "fetchRoster" | "buildCandidate">> = {},
): Harness {
  const fetchRoster = vi.fn(over.fetchRoster ?? (async () => ({ solvedDays: [["N"]] })));
  const build: BuildCandidateDocument =
    over.buildCandidate ??
    (({ container, snapshot }) => ({
      ok: true,
      // The stub stands in for F3's real builder. It records exactly the two
      // authorities F2 is contractually allowed to derive from: the fetched
      // container and the immutable snapshot.
      document: { container, canonicalYaml: snapshot.canonicalYaml },
    }));
  const buildCandidate = vi.fn(build);
  return {
    gate: createRosterCapture({ store, fetchRoster, buildCandidate }),
    fetchRoster,
    buildCandidate,
  };
}

function jobGoneError(): OptimizeApiError {
  return new OptimizeApiError(404, { error: { code: "job_not_found", message: "gone" } }, "roster");
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("roster capture — the committed path", () => {
  it("fetches /roster, assembles from the snapshot, commits, purges, and issues a committed token", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1", "exact: submission");
    const { gate, fetchRoster, buildCandidate } = harness(store);

    const outcome = await gate.capture(request("job-1", capture));

    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(outcome.state.status).toBe("committed");
    expect(outcome.token).toEqual({
      kind: "committed",
      jobId: "job-1",
      candidateVersion: 1,
      submissionOrdinal: 1,
      rosterAttempted: true,
    });

    // De-anonymization ran through the SNAPSHOT, not a reparse of the container.
    expect(buildCandidate.mock.calls[0][0]).toMatchObject({
      jobId: "job-1",
      submissionOrdinal: 1,
      frozenXlsx: FROZEN,
      snapshot: { canonicalYaml: "exact: submission" },
    });

    const pointer = await store.readCurrentCandidate();
    expect(pointer).toEqual({ jobId: "job-1", candidateVersion: 1, submissionOrdinal: 1 });
    // The snapshot now lives inside the committed candidate.
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();
  });

  it("COALESCES concurrent auto/manual entry into ONE fetch, ONE commit, ONE token", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const gateFetch = deferred<unknown>();
    const { gate, fetchRoster, buildCandidate } = harness(store, {
      fetchRoster: () => gateFetch.promise,
    });

    // The auto effect, its StrictMode replay, and a simultaneous manual Download.
    const a = gate.capture(request("job-1", capture));
    const b = gate.capture(request("job-1", capture));
    const c = gate.capture(request("job-1", capture));
    gateFetch.resolve({ solvedDays: [] });
    const [ra, rb, rc] = await Promise.all([a, b, c]);

    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(buildCandidate).toHaveBeenCalledTimes(1);
    expect(ra.token).toEqual(rb.token);
    expect(rb.token).toEqual(rc.token);
    expect((await store.readCurrentCandidate())?.candidateVersion).toBe(1);
  });

  it("a settled job never re-runs: a replayed capture returns the same token without refetching", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate, fetchRoster } = harness(store);

    const first = await gate.capture(request("job-1", capture));
    const replay = await gate.capture(request("job-1", capture));

    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(replay.token).toEqual(first.token);
  });
});

describe("roster capture — unavailable runs stay non-blocking", () => {
  it("a degraded run (snapshot persistence denied) issues a dismissal token and never fetches", async () => {
    const { gate, fetchRoster } = harness(freshStore());

    const outcome = await gate.capture(
      request("job-1", { status: "unavailable", reason: "snapshot_persist_failed" }),
    );

    expect(outcome.state).toEqual({ status: "unavailable", cause: "snapshot_persist_failed" });
    // Cleanup is still authorized: there was never a candidate to lose, and the
    // token's own SHAPE records that the roster fence was vacuous rather than
    // skipped — `rosterAttempted: false` exists only on this variant.
    expect(outcome.token).toEqual({
      kind: "unavailable",
      jobId: "job-1",
      cause: "snapshot_persist_failed",
      rosterAttempted: false,
    });
    expect(fetchRoster).not.toHaveBeenCalled();
  });

  it("a record whose snapshot is gone (crash cut) is capture-unavailable, not a fabricated capture", async () => {
    const store = freshStore();
    const { gate, fetchRoster, buildCandidate } = harness(store);

    const outcome = await gate.capture(
      request("job-1", { status: "staged", snapshotRef: "own-vanished", submissionOrdinal: 7 }),
    );

    expect(outcome.state).toEqual({ status: "unavailable", cause: "snapshot_missing" });
    expect(outcome.token).toMatchObject({ kind: "unavailable", cause: "snapshot_missing" });
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(buildCandidate).not.toHaveBeenCalled();
  });

  it("negative control: the SAME job with its snapshot present captures normally", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-present");
    const { gate } = harness(store);
    expect((await gate.capture(request("job-1", capture))).token?.kind).toBe("committed");
  });

  it("a completed run with no artifact retires its snapshot and authorizes cleanup", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate, fetchRoster } = harness(store);

    const outcome = await gate.capture(request("job-1", capture, null));

    expect(outcome.state).toEqual({ status: "unavailable", cause: "no-artifact" });
    expect(outcome.token).toMatchObject({ kind: "unavailable", cause: "no-artifact" });
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();
  });
});

describe("roster capture — retry by failure mode", () => {
  it("a fetch failure issues NO token (the artifact must survive) and retries the server", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    let attempt = 0;
    const { gate, fetchRoster } = harness(store, {
      fetchRoster: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("network down");
        return { solvedDays: [] };
      },
    });

    const failed = await gate.capture(request("job-1", capture));
    expect(failed.state).toMatchObject({ status: "fetch-failed", jobGone: false });
    expect(failed.token).toBeNull();
    expect(await store.readCurrentCandidate()).toBeNull();

    // An effect replay must NOT silently re-run a failed capture — only an explicit
    // retry re-arms it.
    await gate.capture(request("job-1", capture));
    expect(fetchRoster).toHaveBeenCalledTimes(1);

    const retried = await gate.retry(request("job-1", capture));
    expect(fetchRoster).toHaveBeenCalledTimes(2);
    expect(retried.token?.kind).toBe("committed");
  });

  it("a pruned job is reported as permanently gone (retention is best-effort)", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store, {
      fetchRoster: async () => {
        throw jobGoneError();
      },
    });

    const outcome = await gate.capture(request("job-1", capture));
    expect(outcome.state).toMatchObject({ status: "fetch-failed", jobGone: true });
    expect(outcome.token).toBeNull();
  });

  it("a commit failure retries with the container and bytes IN HAND — no second /roster fetch", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    let builds = 0;
    const { gate, fetchRoster } = harness(store, {
      buildCandidate: ({ container }) => {
        builds += 1;
        return builds === 1
          ? { ok: false, retryable: true, reason: "assembler blew up" }
          : { ok: true, document: { container } };
      },
    });

    const failed = await gate.capture(request("job-1", capture));
    expect(failed.state).toEqual({ status: "commit-failed", message: "assembler blew up" });
    expect(failed.token).toBeNull();

    const retried = await gate.retry(request("job-1", capture));
    expect(retried.token?.kind).toBe("committed");
    // The load-bearing assertion: the retry was purely local.
    expect(fetchRoster).toHaveBeenCalledTimes(1);
  });
});

describe("roster capture — the working-slot disposition", () => {
  it("reports loaded-empty and populates the viewer when no working roster exists", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);

    const outcome = await gate.capture(request("job-1", capture));

    expect(outcome.state).toMatchObject({
      status: "committed",
      working: { kind: "loaded-empty", workingRevision: 1 },
    });
    // The CTA's promise: `Open & adjust roster` opens a POPULATED viewer, with no
    // Load click in between.
    expect(await store.readWorking()).toMatchObject({ revision: 1 });
    // Filling the slot changes nothing about cleanup authority.
    expect(outcome.token).toMatchObject({ kind: "committed", jobId: "job-1" });
  });

  it("reports awaiting-choice and preserves an existing roster and its edits", async () => {
    const store = freshStore();
    // Through promotion, not the edit operation: seeding a whole document IS a
    // replacement, and this stands in for a roster the user imported — which
    // carries no candidate source.
    await store.promoteDocumentToWorking({
      document: { tag: "hand-edited" },
      validate: (value) => ({ ok: true as const, document: value }),
      expectedWorkingRevision: null,
      expectedClearEpoch: await store.getClearEpoch(),
    });
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);

    const outcome = await gate.capture(request("job-1", capture));

    expect(outcome.state).toMatchObject({
      status: "committed",
      working: { kind: "awaiting-choice", reason: "working-present" },
    });
    expect(await store.readWorking()).toMatchObject({
      document: { tag: "hand-edited" },
      revision: 1,
    });
    // The exact new result is still the durable latest candidate, awaiting Load.
    expect((await store.readCurrentCandidate())?.jobId).toBe("job-1");
  });

  it("a RESUMED settle reports what the original commit decided, not the slot's state now", async () => {
    // The commit succeeded and filled the empty slot, but its staging purge could
    // not be proven, so the settle is withheld and retried. By then the slot is
    // populated — so a disposition re-derived at settle time would read
    // `awaiting-choice` and the CTA would stop promising a populated viewer for the
    // very run that populated it.
    const store = freshStore();
    const capture = await stage(store, "own-1");
    let failDelete = true;
    const fragile: RosterStorage = {
      ...store,
      async deleteSubmissionSnapshot(input) {
        if (failDelete) throw new Error("snapshot delete failed");
        return store.deleteSubmissionSnapshot(input);
      },
    };
    const { gate } = harness(fragile);

    const blocked = await gate.capture(request("job-1", capture));
    expect(blocked.token).toBeNull();
    expect(await store.readWorking()).toMatchObject({ revision: 1 });

    failDelete = false;
    const resumed = await gate.retry(request("job-1", capture));

    expect(resumed.state).toMatchObject({
      status: "committed",
      working: { kind: "loaded-empty", workingRevision: 1 },
    });
    expect(resumed.token).toMatchObject({ kind: "committed", jobId: "job-1" });
  });
});

describe("roster capture — ordering authority", () => {
  it("an OLDER late completion becomes a proven superseded dismissal, never a committed token", async () => {
    const store = freshStore();
    const older = await stage(store, "own-old"); // ordinal 1
    await stage(store, "own-new"); // ordinal 2

    // The newer submission captured first (it finished first).
    await store.commitCandidate({
      jobId: "job-new",
      submissionOrdinal: 2,
      document: { tag: "new" },
      expectedClearEpoch: await store.getClearEpoch(),
    });

    const { gate } = harness(store);
    const outcome = await gate.capture(request("job-old", older));

    expect(outcome.state).toEqual({ status: "dismissed", reason: "superseded" });
    expect(outcome.token).toEqual({
      kind: "dismissed",
      jobId: "job-old",
      reason: "superseded",
      rosterAttempted: true,
    });
    // The pointer never moved and the older payload was never stored.
    expect(await store.readCurrentCandidate()).toMatchObject({ jobId: "job-new" });
    expect(await store.readCandidate("job-old")).toBeNull();
    // Its snapshot is retired by that proven outcome.
    expect(await store.readSubmissionSnapshot("own-old")).toBeNull();
  });

  it("candidate A survives a newer B that cannot be assembled", async () => {
    const store = freshStore();
    const a = await stage(store, "own-A");
    const b = await stage(store, "own-B");

    const first = harness(store);
    expect((await first.gate.capture(request("job-A", a))).token?.kind).toBe("committed");

    const second = harness(store, {
      buildCandidate: () => ({ ok: false, retryable: true, reason: "B is non-loadable" }),
    });
    const failed = await second.gate.capture(request("job-B", b));

    expect(failed.token).toBeNull();
    expect(await store.readCurrentCandidate()).toMatchObject({ jobId: "job-A" });
    expect(await store.readCandidate("job-A")).not.toBeNull();

    // Negative control: B atomically supersedes A once it DOES assemble.
    const third = harness(store);
    expect((await third.gate.capture(request("job-B", b))).token?.kind).toBe("committed");
    expect(await store.readCurrentCandidate()).toMatchObject({ jobId: "job-B" });
    expect(await store.readCandidate("job-A")).toBeNull();
  });
});

describe("roster capture — dismissal and Clear races", () => {
  it("a dismissal during the /roster fetch prevents the commit entirely", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const gateFetch = deferred<unknown>();
    const { gate, buildCandidate } = harness(store, { fetchRoster: () => gateFetch.promise });

    const flight = gate.capture(request("job-1", capture));
    const dismissal = gate.dismiss(request("job-1", capture));
    gateFetch.resolve({ solvedDays: [] });

    const [outcome, dismissed] = await Promise.all([flight, dismissal]);

    expect(buildCandidate).not.toHaveBeenCalled();
    expect(outcome.state).toEqual({ status: "dismissed", reason: "user" });
    expect(dismissed).toEqual({
      status: "dismissed",
      token: { kind: "dismissed", jobId: "job-1", reason: "user", rosterAttempted: true },
    });
    expect(await store.readCurrentCandidate()).toBeNull();
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();
  });

  it("a manual dismissal BEFORE any capture still reaches /roster before authorizing a DELETE", async () => {
    // The roster-attempt fence. Dismissing straight from the terminal screen must
    // not hand out a DELETE token for a capture-capable job that never contacted
    // `/roster` — that would destroy the only copy of a roster nobody looked at.
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate, fetchRoster, buildCandidate } = harness(store);

    const dismissed = await gate.dismiss(request("job-1", capture));

    expect(fetchRoster).toHaveBeenCalledTimes(1);
    // The fetch happens; the COMMIT does not — the user already declined it.
    expect(buildCandidate).not.toHaveBeenCalled();
    expect(dismissed.status).toBe("dismissed");
    if (dismissed.status !== "dismissed") throw new Error("unreachable");
    expect(dismissed.token).toMatchObject({ kind: "dismissed", rosterAttempted: true });
    expect(await store.readCurrentCandidate()).toBeNull();
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();
  });

  it("the fence exception is explicit: only a never-capture-capable run skips the fetch", async () => {
    // The contract is roster-attempt-before-DELETE, and the ONLY tokens that may
    // carry `rosterAttempted: false` are runs with no roster to fetch at all. This
    // is asserted rather than left as a global claim the code quietly violates.
    const store = freshStore();
    const staged = await stage(store, "own-1");

    const degraded = harness(store);
    const a = await degraded.gate.dismiss(
      request("job-a", { status: "unavailable", reason: "snapshot_persist_failed" }),
    );
    // `snapshot_missing` is reachable only through a staged authority whose
    // snapshot a successful read proves absent — a null authority defers, so this
    // is the path that keeps the vacuous-fence dismissal.
    const missing = harness(store);
    const b = await missing.gate.dismiss(
      request("job-b", { status: "staged", snapshotRef: "own-vanished", submissionOrdinal: 2 }),
    );
    const noArtifact = harness(store);
    const c = await noArtifact.gate.dismiss(request("job-c", staged, null));

    for (const outcome of [a, b, c]) {
      expect(outcome.status).toBe("dismissed");
      if (outcome.status !== "dismissed") throw new Error("unreachable");
      expect(outcome.token).toMatchObject({ rosterAttempted: false });
    }
    expect(degraded.fetchRoster).not.toHaveBeenCalled();
    expect(missing.fetchRoster).not.toHaveBeenCalled();
    expect(noArtifact.fetchRoster).not.toHaveBeenCalled();
  });

  it("a non-retryable assembly rejection resolves the run instead of offering a dead Retry", async () => {
    // F3's assembler failing closed on a container/version it does not own cannot be
    // repaired by retrying. The `/roster` fetch DID happen and no candidate can ever
    // exist, so this is an explicit unavailable outcome with cleanup authority.
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate, fetchRoster } = harness(store, {
      buildCandidate: () => ({ ok: false, retryable: false, reason: "unsupported container" }),
    });

    const outcome = await gate.capture(request("job-1", capture));

    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(outcome.state).toEqual({ status: "unavailable", cause: "assembly-rejected" });
    expect(outcome.token).toMatchObject({ kind: "dismissed", rosterAttempted: true });
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();

    // Negative control: a RETRYABLE failure of the same shape parks in commit-failed
    // with no token, so the job survives for a retry that can succeed.
    const other = await stage(store, "own-2");
    const retryable = harness(store, {
      buildCandidate: () => ({ ok: false, retryable: true, reason: "transient" }),
    });
    const parked = await retryable.gate.capture(request("job-2", other));
    expect(parked.state.status).toBe("commit-failed");
    expect(parked.token).toBeNull();
  });

  it("a dismissal during assembly prevents the commit entirely", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const building = deferred<{ ok: true; document: unknown }>();
    const { gate } = harness(store, { buildCandidate: () => building.promise });

    const flight = gate.capture(request("job-1", capture));
    // Let the flight reach the builder before dismissing.
    await vi.waitFor(() => expect(gate.getState("job-1").status).toBe("committing"));
    const dismissal = gate.dismiss(request("job-1", capture));
    building.resolve({ ok: true, document: { tag: "never-stored" } });

    await Promise.all([flight, dismissal]);
    expect(await store.readCurrentCandidate()).toBeNull();
    expect(await store.readCandidate("job-1")).toBeNull();
  });

  it("negative control: without the dismissal the same flight commits", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);
    expect((await gate.capture(request("job-1", capture))).token?.kind).toBe("committed");
    expect(await store.readCurrentCandidate()).not.toBeNull();
  });

  it("a dismissal that loses the race to the commit purges that EXACT candidate version", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);

    await gate.capture(request("job-1", capture));
    expect(await store.readCurrentCandidate()).not.toBeNull();

    const dismissed = await gate.dismiss(request("job-1", capture));
    expect(dismissed).toEqual({
      status: "dismissed",
      token: { kind: "dismissed", jobId: "job-1", reason: "user", rosterAttempted: true },
    });
    expect(await store.readCandidate("job-1")).toBeNull();
    expect(await store.readCurrentCandidate()).toBeNull();
  });

  it("a STALE dismissal cannot delete the same-job retry that replaced its candidate", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");

    // Capture #1 commits candidateVersion 1 and its gate remembers that version.
    const stale = harness(store);
    const first = await stale.gate.capture(request("job-1", capture));
    expect(first.token).toMatchObject({ candidateVersion: 1 });

    // A re-capture for the SAME job replaces it with a new, never-reused version.
    await store.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "retry" },
      expectedClearEpoch: await store.getClearEpoch(),
    });
    const current = await store.readCurrentCandidate();
    expect(current?.candidateVersion).toBe(2);

    // The stale gate's dismissal names version 1 — F1 refuses it, and the gate must
    // NOT claim a dismissal or hand out a DELETE token off the back of that refusal.
    const outcome = await stale.gate.dismiss(request("job-1", capture));
    expect(outcome.status).toBe("failed");
    expect(stale.gate.getState("job-1").status).toBe("dismiss-failed");
    // No DISMISSAL was claimed. (The earlier `committed` token stands: that commit
    // really happened and already authorized this job's cleanup. What must never
    // appear is a dismissal token asserting a removal that did not occur.)
    expect(stale.gate.getToken("job-1")?.kind).not.toBe("dismissed");
    expect(await store.readCandidate("job-1")).not.toBeNull();
    expect(await store.readCurrentCandidate()).toEqual(current);
  });

  it("a THROWING candidate deletion never claims dismissal and never authorizes a DELETE", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    let allowDelete = false;
    const failing: typeof store = {
      ...store,
      dismissCandidate: async (input) => {
        if (!allowDelete) throw new Error("IndexedDB is unavailable");
        return store.dismissCandidate(input);
      },
    };
    const { gate } = harness(failing);

    await gate.capture(request("job-1", capture));
    const failed = await gate.dismiss(request("job-1", capture));

    expect(failed.status).toBe("failed");
    expect(gate.getState("job-1").status).toBe("dismiss-failed");
    // No dismissal is claimed — the real-identity candidate is still durable, so
    // nothing here may assert it was removed.
    expect(gate.getToken("job-1")?.kind).not.toBe("dismissed");
    expect(await store.readCandidate("job-1")).not.toBeNull();

    // Negative control: the retry succeeds once storage recovers, and only THEN is a
    // dismissal claimed.
    allowDelete = true;
    const repaired = await gate.dismiss(request("job-1", capture));
    expect(repaired.status).toBe("dismissed");
    expect(gate.getToken("job-1")).toMatchObject({ kind: "dismissed" });
    expect(await store.readCandidate("job-1")).toBeNull();
  });

  it("a stale epoch settles the dismissal ONLY with verified purge evidence", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);
    await gate.capture(request("job-1", capture));

    // A real Clear: the epoch advances AND the stores are purged, so the candidate
    // is verifiably gone and Clear owns the removal.
    expect((await store.clearRosterData()).status).toBe("cleared");
    const outcome = await gate.dismiss(request("job-1", capture));
    expect(outcome.status).toBe("dismissed");
  });

  it("a stale epoch with the candidate STILL PRESENT is a local failure, not Clear-owned success", async () => {
    // `stale-epoch` alone only proves the write was refused. A store that advances
    // the epoch without purging (a Clear that failed midway) must not be mistaken
    // for a successful purge.
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const halfCleared: typeof store = {
      ...store,
      dismissCandidate: async () => ({ status: "stale-epoch", currentEpoch: 9 }),
    };
    const { gate } = harness(halfCleared);

    await gate.capture(request("job-1", capture));
    const outcome = await gate.dismiss(request("job-1", capture));

    expect(outcome.status).toBe("failed");
    expect(gate.getToken("job-1")?.kind).not.toBe("dismissed");
    expect(await store.readCandidate("job-1")).not.toBeNull();
  });

  it("dismissal is idempotent: a second call returns the same token and deletes nothing more", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);
    await gate.capture(request("job-1", capture));

    const one = await gate.dismiss(request("job-1", capture));
    const two = await gate.dismiss(request("job-1", capture));
    expect(two).toEqual(one);
  });

  it("a Clear committed mid-capture is fenced: nothing is stored and the token says so", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const building = deferred<{ ok: true; document: unknown }>();
    const { gate } = harness(store, { buildCandidate: () => building.promise });

    const flight = gate.capture(request("job-1", capture));
    await vi.waitFor(() => expect(gate.getState("job-1").status).toBe("committing"));
    await store.clearRosterData();
    building.resolve({ ok: true, document: { tag: "post-clear" } });

    const outcome = await flight;
    expect(outcome.state).toEqual({ status: "dismissed", reason: "cleared" });
    expect(outcome.token).toEqual({
      kind: "dismissed",
      jobId: "job-1",
      reason: "cleared",
      rosterAttempted: true,
    });
    // The purge is not repopulated by the completion that was in flight across it.
    expect(await store.readCurrentCandidate()).toBeNull();
    expect(await store.readCandidate("job-1")).toBeNull();
  });

  it("notifyCleared settles every unresolved entry without disturbing a settled one", async () => {
    const store = freshStore();
    const a = await stage(store, "own-A");
    const b = await stage(store, "own-B");
    const { gate } = harness(store, {
      fetchRoster: async (jobId: string) =>
        jobId === "job-B" ? Promise.reject(new Error("down")) : { solvedDays: [] },
    });

    expect((await gate.capture(request("job-A", a))).token).toMatchObject({ kind: "committed" });
    await gate.capture(request("job-B", b));

    await gate.notifyCleared();

    // job-A was COMMITTED. Clear destroyed that candidate, so the entry must stop
    // claiming a saved roster — while KEEPING the authority its server job still
    // needs. The token becomes an equivalent cleared dismissal rather than being
    // dropped (a commit implies the roster was fetched) and the state is honest.
    expect(gate.getState("job-A")).toEqual({ status: "dismissed", reason: "cleared" });
    expect(gate.getToken("job-A")).toEqual({
      kind: "dismissed",
      jobId: "job-A",
      reason: "cleared",
      rosterAttempted: true,
    });
    expect(gate.getToken("job-B")).toEqual({
      kind: "dismissed",
      jobId: "job-B",
      reason: "cleared",
      rosterAttempted: true,
    });
  });
});

describe("roster capture — roster-attempt authority", () => {
  it("a PRE-FETCH local failure cannot let dismissal authorize a DELETE", async () => {
    // `getClearEpoch()` rejecting settles `commit-failed` BEFORE `/roster` is
    // requested. That state is "settled", but the fence is still owed: treating it
    // as settled is exactly how a storage hiccup could manufacture DELETE authority
    // for a capture-capable job whose roster was never asked for.
    const store = freshStore();
    const capture = await stage(store, "own-1");
    let storageDown = true;
    const fenced: typeof store = {
      ...store,
      getClearEpoch: async () => {
        if (storageDown) throw new Error("IndexedDB is unavailable");
        return store.getClearEpoch();
      },
    };
    const { gate, fetchRoster } = harness(fenced);

    const first = await gate.capture(request("job-1", capture));
    expect(first.state.status).toBe("commit-failed");
    expect(first.token).toBeNull();
    expect(fetchRoster).not.toHaveBeenCalled();

    // The user dismisses while storage is STILL down: no roster attempt is possible,
    // so no token may be issued and the server job must survive.
    const blocked = await gate.dismiss(request("job-1", capture));
    expect(blocked.status).toBe("failed");
    expect(gate.getToken("job-1")).toBeNull();
    expect(gate.getState("job-1").status).toBe("dismiss-failed");

    // Negative control: once storage recovers, the same dismissal runs the fence —
    // `/roster` IS requested — and only then produces authority.
    storageDown = false;
    const allowed = await gate.dismiss(request("job-1", capture));
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(allowed.status).toBe("dismissed");
    if (allowed.status !== "dismissed") throw new Error("unreachable");
    expect(allowed.token).toMatchObject({ kind: "dismissed", rosterAttempted: true });
  });

  it("a REJECTED snapshot read is retryable and never authorizes a DELETE", async () => {
    // A failed read proves nothing about the snapshot — it may be perfectly intact.
    // Treating it as proven absence would emit a vacuous-fence token and let a
    // transient IndexedDB hiccup destroy the only server-side copy of the roster.
    const store = freshStore();
    const capture = await stage(store, "own-1", "still: here");
    let readsFail = true;
    const flaky: typeof store = {
      ...store,
      readSubmissionSnapshot: async (ownerId: string) => {
        if (readsFail) throw new Error("IndexedDB read failed");
        return store.readSubmissionSnapshot(ownerId);
      },
    };
    const { gate, fetchRoster } = harness(flaky);

    const failed = await gate.capture(request("job-1", capture));
    expect(failed.state.status).toBe("commit-failed");
    expect(failed.token).toBeNull();
    // Not `snapshot_missing`: nothing was proven absent.
    expect(failed.state).not.toMatchObject({ status: "unavailable" });
    expect(fetchRoster).not.toHaveBeenCalled();

    // RECOVERY CONTROL: the snapshot really was intact all along, so once reads
    // work the same entry captures from it successfully.
    readsFail = false;
    const recovered = await gate.retry(request("job-1", capture));
    expect(recovered.state.status).toBe("committed");
    expect(recovered.token).toMatchObject({ kind: "committed" });
    const row = await store.readCandidate<{ canonicalYaml: string }>("job-1");
    expect(row?.document.canonicalYaml).toBe("still: here");
  });

  it("a dismissal during a rejected snapshot read cannot authorize a DELETE either", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    let readsFail = true;
    const flaky: typeof store = {
      ...store,
      readSubmissionSnapshot: async (ownerId: string) => {
        if (readsFail) throw new Error("IndexedDB read failed");
        return store.readSubmissionSnapshot(ownerId);
      },
    };
    const { gate, fetchRoster } = harness(flaky);

    await gate.capture(request("job-1", capture));
    const blocked = await gate.dismiss(request("job-1", capture));

    expect(blocked.status).toBe("failed");
    expect(gate.getToken("job-1")).toBeNull();
    expect(gate.getState("job-1").status).toBe("dismiss-failed");
    // The fence never ran, so nothing may claim it did.
    expect(fetchRoster).not.toHaveBeenCalled();

    // Once reads recover, the SAME dismissal runs the fence and only then produces
    // authority — the repair for a failed dismissal is dismissing again.
    readsFail = false;
    const repaired = await gate.dismiss(request("job-1", capture));
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(repaired.status).toBe("dismissed");
    if (repaired.status !== "dismissed") throw new Error("unreachable");
    expect(repaired.token).toMatchObject({ kind: "dismissed", rosterAttempted: true });
  });

  it("a PROVEN-absent snapshot is still capture-unavailable", async () => {
    // The other half of the distinction: a successful read that finds nothing is a
    // real verdict and does authorize cleanup without a roster attempt.
    const store = freshStore();
    const { gate } = harness(store);
    const outcome = await gate.capture(
      request("job-1", { status: "staged", snapshotRef: "own-gone", submissionOrdinal: 3 }),
    );
    expect(outcome.state).toEqual({ status: "unavailable", cause: "snapshot_missing" });
    expect(outcome.token).toMatchObject({ kind: "unavailable", rosterAttempted: false });
  });

  it("a null authority (recovery handoff) DEFERS: no token, no settle, later capture succeeds", async () => {
    // The race this closes: a remount's terminal effect reaches capture before
    // recovery has attached the durable activation, so the request carries a null
    // authority. Null is not proof of absence — the snapshot may be perfectly
    // intact — so the gate must defer (no token, no settle) rather than hand back
    // a snapshot_missing DELETE token. The entry stays idle so the next call, once
    // recovery attaches the real authority, runs against the intact snapshot.
    const store = freshStore();
    const capture = await stage(store, "own-1", "still: intact");
    const { gate, fetchRoster } = harness(store);

    const deferred = await gate.capture(request("job-1", null));

    // NEGATIVE CONTROL: the old behaviour mapped null → snapshot_missing and
    // authorized DELETE. The deferred outcome is neither settled nor a token.
    expect(deferred.token).toBeNull();
    expect(deferred.state).toEqual({ status: "idle" });
    expect(gate.getState("job-1")).toEqual({ status: "idle" });
    expect(gate.getToken("job-1")).toBeNull();
    expect(fetchRoster).not.toHaveBeenCalled();

    // Recovery attaches the real authority: the intact snapshot captures normally,
    // proving the deferral left it usable.
    const outcome = await gate.capture(request("job-1", capture));
    expect(outcome.token?.kind).toBe("committed");
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    const row = await store.readCandidate<{ canonicalYaml: string }>("job-1");
    expect(row?.document.canonicalYaml).toBe("still: intact");
  });

  it("a null authority during a dismissal also defers (no fence can run yet)", async () => {
    // The same handoff reaches dismiss() if the user acts before recovery attaches.
    // The gate must not claim a dismissal it cannot prove, and the fence has not
    // run, so the outcome is a retryable dismissal failure — never a token.
    const store = freshStore();
    await stage(store, "own-1");
    const { gate, fetchRoster } = harness(store);

    const blocked = await gate.dismiss(request("job-1", null));

    expect(blocked.status).toBe("failed");
    expect(gate.getToken("job-1")).toBeNull();
    expect(fetchRoster).not.toHaveBeenCalled();
  });

  it("TOKEN MATRIX: `rosterAttempted: false` occurs only on the three pre-fetch causes", async () => {
    // Exhaustive over every way a token can be issued. The type already narrows
    // `rosterAttempted: false` to the `unavailable` variant with a
    // `PreFetchUnavailableCause`; this proves the runtime agrees, and that no
    // ordinary dismissal reason can reach it.
    const store = freshStore();
    const tokens: CaptureCleanupToken[] = [];

    // 1-3: the three pre-fetch causes.
    const staged = await stage(store, "own-pre");
    const degraded = harness(store);
    tokens.push(
      (
        await degraded.gate.capture(
          request("job-degraded", { status: "unavailable", reason: "snapshot_persist_failed" }),
        )
      ).token!,
    );
    // `snapshot_missing` is reachable ONLY through a staged authority whose
    // snapshot a successful read proves absent — a null authority (recovery
    // handoff) defers and issues no token, so this is the one remaining way.
    const missing = harness(store);
    tokens.push(
      (
        await missing.gate.capture(
          request("job-missing", {
            status: "staged",
            snapshotRef: "own-vanished",
            submissionOrdinal: 3,
          }),
        )
      ).token!,
    );
    const noArtifact = harness(store);
    tokens.push((await noArtifact.gate.capture(request("job-none", staged, null))).token!);

    // 4: committed.
    const committedOwner = await stage(store, "own-committed");
    const committed = harness(store);
    tokens.push((await committed.gate.capture(request("job-committed", committedOwner))).token!);

    // 5: user dismissal.
    const userOwner = await stage(store, "own-user");
    const user = harness(store);
    const dismissed = await user.gate.dismiss(request("job-user", userOwner));
    if (dismissed.status !== "dismissed") throw new Error("unreachable");
    tokens.push(dismissed.token);

    // 6: superseded (its ordinal is older than the committed pointer above).
    const supersededOwner = await stage(store, "own-superseded");
    await store.commitCandidate({
      jobId: "job-newer",
      submissionOrdinal: 99,
      document: { tag: "newer" },
      expectedClearEpoch: await store.getClearEpoch(),
    });
    const superseded = harness(store);
    tokens.push((await superseded.gate.capture(request("job-superseded", supersededOwner))).token!);

    // 7: assembly rejected — AFTER a real fetch, so it is a normal dismissal.
    const rejectedOwner = await stage(store, "own-rejected");
    const rejected = harness(store, {
      buildCandidate: () => ({ ok: false, retryable: false, reason: "unsupported" }),
    });
    tokens.push((await rejected.gate.capture(request("job-rejected", rejectedOwner))).token!);

    expect(tokens.every((token) => token !== null && token !== undefined)).toBe(true);
    const vacuous = tokens.filter((token) => token.rosterAttempted === false);
    expect(vacuous.map((token) => token.kind)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(vacuous.map((token) => (token.kind === "unavailable" ? token.cause : null))).toEqual([
      "snapshot_persist_failed",
      "snapshot_missing",
      "no-artifact",
    ]);
    // Everything else — committed, user, superseded, assembly-rejected — attempted.
    expect(tokens.filter((token) => token.rosterAttempted).length).toBe(4);
  });
});

describe("roster capture — F2 × F3 → F1 composition", () => {
  // Every other test in this file drives a STUB builder, which proves the state
  // machine but says nothing about whether F2 hands F3 what it actually needs.
  // These run the production builder — F3's real `assembleRosterDocument` — over a
  // real staged snapshot and commit through real F1 storage.

  async function stageReal(store: RosterStorage, ownerId: string) {
    const state = await stageSubmissionSnapshot({
      ownerId,
      // The exact envelope F3 owns: F2 stages it verbatim and never re-versions it.
      payload: fixtureSubmission(),
      store,
    });
    if (state.status !== "staged") throw new Error("fixture failed to stage");
    return state;
  }

  it("assembles a REAL roster document from the staged submission and commits it", async () => {
    const store = freshStore();
    const capture = await stageReal(store, "own-1");
    const gate = createRosterCapture({
      store,
      fetchRoster: async () => JSON.parse(JSON.stringify(fixtureContainer())) as unknown,
      buildCandidate: productionCandidateBuilder,
    });

    const frozen = fixtureFrozenXlsx();
    const outcome = await gate.capture(request("job-1", capture, frozen));

    expect(outcome.state.status).toBe("committed");
    expect(outcome.token).toMatchObject({ kind: "committed", rosterAttempted: true });

    const row = await store.readCandidate<RosterDocument>("job-1");
    const document = row!.document;
    // Only F3's assembler can produce these: the de-anonymized axis with typed ids
    // preserved, the derived calendar, and the recomputed baseline identity.
    expect(document.context.people.map((person) => person.id)).toEqual(["Alice Ng", 7]);
    expect(document.context.calendar).toHaveLength(fixtureContainer().dates.length);
    expect(document.solvedDays).toEqual(fixtureContainer().solvedDays);
    expect(document.provenance.solvedBaselineId).toMatch(/^[0-9a-f]{64}$/);
    expect(document.submission.schemaVersion).toBe(ROSTER_SUBMISSION_VERSION);
    expect(await document.frozenXlsx.arrayBuffer()).toEqual(await frozen.arrayBuffer());
    // The snapshot was consumed by the commit.
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();
  });

  it("a version F3 does not own is rejected THERE, not silently dropped during staging", async () => {
    // F2 stages an unknown submission version verbatim precisely so the single
    // version authority reports it with a real reason. If F2 had kept its own
    // version check the row would have vanished at read time and the run would
    // report a misleading `snapshot_missing`.
    const store = freshStore();
    const staged = await stageSubmissionSnapshot({
      ownerId: "own-future",
      payload: { ...fixtureSubmission(), schemaVersion: "roster-submission/99" },
      store,
    });
    if (staged.status !== "staged") throw new Error("fixture failed to stage");

    const gate = createRosterCapture({
      store,
      fetchRoster: async () => JSON.parse(JSON.stringify(fixtureContainer())) as unknown,
      buildCandidate: productionCandidateBuilder,
    });
    const outcome = await gate.capture(request("job-1", staged, fixtureFrozenXlsx()));

    expect(outcome.state).toEqual({ status: "unavailable", cause: "assembly-rejected" });
    expect(outcome.token).toMatchObject({ kind: "dismissed", rosterAttempted: true });
    expect(await store.readCurrentCandidate()).toBeNull();
  });

  it("a container that does not align with the submission is non-retryable", async () => {
    const store = freshStore();
    const capture = await stageReal(store, "own-1");
    const gate = createRosterCapture({
      store,
      fetchRoster: async () => ({ ...fixtureContainer(), people: [{ id: "P1" }] }),
      buildCandidate: productionCandidateBuilder,
    });

    const outcome = await gate.capture(request("job-1", capture, fixtureFrozenXlsx()));

    expect(outcome.state).toEqual({ status: "unavailable", cause: "assembly-rejected" });
    // Cleanup is authorized (the roster WAS fetched and no candidate can exist),
    // and no Retry is implied.
    expect(outcome.token).toMatchObject({ kind: "dismissed", rosterAttempted: true });
  });

  it("an OLDER real capture still cannot supersede a newer committed candidate", async () => {
    // The ordering authority holds with real documents, not just stub payloads.
    const store = freshStore();
    const older = await stageReal(store, "own-old");
    await stageReal(store, "own-new");
    await store.commitCandidate({
      jobId: "job-new",
      submissionOrdinal: 2,
      document: { tag: "newer" },
      expectedClearEpoch: await store.getClearEpoch(),
    });

    const gate = createRosterCapture({
      store,
      fetchRoster: async () => JSON.parse(JSON.stringify(fixtureContainer())) as unknown,
      buildCandidate: productionCandidateBuilder,
    });
    const outcome = await gate.capture(request("job-old", older, fixtureFrozenXlsx()));

    expect(outcome.state).toEqual({ status: "dismissed", reason: "superseded" });
    expect(await store.readCurrentCandidate()).toMatchObject({ jobId: "job-new" });
    expect(await store.readCandidate("job-old")).toBeNull();
  });
});

describe("roster capture — bounded container retention", () => {
  // The gate is app-lifetime, so anything a job entry holds is held for the tab's
  // life. Raw `/roster` containers are the only large part; retaining them is
  // justified ONLY while a retryable `commit-failed` could reuse them.

  it("retains bytes for an unresolved commit-failure and releases them after the retry", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    let builds = 0;
    const { gate, fetchRoster } = harness(store, {
      buildCandidate: ({ container }) => {
        builds += 1;
        return builds === 1
          ? { ok: false, retryable: true, reason: "transient" }
          : { ok: true, document: { container } };
      },
    });

    await gate.capture(request("job-1", capture));
    expect(gate.getState("job-1").status).toBe("commit-failed");
    expect(gate.retainedContainers()).toEqual(["job-1"]);

    await gate.retry(request("job-1", capture));
    expect(gate.getState("job-1").status).toBe("committed");
    // The retry was local (no second fetch) AND the bytes are now released.
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(gate.retainedContainers()).toEqual([]);
  });

  it("RETENTION MATRIX: no terminal outcome keeps raw roster bytes", async () => {
    const store = freshStore();

    // committed
    const committedOwner = await stage(store, "own-committed");
    const committed = harness(store);
    await committed.gate.capture(request("job-committed", committedOwner));
    expect(committed.gate.getState("job-committed").status).toBe("committed");
    expect(committed.gate.retainedContainers()).toEqual([]);

    // dismissed by the user
    const userOwner = await stage(store, "own-user");
    const user = harness(store);
    await user.gate.dismiss(request("job-user", userOwner));
    expect(user.gate.getState("job-user")).toEqual({ status: "dismissed", reason: "user" });
    expect(user.gate.retainedContainers()).toEqual([]);

    // unavailable via a non-retryable assembly rejection (bytes WERE fetched first)
    const rejectedOwner = await stage(store, "own-rejected");
    const rejected = harness(store, {
      buildCandidate: () => ({ ok: false, retryable: false, reason: "unsupported" }),
    });
    await rejected.gate.capture(request("job-rejected", rejectedOwner));
    expect(rejected.gate.getState("job-rejected")).toEqual({
      status: "unavailable",
      cause: "assembly-rejected",
    });
    expect(rejected.gate.retainedContainers()).toEqual([]);

    // superseded by a newer candidate
    const olderOwner = await stage(store, "own-older");
    await store.commitCandidate({
      jobId: "job-newer",
      submissionOrdinal: 99,
      document: { tag: "newer" },
      expectedClearEpoch: await store.getClearEpoch(),
    });
    const superseded = harness(store);
    await superseded.gate.capture(request("job-older", olderOwner));
    expect(superseded.gate.getState("job-older")).toEqual({
      status: "dismissed",
      reason: "superseded",
    });
    expect(superseded.gate.retainedContainers()).toEqual([]);
  });

  it("a verified Clear releases the bytes an unresolved commit-failure was holding", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store, {
      buildCandidate: () => ({ ok: false, retryable: true, reason: "transient" }),
    });

    await gate.capture(request("job-1", capture));
    expect(gate.retainedContainers()).toEqual(["job-1"]);

    await gate.notifyCleared();
    // There is nothing left to retry against, so the bytes go too.
    expect(gate.retainedContainers()).toEqual([]);
  });
});

describe("roster capture — unproven authority is never a joinable flight", () => {
  it("a null-authority call never becomes a flight the exact request joins", async () => {
    // The overlap, made deterministic. Both calls are issued in the SAME microtask,
    // so the null one is unquestionably still "open" when the exact one arrives —
    // exactly the window a remount hits when recovery attaches mid-handoff. If the
    // null call occupied `inFlight`, the exact caller would be handed its tokenless
    // outcome while arming its own once-guard, stranding the job for good with no
    // dependency left to change.
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate, fetchRoster } = harness(store);

    const deferredCall = gate.capture(request("job-1", null));
    const exactCall = gate.capture(request("job-1", capture));

    // The load-bearing assertion: two DIFFERENT promises. The old code returned
    // `deferredCall` here, and every failure below followed from that.
    expect(exactCall).not.toBe(deferredCall);

    const deferredOutcome = await deferredCall;
    expect(deferredOutcome.state).toEqual({ status: "idle" });
    expect(deferredOutcome.token).toBeNull();

    const outcome = await exactCall;
    expect(outcome.state.status).toBe("committed");
    expect(outcome.token).toMatchObject({ kind: "committed", jobId: "job-1" });
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(await store.readCurrentCandidate()).toMatchObject({ jobId: "job-1" });
  });

  it("a null-authority retry neither refetches nor discards the bytes a real retry needs", async () => {
    // `retry` checks the authority BEFORE its `fetch-failed` container reset, so an
    // authority-less retry arriving during the handoff cannot throw away the
    // container a `commit-failed` still needs — nor open a joinable flight.
    const store = freshStore();
    const capture = await stage(store, "own-1");
    let builds = 0;
    const { gate, fetchRoster } = harness(store, {
      buildCandidate: ({ container }) => {
        builds += 1;
        return builds === 1
          ? { ok: false, retryable: true, reason: "transient" }
          : { ok: true, document: { container } };
      },
    });

    await gate.capture(request("job-1", capture));
    expect(gate.getState("job-1").status).toBe("commit-failed");
    expect(gate.retainedContainers()).toEqual(["job-1"]);

    const ignored = await gate.retry(request("job-1", null));
    expect(ignored.state.status).toBe("commit-failed");
    expect(ignored.token).toBeNull();
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(gate.retainedContainers()).toEqual(["job-1"]);

    // Negative control: the SAME retry with real authority still succeeds locally.
    expect((await gate.retry(request("job-1", capture))).token).toMatchObject({
      kind: "committed",
    });
    expect(fetchRoster).toHaveBeenCalledTimes(1);
  });

  it("PROVEN absence settles durably and authorizes cleanup, so the run cannot deadlock", async () => {
    // The other half of the contract. A null defers forever by design, so recovery
    // proving that no record can attach has to be a DIFFERENT value — otherwise a
    // job whose authority genuinely will never arrive waits for it indefinitely and
    // its server artifact is never released.
    const store = freshStore();
    const { gate, fetchRoster } = harness(store);

    const outcome = await gate.capture(request("job-1", { status: "absent" }));

    expect(outcome.state).toEqual({ status: "unavailable", cause: "session_record_absent" });
    expect(outcome.token).toEqual({
      kind: "unavailable",
      jobId: "job-1",
      cause: "session_record_absent",
      rosterAttempted: false,
    });
    // There is no snapshot ref to reach and no reverse map to de-anonymize with, so
    // the run was never capture-capable and the roster fence is vacuous.
    expect(fetchRoster).not.toHaveBeenCalled();
    // Explicitly NOT the reserved proven-read cause.
    expect(outcome.state).not.toEqual({ status: "unavailable", cause: "snapshot_missing" });
  });

  it("a null authority settles nothing, and the same job still commits once authority arrives", async () => {
    const store = freshStore();
    const { gate, fetchRoster } = harness(store);

    const deferredOutcome = await gate.capture(request("job-1", null));
    expect(deferredOutcome.state).toEqual({ status: "idle" });
    expect(deferredOutcome.token).toBeNull();
    expect(fetchRoster).not.toHaveBeenCalled();

    // Negative control: deferring left nothing behind that blocks the real run.
    const capture = await stage(store, "own-1");
    expect((await gate.capture(request("job-1", capture))).token).toMatchObject({
      kind: "committed",
    });
    expect(fetchRoster).toHaveBeenCalledTimes(1);
  });
});

describe("roster capture — dismissal obeys the unproven-authority rule", () => {
  it("a null-authority DISMISSAL never becomes a flight the exact request joins", async () => {
    // `capture`/`retry` refuse a null request, but `dismiss` used to call `start()`
    // regardless — the same joinable app-lifetime flight, reached through Dismiss /
    // cleanup() instead of the automatic effect. Both calls are issued in the SAME
    // microtask, so the dismissal is unquestionably still open when the exact
    // capture arrives.
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate, fetchRoster } = harness(store);

    const dismissal = gate.dismiss(request("job-1", null));
    const exact = gate.capture(request("job-1", capture));

    // Nothing was minted from an authority nobody could prove.
    const dismissed = await dismissal;
    expect(dismissed.status).toBe("failed");

    // The user's intent is carried out by the flight that DOES have authority: the
    // roster fence runs first, then the dismissal settles. Never a commit, and
    // never the stranded tokenless join the old code produced.
    const outcome = await exact;
    expect(outcome.state).toEqual({ status: "dismissed", reason: "user" });
    expect(outcome.token).toMatchObject({
      kind: "dismissed",
      jobId: "job-1",
      reason: "user",
      rosterAttempted: true,
    });
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(await store.readCurrentCandidate()).toBeNull();
  });

  it("the recorded intent needs no second user action once authority arrives", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate, fetchRoster } = harness(store);

    const dismissed = await gate.dismiss(request("job-1", null));
    expect(dismissed.status).toBe("failed");
    // Deliberately NOT `dismiss-failed`: that notice tells the user the roster is
    // "still saved in this browser", which is false — capture has not run yet.
    expect(gate.getState("job-1")).toEqual({ status: "idle" });
    expect(gate.getToken("job-1")).toBeNull();

    // The ORDINARY capture honours it — the user does not dismiss twice.
    const outcome = await gate.capture(request("job-1", capture));
    expect(outcome.state).toEqual({ status: "dismissed", reason: "user" });
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(await store.readCurrentCandidate()).toBeNull();
    // The declined run's staging snapshot was retired by that explicit decision.
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();
  });

  it("negative control: a dismissal WITH authority still runs the fence and settles immediately", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate, fetchRoster } = harness(store);

    const dismissed = await gate.dismiss(request("job-1", capture));

    expect(dismissed.status).toBe("dismissed");
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(gate.getToken("job-1")).toMatchObject({ kind: "dismissed", rosterAttempted: true });
  });
});

describe("roster capture — dismissal proves BOTH local payload forms absent", () => {
  /** A store whose snapshot deletion can be made to fail on demand. */
  function fragileSnapshots(store: RosterStorage) {
    const control = { failDelete: false, staleEpoch: false, deleteCalls: 0 };
    const wrapped: RosterStorage = {
      ...store,
      async deleteSubmissionSnapshot(input) {
        control.deleteCalls += 1;
        if (control.failDelete) throw new Error("snapshot delete failed");
        if (control.staleEpoch) {
          return { status: "stale-epoch", currentEpoch: (await store.getClearEpoch()) + 1 };
        }
        return store.deleteSubmissionSnapshot(input);
      },
    };
    return Object.assign(control, { store: wrapped });
  }

  it("a PRE-COMMIT dismissal whose snapshot purge fails claims nothing and issues no token", async () => {
    // The user declined before anything was committed. If this reported `dismissed`
    // while the staging row survived, the UI would say the roster was discarded AND
    // hand out a token authorizing the server copy's deletion — leaving the exact
    // canonical YAML and real-identity map as the only surviving copy.
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const fragile = fragileSnapshots(store);
    fragile.failDelete = true;
    const { gate } = harness(fragile.store);

    const outcome = await gate.dismiss(request("job-1", capture));

    expect(outcome.status).toBe("failed");
    expect(gate.getState("job-1").status).toBe("dismiss-failed");
    expect(gate.getToken("job-1")).toBeNull();
    expect(await store.readSubmissionSnapshot("own-1")).not.toBeNull();

    // RETRY completes once the store recovers.
    fragile.failDelete = false;
    const retried = await gate.dismiss(request("job-1", capture));
    expect(retried.status).toBe("dismissed");
    expect(gate.getToken("job-1")).toMatchObject({ kind: "dismissed" });
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();
  });

  it("a COMMIT whose staging purge fails issues NO token, and its retry finishes only the purge", async () => {
    // The candidate is durable, but the staging row is the only durable handle to
    // `snapshot:<ownerId>` — the pointer records job/version/ordinal, not the owner.
    // Handing out the committed token here would let terminal cleanup consume the
    // session authority and leave a reload with a loadable candidate it can never
    // finish retiring. So the token waits for proof.
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const fragile = fragileSnapshots(store);
    fragile.failDelete = true;
    const { gate, fetchRoster } = harness(fragile.store);

    const blocked = await gate.capture(request("job-1", capture));
    expect(blocked.token).toBeNull();
    expect(blocked.state.status).toBe("commit-failed");
    // Everything the retry needs survives: the candidate, the staging row, and the
    // session/job authority that no token was minted to consume.
    expect(await store.readCandidate("job-1")).not.toBeNull();
    expect(await store.readSubmissionSnapshot("own-1")).not.toBeNull();

    fragile.failDelete = false;
    const retried = await gate.retry(request("job-1", capture));
    expect(retried.token).toMatchObject({ kind: "committed" });
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();
    // The retry finished the PURGE only — no second `/roster` call and no second
    // candidate version.
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect((await store.readCurrentCandidate())?.candidateVersion).toBe(1);
  });

  it("RELOAD: a fresh gate finishes a commit whose purge failed, with no durable debt", async () => {
    // The reload cut. A new tab/gate has no memory of the owed purge — and needs
    // none: because no token was issued, terminal cleanup never ran, so the session
    // record still carries `capture.snapshotRef`, and F1 accepts an idempotent
    // same-ordinal recommit for the same job.
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const fragile = fragileSnapshots(store);
    fragile.failDelete = true;
    const first = harness(fragile.store);
    expect((await first.gate.capture(request("job-1", capture))).token).toBeNull();

    // A brand new gate, exactly as a reload would build it.
    fragile.failDelete = false;
    const reloaded = harness(fragile.store);
    const outcome = await reloaded.gate.capture(request("job-1", capture));

    expect(outcome.token).toMatchObject({ kind: "committed" });
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();
    expect(await store.readCurrentCandidate()).toMatchObject({ jobId: "job-1" });

    // And the candidate that survived is dismissible in full afterwards.
    const dismissed = await reloaded.gate.dismiss(request("job-1", capture));
    expect(dismissed.status).toBe("dismissed");
    expect(await store.readCandidate("job-1")).toBeNull();
  });

  it("an explicit dismissal AFTER a fully successful capture still proves both forms absent", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);

    expect((await gate.capture(request("job-1", capture))).token).toMatchObject({
      kind: "committed",
    });
    // The commit already proved its purge, so nothing is owed.
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();

    const dismissed = await gate.dismiss(request("job-1", capture));
    expect(dismissed.status).toBe("dismissed");
    expect(await store.readCandidate("job-1")).toBeNull();
    expect(await store.readCurrentCandidate()).toBeNull();
  });

  // Every remaining capture outcome that used to mint a token after an UNPROVEN
  // purge. None may authorize a server DELETE while the staging row survives.
  const TOKENLESS_OUTCOMES: [string, Partial<Parameters<typeof harness>[1]>, Blob | null][] = [
    ["no-artifact", {}, null],
    [
      "assembly-rejected (non-retryable)",
      { buildCandidate: () => ({ ok: false, retryable: false, reason: "unsupported" }) },
      FROZEN,
    ],
  ];

  it.each(TOKENLESS_OUTCOMES)(
    "%s issues NO token while its staging purge is unproven, and retries to completion",
    async (_label, over, frozen) => {
      const store = freshStore();
      const capture = await stage(store, "own-1");
      const fragile = fragileSnapshots(store);
      fragile.failDelete = true;
      const { gate } = harness(fragile.store, over);

      const blocked = await gate.capture(request("job-1", capture, frozen));
      expect(blocked.token).toBeNull();
      expect(await store.readSubmissionSnapshot("own-1")).not.toBeNull();

      fragile.failDelete = false;
      const retried = await gate.retry(request("job-1", capture, frozen));
      expect(retried.token).not.toBeNull();
      expect(await store.readSubmissionSnapshot("own-1")).toBeNull();
    },
  );

  it("SUPERSEDED issues no token while its staging purge is unproven", async () => {
    const store = freshStore();
    const older = await stage(store, "own-old");
    await store.commitCandidate({
      jobId: "job-new",
      submissionOrdinal: 99,
      document: { tag: "newer" },
      expectedClearEpoch: await store.getClearEpoch(),
    });
    const fragile = fragileSnapshots(store);
    fragile.failDelete = true;
    const { gate } = harness(fragile.store);

    const blocked = await gate.capture(request("job-old", older));
    expect(blocked.token).toBeNull();
    expect(await store.readSubmissionSnapshot("own-old")).not.toBeNull();
    // The newer pointer is untouched throughout.
    expect(await store.readCurrentCandidate()).toMatchObject({ jobId: "job-new" });

    fragile.failDelete = false;
    const retried = await gate.retry(request("job-old", older));
    expect(retried.token).toMatchObject({ kind: "dismissed", reason: "superseded" });
    expect(await store.readSubmissionSnapshot("own-old")).toBeNull();
  });

  it("a Clear racing an unproven purge settles through the epoch fence, not a false token", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const fragile = fragileSnapshots(store);
    fragile.staleEpoch = true;
    const { gate } = harness(fragile.store);

    // The fence refuses while the row is still there — no token.
    expect((await gate.capture(request("job-1", capture))).token).toBeNull();

    // A real Clear then takes the row; the same refusal now reads back as absence.
    expect((await store.clearRosterData()).status).toBe("cleared");
    const retried = await gate.retry(request("job-1", capture));
    expect(retried.token).not.toBeNull();
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();
  });

  it("STALE EPOCH on the dismissal purge settles only on verified absence", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const fragile = fragileSnapshots(store);
    fragile.staleEpoch = true;
    const { gate } = harness(fragile.store);

    // The row is still there, so the fence refusal proves nothing.
    const blocked = await gate.dismiss(request("job-1", capture));
    expect(blocked.status).toBe("failed");
    expect(gate.getToken("job-1")).toBeNull();

    // Now a real Clear has taken the row; the same refusal is read back as absence.
    await store.deleteSubmissionSnapshot({
      ownerId: "own-1",
      expectedClearEpoch: await store.getClearEpoch(),
    });
    const settled = await gate.dismiss(request("job-1", capture));
    expect(settled.status).toBe("dismissed");
  });

  it("negative control: a dismissal whose purge succeeds settles immediately", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);
    expect((await gate.dismiss(request("job-1", capture))).status).toBe("dismissed");
    expect(await store.readSubmissionSnapshot("own-1")).toBeNull();
  });
});

describe("roster capture — subscription", () => {
  it("notifies subscribers as the state advances and stops after unsubscribe", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);
    const seen: string[] = [];
    const unsubscribe = gate.subscribe(() => seen.push(gate.getState("job-1").status));

    await gate.capture(request("job-1", capture));
    expect(seen).toContain("fetching-roster");
    expect(seen).toContain("committing");
    expect(seen.at(-1)).toBe("committed");

    unsubscribe();
    const before = seen.length;
    await gate.dismiss(request("job-1", capture));
    expect(seen.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Durable, job/version-keyed dismissal (F4 surface)
// ---------------------------------------------------------------------------
//
// `dismiss` takes a whole `CaptureRequest` because it may have to run the
// roster-attempt fence. The durable roster surface has no such request: after a
// reload there is no session record, no snapshot ref and no workbook. It knows
// only what F1's pointer says. These tests pin what that keyed operation may and
// may not conclude from that much less evidence.

describe("roster capture — dismissDurableCandidate", () => {
  it("removes the exact stored version and reports the dismissal", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);
    const committed = await gate.capture(request("job-1", capture));
    expect(committed.state.status).toBe("committed");

    const outcome = await gate.dismissDurableCandidate({ jobId: "job-1", candidateVersion: 1 });

    expect(outcome.status).toBe("dismissed");
    expect(await store.readCandidate("job-1")).toBeNull();
    expect(await store.readCurrentCandidate()).toBeNull();
  });

  it("in-session, still issues DELETE authority for the job it captured", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);
    await gate.capture(request("job-1", capture));

    const outcome = await gate.dismissDurableCandidate({ jobId: "job-1", candidateVersion: 1 });

    // This process DID fetch `/roster` for job-1, so the fence is satisfied and
    // the server job may be cleaned up.
    expect(outcome).toMatchObject({ status: "dismissed" });
    if (outcome.status !== "dismissed") throw new Error("unreachable");
    expect(outcome.token).toMatchObject({ jobId: "job-1", rosterAttempted: true });
  });

  // THE FRESH-PROCESS RULE. A reload leaves a durable candidate with no gate
  // entry. Removing it locally is right; issuing DELETE authority is not, because
  // this process never fetched `/roster` for that job — and does not need to,
  // since the session that committed it already consumed its cleanup authority.
  it("after a fresh start, removes locally but issues NO cleanup token", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    // Session one commits the candidate.
    await harness(store).gate.capture(request("job-1", capture));

    // Session two: a brand-new gate, exactly as a reload produces.
    const reloaded = harness(store).gate;
    expect(reloaded.getState("job-1").status).toBe("idle");

    const outcome = await reloaded.dismissDurableCandidate({
      jobId: "job-1",
      candidateVersion: 1,
    });

    expect(outcome.status).toBe("dismissed");
    if (outcome.status !== "dismissed") throw new Error("unreachable");
    expect(outcome.token).toBeNull();
    // The local removal is real, not merely claimed.
    expect(await store.readCandidate("job-1")).toBeNull();
  });

  // THE VERSION FENCE. A retry commits a NEW candidateVersion for the same job.
  // A dismissal decided against the version on screen must not delete a newer
  // capture the user never saw.
  it("refuses when the stored version is not the one displayed", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    await harness(store).gate.capture(request("job-1", capture));

    const reloaded = harness(store).gate;
    const outcome = await reloaded.dismissDurableCandidate({
      jobId: "job-1",
      candidateVersion: 99,
    });

    expect(outcome.status).toBe("failed");
    // NEGATIVE CONTROL: the real candidate is untouched by the refused call.
    expect(await store.readCandidate("job-1")).not.toBeNull();
    expect(await store.readCurrentCandidate()).not.toBeNull();
  });

  it("refuses in-session when a newer capture has moved the pointer", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);
    await gate.capture(request("job-1", capture));

    // The surface is still showing version 1; the gate committed version 1 too,
    // so ask for a stale version and prove the in-session guard fires before any
    // storage call could act on it.
    const outcome = await gate.dismissDurableCandidate({ jobId: "job-1", candidateVersion: 0 });

    expect(outcome.status).toBe("failed");
    expect(await store.readCandidate("job-1")).not.toBeNull();
  });

  it("does not act on a DIFFERENT job than the one named", async () => {
    const store = freshStore();
    const captureA = await stage(store, "own-a");
    const gateA = harness(store).gate;
    await gateA.capture(request("job-a", captureA));

    // A later run B exists in the same gate and is the "current" one by recency.
    const captureB = await stage(store, "own-b");
    const outcomeB = await gateA.capture(request("job-b", captureB));
    expect(outcomeB.state.status).toBe("committed");

    // Dismissing A by key must leave B's entry and token untouched.
    const tokenBBefore = gateA.getToken("job-b");
    await gateA.dismissDurableCandidate({ jobId: "job-a", candidateVersion: 1 });

    expect(gateA.getToken("job-b")).toBe(tokenBBefore);
    expect(gateA.getState("job-b").status).toBe("committed");
  });

  it("is idempotent: a second call returns the same settled dismissal", async () => {
    const store = freshStore();
    const capture = await stage(store, "own-1");
    const { gate } = harness(store);
    await gate.capture(request("job-1", capture));

    const first = await gate.dismissDurableCandidate({ jobId: "job-1", candidateVersion: 1 });
    const second = await gate.dismissDurableCandidate({ jobId: "job-1", candidateVersion: 1 });

    expect(first.status).toBe("dismissed");
    expect(second.status).toBe("dismissed");
  });
});
