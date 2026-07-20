import { describe, expect, it } from "vitest";
import type { PeopleReverseMap } from "@/lib/scenario";
import {
  activateSession,
  buildProvisionalSession,
  forgetInspectedSession,
  inspectPersistedSession,
  FORGET_OPTIMIZE_SESSION_WARNING,
  OPTIMIZE_SESSION_SCHEMA_VERSION,
  OPTIMIZE_SESSION_STORAGE_KEY,
  runSubmissionTransaction,
  stageProvisionalSession,
  type ActiveOptimizeSession,
  type ProvisionalOptimizeSession,
  type SessionCodec,
  type SessionTransactionStorage,
} from "./session-transaction";

const KEY = OPTIMIZE_SESSION_STORAGE_KEY;

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
  raw(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  seed(value: string): void {
    this.store.set(KEY, value);
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
  });
}
function plainProvisional(ownerId = "owner-P"): ProvisionalOptimizeSession {
  return buildProvisionalSession({
    ownerId,
    anonymized: false,
    peopleCount: 2,
    reverseMap: [],
    runOptions: {},
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
    partial.onSet = (_k, _v, store) => store.set(KEY, "trunc");
    expect(stageProvisionalSession(partial, anonymizedProvisional())).toEqual({
      status: "blocked",
      reason: "session-conflict",
    });
  });

  it("classifies the actual foreign active slot after an anonymized write mismatch", () => {
    const storage = new FakeStorage();
    storage.onSet = (_key, _value, store) => {
      store.set(KEY, validActiveJson("job-B", "owner-B"));
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

  it("NON-DESTRUCTIVE: any existing valid record blocks with session-conflict and is preserved (zero set/remove)", () => {
    // A pre-existing record — of EITHER variant — is never cleared by a new stage.
    for (const existing of [
      validActiveJson("job-EXISTING", "owner-OTHER"),
      JSON.stringify(anonymizedProvisional("owner-OTHER")),
    ]) {
      for (const incoming of [anonymizedProvisional("owner-NEW"), plainProvisional("owner-NEW")]) {
        const storage = new FakeStorage();
        storage.seed(existing);
        expect(stageProvisionalSession(storage, incoming)).toMatchObject({
          status: "blocked",
          reason: "session-conflict",
        });
        // The other run's record is byte-for-byte preserved; nothing was written.
        expect(storage.raw(KEY)).toBe(existing);
        expect(storage.setCalls).toBe(0);
        expect(storage.removeCalls).toBe(0);
      }
    }
  });

  it("NON-DESTRUCTIVE: unreadable existing bytes block with conflict and are preserved (never deleted)", () => {
    const storage = new FakeStorage();
    storage.seed("{corrupt-other-tab");
    expect(stageProvisionalSession(storage, anonymizedProvisional("owner-NEW"))).toMatchObject({
      status: "blocked",
      reason: "session-conflict",
    });
    expect(storage.raw(KEY)).toBe("{corrupt-other-tab");
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
      }),
      buildProvisionalSession({
        ownerId: "o",
        anonymized: true,
        peopleCount: -1,
        reverseMap: [],
        runOptions: {},
      }),
      buildProvisionalSession({
        ownerId: "o",
        anonymized: true,
        peopleCount: 2,
        reverseMap: [], // anonymized but empty map ⇒ inconsistent
        runOptions: {},
      }),
      buildProvisionalSession({
        ownerId: "o",
        anonymized: true,
        peopleCount: 2,
        reverseMap: REVERSE_MAP,
        runOptions: { timeout: 999_999 }, // out of bounds
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

  it("does NOT overwrite a foreign owner's record (owner conflict)", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional("owner-A");
    storage.seed(validActiveJson("job-B", "owner-B")); // a different run owns the key
    const outcome = activateSession(storage, provisional, "job-A");

    expect(outcome.status).toBe("activation-unverified");
    if (outcome.status !== "activation-unverified") return;
    expect(outcome.reason).toBe("owner-conflict");
    // The foreign record is untouched.
    expect(JSON.parse(storage.raw(KEY)!)).toMatchObject({ ownerId: "owner-B", jobId: "job-B" });
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
      reloadRecoveryUnavailable: true,
    });
    expect(JSON.parse(storage.raw(KEY)!).phase).toBe("provisional");
  });

  it("write-then-throw where the active bytes LAND is classified activated (reload resumable)", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional();
    stageProvisionalSession(storage, provisional);

    storage.onSet = (_k, value, store) => {
      store.set(KEY, value);
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

  it("missing after write + unverifiable restore is storage-unknown, never a false resume", () => {
    const storage = new FakeStorage();
    const provisional = anonymizedProvisional();
    stageProvisionalSession(storage, provisional);

    // Every write wipes the key and throws → active gone AND restore cannot land.
    storage.onSet = (_k, _v, store) => {
      store.delete(KEY);
      quotaError();
    };
    const outcome = activateSession(storage, provisional, "job-123");
    expect(outcome.status).toBe("activation-unverified");
    if (outcome.status !== "activation-unverified") return;
    expect(outcome.reason).toBe("storage-unknown");
    storage.onSet = null;
    expect(inspectPersistedSession(storage).kind).toBe("none");
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

  // --- interleaved A/B ownership -----------------------------------------
  it.each([
    ["anonymized", anonymizedProvisional("owner-B")],
    ["plain", plainProvisional("owner-B")],
  ])(
    "A (anonymized, acceptance-unknown) map cannot be erased by a %s B staging mid-flight",
    async (_label, recB) => {
      const storage = new FakeStorage();
      const errA = new Error("A read timeout after send");
      let bStage: ReturnType<typeof stageProvisionalSession> | undefined;
      let setDuringB = 0;
      let removeDuringB = 0;
      const outA = await runSubmissionTransaction(anonymizedProvisional("owner-A"), {
        storage,
        submit: async () => {
          // B tries to start while A is in flight: A already owns the slot, so B
          // must see a conflict and touch storage zero times.
          const setBefore = storage.setCalls;
          const removeBefore = storage.removeCalls;
          bStage = stageProvisionalSession(storage, recB);
          setDuringB = storage.setCalls - setBefore;
          removeDuringB = storage.removeCalls - removeBefore;
          return { status: "acceptance-unknown", error: errA };
        },
      });

      expect(bStage).toMatchObject({ status: "blocked", reason: "session-conflict" });
      expect(setDuringB).toBe(0);
      expect(removeDuringB).toBe(0);
      // A is ambiguous: its map is retained and it still owns the slot.
      expect(outA).toEqual({ status: "acceptance-unknown", error: errA });
      const stored = inspectPersistedSession(storage);
      expect(stored.kind).toBe("interrupted");
      if (stored.kind === "interrupted") {
        expect(stored.record.ownerId).toBe("owner-A");
        expect(stored.record.reverseMap).toEqual(REVERSE_MAP);
      }
    },
  );

  it("plain unstaged A + B staged into the empty slot: A's rejection reports conflict and preserves B", async () => {
    const storage = new FakeStorage();
    const recB = anonymizedProvisional("owner-B");
    const errA = new Error("A rejected");
    // Plain A's provisional write fails, so A proceeds WITHOUT durable staging and
    // legitimately leaves the slot empty — B can then stage into it.
    storage.onSet = quotaError;
    const outA = await runSubmissionTransaction(plainProvisional("owner-A"), {
      storage,
      submit: async () => {
        storage.onSet = null; // let B's write succeed into the empty slot
        expect(stageProvisionalSession(storage, recB).status).toBe("staged");
        return { status: "definitely-rejected", error: errA };
      },
    });
    // A must NOT report a clean `absent` — B owns the slot now.
    expect(outA).toMatchObject({
      status: "submit-rejected",
      error: errA,
      rollback: "owner-or-variant-conflict",
    });
    expect(JSON.parse(storage.raw(KEY)!)).toMatchObject({ ownerId: "owner-B" });
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

  it("a pre-existing session blocks a new submission before POST (explicit discard required)", async () => {
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
    expect(outcome).toMatchObject({ status: "blocked-before-post", reason: "session-conflict" });
    expect(submitted).toBe(false);
    // The existing session A is untouched and still resumable.
    expect(inspectPersistedSession(storage)).toMatchObject({ kind: "resumable" });
    expect(storage.setCalls).toBe(0);
    expect(storage.removeCalls).toBe(0);
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
    expect(inspectPersistedSession(corrupt)).toHaveProperty("identity");

    const future = new FakeStorage();
    future.seed(JSON.stringify({ ...JSON.parse(validActiveJson()), schemaVersion: 999 }));
    expect(inspectPersistedSession(future)).toMatchObject({ kind: "unreadable" });

    const throwing = new FakeStorage();
    throwing.onGet = securityError;
    expect(inspectPersistedSession(throwing)).toEqual({ kind: "unreadable", identity: null });
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

describe("forgetInspectedSession — confirmed unchanged-record removal", () => {
  it.each([
    ["provisional", JSON.stringify(anonymizedProvisional())],
    ["active", validActiveJson("job-forget")],
    ["corrupt", "{broken"],
    ["future", JSON.stringify({ ...JSON.parse(validActiveJson()), schemaVersion: 999 })],
  ])("removes an unchanged %s record and verifies absence", (_label, raw) => {
    const storage = new FakeStorage();
    storage.seed(raw);
    const inspected = inspectPersistedSession(storage);
    expect(inspected.kind).not.toBe("none");
    if (inspected.kind === "none" || inspected.identity === null)
      throw new Error("identity missing");

    expect(forgetInspectedSession(storage, inspected.identity)).toEqual({ status: "removed" });
    expect(storage.raw(KEY)).toBeNull();
  });

  it("preserves a record that changed after inspection", () => {
    const storage = new FakeStorage();
    storage.seed(validActiveJson("job-A"));
    const inspected = inspectPersistedSession(storage);
    if (inspected.kind !== "resumable") throw new Error("expected resumable");

    storage.seed(validActiveJson("job-B"));
    expect(forgetInspectedSession(storage, inspected.identity)).toEqual({ status: "changed" });
    expect(storage.raw(KEY)).toContain("job-B");
  });

  it("returns unverified when removal throws or is a no-op", () => {
    for (const mode of ["throw", "no-op"] as const) {
      const storage = new FakeStorage();
      storage.seed("{broken");
      const inspected = inspectPersistedSession(storage);
      if (inspected.kind !== "unreadable" || inspected.identity === null) {
        throw new Error("expected unreadable identity");
      }
      storage.onRemove = mode === "throw" ? securityError : () => {};
      expect(forgetInspectedSession(storage, inspected.identity)).toEqual({
        status: "unverified",
      });
      expect(storage.raw(KEY)).toBe("{broken");
    }
  });

  it("treats an already absent inspected record as removed", () => {
    const storage = new FakeStorage();
    storage.seed("{broken");
    const inspected = inspectPersistedSession(storage);
    if (inspected.kind !== "unreadable" || inspected.identity === null) {
      throw new Error("expected unreadable identity");
    }
    storage.removeItem(KEY);
    expect(forgetInspectedSession(storage, inspected.identity)).toEqual({ status: "removed" });
  });

  it("exports the unknown-backend retention warning", () => {
    expect(FORGET_OPTIMIZE_SESSION_WARNING).toContain(
      "unknown backend optimization may continue until terminal state or server retention",
    );
  });
});
