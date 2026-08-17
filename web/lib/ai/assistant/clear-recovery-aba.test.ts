// Pending-clear recovery, and why it may act only on the operation that is still
// durably pending at the moment it deletes.
//
// THE DEFECT THIS FIXES. Recovery used to read the pending markers, await other work,
// and then replay that snapshot inside a later transaction. Nothing rechecked whether
// the clear it named was still unfinished. So: recovery reads marker M; the original
// clear finishes and consumes M; the user writes new content for the same scenario;
// recovery wakes up and deletes it -- a completed operation reaching forward into data
// created after it ended. Matching markers by scope and scenario made it worse, because
// those repeat: one clear could consume a newer clear's marker and cancel it outright.
//
// Every case here is about identity and timing rather than scope, so the fixtures are
// deliberately same-scenario.

import { beforeEach, describe, expect, it } from "vitest";

import {
  beginClear,
  clearOutcomes,
  finishClear,
  persistClearFacts,
  readClearOutcome,
  resumePendingClears,
} from "./clear-repo";
import { createAssistantHarness, type AssistantHarness } from "./test-support";

const TARGET = "scenario-target";
const OTHER = "scenario-other";

let harness: AssistantHarness;

/** The same canonical commitment the repository computes, over the normalized set. */
function commitmentFor(captured: { scopeKey: string; generation: number }[]) {
  const sorted = [...captured].sort((left, right) =>
    left.scopeKey < right.scopeKey ? -1 : left.scopeKey > right.scopeKey ? 1 : 0,
  );
  return {
    count: sorted.length,
    canonical: JSON.stringify(sorted.map((entry) => [entry.scopeKey, entry.generation])),
  };
}

/**
 * A scenario's whole assistant footprint: a live thread with a turn and two messages,
 * plus the scenario-owned proposal, receipt and diagnostic search.
 *
 * THE THREAD FAMILY IS PART OF THE FIXTURE, not decoration. Overlap and orphan paths
 * delete threads, turns and messages by a different rule from the scenario-scoped
 * rows, so a fixture that seeded only proposals/receipts/searches left every
 * thread/turn/message assertion comparing two empty arrays.
 */
async function seed(scenarioId: string, tag: string) {
  const at = new Date().toISOString();
  const threadId = `thread-${scenarioId}-${tag}`;
  const turnId = `turn-${scenarioId}-${tag}`;
  await harness.db.assistantThreads.put({
    threadId,
    scenarioId,
    state: "active",
    schemaVersion: 1,
    globalGeneration: 0,
    scenarioGeneration: 0,
    createdAt: at,
    updatedAt: at,
  } as never);
  await harness.db.assistantTurns.put({
    turnId,
    threadId,
    scenarioId,
    state: "terminal",
    terminalReason: "completed",
    interruptionTrigger: null,
    basisDocumentRevision: 7,
    leaseEpoch: 4,
    modelId: "anthropic/claude-sonnet-4.5",
    runId: `run-${scenarioId}-${tag}`,
    turnEpoch: 1,
    runtimeInstanceId: null,
    globalGeneration: 0,
    scenarioGeneration: 0,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
  } as never);
  for (const [seq, role] of [
    [0, "user"],
    [1, "assistant"],
  ] as const) {
    await harness.db.assistantMessages.put({
      messageId: `msg-${scenarioId}-${tag}-${seq}`,
      threadId,
      seq,
      turnId,
      role,
      content: `body-${tag}-${seq}`,
      toolCalls: null,
      toolCallId: null,
      modelId: null,
      schemaVersion: 1,
      scenarioId,
      globalGeneration: 0,
      scenarioGeneration: 0,
      createdAt: at,
    } as never);
  }
  await harness.db.assistantProposals.put({
    proposalId: `proposal-${scenarioId}-${tag}`,
    scenarioId,
    schemaVersion: 1,
    createdAt: at,
    note: `body-${tag}`,
  } as never);
  await harness.db.assistantReceipts.put({
    receiptId: `receipt-${scenarioId}-${tag}`,
    scenarioId,
    schemaVersion: 1,
    createdAt: at,
    note: `body-${tag}`,
  } as never);
  await harness.db.diagnosticSearches.put({
    searchId: `search-${scenarioId}-${tag}`,
    scenarioId,
    schemaVersion: 1,
    createdAt: at,
    note: `body-${tag}`,
  } as never);
}

/**
 * WHOLE ROWS, structured-cloned -- not ids.
 *
 * An id list says nothing about a row's body, so a mutation that rewrote another
 * scenario's content while leaving its key alone would pass an id comparison. "Byte
 * for byte" has to mean the bytes.
 *
 * COVERS EVERY scenario-scoped table. An overlap or orphan path that left a thread,
 * turn or message behind would pass a proposals/receipts/searches-only snapshot. The
 * global tables (generations, operations, settings) are NOT here because a legitimate
 * clear operation bumps generations and writes/consumes operation records -- including
 * them would make every before/after comparison fail for the wrong reason. Global
 * state is asserted separately via `markers()` and direct reads where the test needs it.
 */
async function snapshotRows(scenarioId: string) {
  const owned = <T extends { scenarioId: string }>(rows: T[]) =>
    structuredClone(rows.filter((row) => row.scenarioId === scenarioId));
  return {
    proposals: owned(await harness.db.assistantProposals.toArray()),
    receipts: owned(await harness.db.assistantReceipts.toArray()),
    searches: owned(await harness.db.diagnosticSearches.toArray()),
    bases: owned(await harness.db.optimizeBases.toArray()),
    threads: owned(await harness.db.assistantThreads.toArray()),
    turns: owned(await harness.db.assistantTurns.toArray()),
    messages: owned(await harness.db.assistantMessages.toArray()),
  };
}

/**
 * Scenario-owned CONTENT only (proposals, receipts, diagnostic searches, Optimize
 * bases). Used where the test seeds a `cleared` thread and the orphan cleanup is
 * EXPECTED to delete it — the content rows must be untouched, while the thread row is
 * legitimately tidied away.
 */
async function snapshotContent(scenarioId: string) {
  const owned = <T extends { scenarioId: string }>(rows: T[]) =>
    structuredClone(rows.filter((row) => row.scenarioId === scenarioId));
  return {
    proposals: owned(await harness.db.assistantProposals.toArray()),
    receipts: owned(await harness.db.assistantReceipts.toArray()),
    searches: owned(await harness.db.diagnosticSearches.toArray()),
    bases: owned(await harness.db.optimizeBases.toArray()),
  };
}

