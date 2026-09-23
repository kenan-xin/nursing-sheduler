import { describe, expect, it } from "vitest";
import {
  OPTIMIZE_SESSION_KEY_PREFIX,
  OPTIMIZE_SESSION_STORAGE_KEY,
  buildProvisionalSession,
  clearAllOptimizeSessions,
  listOptimizeSessionKeys,
  migrateLegacySession,
  optimizeSessionKeyFor,
  readOwnerSession,
  removeOwnerSession,
  type ProvisionalOptimizeSession,
  type SessionTransactionStorage,
} from "./session-transaction";

// G6.2 step 1 — owner-keyed records.
//
// The single `nurse.optimize.session` slot did something worse than hold one
// record: because `stageProvisionalSession` refuses an occupied slot, an older
// run that had not yet PROVEN its cleanup literally occupied the next
// submission. "Cleanup unproven" and "you may not click Optimize" were the same
// storage cell. Keying by owner separates them, so an abandoned run can finish
// its cleanup in the background while a new run stages beside it.
//
// These are the storage-level proofs. The screen still drives the legacy path at
// this step; what is proven here is that the new surface is safe to switch onto.

function memStorage(seed: Record<string, string> = {}): SessionTransactionStorage & {
  snapshot(): Record<string, string>;
} {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    snapshot: () => Object.fromEntries(map),
  };
}

function provisional(ownerId: string): ProvisionalOptimizeSession {
  return buildProvisionalSession({
    ownerId,
    anonymized: true,
    peopleCount: 2,
    reverseMap: [
      ["P1", "Alice"],
      ["P2", "Bo"],
    ],
    runOptions: { timeout: 300 },
    capture: { status: "staged", snapshotRef: ownerId, submissionOrdinal: 1 },
  });
}

const bytes = (record: ProvisionalOptimizeSession) => JSON.stringify(record);

describe("owner-keyed session keys", () => {
  it("derives a key per owner inside the legacy key's namespace", () => {
    expect(optimizeSessionKeyFor("own-1")).toBe(`${OPTIMIZE_SESSION_KEY_PREFIX}own-1`);
    // A child of the legacy key, so ONE prefix sweep covers both shapes.
    expect(optimizeSessionKeyFor("own-1").startsWith(OPTIMIZE_SESSION_STORAGE_KEY)).toBe(true);
    expect(optimizeSessionKeyFor("own-1")).not.toBe(OPTIMIZE_SESSION_STORAGE_KEY);
  });

  it("enumerates the legacy slot and every owner record, and nothing else", () => {
    const storage = memStorage({
      [OPTIMIZE_SESSION_STORAGE_KEY]: "legacy",
      [optimizeSessionKeyFor("a")]: "A",
      [optimizeSessionKeyFor("b")]: "B",
      // Keys this tab's other features own. A roster privacy action has no
      // authority over them, which is the whole reason `clear()` is off-limits.
      "nurse.scenario.draft": "untouched",
      unrelated: "untouched",
    });

    const listing = listOptimizeSessionKeys(storage);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect([...listing.keys].sort()).toEqual(
      [OPTIMIZE_SESSION_STORAGE_KEY, optimizeSessionKeyFor("a"), optimizeSessionKeyFor("b")].sort(),
    );
  });

  it("reports UNKNOWN, never empty, when the store cannot be enumerated", () => {
    // A denied `sessionStorage` observed nothing, so nothing may be concluded —
    // least of all that it is empty, which would let Clear claim a purge it never
    // performed.
    const throwing: SessionTransactionStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      get length(): number {
        throw new Error("denied");
      },
      key: () => null,
    };
    expect(listOptimizeSessionKeys(throwing).ok).toBe(false);

    // A double with no enumeration surface at all is the same situation.
    const bare: SessionTransactionStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    expect(listOptimizeSessionKeys(bare).ok).toBe(false);
  });
});

describe("owner-scoped read and removal", () => {
  it("reads exactly one owner's record and distinguishes absent from unreadable", () => {
    const storage = memStorage({
      [optimizeSessionKeyFor("own-1")]: bytes(provisional("own-1")),
      [optimizeSessionKeyFor("own-2")]: "{not json",
    });

    const found = readOwnerSession(storage, "own-1");
    expect(found.status).toBe("found");
    if (found.status === "found") expect(found.record.ownerId).toBe("own-1");

    expect(readOwnerSession(storage, "own-2").status).toBe("unreadable");
    expect(readOwnerSession(storage, "own-3").status).toBe("absent");
  });

  it("removes ONLY the named owner, leaving every other run intact", () => {
    // The property the whole design rests on: cleanup for an abandoned run cannot
    // reach the record of the run the user just started.
    const storage = memStorage({
      [optimizeSessionKeyFor("old")]: bytes(provisional("old")),
      [optimizeSessionKeyFor("new")]: bytes(provisional("new")),
      [OPTIMIZE_SESSION_STORAGE_KEY]: bytes(provisional("legacy")),
    });

    expect(removeOwnerSession(storage, "old")).toEqual({ status: "removed" });
    expect(readOwnerSession(storage, "old").status).toBe("absent");
    expect(readOwnerSession(storage, "new").status).toBe("found");
    expect(storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).not.toBeNull();

    // Idempotent: removing again is `absent`, not a failure.
    expect(removeOwnerSession(storage, "old")).toEqual({ status: "absent" });
  });

  it("never claims removal it could not verify", () => {
    // A store whose `removeItem` silently no-ops must not be able to report a
    // verified retirement — the record carries a real-identity reverse map.
    const noop: SessionTransactionStorage = {
      getItem: () => "survives",
      setItem: () => {},
      removeItem: () => {},
    };
    expect(removeOwnerSession(noop, "own-1")).toEqual({ status: "unverified" });
  });
});

