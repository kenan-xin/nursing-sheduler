// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PeopleReverseMap } from "@/lib/scenario";
import {
  OPTIMIZE_SESSION_SCHEMA_VERSION,
  OPTIMIZE_SESSION_STORAGE_KEY,
  buildProvisionalSession,
  inspectPersistedSession,
  stageProvisionalSession,
  type ActiveOptimizeSession,
  type InspectedSession,
  type PreparedDegradedCleanup,
  type SessionTransactionStorage,
} from "./session-transaction";
import {
  buildRecoveryAttachment,
  interpretInspectedSession,
  useOptimizeSessionRecovery,
} from "./session-recovery";
import type {
  CursorPersistenceProvider,
  PreparedRecoveryAttachment,
  RecoveredAttachOutcome,
} from "./use-optimize-run";
import type { SubmissionSnapshotStore } from "./submission-snapshot";
import { OPTIMIZE_RETIRE_PENDING_STORAGE_KEY } from "./session-transaction";

const KEY = OPTIMIZE_SESSION_STORAGE_KEY;

/** A minimal injectable Storage with per-op overrides (throw/no-op adversarial cases).
 *  KEY-HONOURING: a retirement writes its owner-scoped pending marker under a
 *  second key, so a single-slot double would silently clobber the session record. */
class FakeStorage implements SessionTransactionStorage {
  private store = new Map<string, string>();
  // KEY-AWARE overrides: the marker lives under a second key, so a cut like
  // "the marker write fails while session-record writes still work" is only
  // expressible if the hook sees which key it was handed.
  onGet: ((key: string, store: Map<string, string>) => string | null) | null = null;
  onSet: ((key: string, value: string, store: Map<string, string>) => void) | null = null;
  onRemove: ((key: string, store: Map<string, string>) => void) | null = null;

  getItem(key: string): string | null {
    if (this.onGet) return this.onGet(key, this.store);
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.onSet) return this.onSet(key, value, this.store);
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    if (this.onRemove) return this.onRemove(key, this.store);
    this.store.delete(key);
  }
  raw(key: string = KEY): string | null {
    return this.store.get(key) ?? null;
  }
  seed(value: string): void {
    this.store.set(KEY, value);
  }
}

/**
 * The narrow F1 surface a retirement needs, with failure injection.
 *
 * The real store is IndexedDB and this file deliberately runs without it, so the
 * crash cuts below are driven here rather than by importing `fake-indexeddb` and
 * changing the whole file's environment.
 */
function snapshotStoreDouble(seeded: string[] = []) {
  const rows = new Set(seeded);
  const control = {
    rows,
    deleteCalls: [] as string[],
    epoch: 0,
    /** The delete transaction throws (transient IndexedDB failure). */
    failDelete: false,
    /** The epoch fence refuses the write (a verified Clear landed under us). */
    staleEpoch: false,
    /** `getClearEpoch` throws (roster storage unreachable). */
    failEpoch: false,
    /** Park the delete so a test can hold one retirement genuinely in flight. */
    deleteGate: null as Promise<void> | null,
  };
  const store = {
    getClearEpoch: async () => {
      if (control.failEpoch) throw new Error("roster storage is unavailable");
      return control.epoch;
    },
    allocateSubmissionSnapshot: async () => ({
      status: "stale-epoch",
      currentEpoch: control.epoch,
    }),
    readSubmissionSnapshot: async (ownerId: string) =>
      rows.has(ownerId)
        ? { key: `snapshot:${ownerId}`, ownerId, submissionOrdinal: 1, payload: {} }
        : null,
    deleteSubmissionSnapshot: async ({ ownerId }: { ownerId: string }) => {
      control.deleteCalls.push(ownerId);
      if (control.deleteGate) await control.deleteGate;
      if (control.failDelete) throw new Error("snapshot delete failed");
      if (control.staleEpoch) return { status: "stale-epoch", currentEpoch: control.epoch + 1 };
      return rows.delete(ownerId) ? { status: "deleted" } : { status: "already-absent" };
    },
  } as unknown as SubmissionSnapshotStore;
  return Object.assign(control, { store });
}

function securityError(): never {
  const error = new Error("blocked") as Error & { name: string };
  error.name = "SecurityError";
  throw error;
}

const REVERSE_MAP: PeopleReverseMap = [
  ["P1", "Alice"],
  ["P2", 7],
];

function activeRecord(over: Partial<ActiveOptimizeSession> = {}): ActiveOptimizeSession {
  return {
    schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
    ownerId: "owner-A",
    phase: "active",
    jobId: "job-1",
    anonymized: true,
    runOptions: { prettify: true, timeout: 300 },
    peopleCount: 2,
    reverseMap: REVERSE_MAP,
    capture: { status: "staged", snapshotRef: "owner-A", submissionOrdinal: 1 },
    ...over,
  };
}

function seedActive(storage: FakeStorage, over: Partial<ActiveOptimizeSession> = {}): void {
  storage.seed(JSON.stringify(activeRecord(over)));
}

function seedInterrupted(storage: FakeStorage, ownerId = "owner-P"): void {
  const outcome = stageProvisionalSession(
    storage,
    buildProvisionalSession({
      ownerId,
      anonymized: true,
      peopleCount: 2,
      reverseMap: REVERSE_MAP,
      runOptions: { timeout: 300 },
      capture: { status: "staged", snapshotRef: ownerId, submissionOrdinal: 1 },
    }),
  );
  if (outcome.status !== "staged") throw new Error(`expected staged, got ${outcome.status}`);
}

/**
 * A fake T16a controller: records attaches, tracks a mutable live job, holds the
 * registered provider (identity-scoped with token-checked unregister), and lets a test
 * supply a degraded provisional-cleanup capability for a job.
 */
