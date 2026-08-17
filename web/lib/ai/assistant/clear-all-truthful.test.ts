// Clear all, reported truthfully.
//
// THE DEFECT. The deletion pass refuses when a generation scope exists that the
// operation did not capture -- assistant data created after the clear was authorized,
// which a global wipe must not reach forward into. That refusal is correct. But the
// controller published phase `cleared`, the store reset the surface and resolved
// normally, and the browser bridge agreed -- while the user's conversations, proposals,
// receipts and diagnostic searches sat on disk. A safety refusal was being shown as a
// completed deletion.
//
// Every case here asserts the DURABLE state first and the visible state second, because
// that is the order in which they can disagree.

import { beforeEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  remaining: 0,
  begins: 0,
  insert: null as null | (() => Promise<void>),
}));

/** Arm to make the next `finishClear` throw after `beginClear` has deleted settings. */
const fail = vi.hoisted(() => ({ finishClear: false }));

vi.mock("./clear-repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clear-repo")>();
  return {
    ...actual,
    // Wraps the REAL begin and then, while `remaining` allows, creates a generation
    // scope the operation could not have captured -- which is what a scenario's first
    // assistant write does if it lands while the clear is settling.
    beginClear: async (
      scope: Parameters<typeof actual.beginClear>[0],
      scenarioId: Parameters<typeof actual.beginClear>[1],
      config?: Parameters<typeof actual.beginClear>[2],
    ) => {
      const fence = await actual.beginClear(scope, scenarioId, config);
      race.begins += 1;
      if (race.remaining > 0) {
        race.remaining -= 1;
        await race.insert?.();
      }
      return fence;
    },
    // Wraps the REAL finish; when armed, throws to simulate a post-fence storage failure
    // after the settings row has already been deleted by begin.
    finishClear: async (
      fence: Parameters<typeof actual.finishClear>[0],
      config?: Parameters<typeof actual.finishClear>[1],
    ) => {
      if (fail.finishClear) throw new Error("storage went away after settings deletion");
      return actual.finishClear(fence, config);
    },
  };
});

import { CLEAR_RECAPTURE_LIMIT } from "./interruption";
import { assistantActions, hydrateAssistant, useAssistantStore } from "./store";
import { readThreadMessages, selectActiveThread } from "./history-repo";
import { readLifecycleLog } from "./lifecycle";
import {
  createAssistantHarness,
  SENTINEL_KEY,
  TEST_MODEL,
  type AssistantHarness,
} from "./test-support";

const TARGET = "scenario-target";

let harness: AssistantHarness;

async function seedContent(scenarioId: string, tag: string) {
  const at = new Date().toISOString();
  await harness.db.assistantProposals.put({
    proposalId: `proposal-${scenarioId}-${tag}`,
    scenarioId,
    schemaVersion: 1,
    createdAt: at,
  } as never);
  await harness.db.assistantReceipts.put({
    receiptId: `receipt-${scenarioId}-${tag}`,
    scenarioId,
    schemaVersion: 1,
    createdAt: at,
  } as never);
  await harness.db.diagnosticSearches.put({
    searchId: `search-${scenarioId}-${tag}`,
    scenarioId,
    schemaVersion: 1,
    createdAt: at,
  } as never);
}

/** Everything Clear all promises to remove, plus the one thing it must not. */
async function durableState() {
  return {
    proposals: await harness.db.assistantProposals.count(),
    receipts: await harness.db.assistantReceipts.count(),
    searches: await harness.db.diagnosticSearches.count(),
    threads: await harness.db.assistantThreads.count(),
    turns: await harness.db.assistantTurns.count(),
    messages: await harness.db.assistantMessages.count(),
    settings: await harness.db.assistantSettings.count(),
    operations: await harness.db.assistantClearOperations.count(),
  };
}

const NOTHING_LEFT = {
  proposals: 0,
  receipts: 0,
  searches: 0,
  threads: 0,
  turns: 0,
  messages: 0,
  settings: 0,
  operations: 0,
};

beforeEach(async () => {
  fail.finishClear = false;
  harness = await createAssistantHarness();
  assistantActions.resetForTest();
  await hydrateAssistant();
  await assistantActions.setEnabled(true);
  await assistantActions.activate({
    apiKey: SENTINEL_KEY,
    modelId: TEST_MODEL,
    modelSource: "catalog",
  });
  await seedContent(TARGET, "first");
  await harness.db.optimizeBases.put({
    basisId: "basis-1",
    scenarioId: TARGET,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
  } as never);
});