describe("legacy migration — idempotent and read-back verified", () => {
  it("moves a readable legacy record to its owner key and proves the legacy key gone", () => {
    const record = provisional("own-1");
    const storage = memStorage({ [OPTIMIZE_SESSION_STORAGE_KEY]: bytes(record) });

    expect(migrateLegacySession(storage)).toEqual({ status: "migrated", ownerId: "own-1" });

    const moved = readOwnerSession(storage, "own-1");
    expect(moved.status).toBe("found");
    // Semantically identical, including the reverse map it exists to protect.
    if (moved.status === "found") expect(moved.record).toEqual(record);
    expect(storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBeNull();

    // Idempotent: it runs on every route entry, so a second pass is a no-op.
    expect(migrateLegacySession(storage)).toEqual({ status: "none" });
    expect(readOwnerSession(storage, "own-1").status).toBe("found");
  });

  it("PRESERVES an existing owner key rather than overwriting it with legacy bytes", () => {
    // The interrupted-migration case. The owner key was written by the
    // owner-keyed path and is at least as current as the legacy copy; overwriting
    // it could replace a live run's record with a stale duplicate of itself.
    const current = provisional("own-1");
    // Same owner, schema-valid, but a DIFFERENT payload — so an overwrite would be
    // observable rather than a harmless no-op.
    const stale: ProvisionalOptimizeSession = {
      ...provisional("own-1"),
      runOptions: { timeout: 999 },
    };
    const storage = memStorage({
      [OPTIMIZE_SESSION_STORAGE_KEY]: JSON.stringify(stale),
      [optimizeSessionKeyFor("own-1")]: bytes(current),
    });

    expect(migrateLegacySession(storage)).toEqual({
      status: "already-migrated",
      ownerId: "own-1",
    });

    const kept = readOwnerSession(storage, "own-1");
    expect(kept.status).toBe("found");
    if (kept.status === "found") expect(kept.record.runOptions.timeout).toBe(300);
    // The duplicate is gone only because the target was proven readable and same-owner.
    expect(storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("leaves UNREADABLE legacy bytes exactly where they are, for verified Clear", () => {
    // They name no trustworthy owner, so there is nowhere to move them and nothing
    // that may be inferred from them. Deleting bytes we could not read is how a
    // reverse map gets lost silently.
    const storage = memStorage({ [OPTIMIZE_SESSION_STORAGE_KEY]: "{corrupt" });

    expect(migrateLegacySession(storage)).toEqual({ status: "unreadable" });
    expect(storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBe("{corrupt");
    expect(listOptimizeSessionKeys(storage)).toEqual({
      ok: true,
      keys: [OPTIMIZE_SESSION_STORAGE_KEY],
    });
  });

  it("keeps the legacy record when the copy cannot be proven, so a re-run repairs it", () => {
    // A write that silently does not land must not be followed by a removal — that
    // is the sequence that loses the record entirely.
    const map = new Map<string, string>([
      [OPTIMIZE_SESSION_STORAGE_KEY, bytes(provisional("own-1"))],
    ]);
    const refusesOwnerKey: SessionTransactionStorage = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        if (key.startsWith(OPTIMIZE_SESSION_KEY_PREFIX)) return; // silently refuses
        map.set(key, value);
      },
      removeItem: (key) => void map.delete(key),
      get length() {
        return map.size;
      },
      key: (index) => [...map.keys()][index] ?? null,
    };

    expect(migrateLegacySession(refusesOwnerKey)).toEqual({ status: "unverified" });
    // Nothing was lost: the legacy record is still there to migrate later.
    expect(map.get(OPTIMIZE_SESSION_STORAGE_KEY)).not.toBeUndefined();
  });

  it("concludes nothing from an unreadable store", () => {
    const denied: SessionTransactionStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(migrateLegacySession(denied)).toEqual({ status: "unverified" });
  });
});

describe("Clear — exact prefix sweep, never sessionStorage.clear()", () => {
  it("removes the legacy slot and every owner record, and nothing else", () => {
    const storage = memStorage({
      [OPTIMIZE_SESSION_STORAGE_KEY]: "legacy",
      [optimizeSessionKeyFor("a")]: "A",
      [optimizeSessionKeyFor("b")]: "B",
      "nurse.scenario.draft": "untouched",
      "some.other.feature": "untouched",
    });

    expect(clearAllOptimizeSessions(storage)).toEqual({
      status: "cleared",
      remaining: [],
      enumerated: true,
    });

    // The tab's other keys survive: this store is shared, and a roster privacy
    // action has no authority over anything else in it.
    expect(storage.snapshot()).toEqual({
      "nurse.scenario.draft": "untouched",
      "some.other.feature": "untouched",
    });
  });

  it("reports failure with what remains when a removal silently no-ops", () => {
    const map = new Map<string, string>([
      [OPTIMIZE_SESSION_STORAGE_KEY, "legacy"],
      [optimizeSessionKeyFor("stuck"), "S"],
    ]);
    const partial: SessionTransactionStorage = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
      removeItem: (key) => {
        if (key === optimizeSessionKeyFor("stuck")) return; // survives
        map.delete(key);
      },
      get length() {
        return map.size;
      },
      key: (index) => [...map.keys()][index] ?? null,
    };

    expect(clearAllOptimizeSessions(partial)).toEqual({
      status: "failed",
      remaining: [optimizeSessionKeyFor("stuck")],
      enumerated: true,
    });
  });

  it("fails closed when the store cannot be enumerated — residue UNKNOWN, not zero", () => {
    const bare: SessionTransactionStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    expect(clearAllOptimizeSessions(bare)).toEqual({
      status: "failed",
      remaining: [],
      enumerated: false,
    });
  });
});