function makeController(opts?: {
  live?: string | null;
  attachResult?: RecoveredAttachOutcome;
  degraded?: { jobId: string; cleanup: PreparedDegradedCleanup };
}) {
  let live: string | null = opts?.live ?? null;
  let provider: CursorPersistenceProvider | null = null;
  const attach = vi.fn((input: PreparedRecoveryAttachment): RecoveredAttachOutcome => {
    if (opts?.attachResult) return opts.attachResult;
    live = input.jobId;
    provider?.prepare(input.jobId, input.activation.reloadRecoveryAvailable);
    return { status: "attached", jobId: input.jobId };
  });
  // Emits a reset signal only against the exact live attachment (no re-attach).
  const notifyInvalidCursorReset = vi.fn((jobId: string): boolean => jobId === live);
  return {
    controller: {
      attachRecoveredSession: attach,
      getLiveJobId: () => live,
      notifyInvalidCursorReset,
      registerCursorPersistence: (p: CursorPersistenceProvider): (() => void) => {
        provider = p;
        if (live !== null) p.prepare(live, true);
        return () => {
          if (provider === p) provider = null;
        };
      },
      prepareDegradedCleanup: (jobId: string): PreparedDegradedCleanup | null =>
        opts?.degraded && opts.degraded.jobId === jobId ? opts.degraded.cleanup : null,
      revokeCursorPersistence: (jobId: string): void => provider?.revoke(jobId),
    },
    attach,
    notifyInvalidCursorReset,
    getProvider: () => provider,
    setLive: (jobId: string | null) => {
      live = jobId;
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("interpretInspectedSession — raw inspection → UI recovery state", () => {
  it("maps every inspection kind", () => {
    expect(interpretInspectedSession({ kind: "none" })).toEqual({ kind: "none" });

    const storage = new FakeStorage();
    seedActive(storage, { lastCursor: "c9" });
    expect(interpretInspectedSession(inspectPersistedSession(storage))).toEqual({
      kind: "resumable",
      jobId: "job-1",
      anonymized: true,
      peopleCount: 2,
    });

    const interrupted = new FakeStorage();
    seedInterrupted(interrupted);
    expect(interpretInspectedSession(inspectPersistedSession(interrupted))).toEqual({
      kind: "interrupted",
      anonymized: true,
      peopleCount: 2,
    });

    const corrupt = new FakeStorage();
    corrupt.seed("{not json");
    expect(interpretInspectedSession(inspectPersistedSession(corrupt))).toEqual({
      kind: "unreadable",
    });

    const unreadable: InspectedSession = { kind: "unreadable", identity: null };
    expect(interpretInspectedSession(unreadable)).toEqual({ kind: "storage-error" });
  });
});

describe("buildRecoveryAttachment — transport-ready resume seam", () => {
  it("carries job id, activation, and the persisted cursor (no per-attachment callbacks)", () => {
    const attachment = buildRecoveryAttachment(activeRecord({ lastCursor: "c-boot" }));
    expect(attachment.jobId).toBe("job-1");
    expect(attachment.initialCursor).toBe("c-boot");
    expect(attachment.activation).toEqual({
      anonymized: true,
      // The reload's roster-capture authority is carried verbatim from the record.
      capture: { status: "staged", snapshotRef: "owner-A", submissionOrdinal: 1 },
      peopleCount: 2,
      reverseMap: REVERSE_MAP,
      reloadRecoveryAvailable: true,
    });
    expect("onCursorCommit" in attachment).toBe(false);
  });

  it("uses a null initial cursor when the record has not committed one yet", () => {
    expect(buildRecoveryAttachment(activeRecord()).initialCursor).toBeNull();
  });
});

describe("useOptimizeSessionRecovery — boot interpretation + auto-resume", () => {
  it("auto-resumes a resumable record once and surfaces the attach outcome", () => {
    const storage = new FakeStorage();
    seedActive(storage, { lastCursor: "c-seed" });
    const c = makeController();

    const { result, rerender } = renderHook(() =>
      useOptimizeSessionRecovery(c.controller, { storage }),
    );

    expect(c.attach).toHaveBeenCalledTimes(1);
    expect(c.attach.mock.calls[0][0].jobId).toBe("job-1");
    expect(c.attach.mock.calls[0][0].initialCursor).toBe("c-seed");
    expect(result.current.state).toEqual({
      kind: "resumable",
      jobId: "job-1",
      anonymized: true,
      peopleCount: 2,
    });
    expect(result.current.resume).toEqual({ status: "attached", jobId: "job-1" });
    expect(result.current.ready).toBe(true);

    rerender();
    expect(c.attach).toHaveBeenCalledTimes(1);
  });

  it("boots a persisted active session with an oversized cursor into invalid-cursor recovery: clears the cursor, resumes from the floor, never retired", () => {
    // The real persisted-restore path (`cursor-seam-and-feed-order` P1 #2): an
    // otherwise-valid active record whose saved cursor is oversized must resume the
    // job — cursor cleared through the verified seam, attach from the retained floor,
    // and the explicit invalid-cursor reset flag set — NOT become a retirement.
    const storage = new FakeStorage();
    seedActive(storage, { lastCursor: "c".repeat(4096 + 1) });
    const c = makeController();

    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    expect(c.attach).toHaveBeenCalledTimes(1);
    const attachment = c.attach.mock.calls[0][0];
    expect(attachment.jobId).toBe("job-1"); // identity preserved
    expect(attachment.initialCursor).toBeNull(); // resume from the retained floor
    expect(attachment.invalidCursorReset).toBe(true); // explicit invalid-cursor recovery
    // The oversized cursor is durably cleared, so a later reload sees a clean record.
    expect("lastCursor" in JSON.parse(storage.raw()!)).toBe(false);
    // The session resumed — it is NOT classified unreadable.
    expect(result.current.state.kind).toBe("resumable");
    expect(result.current.resume).toEqual({ status: "attached", jobId: "job-1" });
  });

  // P1 #2 (runtime-boundary-and-clear-outcome): boot must BRANCH on the durable clear
  // result — never attach + claim recovery when the poison cursor was not actually removed.
  const OVERSIZED = "c".repeat(4096 + 1);

  it("boot: clear returns `none` (record changed since inspect) — re-inspects and follows the CURRENT classification, never a stale attach", () => {
    const storage = new FakeStorage();
    const poison = JSON.stringify(activeRecord({ jobId: "job-1", lastCursor: OVERSIZED }));
    const clean = JSON.stringify(activeRecord({ jobId: "job-1" })); // no cursor now
    let calls = 0;
    // inspect reads the poison; by the time the clear (and re-inspect) read, the record
    // has been replaced by a clean cursorless active record for the same job.
    storage.onGet = () => {
      calls += 1;
      return calls === 1 ? poison : clean;
    };
    const c = makeController();

    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    expect(c.attach).toHaveBeenCalledTimes(1);
    const attachment = c.attach.mock.calls[0][0];
    expect(attachment.jobId).toBe("job-1");
    // Attaches the RE-INSPECTED clean record (its own state), NOT the stale poison record,
    // and NOT as an invalid-cursor reset.
    expect(attachment.invalidCursorReset ?? false).toBe(false);
    expect(attachment.initialCursor).toBeNull();
    expect(result.current.state.kind).toBe("resumable");
  });

  const poison = (job: string): string =>
    JSON.stringify(activeRecord({ jobId: job, lastCursor: OVERSIZED }));

  it("boot: already-live poisoned record — verified clear runs anyway, ONE exact-job reset signal, no second transport, truthful durability", () => {
    const storage = new FakeStorage();
    seedActive(storage, { lastCursor: OVERSIZED });
    const c = makeController({ live: "job-1" }); // the matching job is already live

    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    // The verified clear runs BEFORE the same-live shortcut: the durable poison is removed.
    expect("lastCursor" in JSON.parse(storage.raw()!)).toBe(false);
    // Exactly one exact-job invalid-cursor reset signal, and NO re-attach (no second stream).
    expect(c.notifyInvalidCursorReset).toHaveBeenCalledTimes(1);
    expect(c.notifyInvalidCursorReset).toHaveBeenCalledWith("job-1");
    expect(c.attach).not.toHaveBeenCalled();
    // Truthful durable recovery for the already-live job.
    expect(result.current.resume).toEqual({ status: "attached", jobId: "job-1" });
    expect(result.current.state.kind).toBe("resumable");
  });

  it("boot: `none` replacement is ANOTHER invalid-cursor job — treats it as the new authority (verified clear + attach)", () => {
    const storage = new FakeStorage();
    storage.seed(poison("job-2")); // the CURRENT record after the race
    let firstRead = true;
    storage.onGet = () => {
      if (firstRead) {
        firstRead = false;
        return poison("job-1"); // the initial inspection sees the OLD job-1 poison
      }
      storage.onGet = null; // everything after uses the real store (job-2 poison)
      return storage.raw();
    };
    const c = makeController();

    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    // job-1's clear returns `none`; the re-inspection processes job-2 as the new authority,
    // verifies ITS clear, and attaches it as an invalid-cursor reset from the floor.
    expect(c.attach).toHaveBeenCalledTimes(1);
    const attachment = c.attach.mock.calls[0][0];
    expect(attachment.jobId).toBe("job-2");
    expect(attachment.invalidCursorReset).toBe(true);
    expect(attachment.initialCursor).toBeNull();
    expect("lastCursor" in JSON.parse(storage.raw()!)).toBe(false); // job-2 poison durably cleared
    expect(result.current.resume).toEqual({ status: "attached", jobId: "job-2" });
  });

  it("boot: `none` replacement is ABSENT — no attach, state none", () => {
    const storage = new FakeStorage();
    let calls = 0;
    storage.onGet = () => {
      calls += 1;
      return calls === 1 ? poison("job-1") : null; // record vanished after inspect
    };
    const c = makeController();

    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    expect(c.attach).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe("none");
    expect(result.current.resume).toBeNull();
  });

  it("boot: `none` replacement has a SECOND defect — no attach, state unreadable", () => {
    const storage = new FakeStorage();
    const secondDefect = JSON.stringify({ ...JSON.parse(poison("job-1")), schemaVersion: 999 });
    let calls = 0;
    storage.onGet = () => {
      calls += 1;
      return calls === 1 ? poison("job-1") : secondDefect; // oversized cursor AND bad version
    };
    const c = makeController();

    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    expect(c.attach).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe("unreadable");
    expect(result.current.resume).toBeNull();
  });

  it("boot: record changes AGAIN during a re-inspected invalid-cursor clear — explicit visible conflict, no attach or loop", () => {
    const storage = new FakeStorage();
    const seq = [poison("job-1"), poison("job-2"), poison("job-2"), poison("job-3")];
    let i = 0;
    storage.onGet = () => seq[Math.min(i++, seq.length - 1)];
    const c = makeController();

    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    expect(c.attach).not.toHaveBeenCalled();
    expect(c.notifyInvalidCursorReset).not.toHaveBeenCalled();
    // Surfaced as an explicit visible conflict — NOT a stuck resumable+null or a loop.
    expect(result.current.resume?.status).toBe("conflict");
    expect(result.current.state.kind).toBe("resumable"); // resumable + conflict → RecoveryNotice error
  });

  it("boot: `unverified` clear (durable WRITE fails) fails closed — no attach, storage-error state, poison retained", () => {
    const storage = new FakeStorage();
    seedActive(storage, { lastCursor: OVERSIZED });
    storage.onSet = () => securityError(); // the verified clear's write throws
    const c = makeController();

    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    expect(c.attach).not.toHaveBeenCalled(); // fail closed — never attach on an unverified clear
    expect(result.current.state.kind).toBe("storage-error"); // visible, not a healthy-reload claim
    expect(result.current.resume).toBeNull();
    expect("lastCursor" in JSON.parse(storage.raw()!)).toBe(true); // poison NOT durably removed
  });

  it("boot: `unverified` clear (READ-BACK mismatch) fails closed — no attach, storage-error state", () => {
    const storage = new FakeStorage();
    seedActive(storage, { lastCursor: OVERSIZED });
    storage.onSet = () => {}; // swallow the write, so the read-back still sees the poison record
    const c = makeController();

    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    expect(c.attach).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe("storage-error");
    expect(result.current.resume).toBeNull();
    expect("lastCursor" in JSON.parse(storage.raw()!)).toBe(true);
  });

  it("boot: `unverified` clear (storage READ failure) fails closed — no attach, storage-error state", () => {
    const storage = new FakeStorage();
    const poison = JSON.stringify(activeRecord({ jobId: "job-1", lastCursor: OVERSIZED }));
    let calls = 0;
    // inspect reads the poison; the clear's own read then fails (private-mode/security).
    storage.onGet = () => {
      calls += 1;
      if (calls >= 2) return securityError();
      return poison;
    };
    const c = makeController();

    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    expect(c.attach).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe("storage-error");
    expect(result.current.resume).toBeNull();
  });

  it("does NOT re-attach when the controller is already live for the record (idempotent)", () => {
    const storage = new FakeStorage();
    seedActive(storage);
    const c = makeController({ live: "job-1" });

    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    expect(c.attach).not.toHaveBeenCalled();
    expect(result.current.resume).toEqual({ status: "attached", jobId: "job-1" });
  });

  it("surfaces a conflicting attach as a closed resume outcome (never silent)", () => {
    const storage = new FakeStorage();
    seedActive(storage);
    const c = makeController({
      attachResult: { status: "conflict", reason: "A different optimize run is attached." },
    });

    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));
    expect(c.attach).toHaveBeenCalledTimes(1);
    expect(result.current.resume).toEqual({
      status: "conflict",
      reason: "A different optimize run is attached.",
    });
    expect(result.current.state.kind).toBe("resumable");
  });

  it("does nothing (state none, resume null) when there is no record", () => {
    const storage = new FakeStorage();
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));
    expect(c.attach).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: "none" });
    expect(result.current.resume).toBeNull();
    expect(result.current.ready).toBe(true);
  });
});

