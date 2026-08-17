// One Clear invocation, one fact record — through every failure boundary.
//
// THE DEFECT THIS FIXES. The direct return value, the durable row, the hydrated
// projection and the browser bridge were four reconstructions of the same event, and
// they disagreed. A finish failure reported `settlement: "run_failed"` although the
// bounded settlement window had already produced a real class; a Clear all reported
// the scenario that happened to be selected while its durable row said `null`; a
// pre-begin failure persisted a real operation id and then returned `null`.
//
// Every case here asserts the SAME facts at every surface, because the bug was never
// that one surface was wrong on its own — it was that they could not be compared.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fail = vi.hoisted(() => ({
  beginClear: false,
  finishClear: false,
  clearOutcomes: false,
  readSettings: false,
  readOutcome: false,
  recovery: false,
  /** Delete this operation between the candidate read and terminalization. */
  consumeBefore: null as string | null,
  /** Run this between the candidate read and terminalization. */
  replaceBefore: null as null | (() => Promise<void>),
}));

vi.mock("./clear-repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clear-repo")>();
  return {
    ...actual,
    beginClear: async (...args: Parameters<typeof actual.beginClear>) => {
      if (fail.beginClear) throw new Error("storage refused the fence");
      return actual.beginClear(...args);
    },
    finishClear: async (...args: Parameters<typeof actual.finishClear>) => {
      if (fail.finishClear) throw new Error("storage went away during deletion");
      return actual.finishClear(...args);
    },
    clearOutcomes: async (...args: Parameters<typeof actual.clearOutcomes>) => {
      if (fail.clearOutcomes) throw new Error("storage went away during cleanup");
      return actual.clearOutcomes(...args);
    },
    readClearOutcome: async (...args: Parameters<typeof actual.readClearOutcome>) => {
      if (fail.readOutcome) throw new Error("storage refused the outcome read");
      return actual.readClearOutcome(...args);
    },
    resumePendingClears: async (...args: Parameters<typeof actual.resumePendingClears>) => {
      // FAIL THE DELETION PASS WITHOUT RUNNING IT, keeping the identity read that
      // precedes it. That is the real shape of the failure: recovery validated what is
      // pending, then its transaction did not commit -- so the pending row is still
      // there, and the caller must terminalize exactly it.
      if (fail.recovery) {
        const candidates = await actual.readClearCandidates();
        // The world moves on AFTER recovery observed its candidates and BEFORE the
        // caller terminalizes -- which is the whole interleaving under test.
        if (fail.consumeBefore) {
          const { getAssistantDb } = await import("./db");
          await getAssistantDb().assistantClearOperations.delete(fail.consumeBefore);
          fail.consumeBefore = null;
        }
        if (fail.replaceBefore) {
          const run = fail.replaceBefore;
          fail.replaceBefore = null;
          await run();
        }
        return {
          outcome: "deleted" as const,
          threads: 0,
          messages: 0,
          turns: 0,
          proposals: 0,
          receipts: 0,
          searches: 0,
          candidates,
          failed: true,
        };
      }
      return actual.resumePendingClears(...args);
    },
  };
});

vi.mock("./settings-repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings-repo")>();
  return {
    ...actual,
    readAssistantSettings: async (...args: Parameters<typeof actual.readAssistantSettings>) => {
      if (fail.readSettings) throw new Error("storage refused the settings read");
      return actual.readAssistantSettings(...args);
    },
  };
});

import { readClearFacts, type PersistedClearOutcome } from "./clear-repo";
import { readLifecycleLog } from "./lifecycle";
import { assistantActions, hydrateAssistant, useAssistantStore } from "./store";
import { selectActiveThread } from "./history-repo";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  createAssistantHarness,
  type AssistantHarness,
} from "./test-support";

const TARGET = "scenario-target";

let harness: AssistantHarness;

/** The durable row for one operation, or `null` if none was written. */
async function durableFacts(operationId: string): Promise<PersistedClearOutcome | null> {
  return (await readClearFacts()).find((row) => row.operationId === operationId) ?? null;
}