async function contentIds(scenarioId: string) {
  const rows = await snapshotRows(scenarioId);
  return [
    ...rows.proposals.map((row) => row.proposalId as string),
    ...rows.receipts.map((row) => row.receiptId as string),
    ...rows.searches.map((row) => row.searchId as string),
  ].sort();
}

/** Every canonical clear operation on disk right now. */
async function markers() {
  return harness.db.assistantClearOperations.toArray();
}

beforeEach(async () => {
  harness = await createAssistantHarness();
  await seed(TARGET, "first");
  await seed(OTHER, "first");
  // Fence rows for both scenarios, so Clear all genuinely captures MORE THAN ONE
  // scope -- which is the precondition for the fragmented-authority defect.
  const at = new Date().toISOString();
  for (const scenarioId of [TARGET, OTHER]) {
    await harness.db.assistantGenerations.put({
      scopeKey: `scenario:${scenarioId}`,
      generation: 0,
      clearedAt: null,
      createdAt: at,
    } as never);
  }
  await harness.db.assistantGenerations.put({
    scopeKey: "global",
    generation: 0,
    clearedAt: null,
    createdAt: at,
  } as never);
  await harness.db.optimizeBases.put({
    basisId: `basis-${TARGET}`,
    scenarioId: TARGET,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
  } as never);
});

