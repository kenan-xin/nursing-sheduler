import { describe, expect, it } from "vitest";
import type { PeopleReverseMap } from "@/lib/scenario";
import {
  activateSession,
  buildProvisionalSession,
  decodeSessionRecord,
  OPTIMIZE_SESSION_KEY_PREFIX,
  OPTIMIZE_SESSION_SCHEMA_VERSION,
  OPTIMIZE_SESSION_STORAGE_KEY,
  optimizeSessionKeyFor,
  removeOwnerSession,
  runSubmissionTransaction,
  stageProvisionalSession,
  type ActiveOptimizeSession,
  type ProvisionalOptimizeSession,
  type SessionCodec,
  type SessionTransactionStorage,
} from "./session-transaction";

// The LEGACY single slot. Records are owner-keyed now; this constant survives
// because the corrupt-bytes fixtures below deliberately seed it, and because
// `FakeStorage.raw(KEY)` reads "the one record in this store" (see there).
const KEY = OPTIMIZE_SESSION_STORAGE_KEY;

/**
 * Classify raw record bytes the way the deleted reload inspector used to.
 *
 * LOCAL to this suite on purpose. The product no longer classifies anything on
 * load — that was the whole point of G6.2 — but the closed schema, the verified
 * writes and the owner-scoped removals below still need a compact way to say what
 * a set of bytes became, and re-deriving it inline in fifty assertions would be
 * worse than naming it once.
 */
type Inspected =
  | { kind: "none" }
  | { kind: "interrupted"; record: ProvisionalOptimizeSession }
  | { kind: "resumable"; record: ActiveOptimizeSession }
  | { kind: "unreadable" };

function classifyRecord(raw: string | null): Inspected {
  if (raw === null) return { kind: "none" };
  const record = decodeSessionRecord(raw);
  if (record === null) return { kind: "unreadable" };
  return record.phase === "provisional"
    ? { kind: "interrupted", record }
    : { kind: "resumable", record };
}

/** Classify whatever single optimize record a store is holding. */
function inspectPersistedSession(storage: SessionTransactionStorage): Inspected {
  let legacy: string | null;
  try {
    legacy = storage.getItem(KEY);
  } catch {
    return { kind: "unreadable" };
  }
  if (legacy !== null) return classifyRecord(legacy);
  return classifyRecord(storage instanceof FakeStorage ? storage.soleRecord() : null);
}

// ---------------------------------------------------------------------------
// F2 — the roster-capture authority on the record.
// ---------------------------------------------------------------------------

describe("session record — F2 capture authority survives the write path", () => {
  const base = () => ({
    schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
    ownerId: "own-1",
    phase: "active" as const,
    jobId: "job-1",
    anonymized: false,
    runOptions: {},
    peopleCount: 0,
    reverseMap: [] as PeopleReverseMap,
  });

  function inspectRaw(value: unknown) {
    const storage = new FakeStorage();
    storage.seed(JSON.stringify(value));
    return inspectPersistedSession(storage);
  }

  it("a pre-capture v1 record is unreadable, never silently migrated", () => {
    // Roster capture authority cannot be invented after the fact: a v1 record has
    // no proof about whether a snapshot was staged, so it fails closed.
    const v1 = { ...base(), schemaVersion: 1 };
    expect(inspectRaw(v1).kind).toBe("unreadable");
  });

  it("rejects every malformed capture authority", () => {
    const malformed = [
      undefined,
      null,
      { status: "staged", snapshotRef: "own-1" }, // no ordinal
      { status: "staged", submissionOrdinal: 1 }, // no ref
      { status: "staged", snapshotRef: "", submissionOrdinal: 1 }, // empty ref
      { status: "staged", snapshotRef: "own-1", submissionOrdinal: 0 }, // F1 starts at 1
      { status: "staged", snapshotRef: "own-1", submissionOrdinal: 1.5 },
      { status: "staged", snapshotRef: "own-1", submissionOrdinal: 1, extra: true },
      { status: "unavailable" }, // no reason
      { status: "unavailable", reason: "because" }, // unknown reason
      { status: "unavailable", reason: "snapshot_persist_failed", snapshotRef: "o" },
      { status: "whatever" },
    ];
    for (const capture of malformed) {
      expect(inspectRaw({ ...base(), capture }).kind).toBe("unreadable");
    }
  });

  it("AUTHORITY BINDING: a staged ref that is not the owner id is unreadable", () => {
    // `snapshotRef` IS the transaction owner id, and that identity is the only
    // reason an owner-scoped snapshot deletion is as narrowly scoped as the record
    // authorizing it. Accept a record naming a FOREIGN owner and removing record B
    // would authorize deleting owner A's snapshot — potentially another tab's live
    // accepted run. It fails closed instead.
    const foreign = inspectRaw({
      ...base(),
      capture: { status: "staged", snapshotRef: "own-SOMEONE-ELSE", submissionOrdinal: 1 },
    });
    expect(foreign.kind).toBe("unreadable");
  });

  it("AUTHORITY BINDING is enforced writer-side too, so unbound bytes never reach storage", () => {
    // The same rule on the pre-write round-trip: a caller cannot stage a record
    // whose capture points at somebody else's snapshot.
    const storage = new FakeStorage();
    const outcome = stageProvisionalSession(
      storage,
      buildProvisionalSession({
        ownerId: "own-1",
        anonymized: false,
        peopleCount: 2,
        reverseMap: [],
        runOptions: {},
        capture: { status: "staged", snapshotRef: "own-SOMEONE-ELSE", submissionOrdinal: 1 },
      }),
    );
    expect(outcome).toEqual({ status: "blocked", reason: "invalid-record" });
    expect(storage.raw(KEY)).toBeNull();
  });

  it("negative control: both well-formed variants are resumable", () => {
    const staged = inspectRaw({
      ...base(),
      capture: { status: "staged", snapshotRef: "own-1", submissionOrdinal: 3 },
    });
    expect(staged.kind).toBe("resumable");
    const degraded = inspectRaw({
      ...base(),
      capture: { status: "unavailable", reason: "snapshot_persist_failed" },
    });
    expect(degraded.kind).toBe("resumable");
  });

  it("survives activation and cursor persistence verbatim", () => {
    const storage = new FakeStorage();
    const capture = { status: "staged" as const, snapshotRef: "own-1", submissionOrdinal: 9 };
    const provisional = buildProvisionalSession({
      ownerId: "own-1",
      anonymized: false,
      peopleCount: 0,
      reverseMap: [],
      runOptions: {},
      capture,
    });
    expect(stageProvisionalSession(storage, provisional).status).toBe("staged");

    const activated = activateSession(storage, provisional, "job-1");
    expect(activated.status).toBe("activated");
    if (activated.status !== "activated") throw new Error("unreachable");
    expect(activated.record.capture).toEqual(capture);

    // Activation rebuilds the record from the provisional one, so the capture
    // authority must survive that rewrite verbatim — it is the only durable handle
    // to the staged snapshot.
    const inspected = inspectPersistedSession(storage);
    expect(inspected.kind).toBe("resumable");
    if (inspected.kind !== "resumable") throw new Error("unreachable");
    expect(inspected.record.capture).toEqual(capture);
  });

  it("a codec that rewrites the capture authority is refused before any setItem", () => {
    // Writer validation must reject a lossy/lying codec on the capture field for the
    // same reason as every other load-bearing field: an ordinal that is not the one
    // F1 allocated would corrupt candidate ordering across tabs.
    const storage = new FakeStorage();
    const codec: SessionCodec = {
      serialize: (record) =>
        JSON.stringify({
          ...record,
          capture: { status: "staged", snapshotRef: "own-1", submissionOrdinal: 99 },
        }),
      deserialize: (raw) => JSON.parse(raw) as unknown,
    };
    const provisional = buildProvisionalSession({
      ownerId: "own-1",
      anonymized: false,
      peopleCount: 0,
      reverseMap: [],
      runOptions: {},
      capture: { status: "staged", snapshotRef: "own-1", submissionOrdinal: 1 },
    });

    expect(stageProvisionalSession(storage, provisional, codec)).toMatchObject({
      status: "blocked",
      reason: "invalid-record",
    });
    expect(storage.getItem(KEY)).toBeNull();
  });
});

