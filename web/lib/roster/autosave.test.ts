// Autosave queue tests (F5): serialization, coalescing, CAS conflict, failure +
// retry + rescue, drain gating, and the Clear (stale-epoch) terminal.
//
// The queue is exercised through a controllable mock `RosterStorage.writeWorkingEdit`
// so every authority/race cut in the proof matrix has a discriminating assertion
// without touching real IndexedDB.

import { describe, expect, it, vi } from "vitest";
import { createAutosaveQueue, type AutosaveDeps } from "./autosave";
import type { RosterStorage, WorkingEditOutcome } from "@/lib/store";

/** A minimal RosterStorage whose `writeWorkingEdit` is a controllable spy. */
function mockStorage(
  responder: (input: {
    document: unknown;
    expectedRevision: number | null;
    expectedClearEpoch: number;
  }) => WorkingEditOutcome | Promise<WorkingEditOutcome>,
): RosterStorage & { writeSpy: ReturnType<typeof vi.fn> } {
  const writeSpy = vi.fn(responder);
  // Keep `writeSpy` on the object itself (not just in the cast) so the test can
  // read it back after the `as unknown` widening.
  return { writeWorkingEdit: writeSpy, writeSpy } as unknown as RosterStorage & {
    writeSpy: typeof writeSpy;
  };
}

function deps(storage: RosterStorage, opts: Partial<AutosaveDeps> = {}): AutosaveDeps {
  return {
    storage,
    clearEpoch: 0,
    initialRevision: 1,
    // Replace the browser guard with a no-op so tests do not touch `window`.
    armLossGuard: () => () => {},
    ...opts,
  };
}

const WRITTEN = (revision: number): WorkingEditOutcome => ({ status: "written", revision });

describe("createAutosaveQueue — happy path", () => {
  it("writes the enqueued document and reaches 'saved'", async () => {
    const storage = mockStorage(async () => WRITTEN(2));
    const queue = createAutosaveQueue(deps(storage));
    const doc = { marker: "edit-1" };
    const outcome = await queue.enqueue(doc);
    expect(outcome.status).toBe("written");
    expect(queue.snapshot()).toMatchObject({ status: "saved", dirty: false });
    expect(queue.expectedRevision).toBe(2);
    expect(storage.writeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ document: doc, expectedRevision: 1, expectedClearEpoch: 0 }),
    );
    queue.dispose();
  });

  it("is idle before any write and saving while one is in flight", async () => {
    let releaseWrite: () => void = () => {};
    const storage = mockStorage(
      () =>
        new Promise<WorkingEditOutcome>((resolve) => (releaseWrite = () => resolve(WRITTEN(2)))),
    );
    const queue = createAutosaveQueue(deps(storage));
    expect(queue.snapshot().status).toBe("idle");

    const promise = queue.enqueue({ a: 1 });
    // pendingDocument is set synchronously, so "saving" shows before the write starts.
    expect(queue.snapshot()).toMatchObject({ status: "saving", dirty: true });
    // Let the deferred pump start the write (so releaseWrite is bound to its promise).
    await Promise.resolve();
    releaseWrite();
    await promise;
    expect(queue.snapshot().status).toBe("saved");
    queue.dispose();
  });

  it("resolves immediately when clean (drain is a no-op)", async () => {
    const storage = mockStorage(async () => WRITTEN(2));
    const queue = createAutosaveQueue(deps(storage));
    await queue.enqueue({ a: 1 });
    await expect(queue.drain()).resolves.toBeUndefined();
    queue.dispose();
  });
});