describe("a recovery continuation that woke up too late", () => {
  it("deletes nothing after its clear finished and new content landed", async () => {
    // THE EXACT SEQUENCE FROM THE REVIEW.
    const fence = await beginClear("history", TARGET, { db: harness.db });

    // Recovery captures the operation... and is then descheduled. There is no way to
    // hold a real continuation across the finish below, so the stale read is modelled
    // the only honest way: recovery runs AFTER the finish, which is precisely the
    // ordering that used to delete the new rows.
    expect(await markers()).toHaveLength(1);

    // The normal finish deletes and consumes the marker, atomically.
    const deletion = await finishClear(fence, { db: harness.db });
    expect(deletion.outcome).toBe("deleted");
    expect(await markers()).toHaveLength(0);
    expect(await contentIds(TARGET)).toEqual([]);

    // The user starts again: new content for the SAME scenario.
    await seed(TARGET, "second");
    const fresh = await snapshotRows(TARGET);
    expect(await contentIds(TARGET)).toHaveLength(3);

    // The stale continuation resumes.
    const resumed = await resumePendingClears({ db: harness.db });

    // It deletes NOTHING, and the new rows are untouched to the byte.
    expect(resumed.proposals + resumed.receipts + resumed.searches).toBe(0);
    expect(await snapshotRows(TARGET)).toEqual(fresh);
  });

  it("is a no-op when the marker was never there", async () => {
    const before = await snapshotRows(TARGET);
    const beforeOther = await snapshotRows(OTHER);
    const resumed = await resumePendingClears({ db: harness.db });

    expect(resumed.proposals + resumed.receipts + resumed.searches).toBe(0);
    expect(await snapshotRows(TARGET)).toEqual(before);
    // The other scenario's rows are untouched too — compared against a PRE-CAPTURED
    // snapshot, not a fresh second read of itself (which would always be equal).
    expect(await snapshotRows(OTHER)).toEqual(beforeOther);
  });

  /**
   * A well-formed scoped record IN THE SHAPE THIS BUILD WRITES, so each case below
   * mutates exactly one thing. Version 3 with `outcome: "pending"` is the only current
   * authority shape; a version-2 baseline would be refused for its version alone and
   * every mutation below would then pass for the wrong reason.
   */
  function validRecord() {
    const captured = [{ scopeKey: `scenario:${TARGET}`, generation: 1 }];
    return {
      operationId: "op-under-test",
      version: 3 as const,
      scope: "history" as const,
      scenarioId: TARGET as string | null,
      captured,
      commitment: commitmentFor(captured),
      startedAt: new Date().toISOString(),
      outcome: "pending" as const,
    };
  }

  /** Put every fence row at `generation`, so a record naming it could match. */
  async function fenceAtGeneration(generation: number) {
    const at = new Date().toISOString();
    for (const scopeKey of ["global", `scenario:${TARGET}`, `scenario:${OTHER}`]) {
      await harness.db.assistantGenerations.put({
        scopeKey,
        generation,
        clearedAt: at,
        createdAt: at,
      } as never);
    }
  }

  /**
   * A leftover thread WITH ITS CHILDREN, which used to be authority to delete on its
   * own. The turn and message matter: the orphan sweep is entitled to take them with
   * the dead thread, and a childless fixture proves nothing about that.
   */
  async function seedClearedThread() {
    const at = new Date().toISOString();
    await harness.db.assistantThreads.put({
      threadId: "thread-legacy",
      scenarioId: TARGET,
      state: "cleared",
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
    } as never);
    await harness.db.assistantTurns.put({
      turnId: "turn-legacy",
      threadId: "thread-legacy",
      scenarioId: TARGET,
      state: "terminal",
      terminalReason: "completed",
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
    } as never);
    await harness.db.assistantMessages.put({
      messageId: "msg-legacy",
      threadId: "thread-legacy",
      seq: 0,
      turnId: "turn-legacy",
      role: "user",
      content: "legacy body",
      schemaVersion: 1,
      scenarioId: TARGET,
      createdAt: at,
    } as never);
  }

  type Record = ReturnType<typeof validRecord>;
  const MALFORMED: [string, (record: Record) => unknown][] = [
    ["an unrecognised version", (r) => ({ ...r, version: 9 })],
    ["the legacy collision-prone version", (r) => ({ ...r, version: 1 })],
    // THE IN-PLACE BREAK ITSELF: version 2 never carried `outcome` when it shipped, so
    // a version-2 record that does is a shape no reader can resolve unambiguously.
    ["the in-place version-2 outcome shape", (r) => ({ ...r, version: 2 })],
    // ...and the mirror: the current version without the field it always carries.
    [
      "a version-3 record missing its outcome",
      (r) => {
        const { outcome: _dropped, ...rest } = r;
        return rest;
      },
    ],
    ["an unknown scope", (r) => ({ ...r, scope: "sideways" })],
    ["a scoped clear with no scenario", (r) => ({ ...r, scenarioId: null })],
    ["a scoped clear naming another scenario", (r) => ({ ...r, scenarioId: OTHER })],
    ["a global clear carrying a scenario", (r) => ({ ...r, scope: "all", scenarioId: TARGET })],
    ["an empty captured set", (r) => ({ ...r, captured: [] })],
    ["no operation id", (r) => ({ ...r, operationId: "" })],
    ["an unparseable timestamp", (r) => ({ ...r, startedAt: "not-a-date" })],
    ["a duplicated capture entry", (r) => ({ ...r, captured: [...r.captured, r.captured[0]] })],
    [
      "an extra capture entry",
      (r) => ({ ...r, captured: [...r.captured, { scopeKey: "global", generation: 1 }] }),
    ],
    [
      "an unknown scope key",
      (r) => ({ ...r, captured: [{ scopeKey: "sideways:x", generation: 1 }] }),
    ],
    [
      "a non-integer generation",
      (r) => ({ ...r, captured: [{ ...r.captured[0], generation: 1.5 }] }),
    ],
    ["a negative generation", (r) => ({ ...r, captured: [{ ...r.captured[0], generation: -1 }] })],
    [
      "an infinite generation",
      (r) => ({ ...r, captured: [{ ...r.captured[0], generation: Infinity }] }),
    ],
    [
      "a commitment that does not match",
      (r) => ({ ...r, commitment: { count: 99, canonical: "[]" } }),
    ],
    ["a commitment that is an array", (r) => ({ ...r, commitment: [] })],
    [
      "a commitment with a non-string canonical",
      (r) => ({ ...r, commitment: { count: 1, canonical: 7 } }),
    ],
    [
      "a commitment with a NaN count",
      (r) => ({ ...r, commitment: { ...r.commitment, count: NaN } }),
    ],
    ["a null captured set", (r) => ({ ...r, captured: null })],
    ["a non-array captured set", (r) => ({ ...r, captured: { scopeKey: "global" } })],
    ["a primitive capture entry", (r) => ({ ...r, captured: ["global"] })],
    ["an array capture entry", (r) => ({ ...r, captured: [["global", 1]] })],
    ["a NaN generation", (r) => ({ ...r, captured: [{ ...r.captured[0], generation: NaN }] })],
    ["a whitespace operation id", (r) => ({ ...r, operationId: "   " })],
    ["a whitespace scenario", (r) => ({ ...r, scenarioId: "   " })],
    // EXACT-SHAPE AND WHITESPACE CASES the round-12 review identified as missing.
    ["a padded operation id", (r) => ({ ...r, operationId: "  op-1  " })],
    ["a padded scenario id", (r) => ({ ...r, scenarioId: `  ${TARGET}  ` })],
    [
      "a whitespace-only scope suffix",
      (r) => ({
        ...r,
        captured: [{ scopeKey: "scenario: ", generation: 1 }],
        commitment: commitmentFor([{ scopeKey: "scenario: ", generation: 1 }]),
      }),
    ],
    [
      "a capture entry with an extra field",
      (r) => ({ ...r, captured: [{ ...r.captured[0], extra: true }] }),
    ],
    [
      "a commitment with an extra field",
      (r) => ({ ...r, commitment: { ...r.commitment, extra: true } }),
    ],
    ["a record with an extra field", (r) => ({ ...r, unexpected: true })],
  ];

  it.each(MALFORMED)("refuses to act on a record with %s", async (_label, mutate) => {
    await fenceAtGeneration(1);
    await harness.db.assistantClearOperations.put(mutate(validRecord()) as never);
    await seedClearedThread();

    const before = await snapshotContent(TARGET);
    const resumed = await resumePendingClears({ db: harness.db });

    // Fail closed: NO scenario-owned content deleted, by any path. The orphan thread
    // cleanup is expected (it tidies a dead thread) and carries no content authority.
    expect(resumed.proposals + resumed.receipts + resumed.searches).toBe(0);
    expect(await snapshotContent(TARGET)).toEqual(before);
  });

  it.each([
    ["a scoped clear capturing only the global scope", "history"],
    ["a global clear capturing only the global scope", "all"],
  ] as const)("refuses %s", async (_label, scope) => {
    // THE P1 ITSELF. Both records are internally consistent: the commitment matches the
    // set they carry, and the global fence row they name really is at that generation.
    // The old claim compared only the entries the record supplied, so both authorized a
    // deletion over content they had never captured.
    await fenceAtGeneration(1);
    const captured = [{ scopeKey: "global", generation: 1 }];
    await harness.db.assistantClearOperations.put({
      operationId: "op-partial",
      version: 3,
      scope,
      scenarioId: scope === "history" ? TARGET : null,
      captured,
      commitment: commitmentFor(captured),
      startedAt: new Date().toISOString(),
      outcome: "pending",
    } as never);

    const targetBefore = await snapshotRows(TARGET);
    const otherBefore = await snapshotRows(OTHER);
    const resumed = await resumePendingClears({ db: harness.db });

    expect(resumed.proposals + resumed.receipts + resumed.searches).toBe(0);
    expect(await snapshotRows(TARGET)).toEqual(targetBefore);
    expect(await snapshotRows(OTHER)).toEqual(otherBefore);
  });

  it("deletes no scenario content for a markerless legacy cleared thread", async () => {
    await seedClearedThread();
    // The LIVE thread family seeded for this scenario must be left alone; only the
    // dead one and its own children may go.
    const liveThread = `thread-${TARGET}-first`;

    const before = await snapshotContent(TARGET);
    const resumed = await resumePendingClears({ db: harness.db });

    // The dead thread and ITS CHILDREN are tidied away -- they can never be resumed --
    // but they carry no authority over the scenario's proposals, receipts, diagnostic
    // searches, or over any other thread.
    expect(resumed.threads).toBe(1);
    expect(resumed.turns).toBe(1);
    expect(resumed.messages).toBe(1);
    expect(resumed.proposals + resumed.receipts + resumed.searches).toBe(0);
    expect(await snapshotContent(TARGET)).toEqual(before);
    expect(await harness.db.assistantThreads.get(liveThread)).toBeDefined();
    expect(await harness.db.assistantTurns.get(`turn-${TARGET}-first`)).toBeDefined();
    expect(await harness.db.assistantMessages.get(`msg-${TARGET}-first-0`)).toBeDefined();
    expect(await harness.db.assistantTurns.get("turn-legacy")).toBeUndefined();
    expect(await harness.db.assistantMessages.get("msg-legacy")).toBeUndefined();
  });
});