describe("useOptimizeSessionRecovery — identity-scoped provider registration", () => {
  it("registers a provider and clears it on unmount", () => {
    const storage = new FakeStorage();
    const c = makeController();
    const { unmount } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));
    expect(c.getProvider()).not.toBeNull();
    unmount();
    expect(c.getProvider()).toBeNull();
  });

  it("initializes health to the live job on a recovery-only remount (not an optimistic default)", () => {
    const storage = new FakeStorage();
    seedActive(storage);
    // The controller is ALREADY live for job-1 (a remount around a live run).
    const c = makeController({ live: "job-1" });
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));
    // The registered provider was prepared for the live job → health is job-scoped.
    expect(result.current.cursorPersistence).toEqual({
      jobId: "job-1",
      reloadRecoveryAvailable: true,
      durable: true,
      lastOutcome: null,
    });
  });
});

describe("useOptimizeSessionRecovery — cursor persistence health (provider-driven)", () => {
  it("persists a committed cursor and reports durable=updated, job-scoped", () => {
    const storage = new FakeStorage();
    seedActive(storage);
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    act(() => c.getProvider()!.onCommit("job-1", "c1"));

    const inspected = inspectPersistedSession(storage);
    expect(inspected.kind === "resumable" && inspected.record.lastCursor).toBe("c1");
    expect(result.current.cursorPersistence).toEqual({
      jobId: "job-1",
      reloadRecoveryAvailable: true,
      durable: true,
      lastOutcome: "updated",
    });
  });

  it("marks persistence non-durable (unverified) without throwing when the write cannot be proven", () => {
    const storage = new FakeStorage();
    seedActive(storage);
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    storage.onSet = () => {};
    expect(() => act(() => c.getProvider()!.onCommit("job-1", "c1"))).not.toThrow();
    expect(result.current.cursorPersistence).toMatchObject({
      durable: false,
      lastOutcome: "unverified",
    });
  });

  it("refreshes the visible state when a commit finds the record replaced (stale)", () => {
    const storage = new FakeStorage();
    seedActive(storage);
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    seedActive(storage, { jobId: "job-2" });
    act(() => c.getProvider()!.onCommit("job-1", "c1"));

    expect(result.current.cursorPersistence.lastOutcome).toBe("stale");
    expect(result.current.cursorPersistence.durable).toBe(false);
    expect(result.current.state).toEqual({
      kind: "resumable",
      jobId: "job-2",
      anonymized: true,
      peopleCount: 2,
    });
  });

  it("resets health when a NEW job becomes current, so A does not leak into B", () => {
    const storage = new FakeStorage();
    seedActive(storage);
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    // Job A records an unverified write.
    storage.onSet = () => {};
    act(() => c.getProvider()!.onCommit("job-1", "cA"));
    expect(result.current.cursorPersistence).toMatchObject({ jobId: "job-1", durable: false });

    // Job B becomes current → health resets to B (clean), not A's unverified.
    storage.onSet = null;
    act(() => c.getProvider()!.prepare("job-B", true));
    expect(result.current.cursorPersistence).toEqual({
      jobId: "job-B",
      reloadRecoveryAvailable: true,
      durable: true,
      lastOutcome: null,
    });
  });

  it("a degraded activation reports reload recovery unavailable rather than inheriting prior state", () => {
    const storage = new FakeStorage();
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    act(() => c.getProvider()!.prepare("degraded-job", false));
    expect(result.current.cursorPersistence).toEqual({
      jobId: "degraded-job",
      reloadRecoveryAvailable: false,
      durable: false,
      lastOutcome: null,
    });
  });

  it("clears the persisted cursor on reset and reports it durably", () => {
    const storage = new FakeStorage();
    seedActive(storage, { lastCursor: "c-old" });
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    act(() => c.getProvider()!.onReset("job-1"));
    expect(JSON.parse(storage.raw()!).lastCursor).toBeUndefined();
    expect(result.current.cursorPersistence).toMatchObject({
      durable: true,
      lastOutcome: "updated",
    });
  });
});