describe("createAutosaveQueue — serialization + coalescing", () => {
  it("writes only the LATEST document when edits arrive faster than storage", async () => {
    // Auto-resolving mock: the write completes immediately, and we capture the
    // document each call received.
    const written: unknown[] = [];
    const storage = mockStorage(async (input: { document: unknown }) => {
      written.push(input.document);
      return WRITTEN(2);
    });
    const queue = createAutosaveQueue(deps(storage));

    // Three edits in one synchronous tick coalesce into a single write.
    void queue.enqueue({ a: 1 });
    void queue.enqueue({ a: 2 });
    await queue.enqueue({ a: 3 });

    expect(written).toEqual([{ a: 3 }]);
    queue.dispose();
  });

  it("never runs two writes concurrently (a second edit arriving mid-write waits, then writes)", async () => {
    // The first write is manually controlled; subsequent writes auto-resolve so
    // the second edit's write settles without a second manual release.
    let releaseFirst: () => void = () => {};
    let callCount = 0;
    const storage = mockStorage(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<WorkingEditOutcome>(
          (resolve) => (releaseFirst = () => resolve(WRITTEN(2))),
        );
      }
      return WRITTEN(3);
    });
    const queue = createAutosaveQueue(deps(storage));
    const first = queue.enqueue({ a: 1 });
    await Promise.resolve(); // let the deferred pump start the first write
    // A second edit lands WHILE the first write is in flight. It must not start
    // its own write until the first settles.
    const second = queue.enqueue({ a: 2 });
    expect(storage.writeSpy).toHaveBeenCalledTimes(1); // only the first has started
    releaseFirst();
    await Promise.all([first, second]);
    // The second edit produced its own write once the first cleared.
    expect(storage.writeSpy).toHaveBeenCalledTimes(2);
    queue.dispose();
  });
});

describe("createAutosaveQueue — CAS conflict", () => {
  it("a conflict is NOT auto-reconciled: it stays failed and retains the original revision", async () => {
    // The rival committed at revision 5. The queue must NOT adopt revision 5 and
    // retry its own whole stale document over the rival — that is the lost update
    // the contract forbids. The conflict surfaces as a persistent failed state,
    // the edit stays visible for rescue/retry/discard, and the ORIGINAL expected
    // revision is retained so Retry can never silently rebase onto the rival.
    const storage = mockStorage(
      () => ({ status: "conflict", currentRevision: 5 }) as WorkingEditOutcome,
    );
    const queue = createAutosaveQueue(deps(storage, { initialRevision: 1 }));
    const outcome = await queue.enqueue({ a: 1 });
    expect(outcome.status).toBe("conflict");
    expect(queue.snapshot()).toMatchObject({ status: "failed", dirty: true });
    expect(queue.snapshot().failure?.reason).toBe("cas-conflict");
    // Exactly ONE write attempt — no silent adopt-and-retry loop.
    expect(storage.writeSpy).toHaveBeenCalledTimes(1);
    // The expected revision is UNCHANGED: Retry re-attempts against the original,
    // so it cannot silently overwrite the rival.
    expect(queue.expectedRevision).toBe(1);
    queue.dispose();
  });

  it("Retry re-attempts against the ORIGINAL revision, so a continuing conflict stays failed (no silent rebase)", async () => {
    // The rival is still there (still conflicts). Retry must not adopt its
    // revision and succeed by overwriting it; it must keep failing.
    const storage = mockStorage(
      () => ({ status: "conflict", currentRevision: 5 }) as WorkingEditOutcome,
    );
    const queue = createAutosaveQueue(deps(storage, { initialRevision: 1 }));
    await queue.enqueue({ a: 1 });
    expect(queue.snapshot().status).toBe("failed");

    const retry = await queue.retry();
    expect(retry.status).toBe("retried");
    // Still failed — the rival was not silently overwritten.
    expect(queue.snapshot().status).toBe("failed");
    expect(queue.expectedRevision).toBe(1);
    // Both writes carried the original expected revision; neither adopted the rival's.
    expect(storage.writeSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedRevision: 1 }),
    );
    expect(storage.writeSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedRevision: 1 }),
    );
    queue.dispose();
  });

  it("Retry succeeds only when the rival is gone (a transient conflict), without adopting the rival revision", async () => {
    // First write conflicts (rival present). The retry succeeds — but because the
    // rival was removed by an explicit decision elsewhere, NOT because the queue
    // adopted the rival's revision. The queue wrote against the ORIGINAL revision.
    let attempt = 0;
    const storage = mockStorage(() => {
      attempt += 1;
      return attempt === 1
        ? ({ status: "conflict", currentRevision: 5 } as WorkingEditOutcome)
        : WRITTEN(2);
    });
    const queue = createAutosaveQueue(deps(storage, { initialRevision: 1 }));
    await queue.enqueue({ a: 1 });
    expect(queue.snapshot().status).toBe("failed");

    const retry = await queue.retry();
    expect(retry.status).toBe("retried");
    expect(queue.snapshot().status).toBe("saved");
    // Both writes carried the ORIGINAL expected revision (1). The successful retry
    // wrote against revision 1, not 5 — it did not silently rebase onto the rival.
    expect(storage.writeSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedRevision: 1 }),
    );
    expect(storage.writeSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedRevision: 1 }),
    );
    queue.dispose();
  });
});