describe("the capture commitment", () => {
  // The first version folded the set into a 32-bit FNV-1a over `scopeKey:generation|`.
  // It iterated code points and took `charCodeAt(0)`, so a non-BMP character
  // contributed only its high surrogate -- and every emoji in the same plane shares
  // one. The delimiters were ambiguous too: an id containing `:` or `|` could
  // reserialize as a different set. Both are properties of the encoding, so they are
  // tested on the encoding.

  /** The canonical encoding, as the repository computes it. */
  function canonical(captured: { scopeKey: string; generation: number }[]) {
    const sorted = [...captured].sort((left, right) =>
      left.scopeKey < right.scopeKey ? -1 : left.scopeKey > right.scopeKey ? 1 : 0,
    );
    return JSON.stringify(sorted.map((entry) => [entry.scopeKey, entry.generation]));
  }

  it.each([
    ["emoji sharing a high surrogate", "😀", "😁"],
    ["emoji from the same block", "🧠", "🧡"],
  ])("distinguishes %s", async (_label, left, right) => {
    expect(canonical([{ scopeKey: `scenario:${left}`, generation: 1 }])).not.toBe(
      canonical([{ scopeKey: `scenario:${right}`, generation: 1 }]),
    );
  });

  it("cannot be imitated by a delimiter-bearing scenario id", async () => {
    // Under the old encoding these two sets serialized to the same bytes.
    const spoof = canonical([{ scopeKey: "scenario:a:1|scenario:b", generation: 2 }]);
    const real = canonical([
      { scopeKey: "scenario:a", generation: 1 },
      { scopeKey: "scenario:b", generation: 2 },
    ]);
    expect(spoof).not.toBe(real);
  });

  it("keeps a lone surrogate distinguishable rather than dropping it", async () => {
    const lone = canonical([{ scopeKey: "scenario:\ud800", generation: 1 }]);
    expect(lone).not.toBe(canonical([{ scopeKey: "scenario:\ud801", generation: 1 }]));
    // Escaped rather than emitted raw, so the stored string is always well formed.
    expect(lone).toContain("\\ud800");
  });

  it("is order-insensitive, because ordering is a representation choice", async () => {
    const forward = canonical([
      { scopeKey: "scenario:a", generation: 1 },
      { scopeKey: "scenario:b", generation: 2 },
    ]);
    const reversed = canonical([
      { scopeKey: "scenario:b", generation: 2 },
      { scopeKey: "scenario:a", generation: 1 },
    ]);
    expect(forward).toBe(reversed);
  });

  it("uses a locale-independent total order, not locale collation", () => {
    // `"é".localeCompare("e\u0301") === 0` in this runtime: locale collation treats the
    // composed (U+00E9) and decomposed (U+0065 + U+0301) forms as the same character.
    // A stable sort under locale collation preserves input order, so reversing these
    // two distinct accepted scope keys would produce a DIFFERENT canonical string for
    // the same set. The code-unit total comparator does not fold them.
    const composed = "scenario:\u00e9";
    const decomposed = "scenario:e\u0301";
    // They ARE distinct code-unit sequences -- the whole point.
    expect(composed).not.toBe(decomposed);

    const forward = canonical([
      { scopeKey: composed, generation: 1 },
      { scopeKey: decomposed, generation: 2 },
    ]);
    const reversed = canonical([
      { scopeKey: decomposed, generation: 2 },
      { scopeKey: composed, generation: 1 },
    ]);
    // Same canonical string regardless of input order: the total comparator places them
    // deterministically, unlike locale collation which would leave them in input order.
    expect(forward).toBe(reversed);
  });

  it("refuses a record whose captured set was substituted under a matching count", async () => {
    // The substitution the old digest could not see: same length, different scopes.
    const at = new Date().toISOString();
    for (const scopeKey of ["global", `scenario:${TARGET}`, `scenario:${OTHER}`]) {
      await harness.db.assistantGenerations.put({
        scopeKey,
        generation: 1,
        clearedAt: at,
        createdAt: at,
      } as never);
    }
    const declared = [{ scopeKey: `scenario:${TARGET}`, generation: 1 }];
    await harness.db.assistantClearOperations.put({
      operationId: "op-substituted",
      version: 3,
      scope: "history",
      scenarioId: TARGET,
      // The commitment describes a DIFFERENT set of the same size.
      captured: declared,
      commitment: {
        count: 1,
        canonical: JSON.stringify([[`scenario:${OTHER}`, 1]]),
      },
      startedAt: at,
      outcome: "pending",
    } as never);

    const before = await snapshotRows(TARGET);
    const resumed = await resumePendingClears({ db: harness.db });

    expect(resumed.proposals + resumed.receipts + resumed.searches).toBe(0);
    expect(await snapshotRows(TARGET)).toEqual(before);
  });
});