/** An injectable Storage subset with per-operation overrides for the adversarial
 *  matrix (throwing / no-op / partial / write-then-throw / wipe-then-throw). */
class FakeStorage implements SessionTransactionStorage {
  private store = new Map<string, string>();
  onGet: ((key: string, store: Map<string, string>) => string | null) | null = null;
  onSet: ((key: string, value: string, store: Map<string, string>) => void) | null = null;
  onRemove: ((key: string, store: Map<string, string>) => void) | null = null;
  setCalls = 0;
  removeCalls = 0;

  getItem(key: string): string | null {
    if (this.onGet) return this.onGet(key, this.store);
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.setCalls += 1;
    if (this.onSet) return this.onSet(key, value, this.store);
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.removeCalls += 1;
    if (this.onRemove) return this.onRemove(key, this.store);
    this.store.delete(key);
  }
  /**
   * Read one key — except for the legacy slot, which now means "the record".
   *
   * Records moved to `nurse.optimize.session.<ownerId>`, and these fixtures drive
   * ONE transaction at a time, so "the record" is unambiguous. Reading it this way
   * keeps every `raw(KEY)` assertion below saying what it always said ("the
   * durable record is / is not this") instead of restating the key layout fifty
   * times — and the owner-keying itself is proved directly in
   * `owner-keyed-session.test.ts`, which is where that belongs.
   */
  raw(key: string): string | null {
    if (key === KEY) {
      const owned = this.ownedEntries();
      if (owned.length === 1) return owned[0][1];
    }
    return this.store.get(key) ?? null;
  }
  /** The single owner-keyed record, or null when there is not exactly one. */
  soleRecord(): string | null {
    const owned = this.ownedEntries();
    return owned.length === 1 ? owned[0][1] : null;
  }
  private ownedEntries(): Array<[string, string]> {
    return [...this.store.entries()].filter(([k]) => k.startsWith(OPTIMIZE_SESSION_KEY_PREFIX));
  }
  /** Seed raw bytes at an EXACT key (used to occupy one owner's key). */
  seedAt(key: string, value: string): void {
    this.store.set(key, value);
  }
  /** Seed a record AT ITS OWN KEY, so the product finds it where it now looks. */
  seed(value: string): void {
    let ownerId: unknown;
    try {
      ownerId = (JSON.parse(value) as { ownerId?: unknown }).ownerId;
    } catch {
      ownerId = undefined;
    }
    // Undecodable bytes name no owner, so they go to the legacy slot — which is
    // also exactly where a real tab would be holding them.
    this.store.set(
      typeof ownerId === "string" && ownerId.length > 0
        ? optimizeSessionKeyFor(ownerId)
        : OPTIMIZE_SESSION_STORAGE_KEY,
      value,
    );
  }
}

function quotaError(): never {
  const error = new Error("quota") as Error & { name: string; code: number };
  error.name = "QuotaExceededError";
  error.code = 22;
  throw error;
}
function securityError(): never {
  const error = new Error("blocked") as Error & { name: string };
  error.name = "SecurityError";
  throw error;
}

const REVERSE_MAP: PeopleReverseMap = [
  ["P1", "Alice"],
  ["P2", "Bob"],
];