beforeEach(async () => {
  fail.beginClear = false;
  fail.finishClear = false;
  fail.clearOutcomes = false;
  fail.readSettings = false;
  fail.readOutcome = false;
  fail.recovery = false;
  fail.consumeBefore = null;
  fail.replaceBefore = null;
  harness = createAssistantHarness();
  assistantActions.resetForTest();
  await hydrateAssistant();
  await assistantActions.setEnabled(true);
  await assistantActions.activate({
    apiKey: SENTINEL_KEY,
    modelId: TEST_MODEL,
    modelSource: "catalog",
  });
  await selectActiveThread(TARGET);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the identity minted before any I/O", () => {
  it("survives a failure inside beginClear itself, with a durable row under it", async () => {
    fail.beginClear = true;

    const facts = await assistantActions.clearHistory({ threadId: null, scenarioId: TARGET });

    // The invocation has ids even though the fence never committed.
    expect(facts.requestId).toBeTruthy();
    expect(facts.operationId).toBeTruthy();
    expect(facts.status).toBe("failed");
    expect(facts.reason).toBe("storage");
    expect(facts.scope).toBe("history");
    expect(facts.scenarioId).toBe(TARGET);
    // Nothing ran, so both are honestly null rather than fabricated.
    expect(facts.settlement).toBeNull();
    expect(facts.deletionOutcome).toBeNull();

    // THE DURABLE ROW IS THE SAME RECORD, found by the id the caller was handed.
    expect(await durableFacts(facts.operationId)).toMatchObject({
      requestId: facts.requestId,
      operationId: facts.operationId,
      scope: "history",
      scenarioId: TARGET,
      status: "failed",
      reason: "storage",
      settlement: null,
      deletionOutcome: null,
    });
  });

  it("is the id the pending row was written under, not a later invention", async () => {
    // Hold the invocation open at the deletion stage so the PENDING row can be read.
    fail.finishClear = true;
    const facts = await assistantActions.clearHistory({ threadId: null, scenarioId: TARGET });
    // The terminal row replaced the pending one AT THE SAME KEY.
    const rows = await harness.db.assistantClearOperations.toArray();
    expect(rows.map((row) => row.operationId)).toEqual([facts.operationId]);
    expect(rows[0]).toMatchObject({ requestId: facts.requestId, outcome: "failed" });
  });
});

describe("a failure after the real settlement", () => {
  it("keeps the settlement class the controller actually computed", async () => {
    fail.finishClear = true;

    const facts = await assistantActions.clearHistory({ threadId: null, scenarioId: TARGET });

    expect(facts.status).toBe("failed");
    // THE CAUSAL ASSERTION. Settlement ran to completion before finish threw, so its
    // class is a known fact. `run_failed` was the fabricated stand-in the old code
    // substituted here, and `null` would claim settlement never happened.
    expect(facts.settlement).not.toBeNull();
    expect(facts.settlement).not.toBe("run_failed");
    // Deletion genuinely did not complete, which is null rather than "superseded".
    expect(facts.deletionOutcome).toBeNull();

    // And the durable row carries the identical facts.
    expect(await durableFacts(facts.operationId)).toMatchObject({
      requestId: facts.requestId,
      settlement: facts.settlement,
      deletionOutcome: null,
      status: "failed",
    });
  });

  it("reports Clear all with no scenario at every surface", async () => {
    fail.finishClear = true;

    // The caller passes the scenario it has selected; a GLOBAL clear has none.
    const facts = await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });

    expect(facts.scope).toBe("all");
    expect(facts.scenarioId).toBeNull();
    expect(await durableFacts(facts.operationId)).toMatchObject({
      scope: "all",
      scenarioId: null,
    });
    expect(useAssistantStore.getState().clearResult).toMatchObject({
      scope: "all",
      scenarioId: null,
      operationId: facts.operationId,
    });

    // Hydration reconstructs the same record from disk alone.
    assistantActions.resetForTest();
    await hydrateAssistant();
    expect(useAssistantStore.getState().clearResult).toEqual({
      status: "failed",
      scope: "all",
      scenarioId: null,
      reason: "storage",
      // The fence committed, so the configuration really was deleted.
      configurationOutcome: "deleted",
      operationId: facts.operationId,
    });
  });
});