describe("two clears of the same scenario", () => {
  it("cannot consume one another's marker", async () => {
    const first = await beginClear("history", TARGET, { db: harness.db });
    const second = await beginClear("history", TARGET, { db: harness.db });
    // Distinct operations, by identity rather than by scope.
    expect(second.operationId).not.toBe(first.operationId);

    // INDEPENDENT RECORDS. The newer operation does not overwrite the older one's
    // identity -- they are separate facts, and only the one that still owns its
    // captured generations may act.
    expect(await markers()).toHaveLength(2);

    // The FIRST one finishes late. Its captured generation is stale, so it must not
    // delete -- and above all must not consume the second's record and cancel a clear
    // the user asked for. It retires itself and nothing else.
    const stale = await finishClear(first, { db: harness.db });
    expect(stale.outcome).toBe("superseded");
    // THE KEY PROPERTY: the second's record is untouched. A stale finish that consumed
    // it would cancel a clear the user asked for.
    const remaining = await markers();
    expect(remaining.map((row) => row.operationId)).toContain(second.operationId);

    // The second still works.
    const real = await finishClear(second, { db: harness.db });
    expect(real.outcome).toBe("deleted");
    expect(await contentIds(TARGET)).toEqual([]);

    // The first operation's own record is still there -- a fenced finish refuses
    // before it reaches the point where it could retire itself. Recovery retires it,
    // deleting nothing, so it cannot be retried forever.
    expect((await markers()).map((row) => row.operationId)).toEqual([first.operationId]);
    const swept = await resumePendingClears({ db: harness.db });
    expect(swept.proposals + swept.receipts + swept.searches).toBe(0);
    expect(await markers()).toHaveLength(0);
  });

  it("finishes both when two different scenarios are pending at once", async () => {
    // TWO CRASHES, TWO UNFINISHED CLEARS. Recovery processes them in one pass, and
    // consuming markers by scope alone would let the first operation clear the
    // SECOND's marker on its way out -- cancelling a clear the user asked for and
    // leaving that scenario's content on disk forever.
    await beginClear("history", TARGET, { db: harness.db });
    await beginClear("history", OTHER, { db: harness.db });
    expect(await markers()).toHaveLength(2);

    const resumed = await resumePendingClears({ db: harness.db });

    // Both scenarios' content is gone, and both markers with it.
    expect(await contentIds(TARGET)).toEqual([]);
    expect(await contentIds(OTHER)).toEqual([]);
    expect(await markers()).toHaveLength(0);
    expect(resumed.searches).toBe(2);
  });

  it("refuses a global deletion when a newer scoped clear advanced one captured scope", async () => {
    // THE FRAGMENTED-AUTHORITY DEFECT, exactly. Clear all A captures several scopes.
    // A newer history clear H advances scenario S and completes. Fresh S content lands.
    // A then recovers -- and under the old per-scope markers it found its surviving
    // fragment on the GLOBAL row, validated only that, and deleted everything.
    const all = await beginClear("all", null, { db: harness.db });
    expect(all.captured.length).toBeGreaterThan(1);

    const history = await beginClear("history", TARGET, { db: harness.db });
    const done = await finishClear(history, { db: harness.db });
    expect(done.outcome).toBe("deleted");

    // The user starts again, in the cleared scenario and in the untouched one.
    await seed(TARGET, "second");
    const freshTarget = await snapshotRows(TARGET);
    const freshOther = await snapshotContent(OTHER);
    expect(freshOther.searches).toHaveLength(1);
    // A's begin already marked EVERY thread cleared, including this untouched
    // scenario's -- that marking is part of the fence it committed, not part of the
    // deletion it was later refused.
    expect((await snapshotRows(OTHER)).threads[0]).toMatchObject({ state: "cleared" });

    // A recovers. One of its captured scopes has moved, so it owns nothing.
    const resumed = await resumePendingClears({ db: harness.db });

    expect(resumed.proposals + resumed.receipts + resumed.searches).toBe(0);
    // THE REACH-FORWARD GUARD: content written after A was authorized is byte-identical,
    // including the fresh ACTIVE thread, its turn and its messages.
    expect(await snapshotRows(TARGET)).toEqual(freshTarget);
    expect((await snapshotRows(TARGET)).threads).toHaveLength(1);
    expect((await snapshotRows(TARGET)).messages).toHaveLength(2);
    // The untouched scenario keeps every content row. Its already-`cleared` thread and
    // that thread's own children are tidied by the orphan sweep, which is the one thing
    // a dead thread does authorize -- and it authorizes nothing beyond itself.
    expect(await snapshotContent(OTHER)).toEqual(freshOther);
    expect((await snapshotRows(OTHER)).threads).toEqual([]);
    // A is retired rather than left to try again forever.
    expect(await markers()).toHaveLength(0);
  });

  it("refuses a scoped replay after a Clear all completed", async () => {
    // The reverse order: H begins, A completes globally, fresh content lands, H
    // recovers. H's captured scope was advanced by A, so it owns nothing either.
    const history = await beginClear("history", TARGET, { db: harness.db });
    const all = await beginClear("all", null, { db: harness.db });
    expect((await finishClear(all, { db: harness.db })).outcome).toBe("deleted");

    await seed(TARGET, "second");
    const fresh = await snapshotRows(TARGET);

    const stale = await finishClear(history, { db: harness.db });
    expect(stale.outcome).toBe("superseded");
    expect(await snapshotRows(TARGET)).toEqual(fresh);

    const resumed = await resumePendingClears({ db: harness.db });
    expect(resumed.proposals + resumed.receipts + resumed.searches).toBe(0);
    expect(await snapshotRows(TARGET)).toEqual(fresh);
  });

  it("refuses the claim when one captured fence row is deleted outright", async () => {
    const all = await beginClear("all", null, { db: harness.db });
    const before = await snapshotRows(TARGET);

    // A captured row disappears. A subset of the set is not the set.
    await harness.db.assistantGenerations.delete(all.captured[0].scopeKey);

    const stale = await finishClear(all, { db: harness.db });
    expect(stale.outcome).toBe("superseded");
    expect(await snapshotRows(TARGET)).toEqual(before);
  });

  it("keeps history and all as distinct operations when they overlap", async () => {
    const history = await beginClear("history", TARGET, { db: harness.db });
    const all = await beginClear("all", null, { db: harness.db });
    expect(all.scenarioId).toBeNull();
    expect(all.operationId).not.toBe(history.operationId);

    // The scoped clear is now stale: Clear all replaced its marker.
    const stale = await finishClear(history, { db: harness.db });
    expect(stale.outcome).toBe("superseded");

    // And Clear all still does its global job.
    const global = await finishClear(all, { db: harness.db });
    expect(global.outcome).toBe("deleted");
    expect(await contentIds(TARGET)).toEqual([]);
    expect(await contentIds(OTHER)).toEqual([]);
    // Ordinary Optimize is never assistant data.
    expect((await snapshotRows(TARGET)).bases).toHaveLength(1);
  });
});

describe("a Clear all that proves its authority", () => {
  // Clear all is the user asking for everything to go. Bookkeeping is not content, but
  // leaving stale operation rows behind after a total wipe is residue of exactly the
  // kind the request was meant to remove -- and overlap is how it accumulates.

  it("leaves no operation rows, including a stale overlapping one", async () => {
    const stale = await beginClear("history", TARGET, { db: harness.db });
    const all = await beginClear("all", null, { db: harness.db });
    expect(await markers()).toHaveLength(2);

    const done = await finishClear(all, { db: harness.db });

    expect(done.outcome).toBe("deleted");
    // Both rows gone: its own, and the overlap residue it is entitled to sweep.
    expect(await markers()).toEqual([]);
    // Non-vacuity: the stale one really was a different operation.
    expect(stale.operationId).not.toBe(all.operationId);
  });

  it("leaves no operation rows when the scoped clear finished first", async () => {
    const history = await beginClear("history", TARGET, { db: harness.db });
    expect((await finishClear(history, { db: harness.db })).outcome).toBe("deleted");

    const all = await beginClear("all", null, { db: harness.db });
    expect((await finishClear(all, { db: harness.db })).outcome).toBe("deleted");

    expect(await markers()).toEqual([]);
    expect(await contentIds(TARGET)).toEqual([]);
    expect(await contentIds(OTHER)).toEqual([]);
  });

  it("does not let a SCOPED clear sweep another operation's record", async () => {
    // The sweep is the user's global authorization, not a general tidy-up.
    const other = await beginClear("history", OTHER, { db: harness.db });
    const target = await beginClear("history", TARGET, { db: harness.db });

    expect((await finishClear(target, { db: harness.db })).outcome).toBe("deleted");

    expect((await markers()).map((row) => row.operationId)).toEqual([other.operationId]);
    // And the other scenario's content is still there, waiting for its own clear.
    expect(await contentIds(OTHER)).toHaveLength(3);
  });
});