function anonymizedProvisional(ownerId = "owner-A"): ProvisionalOptimizeSession {
  return buildProvisionalSession({
    ownerId,
    anonymized: true,
    peopleCount: 2,
    reverseMap: REVERSE_MAP,
    runOptions: { prettify: true, timeout: 300 },
    capture: { status: "staged", snapshotRef: ownerId, submissionOrdinal: 1 },
  });
}
function plainProvisional(ownerId = "owner-P"): ProvisionalOptimizeSession {
  return buildProvisionalSession({
    ownerId,
    anonymized: false,
    peopleCount: 2,
    reverseMap: [],
    runOptions: {},
    capture: { status: "staged", snapshotRef: ownerId, submissionOrdinal: 1 },
  });
}

function validActiveJson(jobId = "job-seed", ownerId = "owner-seed"): string {
  const active: ActiveOptimizeSession = {
    schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
    ownerId,
    phase: "active",
    jobId,
    anonymized: true,
    runOptions: { prettify: true, timeout: 300 },
    peopleCount: 2,
    reverseMap: REVERSE_MAP,
    capture: { status: "staged", snapshotRef: ownerId, submissionOrdinal: 1 },
  };
  return JSON.stringify(active);
}

describe("stageProvisionalSession — durable, verified, validated write before POST", () => {
  it("persists and read-back-verifies the provisional record (owner id present)", () => {
    const storage = new FakeStorage();
    const outcome = stageProvisionalSession(storage, anonymizedProvisional());

    expect(outcome.status).toBe("staged");
    const stored = JSON.parse(storage.raw(KEY)!);
    expect(stored).toMatchObject({ phase: "provisional", ownerId: "owner-A" });
    expect(stored.jobId).toBeUndefined();
    expect(stored.reverseMap).toEqual(REVERSE_MAP);
  });

  it("BLOCKS storage-unavailable / quota / no-op / partial writes (anonymized)", () => {
    const unavailable = new FakeStorage();
    unavailable.onSet = securityError;
    expect(stageProvisionalSession(unavailable, anonymizedProvisional())).toEqual({
      status: "blocked",
      reason: "storage-unavailable",
    });

    const quota = new FakeStorage();
    quota.onSet = quotaError;
    expect(stageProvisionalSession(quota, anonymizedProvisional())).toEqual({
      status: "blocked",
      reason: "quota-exceeded",
    });

    const noop = new FakeStorage();
    noop.onSet = () => {};
    expect(stageProvisionalSession(noop, anonymizedProvisional())).toEqual({
      status: "blocked",
      reason: "read-back-failed",
    });

    const partial = new FakeStorage();
    partial.onSet = (key, _v, store) => store.set(key, "trunc");
    expect(stageProvisionalSession(partial, anonymizedProvisional())).toEqual({
      status: "blocked",
      reason: "session-conflict",
    });
  });

  it("classifies the actual foreign active slot after an anonymized write mismatch", () => {
    const storage = new FakeStorage();
    storage.onSet = (key, _value, store) => {
      store.set(key, validActiveJson("job-B", "owner-B"));
    };
    expect(stageProvisionalSession(storage, anonymizedProvisional("owner-A"))).toEqual({
      status: "blocked",
      reason: "session-conflict",
    });
  });

  it("does NOT block a plain run on a write failure once the key is proven absent", () => {
    const storage = new FakeStorage();
    storage.onSet = quotaError;
    expect(stageProvisionalSession(storage, plainProvisional())).toEqual({
      status: "proceed-without-recovery",
      reason: "quota-exceeded",
    });
  });

  // G6.2 CHANGED WHAT "EXISTING" MEANS. A record belonging to another run used to
  // sit in the SAME cell, so it blocked — that is the defect the ticket exists for.
  // Records are owner-keyed now, so the only thing that can occupy a submission's
  // key is something already claiming to be that submission, and the guard below is
  // what is left: fail closed rather than overwrite.
  it("another run's record does not block a new submission at all", () => {
    for (const existing of [
      validActiveJson("job-EXISTING", "owner-OTHER"),
      JSON.stringify(anonymizedProvisional("owner-OTHER")),
    ]) {
      for (const incoming of [anonymizedProvisional("owner-NEW"), plainProvisional("owner-NEW")]) {
        const storage = new FakeStorage();
        storage.seed(existing);
        expect(stageProvisionalSession(storage, incoming)).toMatchObject({ status: "staged" });
        // ...and the other run's record is byte-for-byte untouched. This is the
        // property that lets an abandoned run's cleanup finish on its own time.
        expect(storage.raw(optimizeSessionKeyFor("owner-OTHER"))).toBe(existing);
      }
    }
  });

  it("NON-DESTRUCTIVE: anything already at THIS owner's key blocks and is preserved (zero set/remove)", () => {
    for (const existing of [
      validActiveJson("job-EXISTING", "owner-NEW"),
      JSON.stringify(anonymizedProvisional("owner-NEW")),
    ]) {
      for (const incoming of [anonymizedProvisional("owner-NEW"), plainProvisional("owner-NEW")]) {
        const storage = new FakeStorage();
        storage.seedAt(optimizeSessionKeyFor("owner-NEW"), existing);
        expect(stageProvisionalSession(storage, incoming)).toMatchObject({
          status: "blocked",
          reason: "session-conflict",
        });
        expect(storage.raw(optimizeSessionKeyFor("owner-NEW"))).toBe(existing);
        expect(storage.setCalls).toBe(0);
        expect(storage.removeCalls).toBe(0);
      }
    }
  });

  it("NON-DESTRUCTIVE: unreadable bytes at this owner's key block and are preserved (never deleted)", () => {
    const storage = new FakeStorage();
    storage.seedAt(optimizeSessionKeyFor("owner-NEW"), "{corrupt-other-tab");
    expect(stageProvisionalSession(storage, anonymizedProvisional("owner-NEW"))).toMatchObject({
      status: "blocked",
      reason: "session-conflict",
    });
    expect(storage.raw(optimizeSessionKeyFor("owner-NEW"))).toBe("{corrupt-other-tab");
    expect(storage.setCalls).toBe(0);
    expect(storage.removeCalls).toBe(0);
  });

  it("BLOCKS when storage cannot be read (cannot prove absence/ownership)", () => {
    const storage = new FakeStorage();
    storage.onGet = securityError;
    expect(stageProvisionalSession(storage, anonymizedProvisional())).toMatchObject({
      status: "blocked",
      reason: "session-conflict",
    });
  });

  it("writer validation: an invalid locally built record NEVER reaches setItem", () => {
    const cases: ProvisionalOptimizeSession[] = [
      buildProvisionalSession({
        ownerId: "",
        anonymized: true,
        peopleCount: 2,
        reverseMap: REVERSE_MAP,
        runOptions: {},
        capture: { status: "staged", snapshotRef: "o", submissionOrdinal: 1 },
      }),
      buildProvisionalSession({
        ownerId: "o",
        anonymized: true,
        peopleCount: -1,
        reverseMap: [],
        runOptions: {},
        capture: { status: "staged", snapshotRef: "o", submissionOrdinal: 1 },
      }),
      buildProvisionalSession({
        ownerId: "o",
        anonymized: true,
        peopleCount: 2,
        reverseMap: [], // anonymized but empty map ⇒ inconsistent
        runOptions: {},
        capture: { status: "staged", snapshotRef: "o", submissionOrdinal: 1 },
      }),
      buildProvisionalSession({
        ownerId: "o",
        anonymized: true,
        peopleCount: 2,
        reverseMap: REVERSE_MAP,
        runOptions: { timeout: 999_999 }, // out of bounds
        capture: { status: "staged", snapshotRef: "o", submissionOrdinal: 1 },
      }),
      buildProvisionalSession({
        ownerId: "o",
        anonymized: true,
        peopleCount: 2,
        reverseMap: REVERSE_MAP,
        runOptions: {},
        // A staged capture with a zero ordinal: F1 hands out 1, 2, 3 … so this is a
        // corrupted ordering authority and must never become durable.
        capture: { status: "staged", snapshotRef: "o", submissionOrdinal: 0 },
      }),
    ];
    for (const record of cases) {
      const storage = new FakeStorage();
      expect(stageProvisionalSession(storage, record)).toEqual({
        status: "blocked",
        reason: "invalid-record",
      });
      expect(storage.setCalls).toBe(0);
      expect(storage.raw(KEY)).toBeNull();
    }
  });

  it("writer validation: a lossy/lying codec is caught before setItem", () => {
    const storage = new FakeStorage();
    const lyingCodec: SessionCodec = {
      serialize: () => "{}", // decodes to an invalid record
      deserialize: JSON.parse,
    };
    expect(stageProvisionalSession(storage, anonymizedProvisional(), lyingCodec)).toEqual({
      status: "blocked",
      reason: "invalid-record",
    });
    expect(storage.setCalls).toBe(0);
  });

  // A codec that emits a DIFFERENT but still schema-valid record must be rejected
  // field-by-field, so the durable recovery payload always describes exactly the
  // submitted people/options.
  it.each([
    ["a different people count + map", { peopleCount: 1, reverseMap: [["P1", "Alice"]] }],
    [
      "a different reverse-map original",
      {
        reverseMap: [
          ["P1", "Mallory"],
          ["P2", "Bob"],
        ],
      },
    ],
    [
      "swapped reverse-map originals",
      {
        reverseMap: [
          ["P1", "Bob"],
          ["P2", "Alice"],
        ],
      },
    ],
    ["a different timeout", { runOptions: { prettify: true, timeout: 600 } }],
    ["a different prettify", { runOptions: { prettify: false, timeout: 300 } }],
    ["a flipped anonymized flag", { anonymized: false, reverseMap: [] }],
    ["a different owner", { ownerId: "owner-EVIL" }],
  ])(
    "writer validation: a valid-but-different codec payload (%s) writes nothing",
    (_label, patch) => {
      const supplied = anonymizedProvisional("owner-A");
      const forged = { ...JSON.parse(JSON.stringify(supplied)), ...patch };
      const lyingCodec: SessionCodec = {
        serialize: () => JSON.stringify(forged), // ignores the supplied record
        deserialize: JSON.parse,
      };
      const storage = new FakeStorage();
      expect(stageProvisionalSession(storage, supplied, lyingCodec)).toEqual({
        status: "blocked",
        reason: "invalid-record",
      });
      expect(storage.setCalls).toBe(0);
      expect(storage.raw(KEY)).toBeNull();
    },
  );

  it("writer validation: an active lying codec (different job id) never writes the active record", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional();
    stageProvisionalSession(storage, provisional); // default codec, real provisional
    const before = storage.setCalls;

    const lyingCodec: SessionCodec = {
      serialize: (record) =>
        JSON.stringify(record.phase === "active" ? { ...record, jobId: "job-FORGED" } : record),
      deserialize: JSON.parse,
    };
    const outcome = activateSession(storage, provisional, "job-REAL", lyingCodec);
    expect(outcome.status).toBe("activation-persistence-failed");
    // No active write happened; the provisional remains intact.
    expect(storage.setCalls).toBe(before);
    const stored = JSON.parse(storage.raw(KEY)!);
    expect(stored.phase).toBe("provisional");
    expect(stored.jobId).toBeUndefined();
  });
});