/**
 * EVERY TABLE, structured-cloned, except the clear-operation table.
 *
 * The operation table is excluded because a legitimate clear writes, retires and
 * tombstones rows there while it runs -- including it would make the comparison fail
 * for the one reason that is not a defect. It is asserted separately, by identity.
 *
 * Everything else is in: settings, generations, threads, turns, messages, proposals,
 * receipts, diagnostic searches, Optimize bases, and the ordinary scenario data
 * (envelopes, commits) that assistant deletion must never reach at all.
 */
async function wholeDatabase(): Promise<Record<string, unknown[]>> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of harness.db.tables) {
    if (table.name === "assistantClearOperations") continue;
    snapshot[table.name] = structuredClone(await table.toArray());
  }
  return snapshot;
}

/** Ordinary scenario data, which is never assistant data and never clearable. */
async function seedControl(scenarioId: string) {
  const at = new Date().toISOString();
  await harness.db.scenarioEnvelopes.put({
    scenarioId,
    documentRevision: 7,
    updatedAt: at,
  } as never);
  await harness.db.scenarioCommits.put({
    commitId: `commit-${scenarioId}`,
    scenarioId,
    documentRevision: 7,
    createdAt: at,
  } as never);
}

/** Arm the race: `times` begins will each mint an uncaptured scope. */
function raceFor(times: number) {
  race.remaining = times;
  race.begins = 0;
  let minted = 0;
  race.insert = async () => {
    minted += 1;
    const at = new Date().toISOString();
    await harness.db.assistantGenerations.put({
      scopeKey: `scenario:late-${minted}`,
      generation: 0,
      clearedAt: null,
      createdAt: at,
    } as never);
  };
  return { minted: () => minted };
}

describe("a scope that appears while Clear all is settling", () => {
  it("recaptures and deletes everything, then reports success", async () => {
    const raced = raceFor(1);

    const result = await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });

    // Non-vacuity: the race really happened, and the recapture really ran.
    expect(raced.minted()).toBe(1);
    expect(race.begins).toBe(2);

    // DURABLE STATE FIRST. Everything the clear promised to remove is gone.
    expect(await durableState()).toEqual(NOTHING_LEFT);
    // Fences are retained and monotonic; ordinary Optimize is untouched.
    const generations = await harness.db.assistantGenerations.toArray();
    expect(generations.length).toBeGreaterThan(0);
    expect(await harness.db.optimizeBases.count()).toBe(1);

    // ONLY THEN the visible story, which now matches.
    expect(result?.status).toBe("deleted");
    expect(result?.deletionOutcome).toBe("deleted");
    expect(result?.scope).toBe("all");
    expect(readLifecycleLog().some((event) => event.errorClass === "clear_incomplete")).toBe(false);
  });

  it("never reports cleared when it cannot win, and leaves a working retry", async () => {
    // Loses every recapture, so the bound is reached.
    raceFor(CLEAR_RECAPTURE_LIMIT + 1);

    const result = await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });

    // DURABLE STATE FIRST: the content is still here, which is the fact everything
    // below has to agree with.
    const durable = await durableState();
    expect(durable.proposals + durable.receipts + durable.searches).toBeGreaterThan(0);

    // So nothing may claim it was deleted.
    expect(result?.status).toBe("incomplete");
    expect(result?.status).not.toBe("deleted");
    expect(useAssistantStore.getState().interruption).toBeNull();
    // THE FIRST-CLASS RESULT: incomplete, with a bounded safe reason.
    expect(useAssistantStore.getState().clearResult).toEqual({
      status: "incomplete",
      scope: "all",
      // NULL, NOT THE SELECTED SCENARIO. A global clear has no scenario at any stage;
      // the caller's current selection is a UI fact and must not reach the result.
      scenarioId: null,
      reason: "recapture_exhausted",
      // The fence committed, so the credential really is gone.
      configurationOutcome: "deleted",
      // Correlated to the durable tombstone, not an unrelated id.
      operationId: result.operationId,
    });
    expect(result.operationId).toBeTruthy();
    expect(result.scenarioId).toBeNull();
    // And the failure is recorded rather than swallowed.
    expect(readLifecycleLog().some((event) => event.errorClass === "clear_incomplete")).toBe(true);
    expect(race.begins).toBe(CLEAR_RECAPTURE_LIMIT + 1);

    // THE RETRY PATH. The credential is already gone -- `beginClear` removes it first --
    // so the retry must not need it back. Same action, no reconfiguration.
    expect(await harness.db.assistantSettings.count()).toBe(0);
    race.remaining = 0;
    const retried = await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });

    expect(await durableState()).toEqual(NOTHING_LEFT);
    expect(retried?.status).toBe("deleted");
    expect(retried?.deletionOutcome).toBe("deleted");
    expect(await harness.db.optimizeBases.count()).toBe(1);
  });

  it("stays truthful when it is asked again and keeps losing", async () => {
    raceFor(Number.MAX_SAFE_INTEGER);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });
      expect(result?.status).not.toBe("deleted");
      expect(result?.status).toBe("incomplete");
      expect(useAssistantStore.getState().clearResult?.status).toBe("incomplete");
    }

    const durable = await durableState();
    expect(durable.proposals + durable.receipts + durable.searches).toBeGreaterThan(0);
    race.remaining = 0;
  });
});