describe("a cleanup failure after the deletion committed", () => {
  it("reports the committed deletion and offers no retry", async () => {
    // A stale predecessor exists, so retirement genuinely runs and genuinely fails.
    fail.clearOutcomes = true;

    const facts = await assistantActions.clearHistory({ threadId: null, scenarioId: TARGET });

    // THE COMMITTED TRUTH WINS. Calling this failed would invite a retry that reaches
    // forward into anything written since the deletion.
    expect(facts.status).toBe("deleted");
    expect(facts.deletionOutcome).toBe("deleted");
    expect(facts.reason).toBeNull();
    expect(useAssistantStore.getState().clearResult).toBeNull();
    // No terminal row: a deletion that committed is not a tombstone.
    expect(await durableFacts(facts.operationId)).toBeNull();
    // The failure is classified, and carries no raw error text.
    const log = readLifecycleLog();
    expect(log.some((event) => event.errorClass === "storage_unavailable")).toBe(true);
    expect(JSON.stringify(log)).not.toContain("storage went away");
  });
});

describe("hydration that cannot read the outcome records", () => {
  it("keeps the notice the user was already looking at", async () => {
    // A real incomplete clear leaves an actionable notice.
    fail.finishClear = true;
    const facts = await assistantActions.clearHistory({ threadId: null, scenarioId: TARGET });
    fail.finishClear = false;
    const known = structuredClone(useAssistantStore.getState().clearResult);
    expect(known).toMatchObject({ operationId: facts.operationId, status: "failed" });

    fail.readOutcome = true;
    await hydrateAssistant();

    // PUBLISHING NULL HERE WOULD ERASE THE WARNING while the unfinished clear behind
    // it stayed exactly as unfinished. A read that did not work is not evidence.
    expect(useAssistantStore.getState().clearResult).toEqual(known);
    expect(useAssistantStore.getState().hydrated).toBe(true);
  });

  it("shows a bounded storage notice when nothing was known before", async () => {
    fail.readOutcome = true;
    assistantActions.resetForTest();
    await hydrateAssistant();

    expect(useAssistantStore.getState().clearResult).toEqual({
      status: "failed",
      scope: null,
      scenarioId: null,
      reason: "storage",
      configurationOutcome: "unknown",
      operationId: null,
    });
  });
});

describe("hydration that cannot read the settings row", () => {
  it("keeps the key and model it already knew", async () => {
    // A first, successful hydrate establishes the projection.
    assistantActions.resetForTest();
    await hydrateAssistant();
    const known = structuredClone(useAssistantStore.getState().settings);
    expect(known.apiKey).toBe(SENTINEL_KEY);
    expect(known.modelId).toBe(TEST_MODEL);

    fail.readSettings = true;
    await hydrateAssistant();

    // BYTE FOR BYTE. Replacing this with empty settings would tell the user their
    // credential had been deleted when no committed Clear-all begin ever deleted it.
    expect(useAssistantStore.getState().settings).toEqual(known);
    expect(useAssistantStore.getState().hydrated).toBe(true);
    // And the failure is visible as a storage notice with no destructive action.
    expect(useAssistantStore.getState().clearResult).toEqual({
      status: "failed",
      scope: null,
      scenarioId: null,
      reason: "storage",
      configurationOutcome: "unknown",
      operationId: null,
    });
  });
});