describe("useOptimizeSessionRecovery — prepareForOptimize: the hidden pre-submit step", () => {
  function mount(storage: FakeStorage, snapshots: ReturnType<typeof snapshotStoreDouble>) {
    const c = makeController();
    return renderHook(() =>
      useOptimizeSessionRecovery(c.controller, { storage, snapshotStore: snapshots.store }),
    );
  }
  async function prepare(result: { current: { prepareForOptimize(): Promise<unknown> } }) {
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.prepareForOptimize();
    });
    return outcome;
  }

  const MARKER = OPTIMIZE_RETIRE_PENDING_STORAGE_KEY;

  it("a clean slate is ready immediately and touches nothing", async () => {
    const storage = new FakeStorage();
    const snapshots = snapshotStoreDouble(["owner-SOMEONE-ELSE"]);
    const { result } = mount(storage, snapshots);

    expect(await prepare(result)).toEqual({ status: "ready" });
    expect(snapshots.deleteCalls).toEqual([]);
    expect(snapshots.rows.has("owner-SOMEONE-ELSE")).toBe(true);
    expect(storage.raw(MARKER)).toBeNull();
  });

  it("retires an exact-owner interrupted record AND its staged submission, then is ready", async () => {
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const { result } = mount(storage, snapshots);
    expect(result.current.state.kind).toBe("interrupted");

    expect(await prepare(result)).toEqual({ status: "ready" });

    // Both halves proven gone — the record and the exact canonical YAML plus
    // real-identity reverse map it named.
    expect(storage.raw()).toBeNull();
    expect(snapshots.deleteCalls).toEqual(["owner-P"]);
    expect(snapshots.rows.has("owner-P")).toBe(false);
    expect(storage.raw(MARKER)).toBeNull();
    expect(result.current.state).toEqual({ kind: "none" });
  });

  it("a valid pending marker resumes only the owed local step and is then ready", async () => {
    const storage = new FakeStorage();
    storage.setItem(MARKER, JSON.stringify({ schemaVersion: 1, ownerId: "owner-P" }));
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const { result } = mount(storage, snapshots);

    expect(await prepare(result)).toEqual({ status: "ready" });
    expect(snapshots.deleteCalls).toEqual(["owner-P"]);
    expect(storage.raw(MARKER)).toBeNull();
  });

  it("an ACTIVE/resumable record is the current run and is never silently retired", async () => {
    const storage = new FakeStorage();
    seedActive(storage);
    const before = storage.raw();
    const snapshots = snapshotStoreDouble(["owner-A"]);
    const { result } = mount(storage, snapshots);

    expect(await prepare(result)).toEqual({ status: "blocked" });
    expect(storage.raw()).toBe(before);
    expect(snapshots.deleteCalls).toEqual([]);
    expect(snapshots.rows.has("owner-A")).toBe(true);
  });

  it("UNREADABLE bytes block the submit and are never removed or deleted from", async () => {
    // They expose no trustworthy owner, yet a record that fails on one extra key can
    // still NAME a real staged snapshot. Removing it would destroy the last handle to
    // that row while proving nothing about it.
    const storage = new FakeStorage();
    storage.seed(
      JSON.stringify({
        schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
        ownerId: "owner-CORRUPT",
        phase: "provisional",
        anonymized: false,
        runOptions: {},
        peopleCount: 2,
        reverseMap: [],
        capture: { status: "staged", snapshotRef: "owner-CORRUPT", submissionOrdinal: 1 },
        unexpectedExtraKey: true,
      }),
    );
    const snapshots = snapshotStoreDouble(["owner-CORRUPT"]);
    const { result } = mount(storage, snapshots);
    expect(result.current.state).toEqual({ kind: "unreadable" });

    expect(await prepare(result)).toEqual({ status: "blocked" });
    expect(storage.raw()).not.toBeNull();
    expect(snapshots.deleteCalls).toEqual([]);
    expect(snapshots.rows.has("owner-CORRUPT")).toBe(true);
    expect(storage.raw(MARKER)).toBeNull();
  });

  it("AUTHORITY BINDING: a record naming a foreign snapshot owner blocks and deletes nothing", async () => {
    // `snapshotRef` IS the transaction owner. Without the binding check this would
    // remove owner-B's record and delete owner-A's snapshot — possibly another tab's
    // live accepted run.
    const storage = new FakeStorage();
    storage.seed(
      JSON.stringify({
        schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
        ownerId: "owner-B",
        phase: "provisional",
        anonymized: false,
        runOptions: {},
        peopleCount: 2,
        reverseMap: [],
        capture: { status: "staged", snapshotRef: "owner-A", submissionOrdinal: 1 },
      }),
    );
    const snapshots = snapshotStoreDouble(["owner-A", "owner-B"]);
    const { result } = mount(storage, snapshots);
    expect(result.current.state).toEqual({ kind: "unreadable" });

    expect(await prepare(result)).toEqual({ status: "blocked" });
    expect(snapshots.deleteCalls).toEqual([]);
    expect(snapshots.rows.has("owner-A")).toBe(true);
    expect(snapshots.rows.has("owner-B")).toBe(true);
    expect(storage.raw()).not.toBeNull();
  });

  it("a record with NO staged snapshot needs no second half", async () => {
    const storage = new FakeStorage();
    const staged = stageProvisionalSession(
      storage,
      buildProvisionalSession({
        ownerId: "owner-degraded",
        anonymized: false,
        peopleCount: 2,
        reverseMap: [],
        runOptions: {},
        capture: { status: "unavailable", reason: "snapshot_persist_failed" },
      }),
    );
    expect(staged.status).toBe("staged");
    const snapshots = snapshotStoreDouble(["owner-degraded"]);
    const { result } = mount(storage, snapshots);

    expect(await prepare(result)).toEqual({ status: "ready" });
    // A degraded run provably never wrote a snapshot, so it claims no F1 authority.
    expect(snapshots.deleteCalls).toEqual([]);
    expect(storage.raw()).toBeNull();
  });

  it("preserves a record that changed to ACTIVE after inspection — and touches NO snapshot", async () => {
    // Why the record half must run FIRST. A provisional can become `active` between
    // inspection and removal; only the exact-bytes check can tell, so nothing may be
    // deleted from F1 until it has passed.
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const { result } = mount(storage, snapshots);

    storage.onSet = (key, value, store) => {
      // The record flips to active exactly as the marker lands, i.e. after this tab
      // inspected it and before it removes it.
      if (key === MARKER) seedActive(storage, { jobId: "job-changed" });
      store.set(key, value);
    };

    expect(await prepare(result)).toEqual({ status: "blocked" });
    expect(storage.raw()).not.toBeNull();
    expect(snapshots.deleteCalls).toEqual([]);
    expect(snapshots.rows.has("owner-P")).toBe(true);
    expect(storage.raw(MARKER)).toBeNull();
  });
});