describe("a published diagnostic during an exhausted Clear all", () => {
  it("preserves activeDiagnostic when deletion was refused", async () => {
    // Publish a live diagnostic card before the clear.
    const search = {
      searchId: "search-active",
      scenarioId: TARGET,
      schemaVersion: 1,
      status: "open",
    } as never;
    assistantActions.publishDiagnostic(search, 1);
    expect(useAssistantStore.getState().activeDiagnostic).not.toBeNull();

    // Lose every recapture.
    raceFor(CLEAR_RECAPTURE_LIMIT + 1);
    await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });

    // DURABLE FIRST: the search row is still on disk because deletion was refused.
    expect(await harness.db.diagnosticSearches.count()).toBeGreaterThan(0);
    // AND THE PROJECTION IS PRESERVED. The old code dropped the card from the fence
    // scope alone; now it decides from the deletion outcome, and a refused deletion
    // leaves the card visible.
    expect(useAssistantStore.getState().activeDiagnostic).not.toBeNull();
    expect(useAssistantStore.getState().clearResult?.status).toBe("incomplete");
    race.remaining = 0;
  });

  it("clears activeDiagnostic when deletion succeeds", async () => {
    const search = {
      searchId: "search-active",
      scenarioId: TARGET,
      schemaVersion: 1,
      status: "open",
    } as never;
    assistantActions.publishDiagnostic(search, 1);
    expect(useAssistantStore.getState().activeDiagnostic).not.toBeNull();

    // No race: deletion succeeds.
    race.remaining = 0;
    await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });

    expect(await harness.db.diagnosticSearches.count()).toBe(0);
    expect(useAssistantStore.getState().activeDiagnostic).toBeNull();
    expect(useAssistantStore.getState().clearResult).toBeNull();
  });
});

describe("a post-fence storage failure after settings deletion", () => {
  it("classifies as failed, projects empty settings, retains content, and retries", async () => {
    fail.finishClear = true;

    const result = await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });

    // The promise resolved with a failed result — never null, never rejected.
    expect(result.status).toBe("failed");
    expect(result.scope).toBe("all");
    expect(result.reason).toBe("storage");
    expect(result.requestId).toBeTruthy();

    // DURABLE FIRST: settings really are gone (begin deleted them), but content remains
    // (the finish transaction rolled back).
    expect(await harness.db.assistantSettings.count()).toBe(0);
    const durable = await durableState();
    expect(durable.proposals + durable.receipts + durable.searches).toBeGreaterThan(0);

    // PROJECTED SETTINGS match the durable truth: the credential cannot be shown.
    expect(useAssistantStore.getState().settings.apiKey).toBeNull();
    expect(useAssistantStore.getState().settings.enabled).toBe(false);

    // THE FIRST-CLASS RESULT: failed, with a bounded safe reason.
    expect(useAssistantStore.getState().clearResult).toEqual({
      status: "failed",
      scope: "all",
      scenarioId: null,
      reason: "storage",
      configurationOutcome: "deleted",
      operationId: result.operationId,
    });
    // A post-begin failure keeps the operation identity it already paid for, and the
    // REAL settlement class the controller had already computed before finish threw.
    expect(result.operationId).toBeTruthy();
    expect(result.scenarioId).toBeNull();
    expect(result.settlement).not.toBeNull();
    expect(result.settlement).not.toBe("run_failed");
    expect(readLifecycleLog().some((event) => event.errorClass === "storage_unavailable")).toBe(
      true,
    );

    // THE RETRY. Disarm the failure; the same action (no credential needed) succeeds.
    fail.finishClear = false;
    race.remaining = 0;
    const retried = await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });

    expect(retried?.status).toBe("deleted");
    expect(await durableState()).toEqual(NOTHING_LEFT);
    expect(useAssistantStore.getState().clearResult).toBeNull();
  });
});