describe("activateSession — owner-scoped replacement + verified reconciliation", () => {
  it("replaces our owned provisional with the active record", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional();
    stageProvisionalSession(storage, provisional);

    const outcome = activateSession(storage, provisional, "job-123");
    expect(outcome.status).toBe("activated");
    expect(JSON.parse(storage.raw(KEY)!)).toMatchObject({
      phase: "active",
      jobId: "job-123",
      ownerId: "owner-A",
    });
  });

  it("is idempotent when our active record is already durable", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional();
    stageProvisionalSession(storage, provisional);
    activateSession(storage, provisional, "job-123");
    expect(activateSession(storage, provisional, "job-123").status).toBe("activated");
  });

  it("rejects an empty job id, retaining the provisional map", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional();
    stageProvisionalSession(storage, provisional);
    expect(activateSession(storage, provisional, "").status).toBe("activation-persistence-failed");
    expect(JSON.parse(storage.raw(KEY)!).phase).toBe("provisional");
  });

  it("does NOT overwrite a foreign record occupying this owner's key (owner conflict)", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional("owner-A");
    // Owner-keyed, so reaching this at all takes a foreign record already sitting
    // at owner A's key. The guard stays anyway: the cost of being wrong here is
    // destroying another run's only reverse map.
    storage.seedAt(optimizeSessionKeyFor("owner-A"), validActiveJson("job-B", "owner-B"));
    const outcome = activateSession(storage, provisional, "job-A");

    expect(outcome.status).toBe("activation-unverified");
    if (outcome.status !== "activation-unverified") return;
    expect(outcome.reason).toBe("owner-conflict");
    // The foreign record is untouched.
    expect(JSON.parse(storage.raw(optimizeSessionKeyFor("owner-A"))!)).toMatchObject({
      ownerId: "owner-B",
      jobId: "job-B",
    });
  });

  it("on a plain second-write failure retains our provisional and returns volatile job/map", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional();
    stageProvisionalSession(storage, provisional);

    storage.onSet = quotaError;
    const outcome = activateSession(storage, provisional, "job-123");
    expect(outcome.status).toBe("activation-persistence-failed");
    if (outcome.status !== "activation-persistence-failed") return;
    expect(outcome.volatile).toEqual({
      jobId: "job-123",
      anonymized: true,
      peopleCount: 2,
      reverseMap: REVERSE_MAP,
    });
    expect(JSON.parse(storage.raw(KEY)!).phase).toBe("provisional");
  });

  it("write-then-throw where the active bytes LAND is classified activated (reload resumable)", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional();
    stageProvisionalSession(storage, provisional);

    storage.onSet = (key, value, store) => {
      store.set(key, value);
      quotaError();
    };
    expect(activateSession(storage, provisional, "job-123").status).toBe("activated");
    storage.onSet = null;
    expect(inspectPersistedSession(storage).kind).toBe("resumable");
  });

  it("no-op active write leaves the provisional intact and reports interrupted on reload", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional();
    stageProvisionalSession(storage, provisional);

    storage.onSet = () => {};
    expect(activateSession(storage, provisional, "job-123").status).toBe(
      "activation-persistence-failed",
    );
    storage.onSet = null;
    expect(inspectPersistedSession(storage).kind).toBe("interrupted");
  });

  it("missing AFTER our write is retirement evidence too — nothing is restored", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional();
    stageProvisionalSession(storage, provisional);

    // Every write wipes the key and throws → the key is absent after our write.
    storage.onSet = (key, _v, store) => {
      store.delete(key);
      quotaError();
    };
    const outcome = activateSession(storage, provisional, "job-123");

    // This used to RESTORE the provisional here, which is the same repopulation
    // the empty-key branch was doing, one step later: a key that went from ours to
    // absent across a single synchronous write was emptied by a retirement.
    expect(outcome).toEqual({ status: "activation-retired", jobId: "job-123" });
    storage.onSet = null;
    expect(storage.raw(KEY)).toBeNull();
    expect(inspectPersistedSession(storage).kind).toBe("none");
  });

  // THE P1 CUT. An empty owner key is not free space.
  //
  // This branch used to fall through and write the active record. Nothing empties
  // an owner key except a retirement or a verified Clear, so a staged activation
  // that finds its key gone has been told the visit ended — and writing would put
  // the identity-bearing record back into the key a `pagehide` had just cut, where
  // nothing is guaranteed to run again to remove it.
  it("a GENUINELY EMPTY key is retirement evidence: no write, no activation", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional();
    expect(stageProvisionalSession(storage, provisional).status).toBe("staged");

    // The retirement, exactly as `retireOnDocumentExit` performs it: the EXACT
    // owner key, removed synchronously.
    storage.removeItem(optimizeSessionKeyFor("owner-A"));
    const writesBefore = storage.setCalls;

    expect(activateSession(storage, provisional, "job-123")).toEqual({
      status: "activation-retired",
      jobId: "job-123",
    });
    expect(storage.setCalls, "a retired activation must not write at all").toBe(writesBefore);
    expect(storage.raw(KEY)).toBeNull();
  });

  it("CONTROL: another owner's record is untouched by a retired activation", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional("owner-A");
    stageProvisionalSession(storage, provisional);
    const otherKey = optimizeSessionKeyFor("owner-OTHER");
    storage.seedAt(otherKey, validActiveJson("job-OTHER", "owner-OTHER"));

    storage.removeItem(optimizeSessionKeyFor("owner-A"));
    expect(activateSession(storage, provisional, "job-A").status).toBe("activation-retired");

    expect(JSON.parse(storage.raw(otherKey)!)).toMatchObject({
      ownerId: "owner-OTHER",
      jobId: "job-OTHER",
    });
  });
});