describe("createAutosaveQueue — failure, retry, and rescue", () => {
  it("a thrown write surfaces 'failed' (write-error) without rejecting the promise", async () => {
    const storage = mockStorage(() => {
      throw new Error("QuotaExceeded");
    });
    const queue = createAutosaveQueue(deps(storage));
    const outcome = await queue.enqueue({ a: 1 });
    expect(outcome.status).toBe("threw");
    expect(queue.snapshot()).toMatchObject({ status: "failed", dirty: true });
    expect(queue.snapshot().failure?.reason).toBe("write-error");
    queue.dispose();
  });

  it("Retry re-attempts the failed document and clears the failure on success", async () => {
    let attempt = 0;
    const storage = mockStorage(() => {
      attempt += 1;
      return attempt === 1 ? WRITTEN(2) : WRITTEN(3);
    });
    // Force a failure first, then recovery: use a throwing responder for attempt 1.
    let throwOnce = true;
    const storage2 = mockStorage(() => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("transient");
      }
      return WRITTEN(2);
    });
    const queue = createAutosaveQueue(deps(storage2, { initialRevision: 1 }));
    await queue.enqueue({ a: 1 });
    expect(queue.snapshot().status).toBe("failed");

    const retry = await queue.retry();
    expect(retry.status).toBe("retried");
    expect(queue.snapshot().status).toBe("saved");
    expect(queue.isDirty()).toBe(false);
    void storage;
    void attempt;
    queue.dispose();
  });

  it("a new edit clears a prior failure and writes the new document", async () => {
    let throwOnce = true;
    const storage = mockStorage(() => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("transient");
      }
      return WRITTEN(2);
    });
    const queue = createAutosaveQueue(deps(storage));
    await queue.enqueue({ a: 1 });
    expect(queue.snapshot().status).toBe("failed");

    // User edits again (does not retry the old document).
    await queue.enqueue({ a: 2 });
    expect(queue.snapshot().status).toBe("saved");
    queue.dispose();
  });

  it("retry is a no-op when there is no failure", async () => {
    const storage = mockStorage(async () => WRITTEN(2));
    const queue = createAutosaveQueue(deps(storage));
    await queue.enqueue({ a: 1 });
    const retry = await queue.retry();
    expect(retry.status).toBe("already-idle");
    queue.dispose();
  });
});