describe("useOptimizeSessionRecovery — prepareForOptimize fails closed on unverified authority", () => {
  function mount(storage: FakeStorage, snapshots: ReturnType<typeof snapshotStoreDouble>) {
    const c = makeController();
    return renderHook(() =>
      useOptimizeSessionRecovery(c.controller, { storage, snapshotStore: snapshots.store }),
    );
  }
  async function prepare(result: { current: { prepareForOptimize(): Promise<unknown> } }) {
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.prepareForOptimize();
    });
    return outcome;
  }

  const MARKER = OPTIMIZE_RETIRE_PENDING_STORAGE_KEY;

  // Three ways the marker write can fail to become durable. In every one the record
  // must survive: removing it would leave the next attempt with no marker and no
  // record, and the snapshot would keep the exact canonical YAML and the
  // real-identity reverse map with no way left to name them.
  const MARKER_FAILURES: [string, (storage: FakeStorage) => void][] = [
    [
      "the write throws",
      (storage) => {
        storage.onSet = (key, value, store) => {
          if (key === MARKER) throw new Error("quota exceeded");
          store.set(key, value);
        };
      },
    ],
    [
      "the write is silently refused",
      (storage) => {
        storage.onSet = (key, value, store) => {
          if (key === MARKER) return;
          store.set(key, value);
        };
      },
    ],
    [
      "the write is corrupted in place",
      (storage) => {
        storage.onSet = (key, value, store) => {
          store.set(key, key === MARKER ? "{truncated" : value);
        };
      },
    ],
  ];

  it.each(MARKER_FAILURES)(
    "MARKER CUT (%s): blocked, the record is NOT removed, both halves keep their authority",
    async (_label, breakMarker) => {
      const storage = new FakeStorage();
      seedInterrupted(storage);
      const before = storage.raw();
      const snapshots = snapshotStoreDouble(["owner-P"]);
      const { result } = mount(storage, snapshots);
      breakMarker(storage);

      expect(await prepare(result)).toEqual({ status: "blocked" });
      expect(result.current.state.kind).toBe("interrupted");
      expect(storage.raw()).toBe(before);
      expect(snapshots.deleteCalls).toEqual([]);
      expect(snapshots.rows.has("owner-P")).toBe(true);
    },
  );

  it("a same-mount RETRY after a marker failure completes both halves", async () => {
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const { result } = mount(storage, snapshots);
    storage.onSet = (key, value, store) => {
      if (key === MARKER) throw new Error("quota exceeded");
      store.set(key, value);
    };

    expect(await prepare(result)).toEqual({ status: "blocked" });
    expect(storage.raw()).not.toBeNull();

    storage.onSet = null;
    expect(await prepare(result)).toEqual({ status: "ready" });
    expect(storage.raw()).toBeNull();
    expect(snapshots.rows.has("owner-P")).toBe(false);
  });

  it("a REMOUNT after a marker failure still has everything it needs", async () => {
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const first = mount(storage, snapshots);
    storage.onSet = (key, value, store) => {
      if (key === MARKER) throw new Error("quota exceeded");
      store.set(key, value);
    };
    expect(await prepare(first.result)).toEqual({ status: "blocked" });
    first.unmount();

    storage.onSet = null;
    const second = mount(storage, snapshots);
    expect(second.result.current.state.kind).toBe("interrupted");
    expect(await prepare(second.result)).toEqual({ status: "ready" });
    expect(storage.raw()).toBeNull();
    expect(snapshots.rows.has("owner-P")).toBe(false);
  });

  it("CUT: record removal unverified — blocked, and no sensitive bytes are orphaned", async () => {
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const { result } = mount(storage, snapshots);

    storage.onRemove = () => {}; // the removal write is swallowed
    expect(await prepare(result)).toEqual({ status: "blocked" });

    // The record half runs first, so its snapshot was never touched.
    expect(snapshots.deleteCalls).toEqual([]);
    expect(snapshots.rows.has("owner-P")).toBe(true);

    // Even the marker could not be retired. A remount must NOT read that stale
    // marker as authority: the record survives and its snapshot is still ITS
    // authority, not ours to destroy.
    storage.onRemove = null;
    const second = mount(storage, snapshots);
    expect(await prepare(second.result)).not.toEqual({ status: "ready" });
    expect(snapshots.rows.has("owner-P")).toBe(true);
  });

  it("CUT: snapshot delete fails — blocked, and the marker survives for the retry", async () => {
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const snapshots = snapshotStoreDouble(["owner-P"]);
    snapshots.failDelete = true;
    const { result } = mount(storage, snapshots);

    expect(await prepare(result)).toEqual({ status: "blocked" });
    // The record IS gone, but the sensitive bytes are not — so no POST.
    expect(storage.raw()).toBeNull();
    expect(snapshots.rows.has("owner-P")).toBe(true);
    expect(storage.raw(MARKER)).toContain("owner-P");

    // The retry resumes exactly that deletion and only then reports ready.
    snapshots.failDelete = false;
    expect(await prepare(result)).toEqual({ status: "ready" });
    expect(snapshots.rows.has("owner-P")).toBe(false);
    expect(storage.raw(MARKER)).toBeNull();
  });

  it("an ALREADY-ABSENT snapshot is proof, so the retirement completes", async () => {
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const snapshots = snapshotStoreDouble([]); // crash cut: staged ref, no row
    const { result } = mount(storage, snapshots);

    expect(await prepare(result)).toEqual({ status: "ready" });
    expect(result.current.state).toEqual({ kind: "none" });
  });

  it("STALE EPOCH completes only on verified absence, never on the refusal alone", async () => {
    // A Clear committed under us. Clear does purge every snapshot, but the fence
    // refusal says the WRITE was declined — not that the payload went with it.
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const stillThere = snapshotStoreDouble(["owner-P"]);
    stillThere.staleEpoch = true;
    const blocked = mount(storage, stillThere);
    expect(await prepare(blocked.result)).toEqual({ status: "blocked" });
    blocked.unmount();

    const storage2 = new FakeStorage();
    seedInterrupted(storage2);
    const purged = snapshotStoreDouble([]);
    purged.staleEpoch = true;
    const done = mount(storage2, purged);
    expect(await prepare(done.result)).toEqual({ status: "ready" });
  });

  // A boot marker is a persisted DESTRUCTIVE capability, so it gets the same
  // fail-closed discipline as the session record. None of these may delete a row.
  const MALFORMED_MARKERS: [string, string][] = [
    ["non-JSON bytes", "{truncated"],
    ["a bare array", JSON.stringify([{ schemaVersion: 1, ownerId: "owner-P" }])],
    ["a missing version", JSON.stringify({ ownerId: "owner-P" })],
    ["a future version", JSON.stringify({ schemaVersion: 2, ownerId: "owner-P" })],
    ["an extra key", JSON.stringify({ schemaVersion: 1, ownerId: "owner-P", scope: "all" })],
    ["a wrong-typed owner", JSON.stringify({ schemaVersion: 1, ownerId: 42 })],
    ["an empty owner", JSON.stringify({ schemaVersion: 1, ownerId: "" })],
    ["an unbounded owner", JSON.stringify({ schemaVersion: 1, ownerId: "x".repeat(257) })],
  ];

  it.each(MALFORMED_MARKERS)(
    "MARKER SCHEMA (%s): blocks the submit and deletes nothing",
    async (_label, raw) => {
      const storage = new FakeStorage();
      storage.setItem(MARKER, raw);
      const snapshots = snapshotStoreDouble(["owner-P"]);
      const { result } = mount(storage, snapshots);

      expect(await prepare(result)).toEqual({ status: "blocked" });
      expect(snapshots.deleteCalls).toEqual([]);
      expect(snapshots.rows.has("owner-P")).toBe(true);
    },
  );
});

