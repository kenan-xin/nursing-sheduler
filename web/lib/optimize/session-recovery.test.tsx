// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
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

const KEY = OPTIMIZE_SESSION_STORAGE_KEY;

/** A minimal injectable Storage with per-op overrides (throw/no-op adversarial cases). */
class FakeStorage implements SessionTransactionStorage {
  private store = new Map<string, string>();
  onGet: (() => string | null) | null = null;
  onSet: ((value: string) => void) | null = null;
  onRemove: (() => void) | null = null;

  getItem(): string | null {
    if (this.onGet) return this.onGet();
    return this.store.get(KEY) ?? null;
  }
  setItem(_key: string, value: string): void {
    if (this.onSet) return this.onSet(value);
    this.store.set(KEY, value);
  }
  removeItem(): void {
    if (this.onRemove) return this.onRemove();
    this.store.delete(KEY);
  }
  raw(): string | null {
    return this.store.get(KEY) ?? null;
  }
  seed(value: string): void {
    this.store.set(KEY, value);
  }
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
  return {
    controller: {
      attachRecoveredSession: attach,
      getLiveJobId: () => live,
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

describe("useOptimizeSessionRecovery — Forget (interrupted/unreadable)", () => {
  it("removes an interrupted record and reports the warning", () => {
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));

    expect(c.attach).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: "interrupted", anonymized: true, peopleCount: 2 });
    expect(result.current.forgetWarning).toContain("unknown backend optimization may continue");

    let outcome: ReturnType<typeof result.current.forget> | undefined;
    act(() => {
      outcome = result.current.forget();
    });
    expect(outcome).toEqual({ status: "removed" });
    expect(storage.raw()).toBeNull();
    expect(result.current.state).toEqual({ kind: "none" });
    expect(result.current.cursorPersistence).toEqual({
      jobId: null,
      reloadRecoveryAvailable: false,
      durable: true,
      lastOutcome: null,
    });
  });

  it("removes corrupt bytes as unreadable", () => {
    const storage = new FakeStorage();
    storage.seed("{corrupt");
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));
    expect(result.current.state).toEqual({ kind: "unreadable" });
    act(() => {
      result.current.forget();
    });
    expect(storage.raw()).toBeNull();
  });

  it("reports storage-error with nothing to forget", () => {
    const storage = new FakeStorage();
    storage.onGet = securityError;
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));
    expect(result.current.state).toEqual({ kind: "storage-error" });
    let outcome: ReturnType<typeof result.current.forget> | undefined;
    act(() => {
      outcome = result.current.forget();
    });
    expect(outcome).toEqual({ status: "nothing-to-forget" });
  });

  it("preserves a record that changed after inspection and refreshes the state", () => {
    const storage = new FakeStorage();
    seedInterrupted(storage);
    const c = makeController();
    const { result } = renderHook(() => useOptimizeSessionRecovery(c.controller, { storage }));
    expect(result.current.state.kind).toBe("interrupted");

    seedActive(storage, { jobId: "job-changed" });
    let outcome: ReturnType<typeof result.current.forget> | undefined;
    act(() => {
      outcome = result.current.forget();
    });
    expect(outcome).toEqual({ status: "changed" });
    expect(storage.raw()).not.toBeNull();
    expect(result.current.state).toEqual({
      kind: "resumable",
      jobId: "job-changed",
      anonymized: true,
      peopleCount: 2,
    });
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
  // exact transaction (owner + provisional variant), never a generic forget.

  it("removes the retained provisional via the opaque capability and verifies absence", () => {
    const storage = new FakeStorage();
    seedInterrupted(storage, "owner-degraded");
    const cleanupCap: PreparedDegradedCleanup = () => {
      storage.removeItem();
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