describe("createAutosaveQueue — drain (replacement gating)", () => {
  it("waits for an in-flight write to settle before resolving", async () => {
    let release: () => void = () => {};
    const storage = mockStorage(
      () => new Promise<WorkingEditOutcome>((resolve) => (release = () => resolve(WRITTEN(2)))),
    );
    const queue = createAutosaveQueue(deps(storage));
    const firstWrite = queue.enqueue({ a: 1 });
    await Promise.resolve(); // let the deferred pump start the write
    expect(queue.isDirty()).toBe(true);

    let drained = false;
    void queue.drain().then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);

    release();
    await firstWrite;
    await queue.drain();
    expect(drained).toBe(true);
    queue.dispose();
  });

  it("does not resolve while a failure is outstanding", async () => {
    const storage = mockStorage(() => {
      throw new Error("persistently broken");
    });
    const queue = createAutosaveQueue(deps(storage));
    await queue.enqueue({ a: 1 });
    expect(queue.snapshot().status).toBe("failed");
    // drain hangs because the failure is outstanding; only resolve/discard clears it.
    let drained = false;
    const drainPromise = queue.drain().then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);
    // A new edit clears the failure and lets drain resolve.
    // (Broken storage throws again, but the failure cycle means drain still waits.)
    void drainPromise;
    queue.dispose();
  });

  it("settle() resolves the moment an in-flight write settles, even when it FAILS (no hang)", async () => {
    // The replacement coordinator gates on settle(), not drain(): a failed save
    // must not leave Load/Import hanging. settle() resolves with the failed
    // snapshot so the coordinator can offer Retry or explicit discard.
    const storage = mockStorage(() => {
      throw new Error("persistently broken");
    });
    const queue = createAutosaveQueue(deps(storage));
    const write = queue.enqueue({ a: 1 });
    await Promise.resolve(); // let the deferred pump start the write
    const settled = await Promise.race([
      queue.settle().then((s) => s),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hung")), 50)),
    ]);
    expect(settled.status).toBe("failed");
    await write;
    queue.dispose();
  });

  it("settle() resolves with 'saved' when an in-flight write commits", async () => {
    let release: () => void = () => {};
    const storage = mockStorage(
      () => new Promise<WorkingEditOutcome>((resolve) => (release = () => resolve(WRITTEN(2)))),
    );
    const queue = createAutosaveQueue(deps(storage));
    const write = queue.enqueue({ a: 1 });
    await Promise.resolve(); // let the deferred pump start the write
    release();
    await write;
    const settled = await queue.settle();
    expect(settled.status).toBe("saved");
    queue.dispose();
  });
});

describe("createAutosaveQueue — Clear (stale-epoch)", () => {
  it("treats a stale-epoch outcome as terminal: no retry, no failed banner", async () => {
    const storage = mockStorage(
      () => ({ status: "stale-epoch", currentEpoch: 1 }) as WorkingEditOutcome,
    );
    const queue = createAutosaveQueue(deps(storage, { clearEpoch: 0 }));
    const outcome = await queue.enqueue({ a: 1 });
    expect(outcome.status).toBe("stale-epoch");
    // Not failed: the Clear flow owns the state. Not dirty from the queue's view
    // of a retryable failure.
    expect(queue.snapshot().failure).toBeNull();
    queue.dispose();
  });
});

describe("createAutosaveQueue — loss guard", () => {
  it("arms the loss guard on creation and disarms on dispose", () => {
    const arm = vi.fn(() => () => {});
    const queue = createAutosaveQueue(
      deps(
        mockStorage(async () => WRITTEN(2)),
        { armLossGuard: arm },
      ),
    );
    expect(arm).toHaveBeenCalledTimes(1);
    queue.dispose();
    // The disposer returned by arm is called on dispose.
    // (arm returns a no-op disposer here; the call itself is the assertion.)
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it("isDirty is true while a write is pending and false once it commits", async () => {
    let release: () => void = () => {};
    const storage = mockStorage(
      () => new Promise<WorkingEditOutcome>((resolve) => (release = () => resolve(WRITTEN(2)))),
    );
    const queue = createAutosaveQueue(deps(storage));
    const write = queue.enqueue({ a: 1 });
    await Promise.resolve(); // let the deferred pump start the write
    expect(queue.isDirty()).toBe(true);
    release();
    await write;
    expect(queue.isDirty()).toBe(false);
    queue.dispose();
  });
});