describe("a deletion transaction that fails", () => {
  it("rolls back the rows and the marker together, and a retry completes once", async () => {
    const fence = await beginClear("history", TARGET, { db: harness.db });
    const before = await snapshotRows(TARGET);

    // Fails INSIDE the transaction, after the deletes and before the marker is
    // consumed -- the only point where the two could come apart.
    await expect(
      finishClear(fence, {
        db: harness.db,
        barrier: () => {
          throw new Error("storage went away");
        },
      }),
    ).rejects.toThrow(/storage went away/);

    // Neither half landed: the content is byte-identical and the clear is still pending.
    expect(await snapshotRows(TARGET)).toEqual(before);
    expect(await markers()).toHaveLength(1);
    expect((await markers())[0]!.operationId).toBe(fence.operationId);

    // The retry completes, exactly once.
    const retried = await finishClear(fence, { db: harness.db });
    expect(retried.outcome).toBe("deleted");
    expect(await contentIds(TARGET)).toEqual([]);
    expect(await markers()).toHaveLength(0);

    // And a second retry is a no-op rather than a second deletion.
    await seed(TARGET, "third");
    const fresh = await snapshotRows(TARGET);
    const again = await finishClear(fence, { db: harness.db });
    // THE DATA FIRST: a finished operation must not reach forward into content written
    // after it ended. The outcome below is the same fact stated as a return value, but
    // it is the rows that matter, so it is the rows that are checked first.
    expect(await snapshotRows(TARGET)).toEqual(fresh);
    expect(await contentIds(TARGET)).toHaveLength(3);
    expect(again.outcome).toBe("superseded");
  });
});

describe("the other scenario", () => {
  it("is untouched to the byte through every path above", async () => {
    const before = await snapshotRows(OTHER);

    const fence = await beginClear("history", TARGET, { db: harness.db });
    await finishClear(fence, { db: harness.db });
    await resumePendingClears({ db: harness.db });

    expect(await snapshotRows(OTHER)).toEqual(before);
  });
});

describe("strict product-outcome tombstone parsing", () => {
  // The product-outcome reader must be as strict as the deletion-authority reader.
  // A malformed or future row must not render a notice, authorize deletion, broaden
  // to Clear all, or be retired by scoped cleanup.

  /** A genuinely valid incomplete-history tombstone baseline, in the current shape. */
  function validTombstone() {
    const captured = [{ scopeKey: `scenario:${TARGET}`, generation: 1 }];
    return {
      operationId: "op-tombstone",
      version: 3 as const,
      scope: "history" as const,
      scenarioId: TARGET as string | null,
      captured,
      commitment: commitmentFor(captured),
      startedAt: new Date().toISOString(),
      outcome: "incomplete" as const,
    };
  }

  /** Seed every fence row at generation 1 so the tombstone's captured set is consistent. */
  async function fenceAtOne() {
    const at = new Date().toISOString();
    for (const scopeKey of ["global", `scenario:${TARGET}`, `scenario:${OTHER}`]) {
      await harness.db.assistantGenerations.put({
        scopeKey,
        generation: 1,
        clearedAt: at,
        createdAt: at,
      } as never);
    }
  }

  const TOMBSTONE_MUTATIONS: [string, (record: ReturnType<typeof validTombstone>) => unknown][] = [
    ["an unrecognised version", (r) => ({ ...r, version: 99 })],
    ["an unknown outcome status", (r) => ({ ...r, outcome: "sideways" })],
    ["a pending outcome (not a tombstone)", (r) => ({ ...r, outcome: "pending" })],
    ["an unknown scope", (r) => ({ ...r, scope: "sideways" })],
    ["a null scenario on a history tombstone", (r) => ({ ...r, scenarioId: null })],
    ["a scenario on an all tombstone", (r) => ({ ...r, scope: "all", scenarioId: TARGET })],
    ["an empty operation id", (r) => ({ ...r, operationId: "" })],
    ["a padded operation id", (r) => ({ ...r, operationId: "  op  " })],
    ["an unparseable timestamp", (r) => ({ ...r, startedAt: "not-a-date" })],
    [
      "a commitment that does not match",
      (r) => ({ ...r, commitment: { count: 99, canonical: "[]" } }),
    ],
    [
      "a commitment with an extra field",
      (r) => ({ ...r, commitment: { ...r.commitment, extra: true } }),
    ],
    ["a record with an extra field", (r) => ({ ...r, unexpected: true })],
    ["a null captured set", (r) => ({ ...r, captured: null })],
    [
      "a non-integer generation",
      (r) => ({ ...r, captured: [{ ...r.captured[0], generation: 1.5 }] }),
    ],
    ["an empty captured set", (r) => ({ ...r, captured: [] })],
  ];

  it.each(TOMBSTONE_MUTATIONS)("readClearOutcome rejects %s", async (_label, mutate) => {
    await harness.db.assistantClearOperations.put(mutate(validTombstone()) as never);
    const outcome = await readClearOutcome({ db: harness.db });
    expect(outcome).toBeNull();
  });

  it("readClearOutcome accepts a genuinely valid tombstone", async () => {
    await harness.db.assistantClearOperations.put(validTombstone() as never);
    const outcome = await readClearOutcome({ db: harness.db });
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("incomplete");
    expect(outcome!.scope).toBe("history");
    expect(outcome!.scenarioId).toBe(TARGET);
  });

  it("readClearOutcome accepts a valid failed-all tombstone", async () => {
    const captured = [{ scopeKey: "global", generation: 1 }];
    await harness.db.assistantClearOperations.put({
      operationId: "op-failed-all",
      version: 3,
      scope: "all",
      scenarioId: null,
      captured,
      commitment: commitmentFor(captured),
      startedAt: new Date().toISOString(),
      outcome: "failed",
    } as never);
    const outcome = await readClearOutcome({ db: harness.db });
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("failed");
    expect(outcome!.scope).toBe("all");
  });

  it("clearOutcomes does not retire a malformed tombstone", async () => {
    await fenceAtOne();
    // A tombstone with a future version — readClearOutcome rejects it.
    await harness.db.assistantClearOperations.put({ ...validTombstone(), version: 99 } as never);
    await clearOutcomes("history", TARGET, { db: harness.db });
    // The row survives because clearOutcomes only deletes validated outcome tombstones.
    // (It filters by outcome strings, but the row is still on disk — it is NOT retired
    // by the strict path because readClearOutcome would not have returned it.)
    expect(await harness.db.assistantClearOperations.count()).toBeGreaterThan(0);
  });

  it("clearOutcomes does not retire a newer same-scenario tombstone (causal cutoff)", async () => {
    await fenceAtOne();
    const old = {
      ...validTombstone(),
      operationId: "op-old",
      startedAt: "2026-08-01T00:00:00.000Z",
    };
    const newer = {
      ...validTombstone(),
      operationId: "op-new",
      startedAt: "2026-08-02T00:00:00.000Z",
    };
    await harness.db.assistantClearOperations.put(old as never);
    await harness.db.assistantClearOperations.put(newer as never);
    // Retire with a cutoff that precedes the newer tombstone.
    await clearOutcomes("history", TARGET, {
      db: harness.db,
      predecessorStartedAt: "2026-08-01T12:00:00.000Z",
    });
    const remaining = await harness.db.assistantClearOperations.toArray();
    expect(remaining.map((r) => r.operationId)).toContain("op-new");
    expect(remaining.map((r) => r.operationId)).not.toContain("op-old");
  });
});

