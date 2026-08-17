// Recovery may terminalize only the exact operation it observed.
//
// THE DEFECT THIS FIXES. Recovery read a pending row, did work that could fail, and on
// failure wrote a terminal record with an unconditional `put`. Between the read and the
// write, another tab could complete that operation, a newer invocation could write its
// own terminal row at the same key, or the row could be consumed outright -- and the
// stale snapshot would overwrite or resurrect any of them. The write also rebuilt
// fields that were sitting on disk intact: the request id became the operation id, the
// captured set became generation zero, the start time became "now".
//
// Every case here is an interleaving, because that is the only thing the defect was
// about: the single-threaded path was always fine.

import { beforeEach, describe, expect, it } from "vitest";

import {
  beginClear,
  clearOutcomes,
  finishClear,
  persistClearFacts,
  readClearCandidates,
  exactClearRowEqualityForTest as isExactSameRow,
  readClearOutcome,
  terminalizeRecoveryFailure,
  type ClearCandidate,
} from "./clear-repo";

import { createAssistantHarness, type AssistantHarness } from "./test-support";

const TARGET = "scenario-target";

let harness: AssistantHarness;

/** A real pending operation, plus the exact candidate recovery would have observed. */
async function pendingWithCandidate(input: {
  operationId: string;
  requestId: string;
}): Promise<ClearCandidate> {
  await beginClear("history", TARGET, { db: harness.db, ...input });
  const candidates = await readClearCandidates({ db: harness.db });
  const candidate = candidates.find((entry) => entry.operationId === input.operationId);
  expect(candidate).toBeDefined();
  return candidate!;
}

beforeEach(async () => {
  harness = createAssistantHarness();
});

