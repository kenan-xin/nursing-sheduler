import { describe, expect, it } from "vitest";
import { createAttemptRegistry, isAbortError } from "./visit-attempt";

// G6.2 step 2 — the attempt authority.
//
// `mountedRef` only ever suppressed React state after unmount; the asynchronous
// terminal chain (XLSX fetch, saveBlob, roster fetch, candidate commit, DELETE)
// carried on regardless. These prove the replacement's two load-bearing
// properties: revocation is SYNCHRONOUS, and it is observable from inside the
// abort handler itself.

describe("attempt registry", () => {
  it("makes exactly one attempt current, monotonically", () => {
    const registry = createAttemptRegistry();
    expect(registry.current()).toBeNull();

    const first = registry.start();
    expect(first.isCurrent()).toBe(true);
    expect(registry.current()).toBe(first);

    const second = registry.start();
    // The later deliberate click wins; the older attempt is authority no longer.
    expect(second.id).toBeGreaterThan(first.id);
    expect(second.isCurrent()).toBe(true);
    expect(first.isCurrent()).toBe(false);
  });

  it("revokes SYNCHRONOUSLY — no await may sit between exit and the fence closing", () => {
    const registry = createAttemptRegistry();
    const attempt = registry.start();
    expect(attempt.signal.aborted).toBe(false);

    registry.revoke();

    // Both true on the very next line: a caller must be able to say "after this
    // returns, nothing the old attempt does can reach the user".
    expect(attempt.isCurrent()).toBe(false);
    expect(attempt.signal.aborted).toBe(true);
    expect(registry.current()).toBeNull();
  });

  it("is already non-current INSIDE its own abort handler", () => {
    // The subtle one. `abort()` runs listeners synchronously, so a handler that
    // reacts to revocation by asking "am I still live?" must not be told yes —
    // otherwise the exact code cleaning up would believe it still owns the UI.
    const registry = createAttemptRegistry();
    const attempt = registry.start();
    let currentInsideHandler: boolean | null = null;
    attempt.signal.addEventListener("abort", () => {
      currentInsideHandler = attempt.isCurrent();
    });

    registry.revoke();
    expect(currentInsideHandler).toBe(false);
  });

  it("revokes the predecessor when a new attempt starts", () => {
    const registry = createAttemptRegistry();
    const first = registry.start();
    const second = registry.start();

    expect(first.signal.aborted).toBe(true);
    // The new attempt is untouched by its predecessor's revocation.
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it("claims an owner exactly once", () => {
    // Write-once: an attempt owns one staged submission, and a second claim would
    // silently re-point retirement at the wrong record.
    const attempt = createAttemptRegistry().start();
    expect(attempt.ownerId()).toBeNull();
    attempt.claimOwner("own-1");
    attempt.claimOwner("own-2");
    expect(attempt.ownerId()).toBe("own-1");
  });

  it("recognizes a stale-attempt abort so it can be treated as silence", () => {
    const registry = createAttemptRegistry();
    const attempt = registry.start();
    registry.revoke();

    const aborted = attempt.signal.reason;
    expect(isAbortError(aborted)).toBe(true);
    // A real failure is NOT silence — the discrimination the notice depends on.
    expect(isAbortError(new Error("upstream exploded"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});