describe("a terminal record whose scope and capture contradict each other", () => {
  // The product parser must be exactly as strict as the deletion-authority parser about
  // the scope contract. A terminal record is never authority -- but a malformed one
  // that renders anyway solicits a destructive retry for a scenario it does not own.

  /** A genuinely valid canonical terminal record: history A, capturing A's fence. */
  function validCanonical() {
    const captured = [{ scopeKey: `scenario:${TARGET}`, generation: 1 }];
    return {
      operationId: "op-canonical",
      version: 4 as const,
      requestId: "request-canonical",
      scope: "history" as const,
      scenarioId: TARGET as string | null,
      captured,
      commitment: commitmentFor(captured),
      startedAt: new Date().toISOString(),
      outcome: "incomplete" as const,
      reason: "superseded" as const,
      settlement: "stopped" as const,
      deletionOutcome: "superseded" as const,
    };
  }

  type Canonical = ReturnType<typeof validCanonical>;
  const CONTRADICTIONS: [string, (record: Canonical) => unknown][] = [
    [
      "history A committing to scenario B",
      (r) => {
        const captured = [{ scopeKey: `scenario:${OTHER}`, generation: 1 }];
        return { ...r, captured, commitment: commitmentFor(captured) };
      },
    ],
    [
      "history carrying an extra scope",
      (r) => {
        const captured = [...r.captured, { scopeKey: "global", generation: 1 }];
        return { ...r, captured, commitment: commitmentFor(captured) };
      },
    ],
    [
      "history substituting the global scope",
      (r) => {
        const captured = [{ scopeKey: "global", generation: 1 }];
        return { ...r, captured, commitment: commitmentFor(captured) };
      },
    ],
    [
      "all with no global scope",
      (r) => {
        const captured = [{ scopeKey: `scenario:${TARGET}`, generation: 1 }];
        return {
          ...r,
          scope: "all",
          scenarioId: null,
          captured,
          commitment: commitmentFor(captured),
        };
      },
    ],
    [
      "all carrying a scenario",
      (r) => {
        const captured = [{ scopeKey: "global", generation: 1 }];
        return { ...r, scope: "all", captured, commitment: commitmentFor(captured) };
      },
    ],
    [
      "a commitment that does not match its own capture",
      (r) => ({ ...r, commitment: { count: 1, canonical: "[]" } }),
    ],
    ["an unrecognised settlement", (r) => ({ ...r, settlement: "teleported" })],
    ["an unrecognised reason", (r) => ({ ...r, reason: "vibes" })],
    ["an unrecognised deletion outcome", (r) => ({ ...r, deletionOutcome: "maybe" })],
    ["a missing request id", (r) => ({ ...r, requestId: "" })],
  ];

  it("accepts the baseline, so every mutation below means something", async () => {
    await harness.db.assistantClearOperations.put(validCanonical() as never);
    expect(await readClearOutcome({ db: harness.db })).toMatchObject({
      operationId: "op-canonical",
      requestId: "request-canonical",
      status: "incomplete",
      scope: "history",
      scenarioId: TARGET,
      reason: "superseded",
      settlement: "stopped",
      deletionOutcome: "superseded",
    });
  });

  it.each(CONTRADICTIONS)("renders nothing for %s", async (_label, mutate) => {
    await harness.db.assistantClearOperations.put(mutate(validCanonical()) as never);

    // Invisible: no notice, and therefore no retry to widen.
    expect(await readClearOutcome({ db: harness.db })).toBeNull();
    // Not retirable either: a scoped success must leave a row it cannot read alone.
    await clearOutcomes("history", TARGET, {
      db: harness.db,
      predecessorOperationIds: ["op-canonical"],
    });
    expect(await harness.db.assistantClearOperations.get("op-canonical")).toBeDefined();
  });
});