describe("useOptimizeSessionRecovery — a marker alone never authorizes a deletion", () => {
  function mount(storage: FakeStorage, snapshots: ReturnType<typeof snapshotStoreDouble>) {
    const c = makeController();
    return renderHook(() =>
      useOptimizeSessionRecovery(c.controller, { storage, snapshotStore: snapshots.store }),
    );
  }
  async function prepare(result: { current: { prepareForOptimize(): Promise<unknown> } }) {
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.prepareForOptimize();
    });
    return outcome;
  }

  const MARKER = OPTIMIZE_RETIRE_PENDING_STORAGE_KEY;
  const OWED = JSON.stringify({ schemaVersion: 1, ownerId: "owner-P" });

  it("CUT: marker owed + the record is UNREADABLE — nothing is deleted", async () => {
    // The crash cut this closes: the marker was written, the process died before the
    // record was removed, and the record now fails to decode. `snapshotOwnerOf` maps
    // that to null, which used to look exactly like "the record is gone" — so the
    // snapshot was deleted while its record may still be live.
    const storage = new FakeStorage();
    storage.setItem(MARKER, OWED);
    storage.seed(
      JSON.stringify({
        schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
        ownerId: "owner-P",
        phase: "provisional",
        anonymized: false,
        runOptions: {},
        peopleCount: 2,
        reverseMap: [],
        capture: { status: "staged", snapshotRef: "owner-P", submissionOrdinal: 1 },
        unexpectedExtraKey: true, // the ONLY defect
      }),
    );
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const { result } = mount(storage, snapshots);

    expect(await prepare(result)).toEqual({ status: "blocked" });
    expect(snapshots.deleteCalls).toEqual([]);
    expect(snapshots.rows.has("owner-P")).toBe(true);
    expect(storage.raw()).not.toBeNull();
    // The marker is kept: the work is still owed, just not yet provable.
    expect(storage.raw(MARKER)).toBe(OWED);
  });

  it("CUT: marker owed + the session read THROWS — nothing is deleted", async () => {
    const storage = new FakeStorage();
    storage.setItem(MARKER, OWED);
    seedInterrupted(storage);
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const { result } = mount(storage, snapshots);

    // Only the session key fails; the marker key still reads, so the attempt gets as
    // far as needing proof and cannot obtain it.
    storage.onGet = (key, store) => {
      if (key === OPTIMIZE_SESSION_STORAGE_KEY) throw new Error("read failed");
      return store.get(key) ?? null;
    };

    expect(await prepare(result)).toEqual({ status: "blocked" });
    expect(snapshots.deleteCalls).toEqual([]);
    expect(snapshots.rows.has("owner-P")).toBe(true);

    // RECOVERY: once the read works again the owed deletion completes.
    storage.onGet = null;
    expect(await prepare(result)).toEqual({ status: "ready" });
    expect(snapshots.rows.has("owner-P")).toBe(false);
  });

  it("our own surviving record retires the marker instead of deleting", async () => {
    const storage = new FakeStorage();
    storage.setItem(MARKER, OWED);
    seedInterrupted(storage); // owner-P is still in the slot
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const { result } = mount(storage, snapshots);

    expect(await prepare(result)).toEqual({ status: "blocked" });
    expect(snapshots.deleteCalls).toEqual([]);
    // The record is the authority again, so the marker is not owed.
    expect(storage.raw(MARKER)).toBeNull();
  });

  it("a DIFFERENT owner in the slot proves ours is gone, so the owed deletion completes", async () => {
    // Otherwise a newer submission taking the slot would strand the owed deletion
    // forever — the slot holds one record, so someone else's presence is proof.
    const storage = new FakeStorage();
    storage.setItem(MARKER, OWED);
    seedInterrupted(storage, "owner-NEWER");
    const snapshots = snapshotStoreDouble(["owner-P", "owner-NEWER"]);
    const { result } = mount(storage, snapshots);

    expect(await prepare(result)).toEqual({ status: "ready" });
    expect(snapshots.deleteCalls).toEqual(["owner-P"]);
    expect(snapshots.rows.has("owner-NEWER")).toBe(true);
  });

  // `ready` claims record, snapshot AND marker are gone. A removal that silently
  // no-ops would leave the destructive capability replaying on every later attempt.
  const MARKER_CLEAR_FAILURES: [string, (storage: FakeStorage) => void][] = [
    [
      "the removal throws",
      (storage) => {
        storage.onRemove = (key, store) => {
          if (key === OPTIMIZE_RETIRE_PENDING_STORAGE_KEY) throw new Error("remove failed");
          store.delete(key);
        };
      },
    ],
    [
      "the removal is silently ignored",
      (storage) => {
        storage.onRemove = (key, store) => {
          if (key === OPTIMIZE_RETIRE_PENDING_STORAGE_KEY) return;
          store.delete(key);
        };
      },
    ],
    [
      "something rewrites the marker after the removal",
      (storage) => {
        storage.onRemove = (key, store) => {
          store.delete(key);
          if (key === OPTIMIZE_RETIRE_PENDING_STORAGE_KEY) store.set(key, OWED);
        };
      },
    ],
  ];

  it("CUT: the marker removal succeeds but the READ-BACK throws — not proven, so blocked", async () => {
    // A read that threw is unverified evidence, not absence. Collapsing it to `none`
    // would let a failed read-back pass for a verified clear and POST anyway.
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const { result } = mount(storage, snapshots);

    let removed = false;
    storage.onRemove = (key, store) => {
      store.delete(key);
      if (key === MARKER) removed = true;
    };
    storage.onGet = (key, store) => {
      if (key === MARKER && removed) throw new Error("read-back failed");
      return store.get(key) ?? null;
    };

    expect(await prepare(result)).toEqual({ status: "blocked" });

    // RECOVERY: the next attempt reads cleanly and completes.
    storage.onGet = null;
    expect(await prepare(result)).toEqual({ status: "ready" });
  });

  it("CUT: the initial marker read throws while the session slot is EMPTY — zero POST", async () => {
    // The other half of the collapse: an unreadable marker used to look like "nothing
    // owed", so an empty session slot would authorize the POST without ever proving
    // whether an owed deletion existed.
    const storage = new FakeStorage();
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const { result } = mount(storage, snapshots);

    storage.onGet = (key, store) => {
      if (key === MARKER) throw new Error("read failed");
      return store.get(key) ?? null;
    };

    expect(await prepare(result)).toEqual({ status: "blocked" });
    expect(snapshots.deleteCalls).toEqual([]);

    storage.onGet = null;
    expect(await prepare(result)).toEqual({ status: "ready" });
  });

  it.each(MARKER_CLEAR_FAILURES)(
    "MARKER CLEAR CUT (%s): blocked, not ready, and still retryable",
    async (_label, breakClear) => {
      const storage = new FakeStorage();
      seedInterrupted(storage);
      const snapshots = snapshotStoreDouble(["owner-P"]);
      const { result } = mount(storage, snapshots);
      breakClear(storage);

      expect(await prepare(result)).toEqual({ status: "blocked" });
      // The privacy half really is done — this is about not claiming completion.
      expect(snapshots.rows.has("owner-P")).toBe(false);
      expect(storage.raw(MARKER)).not.toBeNull();

      // RECOVERY on a later attempt, including across a remount.
      storage.onRemove = null;
      const second = mount(storage, snapshots);
      expect(await prepare(second.result)).toEqual({ status: "ready" });
      expect(storage.raw(MARKER)).toBeNull();
    },
  );
});