describe("the compare-and-swap barrier", () => {
  it("terminalizes the row it observed, preserving every original field", async () => {
    const candidate = await pendingWithCandidate({
      operationId: "op-cas-0001",
      requestId: "request-cas-0001",
    });
    const before = structuredClone(await harness.db.assistantClearOperations.get("op-cas-0001"));

    expect(await terminalizeRecoveryFailure(candidate, { db: harness.db })).toBe("terminalized");

    const after = await harness.db.assistantClearOperations.get("op-cas-0001");
    // ONLY THE STATE TRANSITION FIELDS MOVED. Identity, capture, commitment and start
    // are the row's own, not rebuilt from a reduced summary.
    expect(after).toMatchObject({
      operationId: before!.operationId,
      requestId: before!.requestId,
      scope: before!.scope,
      scenarioId: before!.scenarioId,
      captured: before!.captured,
      commitment: before!.commitment,
      startedAt: before!.startedAt,
      configurationOutcome: before!.configurationOutcome,
      outcome: "failed",
      reason: "storage",
    });
    expect(after!.requestId).toBe("request-cas-0001");
    expect(after!.requestId).not.toBe(after!.operationId);
  });

  it("is a no-op when a newer terminal row landed at the same key (ABA)", async () => {
    const candidate = await pendingWithCandidate({
      operationId: "op-aba",
      requestId: "request-original",
    });

    // A NEWER INVOCATION COMPLETES FIRST, writing its own terminal facts at this key.
    await persistClearFacts(
      {
        requestId: "request-newer",
        operationId: "op-aba",
        scope: "history",
        scenarioId: TARGET,
        status: "incomplete",
        reason: "superseded",
        settlement: "stopped",
        deletionOutcome: "superseded",
        configurationOutcome: "retained",
      },
      { db: harness.db },
    );
    const newer = structuredClone(await harness.db.assistantClearOperations.get("op-aba"));

    // The stale recovery report finally lands.
    expect(await terminalizeRecoveryFailure(candidate, { db: harness.db })).toBe("no_op");

    // BYTE FOR BYTE. The newer row is what the user is looking at, and a failure that
    // happened before it must not rewrite it.
    expect(await harness.db.assistantClearOperations.get("op-aba")).toEqual(newer);
    expect(await readClearOutcome({ db: harness.db })).toMatchObject({
      requestId: "request-newer",
      status: "incomplete",
    });
  });

  it("resurrects nothing after the operation was consumed", async () => {
    const candidate = await pendingWithCandidate({
      operationId: "op-consumed",
      requestId: "request-consumed",
    });
    // The clear finishes normally, which consumes the row.
    const fence = {
      scope: "history" as const,
      scenarioId: TARGET,
      operationId: "op-consumed",
      captured: [...candidate.captured],
      threadIds: [],
      configurationDeleted: false,
    };
    expect((await finishClear(fence, { db: harness.db })).outcome).toBe("deleted");
    expect(await harness.db.assistantClearOperations.get("op-consumed")).toBeUndefined();

    expect(await terminalizeRecoveryFailure(candidate, { db: harness.db })).toBe("no_op");

    // Still gone. A completed operation is not something a later failure may revive.
    expect(await harness.db.assistantClearOperations.get("op-consumed")).toBeUndefined();
    expect(await readClearOutcome({ db: harness.db })).toBeNull();
  });

  it("is a no-op when the row was deleted outright", async () => {
    const candidate = await pendingWithCandidate({
      operationId: "op-deleted",
      requestId: "request-deleted",
    });
    await harness.db.assistantClearOperations.delete("op-deleted");

    expect(await terminalizeRecoveryFailure(candidate, { db: harness.db })).toBe("no_op");
    expect(await harness.db.assistantClearOperations.get("op-deleted")).toBeUndefined();
  });

  it("is a no-op when the row changed under the same key", async () => {
    const candidate = await pendingWithCandidate({
      operationId: "op-changed",
      requestId: "request-changed",
    });
    // A different pending operation now occupies the key: same id, different start.
    const current = await harness.db.assistantClearOperations.get("op-changed");
    await harness.db.assistantClearOperations.put({
      ...current!,
      startedAt: "2030-01-01T00:00:00.000Z",
    });
    const replaced = structuredClone(await harness.db.assistantClearOperations.get("op-changed"));

    expect(await terminalizeRecoveryFailure(candidate, { db: harness.db })).toBe("no_op");
    expect(await harness.db.assistantClearOperations.get("op-changed")).toEqual(replaced);
  });

  it("is a no-op when the observed row is a legacy shape that changed version", async () => {
    const candidate = await pendingWithCandidate({
      operationId: "op-version",
      requestId: "request-version",
    });
    // Same facts, older declared version: a different record shape at the same key.
    const current = await harness.db.assistantClearOperations.get("op-version");
    const { configurationOutcome: _dropped, ...asV4 } = current!;
    await harness.db.assistantClearOperations.put({ ...asV4, version: 4 } as never);
    const replaced = structuredClone(await harness.db.assistantClearOperations.get("op-version"));

    expect(await terminalizeRecoveryFailure(candidate, { db: harness.db })).toBe("no_op");
    expect(await harness.db.assistantClearOperations.get("op-version")).toEqual(replaced);
  });

  /**
   * ONE STORED DETAIL CHANGES, and the row still parses. These are the cases semantic
   * equivalence could not see: a reordered array normalizes to the same set, a
   * recomputed commitment matches, and a rebuilt candidate compares equal to itself.
   */
  const EXACT_ROW_MUTATIONS: [string, (row: Record<string, unknown>) => unknown][] = [
    [
      "captured bytes",
      (row) => ({
        ...row,
        captured: (row.captured as { scopeKey: string; generation: number }[]).map((entry) => ({
          ...entry,
          generation: entry.generation + 1,
        })),
      }),
    ],
    ["the commitment", (row) => ({ ...row, commitment: { count: 99, canonical: "[]" } })],
    ["the request id", (row) => ({ ...row, requestId: "request-someone-else" })],
    ["the start time", (row) => ({ ...row, startedAt: "2030-01-01T00:00:00.000Z" })],
    ["the configuration fact", (row) => ({ ...row, configurationOutcome: "unknown" })],
    ["the version", (row) => ({ ...row, version: 4 })],
    ["an extra key", (row) => ({ ...row, unexpected: true })],
    [
      "a missing key",
      (row) => {
        const { settlement: _dropped, ...rest } = row;
        return rest;
      },
    ],
    ["the outcome value", (row) => ({ ...row, outcome: "failed" })],
    [
      "the outcome key's presence",
      (row) => {
        const { outcome: _dropped, ...rest } = row;
        return rest;
      },
    ],
  ];

  it.each(EXACT_ROW_MUTATIONS)("is a no-op when %s changed", async (_label, mutate) => {
    const candidate = await pendingWithCandidate({
      operationId: "op-exact",
      requestId: "request-exact",
    });
    const stored = await harness.db.assistantClearOperations.get("op-exact");
    await harness.db.assistantClearOperations.put(
      mutate(stored as unknown as Record<string, unknown>) as never,
    );
    const replacement = structuredClone(await harness.db.assistantClearOperations.get("op-exact"));

    expect(await terminalizeRecoveryFailure(candidate, { db: harness.db })).toBe("no_op");

    // BYTE FOR BYTE: the replacement is what is on disk, and nothing was written.
    expect(await harness.db.assistantClearOperations.get("op-exact")).toEqual(replacement);
  });

  it("is a no-op when only the captured ORDER changed", async () => {
    // A GLOBAL clear, because it is the only scope that captures more than one entry --
    // and order can only differ where there is more than one thing to order. This is
    // precisely the case the semantic comparison could not see: `normalizeCaptured`
    // sorts, so both orders produce the same commitment and the same parsed set.
    const at = new Date().toISOString();
    for (const scopeKey of ["scenario:a", "scenario:b"]) {
      await harness.db.assistantGenerations.put({
        scopeKey,
        generation: 0,
        clearedAt: null,
        createdAt: at,
      } as never);
    }
    await beginClear("all", null, {
      db: harness.db,
      operationId: "op-order",
      requestId: "request-order",
    });
    const candidate = (await readClearCandidates({ db: harness.db })).find(
      (entry) => entry.operationId === "op-order",
    )!;
    expect(candidate.raw.captured.length).toBeGreaterThan(1);

    const stored = await harness.db.assistantClearOperations.get("op-order");
    await harness.db.assistantClearOperations.put({
      ...stored!,
      captured: [...stored!.captured].reverse(),
    });
    const replacement = structuredClone(await harness.db.assistantClearOperations.get("op-order"));

    expect(await terminalizeRecoveryFailure(candidate, { db: harness.db })).toBe("no_op");
    expect(await harness.db.assistantClearOperations.get("op-order")).toEqual(replacement);
  });

  it("never terminalizes one version-2 layout from the other, in either direction", async () => {
    // VERSION 2 HAS TWO HISTORICAL LAYOUTS under one discriminator: the shipped
    // pre-outcome row, which IS deletion authority, and the later row carrying
    // `outcome: "pending"`, which is not. `version: 2` alone cannot tell them apart, so
    // a comparison that recorded only the version accepted each as the other -- and in
    // one direction that replaces live deletion authority with a failure tombstone and
    // strands the fenced content.
    const captured = [{ scopeKey: `scenario:${TARGET}`, generation: 1 }];
    const shared = {
      operationId: "op-layout",
      version: 2 as const,
      scope: "history" as const,
      scenarioId: TARGET,
      captured,
      commitment: {
        count: 1,
        canonical: JSON.stringify([[`scenario:${TARGET}`, 1]]),
      },
      startedAt: "2026-08-01T00:00:00.000Z",
    };
    const authorityLayout = { ...shared };
    const strandedLayout = { ...shared, outcome: "pending" as const };
    const at = new Date().toISOString();
    await harness.db.assistantGenerations.put({
      scopeKey: `scenario:${TARGET}`,
      generation: 1,
      clearedAt: at,
      createdAt: at,
    } as never);

    // A → B: observe the authority layout, find the stranded one in its place.
    await harness.db.assistantClearOperations.put(authorityLayout as never);
    const fromAuthority = (await readClearCandidates({ db: harness.db })).find(
      (entry) => entry.operationId === "op-layout",
    )!;
    expect("outcome" in fromAuthority.raw).toBe(false);
    await harness.db.assistantClearOperations.put(strandedLayout as never);
    expect(await terminalizeRecoveryFailure(fromAuthority, { db: harness.db })).toBe("no_op");
    expect(await harness.db.assistantClearOperations.get("op-layout")).toEqual(strandedLayout);

    // B → A: and the reverse, which is the one that would destroy live authority.
    const fromStranded = (await readClearCandidates({ db: harness.db })).find(
      (entry) => entry.operationId === "op-layout",
    )!;
    expect(fromStranded.raw.outcome).toBe("pending");
    await harness.db.assistantClearOperations.put(authorityLayout as never);
    expect(await terminalizeRecoveryFailure(fromStranded, { db: harness.db })).toBe("no_op");
    expect(await harness.db.assistantClearOperations.get("op-layout")).toEqual(authorityLayout);
  });

  it("reports a transaction failure distinctly from an ABA no-op", async () => {
    const candidate = await pendingWithCandidate({
      operationId: "op-txn",
      requestId: "request-txn",
    });
    const before = structuredClone(await harness.db.assistantClearOperations.get("op-txn"));

    // Storage itself does not answer. That is a different fact from "the row moved on",
    // and the caller is entitled to surface it as a bounded storage state -- which it
    // must never do for an ordinary no-op.
    const broken = {
      transaction: () => Promise.reject(new Error("storage went away")),
    } as unknown as typeof harness.db;
    expect(await terminalizeRecoveryFailure(candidate, { db: broken })).toBe("transaction_failed");

    // And it wrote nothing from the stale candidate.
    expect(await harness.db.assistantClearOperations.get("op-txn")).toEqual(before);
  });

  it("holds its snapshot immutable, so a later mutation cannot change what CAS sees", async () => {
    const candidate = await pendingWithCandidate({
      operationId: "op-frozen",
      requestId: "request-frozen",
    });

    // THE SNAPSHOT IS THE THING THE COMPARISON IS AGAINST. `terminalizeRecoveryFailure`
    // is exported and takes this object from callers this module does not control, so a
    // writable snapshot would let one of them redefine "unchanged" after the fact.
    expect(Object.isFrozen(candidate.raw)).toBe(true);
    expect(Object.isFrozen(candidate.raw.captured)).toBe(true);
    expect(Object.isFrozen(candidate.raw.commitment)).toBe(true);
    expect(Object.isFrozen(candidate.raw.captured[0])).toBe(true);

    // A mutation attempt in strict mode throws; either way nothing changes.
    const mutable = candidate.raw as unknown as { startedAt: string };
    expect(() => {
      mutable.startedAt = "2030-01-01T00:00:00.000Z";
    }).toThrow();
    expect(candidate.raw.startedAt).not.toBe("2030-01-01T00:00:00.000Z");

    // And the row on disk still terminalizes, because the snapshot is intact.
    expect(await terminalizeRecoveryFailure(candidate, { db: harness.db })).toBe("terminalized");
  });

  it("freezes the WHOLE candidate, including its synthesized legacy facts", async () => {
    // A version-2 global row: the layout that carries neither a request id nor a
    // configuration fact, so both are synthesized here. Those two derived fields were
    // writable while `raw` was frozen, and terminalization used them -- so a caller
    // could inject facts into a durable record whose raw bytes it never touched.
    const captured = [{ scopeKey: "global", generation: 1 }];
    const at = new Date().toISOString();
    await harness.db.assistantGenerations.put({
      scopeKey: "global",
      generation: 1,
      clearedAt: at,
      createdAt: at,
    } as never);
    await harness.db.assistantClearOperations.put({
      operationId: "op-legacy-global",
      version: 2,
      scope: "all",
      scenarioId: null,
      captured,
      commitment: { count: 1, canonical: JSON.stringify([["global", 1]]) },
      startedAt: at,
    } as never);

    const candidate = (await readClearCandidates({ db: harness.db })).find(
      (entry) => entry.operationId === "op-legacy-global",
    )!;
    // Synthesized, because the version-2 layout has neither.
    expect(candidate.requestId).toBe("op-legacy-global");
    expect(candidate.configurationOutcome).toBe("deleted");

    expect(Object.isFrozen(candidate)).toBe(true);
    const mutable = candidate as unknown as {
      requestId: string;
      configurationOutcome: string;
    };
    expect(() => {
      mutable.requestId = "request-injected";
    }).toThrow();
    expect(() => {
      mutable.configurationOutcome = "retained";
    }).toThrow();

    // And the durable record is built from the in-transaction re-read regardless, so
    // the honest facts land even if a caller found a way to rewrite the argument.
    expect(await terminalizeRecoveryFailure(candidate, { db: harness.db })).toBe("terminalized");
    expect(await harness.db.assistantClearOperations.get("op-legacy-global")).toMatchObject({
      requestId: "op-legacy-global",
      configurationOutcome: "deleted",
      outcome: "failed",
    });
  });

  it("ignores tampered derived fields even from an unfrozen candidate", async () => {
    // THE FREEZE IS NOT THE ONLY DEFENCE, and it should not be: `terminalizeRecoveryFailure`
    // is exported, so a caller can always hand it a plain object of the right shape. The
    // record is therefore built from the row this transaction just re-read and
    // re-validated, never from the argument's synthesized fields.
    const captured = [{ scopeKey: "global", generation: 1 }];
    const at = new Date().toISOString();
    await harness.db.assistantGenerations.put({
      scopeKey: "global",
      generation: 1,
      clearedAt: at,
      createdAt: at,
    } as never);
    await harness.db.assistantClearOperations.put({
      operationId: "op-tampered",
      version: 2,
      scope: "all",
      scenarioId: null,
      captured,
      commitment: { count: 1, canonical: JSON.stringify([["global", 1]]) },
      startedAt: at,
    } as never);
    const genuine = (await readClearCandidates({ db: harness.db })).find(
      (entry) => entry.operationId === "op-tampered",
    )!;

    // A thawed copy with the same raw bytes and dishonest derived facts.
    const tampered = {
      ...genuine,
      requestId: "request-injected",
      configurationOutcome: "retained",
    } as unknown as typeof genuine;

    expect(await terminalizeRecoveryFailure(tampered, { db: harness.db })).toBe("terminalized");

    // THE DURABLE RECORD CARRIES THE HONEST FACTS. A global begin deleted the settings
    // row, so `retained` would be a lie about what happened.
    expect(await harness.db.assistantClearOperations.get("op-tampered")).toMatchObject({
      requestId: "op-tampered",
      configurationOutcome: "deleted",
      outcome: "failed",
    });
  });

  it("pins the comparator's own value domain", () => {
    // TESTED DIRECTLY, because the strict parser guards every path that reaches it: a
    // stored row carrying a Date is refused before terminalization ever compares it, so
    // this behaviour cannot be observed in situ. Left unpinned it would be free to rot
    // into a hazard the day an accepted layout does carry one.
    expect(isExactSameRow(new Date(0), new Date(1))).toBe(false);
    expect(isExactSameRow(new Date(5), new Date(5))).toBe(true);
    expect(isExactSameRow(new Date(0), "1970-01-01T00:00:00.000Z")).toBe(false);
    // Structured clone carries these too, and each walks as an empty object.
    expect(isExactSameRow(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
    expect(isExactSameRow(new Set([1]), new Set([2]))).toBe(false);
    expect(isExactSameRow(/one/, /two/)).toBe(false);
    // The accepted domain still compares exactly, including array order and key set.
    expect(isExactSameRow({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(isExactSameRow({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(isExactSameRow({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });

  it("treats two different Dates, and any unsupported durable type, as not identical", async () => {
    // A DATE HAS NO ENUMERABLE KEYS. A generic key-walk therefore compares two different
    // instants as equal -- an "exact" comparator quietly agreeing that different values
    // are the same. Structured clone can also carry Map, Set and RegExp, each of which
    // walks as an indistinguishable empty object.
    //
    // No accepted row layout carries these today, which is why this is pinned through a
    // real terminalization rather than asserted on a helper: the contract under test is
    // "a value the comparator cannot reason about never authorizes a write".
    const candidate = await pendingWithCandidate({
      operationId: "op-domain",
      requestId: "request-domain",
    });
    const stored = await harness.db.assistantClearOperations.get("op-domain");

    for (const exotic of [new Date(1), new Map([["a", 1]]), new Set([1]), /pattern/] as unknown[]) {
      // The snapshot claims a value of an unsupported type; the row on disk has the
      // ordinary one. Neither direction may be treated as identical.
      const spoofed = {
        ...candidate,
        raw: { ...structuredClone(stored!), startedAt: exotic as unknown as string },
      };
      expect(await terminalizeRecoveryFailure(spoofed, { db: harness.db })).toBe("no_op");
    }

    // Two different Dates specifically, on both sides.
    await harness.db.assistantClearOperations.put({
      ...stored!,
      startedAt: new Date(1) as unknown as string,
    });
    const withDate = {
      ...candidate,
      raw: { ...structuredClone(stored!), startedAt: new Date(0) as unknown as string },
    };
    expect(await terminalizeRecoveryFailure(withDate, { db: harness.db })).toBe("no_op");
  });

  it("does not retire a row it refused to terminalize", async () => {
    const candidate = await pendingWithCandidate({
      operationId: "op-survivor",
      requestId: "request-survivor",
    });
    await harness.db.assistantClearOperations.put({
      ...(await harness.db.assistantClearOperations.get("op-survivor"))!,
      startedAt: "2030-01-01T00:00:00.000Z",
    });

    await terminalizeRecoveryFailure(candidate, { db: harness.db });
    await clearOutcomes("history", TARGET, {
      db: harness.db,
      predecessorOperationIds: ["op-survivor"],
    });

    expect(await harness.db.assistantClearOperations.get("op-survivor")).toBeDefined();
  });
});