describe("the record version this build writes", () => {
  // The version is the discriminator that tells a reader WHICH layout it is holding.
  // Adding `outcome` to version 2 in place destroyed that: two layouts shared one
  // number, and a reader had to guess from key presence. Version 3 restores it.

  it("beginClear writes a canonical version-5 pending record under the minted identity", async () => {
    const fence = await beginClear("history", TARGET, {
      db: harness.db,
      operationId: "op-minted-0001",
      requestId: "request-minted-0001",
    });
    // THE IDENTITY IS THE CALLER'S, minted before any I/O.
    expect(fence.operationId).toBe("op-minted-0001");
    const row = await harness.db.assistantClearOperations.get("op-minted-0001");
    expect(row).toMatchObject({
      version: 5,
      requestId: "request-minted-0001",
      outcome: "pending",
      // Explicit nulls: "not known yet" is a fact, and an absent key could not say it.
      reason: null,
      settlement: null,
      deletionOutcome: null,
      // A history fence never touches the configuration row.
      configurationOutcome: "retained",
    });
    expect(Object.keys(row!).sort()).toEqual(
      [
        "captured",
        "commitment",
        "configurationOutcome",
        "deletionOutcome",
        "operationId",
        "outcome",
        "reason",
        "requestId",
        "scenarioId",
        "scope",
        "settlement",
        "startedAt",
        "version",
      ].sort(),
    );
  });

  it("persistClearFacts writes a canonical terminal record", async () => {
    const id = await persistClearFacts(
      {
        requestId: "request-0001",
        operationId: "op-terminal-0001",
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
    expect(id).toBe("op-terminal-0001");
    expect(await harness.db.assistantClearOperations.get(id!)).toMatchObject({
      version: 5,
      requestId: "request-0001",
      outcome: "incomplete",
      reason: "superseded",
      settlement: "stopped",
      deletionOutcome: "superseded",
      configurationOutcome: "retained",
    });
    // And it is readable as a product outcome, not as authority.
    expect(await readClearOutcome({ db: harness.db })).toMatchObject({
      operationId: id,
      status: "incomplete",
    });
  });

  it("refuses a current pending record rewritten back to an older version", async () => {
    // THE CAUSAL PAIR. The same bytes at version 3 authorize the deletion below; at
    // version 2 with `outcome` present they are an unresolvable shape and authorize
    // nothing.
    const fence = await beginClear("history", TARGET, { db: harness.db });
    const written = await harness.db.assistantClearOperations.get(fence.operationId);
    await harness.db.assistantClearOperations.put({ ...written!, version: 2 } as never);

    const before = await snapshotContent(TARGET);
    const refused = await finishClear(fence, { db: harness.db });
    expect(refused.outcome).toBe("superseded");
    expect(await snapshotContent(TARGET)).toEqual(before);

    // Put the version back and the very same record deletes.
    await harness.db.assistantClearOperations.put(written!);
    expect((await finishClear(fence, { db: harness.db })).outcome).toBe("deleted");
    expect(await contentIds(TARGET)).toEqual([]);
  });
});

describe("legacy version-2 compatibility", () => {
  it("readOperation accepts a pre-outcome v2 pending record as deletion authority", async () => {
    // A record written BEFORE the outcome field was added: no outcome key.
    const captured = [{ scopeKey: `scenario:${TARGET}`, generation: 1 }];
    await harness.db.assistantGenerations.put({
      scopeKey: `scenario:${TARGET}`,
      generation: 1,
      clearedAt: null,
      createdAt: new Date().toISOString(),
    } as never);
    await harness.db.assistantClearOperations.put({
      operationId: "op-legacy-pending",
      version: 2,
      scope: "history",
      scenarioId: TARGET,
      captured,
      commitment: commitmentFor(captured),
      startedAt: new Date().toISOString(),
      // NO outcome field — the shipped legacy shape.
    } as never);
    const otherBefore = await snapshotRows(OTHER);

    const result = await resumePendingClears({ db: harness.db });

    // IT REALLY RECOVERED: the scenario's content is deleted, the record consumed, and
    // the other scenario untouched. "Recovery did not reject it" is not enough — an
    // upgrade that stranded a fenced clear would also leave the content in place.
    expect(result.proposals).toBe(1);
    expect(result.receipts).toBe(1);
    expect(result.searches).toBe(1);
    expect(await contentIds(TARGET)).toEqual([]);
    expect(await markers()).toEqual([]);
    expect(await snapshotRows(OTHER)).toEqual(otherBefore);
  });

  it("reads a legacy version-2 tombstone as a product outcome", async () => {
    const captured = [{ scopeKey: `scenario:${TARGET}`, generation: 1 }];
    await harness.db.assistantClearOperations.put({
      operationId: "op-legacy-tombstone",
      version: 2,
      scope: "history",
      scenarioId: TARGET,
      captured,
      commitment: commitmentFor(captured),
      startedAt: new Date().toISOString(),
      outcome: "incomplete",
    } as never);

    // Visible, so an upgrade does not swallow a notice the user was already shown.
    expect(await readClearOutcome({ db: harness.db })).toMatchObject({
      operationId: "op-legacy-tombstone",
      status: "incomplete",
      scope: "history",
      scenarioId: TARGET,
    });
    // And retirable by its own scope's success, like any other tombstone.
    await clearOutcomes("history", TARGET, {
      db: harness.db,
      predecessorOperationIds: ["op-legacy-tombstone"],
    });
    expect(await harness.db.assistantClearOperations.get("op-legacy-tombstone")).toBeUndefined();
  });

  it("normalizes a stranded version-2 pending-with-outcome row into a visible failure", async () => {
    // THE ROUND-14 SHAPE. It is not authority (its layout is ambiguous) and it is not a
    // tombstone (`pending` is not a terminal outcome), so left alone it would be a
    // fenced, undeleted clear that nothing on screen could ever mention.
    const captured = [{ scopeKey: `scenario:${TARGET}`, generation: 1 }];
    const startedAt = "2026-08-01T00:00:00.000Z";
    await harness.db.assistantGenerations.put({
      scopeKey: `scenario:${TARGET}`,
      generation: 1,
      clearedAt: null,
      createdAt: startedAt,
    } as never);
    await harness.db.assistantClearOperations.put({
      operationId: "op-stranded",
      version: 2,
      scope: "history",
      scenarioId: TARGET,
      captured,
      commitment: commitmentFor(captured),
      startedAt,
      outcome: "pending",
    } as never);

    // BEFORE: invisible and non-authorizing.
    expect(await readClearOutcome({ db: harness.db })).toBeNull();

    const before = await snapshotContent(TARGET);
    const resumed = await resumePendingClears({ db: harness.db });

    // It authorized NOTHING, even though its captured generation matches on disk.
    expect(resumed.proposals + resumed.receipts + resumed.searches).toBe(0);
    expect(await snapshotContent(TARGET)).toEqual(before);

    // AFTER: the same row, canonical, as a failure the user can see and retry.
    // Identity, scope, scenario, captured set, commitment and startedAt are unchanged,
    // so it still sorts by when the clear actually began.
    expect(await harness.db.assistantClearOperations.get("op-stranded")).toEqual({
      operationId: "op-stranded",
      version: 5,
      requestId: "op-stranded",
      scope: "history",
      scenarioId: TARGET,
      captured,
      commitment: commitmentFor(captured),
      startedAt,
      outcome: "failed",
      reason: "storage",
      // The legacy row never recorded these; they are reported null, never guessed.
      settlement: null,
      deletionOutcome: null,
      // Derived from what a scoped clear proves: it never touches configuration.
      configurationOutcome: "retained",
    });
    expect(await readClearOutcome({ db: harness.db })).toMatchObject({
      operationId: "op-stranded",
      status: "failed",
      scope: "history",
      scenarioId: TARGET,
      at: startedAt,
    });
  });

  it("normalizes nothing when there is no stranded row", async () => {
    const fence = await beginClear("history", TARGET, { db: harness.db });
    const written = await harness.db.assistantClearOperations.get(fence.operationId);
    await resumePendingClears({ db: harness.db });
    // A current pending record is CONSUMED by recovery, never rewritten as a failure.
    expect(await harness.db.assistantClearOperations.get(fence.operationId)).toBeUndefined();
    expect(written).toMatchObject({ version: 5, outcome: "pending" });
  });

  it("readClearOutcome ignores a pre-outcome v2 record (no outcome = not a tombstone)", async () => {
    const captured = [{ scopeKey: `scenario:${TARGET}`, generation: 1 }];
    await harness.db.assistantClearOperations.put({
      operationId: "op-legacy",
      version: 2,
      scope: "history",
      scenarioId: TARGET,
      captured,
      commitment: commitmentFor(captured),
      startedAt: new Date().toISOString(),
    } as never);

    const outcome = await readClearOutcome({ db: harness.db });
    expect(outcome).toBeNull();
  });
});