describe("a superseded Clear history that must not recapture", () => {
  it("returns incomplete without recapture and preserves fresh same-scenario data", async () => {
    // The conversation that existed BEFORE the clear, so "the original was fenced" and
    // "the fresh data survived" are two different rows rather than one.
    const originalAt = new Date().toISOString();
    await harness.db.assistantThreads.put({
      threadId: "thread-original",
      scenarioId: TARGET,
      state: "active",
      schemaVersion: 1,
      globalGeneration: 0,
      scenarioGeneration: 0,
      createdAt: originalAt,
      updatedAt: originalAt,
    } as never);
    await harness.db.assistantMessages.put({
      messageId: "msg-original",
      threadId: "thread-original",
      seq: 0,
      turnId: null,
      role: "user",
      content: "the older question",
      toolCalls: null,
      toolCallId: null,
      modelId: null,
      schemaVersion: 1,
      scenarioId: TARGET,
      globalGeneration: 0,
      scenarioGeneration: 0,
      createdAt: originalAt,
    } as never);
    await seedControl(TARGET);

    // Create REAL post-fence content: a fresh thread, turn, messages, proposal, receipt,
    // and diagnostic search. The older clear must not delete any of it.
    race.remaining = 1;
    race.begins = 0;
    const freshTag = "fresh-post-fence";
    const at = new Date().toISOString();
    /** The whole database as it stood the instant the fresh data landed. */
    let atFence: Record<string, unknown[]> = {};
    race.insert = async () => {
      // Advance the scenario generation — the fence check will refuse.
      const row = await harness.db.assistantGenerations.get(`scenario:${TARGET}`);
      if (row)
        await harness.db.assistantGenerations.put({ ...row, generation: row.generation + 1 });
      // Create a FRESH same-scenario thread + messages + proposal + receipt + search.
      await harness.db.assistantThreads.put({
        threadId: `thread-${freshTag}`,
        scenarioId: TARGET,
        state: "active",
        schemaVersion: 1,
        globalGeneration: 0,
        scenarioGeneration: (row?.generation ?? 0) + 1,
        createdAt: at,
        updatedAt: at,
      } as never);
      await harness.db.assistantTurns.put({
        turnId: `turn-${freshTag}`,
        threadId: `thread-${freshTag}`,
        scenarioId: TARGET,
        state: "terminal",
        terminalReason: "completed",
        interruptionTrigger: null,
        basisDocumentRevision: 7,
        leaseEpoch: 4,
        modelId: TEST_MODEL,
        runId: `run-${freshTag}`,
        turnEpoch: 1,
        runtimeInstanceId: null,
        globalGeneration: 0,
        scenarioGeneration: (row?.generation ?? 0) + 1,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
      } as never);
      await harness.db.assistantMessages.put({
        messageId: `msg-${freshTag}`,
        threadId: `thread-${freshTag}`,
        seq: 0,
        turnId: `turn-${freshTag}`,
        role: "user",
        content: "fresh post-fence question",
        toolCalls: null,
        toolCallId: null,
        modelId: null,
        schemaVersion: 1,
        scenarioId: TARGET,
        globalGeneration: 0,
        scenarioGeneration: (row?.generation ?? 0) + 1,
        createdAt: at,
      } as never);
      await harness.db.assistantProposals.put({
        proposalId: `proposal-${TARGET}-${freshTag}`,
        scenarioId: TARGET,
        schemaVersion: 1,
        createdAt: at,
      } as never);
      await harness.db.assistantReceipts.put({
        receiptId: `receipt-${TARGET}-${freshTag}`,
        scenarioId: TARGET,
        schemaVersion: 1,
        createdAt: at,
      } as never);
      await harness.db.diagnosticSearches.put({
        searchId: `search-${TARGET}-${freshTag}`,
        scenarioId: TARGET,
        schemaVersion: 1,
        createdAt: at,
      } as never);
      // THE BASELINE, taken here: everything that exists the moment the fresh data
      // lands is what the older request must hand back untouched.
      atFence = await wholeDatabase();
    };

    const result = await assistantActions.clearHistory({ threadId: null, scenarioId: TARGET });

    // No recapture: exactly one begin.
    expect(race.begins).toBe(1);

    // NON-VACUITY OF THE BASELINE. Every table the comparison depends on really was
    // populated when it was taken, so `toEqual` below is not comparing two empties.
    expect(atFence.assistantSettings).toHaveLength(1);
    expect(atFence.assistantThreads!.length).toBeGreaterThanOrEqual(2);
    expect(atFence.assistantTurns).toHaveLength(1);
    expect(atFence.assistantMessages!.length).toBeGreaterThanOrEqual(2);
    expect(atFence.assistantProposals!.length).toBeGreaterThanOrEqual(2);
    expect(atFence.assistantReceipts!.length).toBeGreaterThanOrEqual(2);
    expect(atFence.diagnosticSearches!.length).toBeGreaterThanOrEqual(2);
    expect(atFence.assistantGenerations!.length).toBeGreaterThanOrEqual(1);
    expect(atFence.optimizeBases).toHaveLength(1);
    expect(atFence.scenarioEnvelopes).toHaveLength(1);
    expect(atFence.scenarioCommits).toHaveLength(1);

    // DURABLE FIRST, AND BYTE FOR BYTE. Settings, generations, threads, turns,
    // messages, proposals, receipts, diagnostic searches, Optimize bases and the
    // ordinary scenario data are all exactly as the fence left them: the older request
    // deleted nothing, and reached forward into nothing.
    expect(await wholeDatabase()).toEqual(atFence);

    // THE VISIBLE CONVERSATION, not just the rows behind it: the fresh thread is still
    // the one this schedule selects, and its message is still readable.
    expect((await selectActiveThread(TARGET)).threadId).toBe(`thread-${freshTag}`);
    expect(
      (await readThreadMessages(`thread-${freshTag}`)).map((message) => message.messageId),
    ).toEqual([`msg-${freshTag}`]);

    // THE OPERATION/OUTCOME ROWS, asserted by identity rather than by snapshot. The
    // clear's own pending record is retired and exactly one history tombstone remains.
    const operations = await harness.db.assistantClearOperations.toArray();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      scope: "history",
      scenarioId: TARGET,
      outcome: "incomplete",
    });

    // THE FIRST-CLASS RESULT: incomplete, scoped to history, carrying the identity the
    // Settings retry hands back.
    expect(result.status).toBe("incomplete");
    expect(useAssistantStore.getState().clearResult).toEqual({
      status: "incomplete",
      scope: "history",
      scenarioId: TARGET,
      reason: "superseded",
      configurationOutcome: "retained",
      operationId: operations[0]!.operationId,
    });
    race.remaining = 0;
  });
});

describe("a tombstone surviving reload", () => {
  it("preserves the notice and keyless retry after hydration", async () => {
    // Exhaust the recapture bound.
    raceFor(CLEAR_RECAPTURE_LIMIT + 1);
    await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });

    // DURABLE FIRST: content remains.
    expect((await durableState()).proposals).toBeGreaterThan(0);
    // The tombstone persists.
    expect(await harness.db.assistantClearOperations.count()).toBeGreaterThan(0);
    expect(useAssistantStore.getState().clearResult?.status).toBe("incomplete");
    race.remaining = 0;

    // SIMULATE RELOAD: re-hydrate. Recovery ignores tombstones; hydrate reads them.
    assistantActions.resetForTest();
    await hydrateAssistant();

    // The notice survives: clearResult is reconstructed from the tombstone.
    expect(useAssistantStore.getState().clearResult?.status).toBe("incomplete");
    expect(useAssistantStore.getState().settings.apiKey).toBeNull();

    // Keyless retry succeeds: the credential is gone, but Clear all needs no key.
    const retried = await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });
    expect(retried.status).toBe("deleted");
    expect(await durableState()).toEqual(NOTHING_LEFT);
    expect(useAssistantStore.getState().clearResult).toBeNull();
  });
});