describe("runSubmissionTransaction — closed submit seam + owner scoping", () => {
  it("activates a resumable session on accepted(jobId)", async () => {
    const storage = new FakeStorage();
    const outcome = await runSubmissionTransaction(anonymizedProvisional(), {
      storage,
      submit: async () => ({ status: "accepted", jobId: "job-9" }),
    });
    expect(outcome.status).toBe("activated");
    expect(JSON.parse(storage.raw(KEY)!)).toMatchObject({ phase: "active", jobId: "job-9" });
  });

  it("blocks before POST for an anonymized run when staging fails", async () => {
    const storage = new FakeStorage();
    storage.onSet = securityError;
    let submitted = false;
    const outcome = await runSubmissionTransaction(anonymizedProvisional(), {
      storage,
      submit: async () => {
        submitted = true;
        return { status: "accepted", jobId: "never" };
      },
    });
    expect(outcome).toEqual({ status: "blocked-before-post", reason: "storage-unavailable" });
    expect(submitted).toBe(false);
  });

  it("definitely-rejected removes our provisional and reports rollback: removed", async () => {
    const storage = new FakeStorage();
    const error = new Error("400 bad request");
    const outcome = await runSubmissionTransaction(anonymizedProvisional(), {
      storage,
      submit: async () => ({ status: "definitely-rejected", error }),
    });
    expect(outcome).toEqual({ status: "submit-rejected", error, rollback: "removed" });
    expect(storage.raw(KEY)).toBeNull();
  });

  it("definitely-rejected with a throwing remove reports rollback: unverified, A remains", async () => {
    const storage = new FakeStorage();
    const error = new Error("400 bad request");
    const outcome = await runSubmissionTransaction(anonymizedProvisional("owner-A"), {
      storage,
      submit: async () => {
        storage.onRemove = securityError; // removal throws at rollback time
        return { status: "definitely-rejected", error };
      },
    });
    expect(outcome).toMatchObject({ status: "submit-rejected", error, rollback: "unverified" });
    storage.onRemove = null;
    // A's provisional was NOT cleanly cleared — reload must not claim otherwise.
    expect(inspectPersistedSession(storage).kind).toBe("interrupted");
  });

  it("definitely-rejected with a no-op remove reports rollback: unverified", async () => {
    const storage = new FakeStorage();
    const error = new Error("400 bad request");
    const outcome = await runSubmissionTransaction(anonymizedProvisional("owner-A"), {
      storage,
      submit: async () => {
        storage.onRemove = () => {}; // removal silently does nothing
        return { status: "definitely-rejected", error };
      },
    });
    expect(outcome).toMatchObject({ status: "submit-rejected", error, rollback: "unverified" });
  });

  it("acceptance-unknown and thrown submit both retain the map; reload interrupted", async () => {
    const unknown = new FakeStorage();
    const e1 = new Error("read timeout after send");
    expect(
      await runSubmissionTransaction(anonymizedProvisional(), {
        storage: unknown,
        submit: async () => ({ status: "acceptance-unknown", error: e1 }),
      }),
    ).toEqual({ status: "acceptance-unknown", error: e1 });
    expect(inspectPersistedSession(unknown).kind).toBe("interrupted");

    const thrown = new FakeStorage();
    const e2 = new Error("network dropped mid-response");
    expect(
      await runSubmissionTransaction(anonymizedProvisional(), {
        storage: thrown,
        submit: async () => {
          throw e2;
        },
      }),
    ).toEqual({ status: "acceptance-unknown", error: e2 });
    expect(JSON.parse(thrown.raw(KEY)!).reverseMap).toEqual(REVERSE_MAP);
  });

  it("an accepted response with an empty job id is treated as acceptance-unknown", async () => {
    const storage = new FakeStorage();
    const outcome = await runSubmissionTransaction(anonymizedProvisional(), {
      storage,
      submit: async () => ({ status: "accepted", jobId: "" }),
    });
    expect(outcome.status).toBe("acceptance-unknown");
    expect(storage.raw(KEY)).not.toBeNull();
  });

  it("injected second-write failure: volatile job/map, provisional retained, reload NOT resumable", async () => {
    const storage = new FakeStorage();
    const outcome = await runSubmissionTransaction(anonymizedProvisional(), {
      storage,
      submit: async () => {
        storage.onSet = quotaError;
        return { status: "accepted", jobId: "job-202" };
      },
    });
    expect(outcome.status).toBe("activation-persistence-failed");
    if (outcome.status !== "activation-persistence-failed") return;
    expect(outcome.volatile.jobId).toBe("job-202");
    expect(outcome.volatile.reverseMap).toEqual(REVERSE_MAP);
    storage.onSet = null;
    expect(JSON.parse(storage.raw(KEY)!).reverseMap).toEqual(REVERSE_MAP);
    expect(inspectPersistedSession(storage).kind).toBe("interrupted");
  });

  // REMOVED (G6.2d): "degraded cleanup classifies exact owned variants, absence,
  // conflicts, and storage failures". It was the only consumer of
  // `cleanupDegraded` / `removeDegradedRecord`, which existed for the controller's
  // `prepareDegradedCleanup` — deleted with boot recovery in G6.2. The live
  // authority is owner-scoped `removeOwnedRecord` / `retireSessionRecord`, proved
  // by `owner-scoped removal agrees with the transaction that wrote the record`
  // below and by `owner-keyed-session.test.ts`.

  // THE RETIREMENT INTERLEAVING, at the transaction boundary.
  it("a retirement during the POST leaves the key absent and activates nothing", async () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional("owner-A");
    const outcome = await runSubmissionTransaction(provisional, {
      storage,
      submit: async () => {
        // The record is durably staged at this point — assert it, so "absent at the
        // end" cannot pass because nothing was ever written.
        expect(storage.raw(optimizeSessionKeyFor("owner-A"))).not.toBeNull();
        // The visit ends while the request is in flight.
        storage.removeItem(optimizeSessionKeyFor("owner-A"));
        return { status: "accepted", jobId: "job-late" };
      },
    });

    expect(outcome).toEqual({ status: "activation-retired", jobId: "job-late" });
    expect(storage.raw(optimizeSessionKeyFor("owner-A"))).toBeNull();
  });

  it("NEGATIVE CONTROL: an untouched staged record still activates normally", async () => {
    const storage = new FakeStorage();
    const outcome = await runSubmissionTransaction(anonymizedProvisional("owner-A"), {
      storage,
      submit: async () => ({ status: "accepted", jobId: "job-live" }),
    });

    expect(outcome.status).toBe("activated");
    expect(JSON.parse(storage.raw(optimizeSessionKeyFor("owner-A"))!)).toMatchObject({
      phase: "active",
      jobId: "job-live",
    });
  });

  it("an accepted PLAIN run that never staged stays volatile and writes no record", async () => {
    // The only caller that could legitimately reach activation with no provisional.
    // It no longer reaches it at all: activation requires the record it staged, so
    // the transaction returns the volatile activation directly rather than
    // manufacturing an active record in a key it never owned.
    const storage = new FakeStorage();
    storage.onSet = quotaError; // plain staging fails; the key stays proven empty
    const outcome = await runSubmissionTransaction(plainProvisional("owner-P"), {
      storage,
      submit: async () => ({ status: "accepted", jobId: "job-plain" }),
    });

    expect(outcome.status).toBe("activation-persistence-failed");
    if (outcome.status !== "activation-persistence-failed") return;
    expect(outcome.volatile.jobId).toBe("job-plain");
    expect(outcome.volatile.reverseMap).toEqual(plainProvisional("owner-P").reverseMap);
    storage.onSet = null;
    expect(storage.raw(optimizeSessionKeyFor("owner-P"))).toBeNull();
  });

  // --- interleaved A/B ownership -----------------------------------------
  it.each([
    ["anonymized", anonymizedProvisional("owner-B")],
    ["plain", plainProvisional("owner-B")],
  ])(
    "A (anonymized, acceptance-unknown) map cannot be erased by a %s B staging mid-flight",
    async (_label, recB) => {
      const storage = new FakeStorage();
      const errA = new Error("A read timeout after send");
      let removeDuringB = 0;
      const outA = await runSubmissionTransaction(anonymizedProvisional("owner-A"), {
        storage,
        submit: async () => {
          // B starts while A is in flight. It now SUCCEEDS — that is the point of
          // owner-keying — and the property that still matters is that it removes
          // nothing of A's.
          const removeBefore = storage.removeCalls;
          expect(stageProvisionalSession(storage, recB)).toMatchObject({ status: "staged" });
          removeDuringB = storage.removeCalls - removeBefore;
          return { status: "acceptance-unknown", error: errA };
        },
      });

      expect(removeDuringB).toBe(0);
      // A is ambiguous: its map is retained, under its own key, untouched by B.
      expect(outA).toEqual({ status: "acceptance-unknown", error: errA });
      const stored = classifyRecord(storage.raw(optimizeSessionKeyFor("owner-A")));
      expect(stored.kind).toBe("interrupted");
      if (stored.kind === "interrupted") {
        expect(stored.record.ownerId).toBe("owner-A");
        expect(stored.record.reverseMap).toEqual(REVERSE_MAP);
      }
      // ...and B's own record is durable beside it.
      expect(classifyRecord(storage.raw(optimizeSessionKeyFor("owner-B"))).kind).toBe(
        "interrupted",
      );
    },
  );

  it("plain unstaged A rolling back reports `absent` and cannot touch a concurrent B", async () => {
    const storage = new FakeStorage();
    const recB = anonymizedProvisional("owner-B");
    const errA = new Error("A rejected");
    // Plain A's provisional write fails, so A proceeds WITHOUT durable staging.
    storage.onSet = quotaError;
    const outA = await runSubmissionTransaction(plainProvisional("owner-A"), {
      storage,
      submit: async () => {
        storage.onSet = null; // let B's write succeed
        expect(stageProvisionalSession(storage, recB).status).toBe("staged");
        return { status: "definitely-rejected", error: errA };
      },
    });
    // A's rollback looks at A's OWN key, which is genuinely empty — so `absent` is
    // now the honest answer, where the single slot forced it to report a conflict
    // with a run it had nothing to do with.
    expect(outA).toMatchObject({ status: "submit-rejected", error: errA, rollback: "absent" });
    // B is intact, and A's rollback never went near it.
    expect(JSON.parse(storage.raw(optimizeSessionKeyFor("owner-B"))!)).toMatchObject({
      ownerId: "owner-B",
    });
  });

  it("plain unstaged A with an empty slot reports rollback: absent on rejection", async () => {
    const storage = new FakeStorage();
    const errA = new Error("A rejected");
    storage.onSet = quotaError; // plain A proceeds without recovery
    const outA = await runSubmissionTransaction(plainProvisional("owner-A"), {
      storage,
      submit: async () => {
        storage.onSet = null; // slot stays empty (no B)
        return { status: "definitely-rejected", error: errA };
      },
    });
    expect(outA).toEqual({ status: "submit-rejected", error: errA, rollback: "absent" });
    expect(storage.raw(KEY)).toBeNull();
  });

  // THE HEADLINE PROPERTY. This test used to assert the opposite — that an existing
  // session blocked the next submission until it was explicitly discarded — and
  // that is exactly what put “An optimisation from this browser is still running”
  // between the user and the Optimize button.
  it("a run already in the tab does NOT block a new submission", async () => {
    const storage = new FakeStorage();
    storage.seed(validActiveJson("job-A", "owner-A"));
    let submitted = false;
    const outcome = await runSubmissionTransaction(plainProvisional("owner-B"), {
      storage,
      submit: async () => {
        submitted = true;
        return { status: "accepted", jobId: "job-B" };
      },
    });
    expect(outcome).toMatchObject({ status: "activated" });
    expect(submitted).toBe(true);
    // Both records coexist: the older run can still finish its cleanup, and the
    // newer one never waited on it.
    expect(classifyRecord(storage.raw(optimizeSessionKeyFor("owner-A")))).toMatchObject({
      kind: "resumable",
    });
    expect(classifyRecord(storage.raw(optimizeSessionKeyFor("owner-B")))).toMatchObject({
      kind: "resumable",
    });
  });
});