describe("the configuration fact decides what Settings may claim", () => {
  it("a Clear all that failed BEFORE its fence kept the key, and says so", async () => {
    fail.beginClear = true;

    const facts = await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });

    // No fence ever committed, so nothing was deleted -- and the durable row agrees.
    expect(facts.status).toBe("failed");
    expect(facts.configurationOutcome).toBe("retained");
    expect(await durableFacts(facts.operationId)).toMatchObject({
      configurationOutcome: "retained",
    });
    // THE CREDENTIAL IS STILL THERE, in the store and on disk.
    expect(useAssistantStore.getState().settings.apiKey).toBe(SENTINEL_KEY);
    expect((await harness.db.assistantSettings.toArray())[0]?.apiKey).toBe(SENTINEL_KEY);
    expect(useAssistantStore.getState().clearResult).toMatchObject({
      scope: "all",
      configurationOutcome: "retained",
    });
  });

  it("a Clear all that failed AFTER its fence really did delete the key", async () => {
    fail.finishClear = true;

    const facts = await assistantActions.clearAll({ threadId: null, scenarioId: TARGET });

    expect(facts.configurationOutcome).toBe("deleted");
    expect(await durableFacts(facts.operationId)).toMatchObject({
      configurationOutcome: "deleted",
    });
    // The fence's own transaction removed it, so the projection must agree.
    expect(useAssistantStore.getState().settings.apiKey).toBeNull();
    expect(await harness.db.assistantSettings.count()).toBe(0);
  });

  it("empties the projection through the Clear action that commits the deletion", async () => {
    // THE DELETION PATH, OWNED WHERE IT IS CAUSAL. `beginClear` deletes the settings row
    // inside the transaction that commits its fence, and the action projects `empty`
    // from that committed fence -- in the tab that performed it, with no inference.
    expect(useAssistantStore.getState().settings.apiKey).toBe(SENTINEL_KEY);

    const facts = await assistantActions.clearAll({ threadId: null, scenarioId: null });

    expect(facts.status).toBe("deleted");
    expect(facts.configurationOutcome).toBe("deleted");
    expect(await harness.db.assistantSettings.count()).toBe(0);
    expect(useAssistantStore.getState().settings.apiKey).toBeNull();
    expect(useAssistantStore.getState().settings.enabled).toBe(false);
  });

  it("reports a real deletion on an ORDINARY successful hydrate, with no proof machinery", async () => {
    // The second causal path, and the reason hydration needs no inference at all:
    // `readAssistantSettings` returns the off-by-default shape for an absent row, so a
    // successful read already reports a deleted configuration exactly.
    await assistantActions.clearAll({ threadId: null, scenarioId: null });
    assistantActions.resetForTest();

    await hydrateAssistant();

    expect(useAssistantStore.getState().settings.apiKey).toBeNull();
    expect(useAssistantStore.getState().settings.enabled).toBe(false);
  });

  it("does not second-guess a committed deletion when the later reread fails", async () => {
    // Preservation is not resurrection. After a genuine Clear all the projection is
    // already empty; a failed reread leaves it exactly as it is rather than restoring
    // anything.
    await assistantActions.clearAll({ threadId: null, scenarioId: null });
    expect(useAssistantStore.getState().settings.apiKey).toBeNull();

    fail.readSettings = true;
    await hydrateAssistant();

    expect(useAssistantStore.getState().settings.apiKey).toBeNull();
    expect(await harness.db.assistantSettings.count()).toBe(0);
  });

  it("keeps a re-added configuration after a consumed global candidate and a failed reread", async () => {
    // THE EXACT COLD INTERLEAVING. A global clear fenced and deleted the configuration;
    // recovery observed its pending row; the operation was then consumed; the user
    // reconfigured; and only afterwards did the settings reread fail.
    //
    // The candidate is a structured clone taken BEFORE recovery ran, and its
    // compare-and-swap returns `no_op` precisely because the world moved on. Treating
    // it as proof projected a durable, present, Ready configuration as empty -- hiding
    // a working assistant behind a storage hiccup.
    const { beginClear } = await import("./clear-repo");
    await beginClear("all", null, {
      operationId: "op-consumed-global",
      requestId: "request-consumed-global",
    });
    expect(await harness.db.assistantSettings.count()).toBe(0);

    fail.recovery = true;
    // Between the candidate read and terminalization: the operation is consumed and the
    // user configures the assistant again.
    fail.consumeBefore = "op-consumed-global";
    fail.replaceBefore = async () => {
      const { activateProbedConfiguration } = await import("./settings-repo");
      await activateProbedConfiguration({
        apiKey: SENTINEL_KEY,
        modelId: TEST_MODEL,
        modelSource: "catalog",
      });
    };
    fail.readSettings = true;

    assistantActions.resetForTest();
    useAssistantStore.setState({
      settings: {
        key: "local",
        enabled: true,
        apiKey: SENTINEL_KEY,
        modelId: TEST_MODEL,
        modelSource: "catalog",
        probedAt: null,
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
      },
    });

    await hydrateAssistant();

    // DURABLE FIRST: the configuration row is genuinely present.
    expect(await harness.db.assistantSettings.count()).toBe(1);
    // AND THE PROJECTION AGREES. A consumed operation is not present-day proof of
    // anything, and a read that failed is not evidence of a deletion.
    expect(useAssistantStore.getState().settings.apiKey).toBe(SENTINEL_KEY);
    expect(useAssistantStore.getState().settings.modelId).toBe(TEST_MODEL);
    // A NOTICE IS STILL PERMITTED HERE, but only the bounded non-destructive one, and
    // only because the settings read genuinely failed -- never because of the no-op.
    // It claims nothing about the configuration and offers no destructive action.
    expect(useAssistantStore.getState().clearResult).toEqual({
      status: "failed",
      scope: null,
      scenarioId: null,
      reason: "storage",
      configurationOutcome: "unknown",
      operationId: null,
    });
  });

  it("keeps a configuration written AFTER a still-current global fence", async () => {
    // The row is genuinely unchanged, so its compare-and-swap verifies it -- currency is
    // satisfied. What is not satisfied is exclusivity: the user reconfigured after the
    // fence (a clear that crashed, a key re-entered, then a reload), so the deletion
    // that fence performed is spent. Currency alone would empty a key the user just
    // typed in.
    const { beginClear } = await import("./clear-repo");
    await beginClear("all", null, {
      operationId: "op-later-write",
      requestId: "request-later-write",
    });
    // The reconfiguration lands after the fence and stays on disk.
    const { activateProbedConfiguration } = await import("./settings-repo");
    const reconfigured = await activateProbedConfiguration({
      apiKey: SENTINEL_KEY,
      modelId: TEST_MODEL,
      modelSource: "catalog",
    });
    expect(reconfigured).not.toBeNull();

    fail.recovery = true;
    fail.readSettings = true;
    assistantActions.resetForTest();
    useAssistantStore.setState({ settings: reconfigured! });

    await hydrateAssistant();

    // The pending row really was still there to verify...
    expect(await harness.db.assistantClearOperations.get("op-later-write")).toMatchObject({
      outcome: "failed",
    });
    // ...and the configuration written after it stands.
    expect(await harness.db.assistantSettings.count()).toBe(1);
    expect(useAssistantStore.getState().settings.apiKey).toBe(SENTINEL_KEY);
  });

  it("keeps a SECOND TAB's durable reconfiguration this store never observed", async () => {
    // THE BLOCKER, EXACTLY. Everything here is current and legitimate: the pending
    // global row is unchanged, so its compare-and-swap returns `terminalized`. What no
    // amount of operation currency can establish is that another tab has not written a
    // settings row in the meantime -- that write is invisible until it is read, and the
    // read is what failed.
    const { beginClear } = await import("./clear-repo");
    await beginClear("all", null, {
      operationId: "op-second-tab",
      requestId: "request-second-tab",
    });
    expect(await harness.db.assistantSettings.count()).toBe(0);

    // ANOTHER TAB reconfigures. It writes durably and updates ITS store, not ours.
    const { activateProbedConfiguration } = await import("./settings-repo");
    await activateProbedConfiguration({
      apiKey: SENTINEL_KEY,
      modelId: TEST_MODEL,
      modelSource: "catalog",
    });

    fail.recovery = true;
    fail.readSettings = true;
    assistantActions.resetForTest();
    // This tab still holds its pre-clear projection and has never seen the new row.
    useAssistantStore.setState({
      settings: {
        key: "local",
        enabled: true,
        apiKey: SENTINEL_KEY,
        modelId: TEST_MODEL,
        modelSource: "catalog",
        probedAt: null,
        schemaVersion: 1,
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    await hydrateAssistant();

    // The compare-and-swap really did verify the row -- this is not a `no_op` case.
    expect(await harness.db.assistantClearOperations.get("op-second-tab")).toMatchObject({
      outcome: "failed",
    });
    // DURABLE FIRST: the other tab's configuration is present.
    expect(await harness.db.assistantSettings.count()).toBe(1);
    // AND THE PROJECTION DOES NOT HIDE IT.
    expect(useAssistantStore.getState().settings.apiKey).toBe(SENTINEL_KEY);
    expect(useAssistantStore.getState().settings.modelId).toBe(TEST_MODEL);
  });

  it("keeps a causally later configuration that carries an EARLIER wall clock", async () => {
    // Wall clock is metadata, not a causal clock. Two tabs, a clock adjustment, or
    // coarse timer resolution can stamp a later write with an earlier instant. Nothing
    // here may depend on that ordering.
    const { beginClear } = await import("./clear-repo");
    await beginClear("all", null, {
      operationId: "op-skewed",
      requestId: "request-skewed",
    });
    // Written AFTER the fence, stamped an hour BEFORE it.
    await harness.db.assistantSettings.put({
      key: "local",
      enabled: true,
      apiKey: SENTINEL_KEY,
      modelId: TEST_MODEL,
      modelSource: "catalog",
      probedAt: null,
      schemaVersion: 1,
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    } as never);

    fail.recovery = true;
    fail.readSettings = true;
    assistantActions.resetForTest();
    useAssistantStore.setState({
      settings: {
        key: "local",
        enabled: true,
        apiKey: SENTINEL_KEY,
        modelId: TEST_MODEL,
        modelSource: "catalog",
        probedAt: null,
        schemaVersion: 1,
        updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    });

    await hydrateAssistant();

    expect(await harness.db.assistantSettings.count()).toBe(1);
    expect(useAssistantStore.getState().settings.apiKey).toBe(SENTINEL_KEY);
  });

  it("keeps a reconfiguration made after a TERMINAL outcome is already current", async () => {
    // Not a pending row this time: a valid terminal record claiming the configuration
    // was deleted is the current durable truth, and the user reconfigured after it.
    const { persistClearFacts } = await import("./clear-repo");
    await persistClearFacts({
      requestId: "request-terminal",
      operationId: "op-terminal-then-reconfig",
      scope: "all",
      scenarioId: null,
      status: "failed",
      reason: "storage",
      settlement: null,
      deletionOutcome: null,
      configurationOutcome: "deleted",
    });
    const { activateProbedConfiguration } = await import("./settings-repo");
    await activateProbedConfiguration({
      apiKey: SENTINEL_KEY,
      modelId: TEST_MODEL,
      modelSource: "catalog",
    });

    fail.readSettings = true;
    assistantActions.resetForTest();
    useAssistantStore.setState({
      settings: {
        key: "local",
        enabled: true,
        apiKey: SENTINEL_KEY,
        modelId: TEST_MODEL,
        modelSource: "catalog",
        probedAt: null,
        schemaVersion: 1,
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    await hydrateAssistant();

    // The terminal record is current and says `deleted`; the configuration is present
    // anyway. Later configuration always wins over earlier Clear history.
    expect(useAssistantStore.getState().clearResult).toMatchObject({
      scope: "all",
      configurationOutcome: "deleted",
    });
    expect(await harness.db.assistantSettings.count()).toBe(1);
    expect(useAssistantStore.getState().settings.apiKey).toBe(SENTINEL_KEY);
  });

  it("treats a global candidate whose row merely CHANGED as no proof either", async () => {
    // Not consumed this time -- replaced. The candidate still describes a global fence,
    // but it is no longer the row on disk, so its compare-and-swap declines and it
    // proves nothing about the present.
    const { beginClear } = await import("./clear-repo");
    await beginClear("all", null, {
      operationId: "op-changed-global",
      requestId: "request-changed-global",
    });

    fail.recovery = true;
    fail.replaceBefore = async () => {
      const current = await harness.db.assistantClearOperations.get("op-changed-global");
      await harness.db.assistantClearOperations.put({
        ...current!,
        startedAt: "2030-01-01T00:00:00.000Z",
      });
      const { activateProbedConfiguration } = await import("./settings-repo");
      await activateProbedConfiguration({
        apiKey: SENTINEL_KEY,
        modelId: TEST_MODEL,
        modelSource: "catalog",
      });
    };
    fail.readSettings = true;

    assistantActions.resetForTest();
    useAssistantStore.setState({
      settings: {
        key: "local",
        enabled: true,
        apiKey: SENTINEL_KEY,
        modelId: TEST_MODEL,
        modelSource: "catalog",
        probedAt: null,
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
      },
    });

    await hydrateAssistant();

    expect(await harness.db.assistantSettings.count()).toBe(1);
    expect(useAssistantStore.getState().settings.apiKey).toBe(SENTINEL_KEY);
  });

  it("keeps a history clear from ever claiming the key was removed", async () => {
    fail.finishClear = true;
    const facts = await assistantActions.clearHistory({ threadId: null, scenarioId: TARGET });

    expect(facts.configurationOutcome).toBe("retained");
    expect(useAssistantStore.getState().settings.apiKey).toBe(SENTINEL_KEY);
  });
});

describe("recovery that fails after reading a pending identity", () => {
  it("offers the captured scoped retry, never Clear all", async () => {
    // A real pending history operation, left behind by an interrupted clear.
    fail.finishClear = true;
    await assistantActions.clearHistory({ threadId: null, scenarioId: TARGET });
    // Put a genuine PENDING row back on disk under a known identity.
    await harness.db.assistantClearOperations.clear();
    const { beginClear } = await import("./clear-repo");
    await beginClear("history", TARGET, {
      operationId: "op-pending-0001",
      requestId: "request-pending-0001",
    });

    fail.recovery = true;
    fail.finishClear = false;
    assistantActions.resetForTest();
    await hydrateAssistant();

    // THE SCOPE IS THE ONE THE USER ASKED FOR. Defaulting to `all` here would offer to
    // delete every scenario's data plus the credential on the strength of a failed read.
    expect(useAssistantStore.getState().clearResult).toEqual({
      status: "failed",
      scope: "history",
      scenarioId: TARGET,
      reason: "storage",
      configurationOutcome: "retained",
      operationId: "op-pending-0001",
    });
    // TERMINALIZED IN PLACE: the row keeps its own request identity, capture and start.
    expect(await harness.db.assistantClearOperations.get("op-pending-0001")).toMatchObject({
      version: 5,
      requestId: "request-pending-0001",
      outcome: "failed",
      reason: "storage",
      configurationOutcome: "retained",
    });
    // The credential and model survive a scoped failure.
    expect(useAssistantStore.getState().settings.apiKey).toBe(SENTINEL_KEY);
    expect(useAssistantStore.getState().settings.modelId).toBe(TEST_MODEL);
  });

  it("publishes NOTHING when the observed operation was already consumed", async () => {
    // The exact interleaving: recovery validated a pending row, the operation was then
    // consumed (finished, or completed by another tab), and only afterwards did
    // recovery report failure. The compare-and-swap correctly declines -- and a decline
    // is not a failure. Publishing a storage warning here told the user something had
    // gone wrong with a clear that had in fact completed.
    const { beginClear } = await import("./clear-repo");
    await beginClear("history", TARGET, {
      operationId: "op-consumed-0001",
      requestId: "request-consumed-0001",
    });
    fail.recovery = true;
    fail.consumeBefore = "op-consumed-0001";

    assistantActions.resetForTest();
    await hydrateAssistant();

    // No row, no notice, and nothing resurrected.
    expect(await harness.db.assistantClearOperations.count()).toBe(0);
    expect(useAssistantStore.getState().clearResult).toBeNull();
    expect(useAssistantStore.getState().hydrated).toBe(true);
  });

  it("publishes the newer terminal row, not the stale candidate", async () => {
    const { beginClear, persistClearFacts } = await import("./clear-repo");
    await beginClear("history", TARGET, {
      operationId: "op-superseded-0001",
      requestId: "request-original",
    });
    fail.recovery = true;
    // A newer invocation completes at the same key while recovery is failing.
    fail.replaceBefore = async () => {
      await persistClearFacts({
        requestId: "request-newer",
        operationId: "op-superseded-0001",
        scope: "history",
        scenarioId: TARGET,
        status: "incomplete",
        reason: "superseded",
        settlement: "stopped",
        deletionOutcome: "superseded",
        configurationOutcome: "retained",
      });
    };

    assistantActions.resetForTest();
    await hydrateAssistant();

    // THE CURRENT ROW IS WHAT PUBLISHES. The stale candidate is not news.
    expect(useAssistantStore.getState().clearResult).toMatchObject({
      status: "incomplete",
      scope: "history",
      scenarioId: TARGET,
      operationId: "op-superseded-0001",
    });
    expect(await harness.db.assistantClearOperations.get("op-superseded-0001")).toMatchObject({
      requestId: "request-newer",
      outcome: "incomplete",
    });
  });

  it("invents no scope at all when no identity could be read", async () => {
    await harness.db.assistantClearOperations.clear();
    fail.recovery = true;

    assistantActions.resetForTest();
    await hydrateAssistant();

    expect(useAssistantStore.getState().clearResult).toEqual({
      status: "failed",
      scope: null,
      scenarioId: null,
      reason: "storage",
      configurationOutcome: "unknown",
      operationId: null,
    });
    expect(useAssistantStore.getState().settings.apiKey).toBe(SENTINEL_KEY);
  });
});