describe("useOptimizeSessionRecovery — per-tab coalescing and cross-tab isolation", () => {
  const MARKER = OPTIMIZE_RETIRE_PENDING_STORAGE_KEY;

  function mount(storage: FakeStorage, snapshots: ReturnType<typeof snapshotStoreDouble>) {
    const c = makeController();
    return renderHook(() =>
      useOptimizeSessionRecovery(c.controller, { storage, snapshotStore: snapshots.store }),
    );
  }

  it("concurrent calls in one tab share ONE retirement", async () => {
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const { result } = mount(storage, snapshots);

    // Issued in the same microtask, so the first is unquestionably still open.
    let a: unknown;
    let b: unknown;
    await act(async () => {
      const first = result.current.prepareForOptimize();
      const second = result.current.prepareForOptimize();
      [a, b] = await Promise.all([first, second]);
    });

    expect(a).toEqual({ status: "ready" });
    expect(b).toEqual({ status: "ready" });
    // ONE retirement, not two: one delete, and the record removed once.
    expect(snapshots.deleteCalls).toEqual(["owner-P"]);
    expect(storage.raw()).toBeNull();
  });

  it("a route REMOUNT mid-attempt joins the same retirement", async () => {
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const first = mount(storage, snapshots);

    // Park the snapshot delete so the first attempt is unquestionably still open
    // across the remount.
    const gate = Promise.withResolvers<void>();
    snapshots.deleteGate = gate.promise;
    const inFlight = first.result.current.prepareForOptimize();

    // The route unmounts and remounts mid-attempt. The coalescer lives at TAB
    // lifetime, so the new mount JOINS rather than starting a rival retirement.
    first.unmount();
    const second = mount(storage, snapshots);
    const joined = second.result.current.prepareForOptimize();
    gate.resolve();

    let outcomes: unknown[] = [];
    await act(async () => {
      outcomes = await Promise.all([inFlight, joined]);
    });

    expect(outcomes).toEqual([{ status: "ready" }, { status: "ready" }]);
    expect(snapshots.deleteCalls).toEqual(["owner-P"]);
  });

  it("TWO TABS submit independently, and neither can retire the other's owner", async () => {
    // Deliberately NOT an origin-wide lease: each tab has its own sessionStorage and
    // its own record. Cross-tab safety is exact-owner isolation.
    const tabA = new FakeStorage();
    seedInterrupted(tabA, "owner-TAB-A");
    const tabB = new FakeStorage();
    seedInterrupted(tabB, "owner-TAB-B");
    const shared = snapshotStoreDouble(["owner-TAB-A", "owner-TAB-B"]);

    const a = mount(tabA, shared);
    const b = mount(tabB, shared);

    let outcomes: unknown[] = [];
    await act(async () => {
      outcomes = await Promise.all([
        a.result.current.prepareForOptimize(),
        b.result.current.prepareForOptimize(),
      ]);
    });

    // Both tabs may start a schedule.
    expect(outcomes).toEqual([{ status: "ready" }, { status: "ready" }]);
    // Each deleted ONLY its own owner's snapshot.
    expect([...shared.deleteCalls].sort()).toEqual(["owner-TAB-A", "owner-TAB-B"]);
    expect(shared.rows.size).toBe(0);
    expect(tabA.raw()).toBeNull();
    expect(tabB.raw()).toBeNull();
  });

  it("one tab's retirement never touches another tab's snapshot", async () => {
    const tabA = new FakeStorage();
    seedInterrupted(tabA, "owner-TAB-A");
    const shared = snapshotStoreDouble(["owner-TAB-A", "owner-LIVE-OTHER-TAB"]);
    const a = mount(tabA, shared);

    await act(async () => {
      await a.result.current.prepareForOptimize();
    });

    expect(shared.deleteCalls).toEqual(["owner-TAB-A"]);
    expect(shared.rows.has("owner-LIVE-OTHER-TAB")).toBe(true);
  });

  it("a click DURING boot marker recovery is adopted — exactly one submit after release", async () => {
    // The cut this closes. Boot finds a valid marker and starts a retirement-only
    // flight; the snapshot delete is parked; the screen is already submit-ready and
    // the user clicks. A flight that cached only the boot caller's empty callback
    // would run that no-op, hand the click `ready`, and send NOTHING.
    const storage = new FakeStorage();
    storage.setItem(MARKER, JSON.stringify({ schemaVersion: 1, ownerId: "owner-P" }));
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const gate = Promise.withResolvers<void>();
    snapshots.deleteGate = gate.promise;
    const { result } = mount(storage, snapshots);

    // Boot's retirement is parked inside the purge.
    await waitFor(() => expect(snapshots.deleteCalls).toEqual(["owner-P"]));

    const submit = vi.fn(async () => {});
    let outcome: unknown;
    const click = result.current.runOptimizeAttempt(submit);
    expect(submit).not.toHaveBeenCalled();

    gate.resolve();
    await act(async () => {
      outcome = await click;
    });

    expect(outcome).toEqual({ status: "ready" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(storage.raw(MARKER)).toBeNull();
  });

  it("repeated clicks and a REMOUNT while parked still submit exactly once", async () => {
    const storage = new FakeStorage();
    storage.setItem(MARKER, JSON.stringify({ schemaVersion: 1, ownerId: "owner-P" }));
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const gate = Promise.withResolvers<void>();
    snapshots.deleteGate = gate.promise;
    const first = mount(storage, snapshots);
    await waitFor(() => expect(snapshots.deleteCalls).toEqual(["owner-P"]));

    const submit = vi.fn(async () => {});
    const clicks = [
      first.result.current.runOptimizeAttempt(submit),
      first.result.current.runOptimizeAttempt(submit),
    ];
    // The route navigates away and back while the purge is still parked.
    first.unmount();
    const second = mount(storage, snapshots);
    clicks.push(second.result.current.runOptimizeAttempt(submit));

    gate.resolve();
    let outcomes: unknown[] = [];
    await act(async () => {
      outcomes = await Promise.all(clicks);
    });

    expect(outcomes).toEqual([{ status: "ready" }, { status: "ready" }, { status: "ready" }]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(snapshots.deleteCalls).toEqual(["owner-P"]);
  });

  it("a BLOCKED release runs no submit and reports the plain failure to the click", async () => {
    const storage = new FakeStorage();
    storage.setItem(MARKER, JSON.stringify({ schemaVersion: 1, ownerId: "owner-P" }));
    const snapshots = snapshotStoreDouble(["owner-P"]);
    snapshots.failDelete = true;
    const gate = Promise.withResolvers<void>();
    snapshots.deleteGate = gate.promise;
    const { result } = mount(storage, snapshots);
    await waitFor(() => expect(snapshots.deleteCalls).toEqual(["owner-P"]));

    const submit = vi.fn(async () => {});
    const click = result.current.runOptimizeAttempt(submit);
    gate.resolve();

    let outcome: unknown;
    await act(async () => {
      outcome = await click;
    });

    expect(outcome).toEqual({ status: "blocked" });
    expect(submit).not.toHaveBeenCalled();
    // Still owed, so a later attempt can finish it.
    expect(storage.raw(MARKER)).not.toBeNull();
    expect(snapshots.rows.has("owner-P")).toBe(true);
  });

  it("an intent arriving AFTER a retirement-only flight claimed still submits exactly once", async () => {
    // The settlement-boundary case: the boot flight has already read its (absent)
    // intent, so it cannot run this one. It must neither be lost nor race a rival
    // attempt — it chains behind and submits once.
    const storage = new FakeStorage();
    storage.setItem(MARKER, JSON.stringify({ schemaVersion: 1, ownerId: "owner-P" }));
    const snapshots = snapshotStoreDouble(["owner-P"]);
    const { result } = mount(storage, snapshots);
    await waitFor(() => expect(storage.raw(MARKER)).toBeNull());

    const submit = vi.fn(async () => {});
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.runOptimizeAttempt(submit);
    });

    expect(outcome).toEqual({ status: "ready" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("BOOT resumes an owed marker with no click at all", async () => {
    const storage = new FakeStorage();
    storage.setItem(MARKER, JSON.stringify({ schemaVersion: 1, ownerId: "owner-P" }));
    const snapshots = snapshotStoreDouble(["owner-P"]);
    mount(storage, snapshots);

    await waitFor(() => expect(snapshots.rows.has("owner-P")).toBe(false));
    expect(storage.raw(MARKER)).toBeNull();
  });
});

describe("useOptimizeSessionRecovery — active job-scoped cleanup/abandon", () => {
  it("removes the still-current active record even after the cursor advanced", () => {
    const storage = new FakeStorage();
    seedActive(storage);
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    act(() => c.getProvider()!.onCommit("job-1", "c-final"));

    let outcome: ReturnType<typeof result.current.cleanup> | undefined;
    act(() => {
      outcome = result.current.cleanup("job-1");
    });
    expect(outcome).toEqual({ status: "removed" });
    expect(storage.raw()).toBeNull();
    expect(result.current.state).toEqual({ kind: "none" });
  });

  it("preserves a replacement record for a different job (not-current)", () => {
    const storage = new FakeStorage();
    seedActive(storage, { jobId: "job-2", ownerId: "owner-2" });
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    let outcome: ReturnType<typeof result.current.cleanup> | undefined;
    act(() => {
      outcome = result.current.cleanup("job-1");
    });
    expect(outcome).toEqual({ status: "not-current" });
    expect(JSON.parse(storage.raw()!).jobId).toBe("job-2");
  });

  it("reports absent for an empty slot", () => {
    const storage = new FakeStorage();
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));
    let outcome: ReturnType<typeof result.current.cleanup> | undefined;
    act(() => {
      outcome = result.current.cleanup("job-1");
    });
    expect(outcome).toEqual({ status: "absent" });
  });

  it("retains the record and its map when removal cannot be verified (unverified)", () => {
    const storage = new FakeStorage();
    seedActive(storage);
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    storage.onRemove = () => {};
    let outcome: ReturnType<typeof result.current.cleanup> | undefined;
    act(() => {
      outcome = result.current.cleanup("job-1");
    });
    expect(outcome).toEqual({ status: "unverified" });
    const inspected = inspectPersistedSession(storage);
    expect(inspected.kind === "resumable" && inspected.record.reverseMap).toEqual(REVERSE_MAP);
  });

  it("reports unverified when storage cannot be read", () => {
    const storage = new FakeStorage();
    seedActive(storage);
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    storage.onGet = securityError;
    let outcome: ReturnType<typeof result.current.cleanup> | undefined;
    act(() => {
      outcome = result.current.cleanup("job-1");
    });
    expect(outcome).toEqual({ status: "unverified" });
  });
});

describe("useOptimizeSessionRecovery — degraded provisional cleanup/abandon", () => {
  // A degraded (activation-persistence-failed) run's retained record is PROVISIONAL and
  // has no embedded job id; cleanup uses the controller's opaque capability bound to the
  // exact transaction (owner + provisional variant), never a generic removal.

  it("removes the retained provisional via the opaque capability and verifies absence", () => {
    const storage = new FakeStorage();
    seedInterrupted(storage, "owner-degraded");
    const cleanupCap: PreparedDegradedCleanup = () => {
      storage.removeItem(KEY);
      return storage.raw() === null
        ? { status: "removed", variant: "provisional" }
        : { status: "unverified", operation: "remove-or-verify" };
    };
    const c = makeController({ degraded: { jobId: "vol-job", cleanup: cleanupCap } });
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    let outcome: ReturnType<typeof result.current.cleanup> | undefined;
    act(() => {
      outcome = result.current.cleanup("vol-job");
    });
    expect(outcome).toEqual({ status: "removed" });
    expect(storage.raw()).toBeNull();
    expect(result.current.state).toEqual({ kind: "none" });
  });

  it("maps a preserved replacement (owner/variant conflict) to not-current and retains it", () => {
    const storage = new FakeStorage();
    seedInterrupted(storage, "owner-other");
    // The capability refuses to remove because the current record is a different owner.
    const cleanupCap: PreparedDegradedCleanup = () => ({
      status: "conflict",
      evidence: "foreign-provisional",
    });
    const c = makeController({ degraded: { jobId: "vol-job", cleanup: cleanupCap } });
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    let outcome: ReturnType<typeof result.current.cleanup> | undefined;
    act(() => {
      outcome = result.current.cleanup("vol-job");
    });
    expect(outcome).toEqual({ status: "not-current" });
    expect(storage.raw()).not.toBeNull();
  });

  it("retains the map when a degraded removal cannot be verified (unverified)", () => {
    const storage = new FakeStorage();
    seedInterrupted(storage, "owner-degraded");
    const cleanupCap: PreparedDegradedCleanup = () => ({
      status: "unverified",
      operation: "remove-or-verify",
    });
    const c = makeController({ degraded: { jobId: "vol-job", cleanup: cleanupCap } });
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    let outcome: ReturnType<typeof result.current.cleanup> | undefined;
    act(() => {
      outcome = result.current.cleanup("vol-job");
    });
    expect(outcome).toEqual({ status: "unverified" });
    const inspected = inspectPersistedSession(storage);
    expect(inspected.kind === "interrupted" && inspected.record.reverseMap).toEqual(REVERSE_MAP);
  });

  it("without a capability for the job, a provisional record is preserved as not-current", () => {
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const c = makeController(); // no degraded capability
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    let outcome: ReturnType<typeof result.current.cleanup> | undefined;
    act(() => {
      outcome = result.current.cleanup("vol-job");
    });
    expect(outcome).toEqual({ status: "not-current" });
    expect(storage.raw()).not.toBeNull();
  });
});