describe("inspectPersistedSession — strict reload classification", () => {
  it("reports none / interrupted / resumable", () => {
    expect(inspectPersistedSession(new FakeStorage())).toEqual({ kind: "none" });

    const provisional = new FakeStorage();
    stageProvisionalSession(provisional, anonymizedProvisional());
    expect(inspectPersistedSession(provisional).kind).toBe("interrupted");

    const active = new FakeStorage();
    active.seed(validActiveJson("job-77"));
    const resumable = inspectPersistedSession(active);
    expect(resumable.kind).toBe("resumable");
    if (resumable.kind === "resumable") expect(resumable.record.jobId).toBe("job-77");
  });

  it("reports corrupt JSON, a future version, and a throwing read as unreadable", () => {
    const corrupt = new FakeStorage();
    corrupt.seed("{not valid json");
    expect(inspectPersistedSession(corrupt)).toMatchObject({ kind: "unreadable" });

    const future = new FakeStorage();
    future.seed(JSON.stringify({ ...JSON.parse(validActiveJson()), schemaVersion: 999 }));
    expect(inspectPersistedSession(future)).toMatchObject({ kind: "unreadable" });

    const throwing = new FakeStorage();
    throwing.onGet = securityError;
    expect(inspectPersistedSession(throwing)).toEqual({ kind: "unreadable" });
  });

  it.each([
    ["an empty job id", { phase: "active", jobId: "" }],
    ["a negative people count", { peopleCount: -1 }],
    ["a fractional people count", { peopleCount: 1.5 }],
    ["run options as an array", { runOptions: [] }],
    ["a non-boolean prettify", { runOptions: { prettify: "yes" } }],
    ["an out-of-range timeout", { runOptions: { timeout: 999_999 } }],
    ["a zero timeout", { runOptions: { timeout: 0 } }],
    ["an anonymized record with an empty map", { anonymized: true, reverseMap: [] }],
    ["a plain record with a non-empty map", { anonymized: false, reverseMap: REVERSE_MAP }],
    ["an empty owner id", { ownerId: "" }],
    ["an extra field", { extra: "nope" }],
    [
      "a duplicate typed original",
      {
        reverseMap: [
          ["P1", "Alice"],
          ["P2", "Alice"],
        ],
      },
    ],
    ["a cardinality that disagrees with the count", { peopleCount: 3, reverseMap: REVERSE_MAP }],
  ])("rejects %s as unreadable", (_label, patch) => {
    const storage = new FakeStorage();
    storage.seed(JSON.stringify({ ...JSON.parse(validActiveJson()), ...patch }));
    expect(inspectPersistedSession(storage)).toMatchObject({ kind: "unreadable" });
  });
});

// ---------------------------------------------------------------------------
// Owner-scoped removal
// ---------------------------------------------------------------------------
//
// REPLACED the \`removeInspectedSession\` and \`updateActiveCursor\` batteries.
//
// \`removeInspectedSession\` removed "the" record only if its exact bytes were
// still the ones a boot inspection had classified. That exact-bytes check was the
// only thing standing between a removal and somebody else's run, because one slot
// held every run. The key names the owner now, so the scoping is structural and
// the proof belongs with it, in \`owner-keyed-session.test.ts\`. What is worth
// pinning HERE is that the transaction's own removal path agrees.
//
// \`updateActiveCursor\` is gone outright, along with the persisted resume cursor:
// it existed so a RELOAD could resume, and a reload is now a fresh entry.

describe("owner-scoped removal agrees with the transaction that wrote the record", () => {
  it("removes the record the transaction staged, and proves it absent", () => {
    const storage = new FakeStorage();
    const provisional = buildProvisionalSession({
      ownerId: "own-1",
      anonymized: false,
      peopleCount: 0,
      reverseMap: [],
      runOptions: {},
      capture: { status: "unavailable", reason: "snapshot_persist_failed" },
    });
    expect(stageProvisionalSession(storage, provisional).status).toBe("staged");
    expect(activateSession(storage, provisional, "job-1").status).toBe("activated");

    expect(removeOwnerSession(storage, "own-1")).toEqual({ status: "removed" });
    expect(storage.raw(optimizeSessionKeyFor("own-1"))).toBeNull();
  });

  it("cannot reach another owner's record, even when asked to", () => {
    const storage = new FakeStorage();
    for (const ownerId of ["own-1", "own-2"]) {
      const record = buildProvisionalSession({
        ownerId,
        anonymized: false,
        peopleCount: 0,
        reverseMap: [],
        runOptions: {},
        capture: { status: "unavailable", reason: "snapshot_persist_failed" },
      });
      expect(stageProvisionalSession(storage, record).status).toBe("staged");
    }

    expect(removeOwnerSession(storage, "own-1")).toEqual({ status: "removed" });
    // The other run is untouched — the property that lets an abandoned run finish
    // its cleanup while a brand-new submission is already staged.
    expect(storage.raw(optimizeSessionKeyFor("own-2"))).not.toBeNull();
    expect(classifyRecord(storage.raw(optimizeSessionKeyFor("own-2"))).kind).toBe("interrupted");
  });

  it("reports an unproven removal rather than a false clean one", () => {
    const storage = new FakeStorage();
    const provisional = buildProvisionalSession({
      ownerId: "own-1",
      anonymized: false,
      peopleCount: 0,
      reverseMap: [],
      runOptions: {},
      capture: { status: "unavailable", reason: "snapshot_persist_failed" },
    });
    expect(stageProvisionalSession(storage, provisional).status).toBe("staged");
    storage.onRemove = () => {}; // silently no-ops
    expect(removeOwnerSession(storage, "own-1")).toEqual({ status: "unverified" });
  });
});
