// @vitest-environment jsdom
//
// What the browser bridge reports for EACH call, against what is actually on disk.
//
// THE DEFECT THIS COVERS. A bridge that answered from the store would hand every
// caller the LATEST clear's projection, so a queued or repeated call would report its
// successor's outcome as its own and a browser journey asserting on it would be
// asserting on the wrong event.
//
// AND THE ONE THIS TEST FILE ITSELF HAD. The previous version drove only successful
// calls: it named its variables `incomplete` and `repeat`, but clearing a scenario with
// no thread is still an owned zero-row deletion, so both returned `deleted` and the
// durable comparison sat behind an `if (status !== "deleted")` that never fired. Here
// each status is ASSERTED FIRST, and the field-for-field comparison is unconditional.
//
// Kept apart from `assistant-test-bridge.test.tsx` deliberately: that file resets the
// module registry between cases to re-evaluate the build-time compile-out constant,
// which would hand the bridge a different database instance than the fixtures here set
// up.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const fail = vi.hoisted(() => ({
  finishClear: false,
  supersedeScenario: null as string | null,
}));

vi.mock("@/lib/ai/assistant/clear-repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/assistant/clear-repo")>();
  return {
    ...actual,
    finishClear: async (...args: Parameters<typeof actual.finishClear>) => {
      if (fail.finishClear) throw new Error("storage went away during deletion");
      // Land a scenario write in the window between the fence and the deletion pass --
      // deterministically, which racing the caller's promise cannot be.
      if (fail.supersedeScenario) {
        const scenarioId = fail.supersedeScenario;
        fail.supersedeScenario = null;
        const { getAssistantDb } = await import("@/lib/ai/assistant/db");
        const db = getAssistantDb();
        const row = await db.assistantGenerations.get(`scenario:${scenarioId}`);
        if (row) await db.assistantGenerations.put({ ...row, generation: row.generation + 1 });
      }
      return actual.finishClear(...args);
    },
  };
});

import { AssistantTestBridge, type BridgeClearFacts } from "./assistant-test-bridge";
import { assistantActions, hydrateAssistant } from "@/lib/ai/assistant/store";
import { selectActiveThread } from "@/lib/ai/assistant/history-repo";
import { getAssistantDb } from "@/lib/ai/assistant/db";
import { SENTINEL_KEY, TEST_MODEL, createAssistantHarness } from "@/lib/ai/assistant/test-support";

const SCENARIO_A = "scenario-a";
const SCENARIO_B = "scenario-b";

/** Every canonical field, compared without exception. */
function expectDurableMatch(direct: BridgeClearFacts, durable: BridgeClearFacts[]): void {
  const stored = durable.find((row) => row.operationId === direct.operationId);
  expect(stored, `no durable row for ${direct.operationId}`).toBeDefined();
  expect(stored).toEqual({
    requestId: direct.requestId,
    operationId: direct.operationId,
    status: direct.status,
    scope: direct.scope,
    scenarioId: direct.scenarioId,
    reason: direct.reason,
    settlement: direct.settlement,
    deletionOutcome: direct.deletionOutcome,
    configurationOutcome: direct.configurationOutcome,
  });
}

function bridge() {
  const found = window.__nsAssistant;
  expect(found).toBeDefined();
  return found!;
}

beforeEach(async () => {
  fail.finishClear = false;
  fail.supersedeScenario = null;
  window.__NS_ENABLE_TEST_BRIDGE = true;
  createAssistantHarness();
  assistantActions.resetForTest();
  await hydrateAssistant();
  await assistantActions.setEnabled(true);
  await assistantActions.activate({
    apiKey: SENTINEL_KEY,
    modelId: TEST_MODEL,
    modelSource: "catalog",
  });
  render(<AssistantTestBridge />);
});

afterEach(() => {
  cleanup();
  delete window.__nsAssistant;
  delete window.__NS_ENABLE_TEST_BRIDGE;
  vi.restoreAllMocks();
});

describe("a deleted call", () => {
  it("gives queued calls distinct identities and each its own scenario", async () => {
    await selectActiveThread(SCENARIO_A);
    await selectActiveThread(SCENARIO_B);

    const [first, second] = await Promise.all([
      bridge().clearHistory(SCENARIO_A),
      bridge().clearHistory(SCENARIO_B),
    ]);

    expect(first.status).toBe("deleted");
    expect(second.status).toBe("deleted");
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.operationId).not.toBe(second.operationId);
    // Each reports ITS OWN scenario, not whichever finished last.
    expect(first.scenarioId).toBe(SCENARIO_A);
    expect(second.scenarioId).toBe(SCENARIO_B);
    // A committed deletion leaves no terminal row: its contract is direct/bridge
    // equality plus zero residue, not a fabricated fourth durable surface.
    const durable = await bridge().clearFacts();
    expect(durable.map((row) => row.operationId)).not.toContain(first.operationId);
    expect(durable.map((row) => row.operationId)).not.toContain(second.operationId);
  });

  it("reports a global success with no scenario and leaves zero operation residue", async () => {
    await selectActiveThread(SCENARIO_A);

    const facts = await bridge().clearAll(SCENARIO_A);

    expect(facts.status).toBe("deleted");
    expect(facts.scope).toBe("all");
    expect(facts.scenarioId).toBeNull();
    expect(facts.configurationOutcome).toBe("deleted");
    expect(await getAssistantDb().assistantClearOperations.count()).toBe(0);
  });
});

describe("a genuinely INCOMPLETE call", () => {
  it("matches its durable row field for field", async () => {
    await selectActiveThread(SCENARIO_A);
    fail.supersedeScenario = SCENARIO_A;

    const facts = await bridge().clearHistory(SCENARIO_A);

    // ASSERTED, not assumed: the branch below only means something if this holds.
    expect(facts.status).toBe("incomplete");
    expect(facts.deletionOutcome).toBe("superseded");
    expect(facts.reason).toBe("superseded");
    expect(facts.configurationOutcome).toBe("retained");
    expectDurableMatch(facts, await bridge().clearFacts());
  });
});

describe("a genuinely FAILED call", () => {
  it("matches its durable row field for field, and repeats stay distinct", async () => {
    await selectActiveThread(SCENARIO_A);
    fail.finishClear = true;

    const first = await bridge().clearHistory(SCENARIO_A);
    const repeat = await bridge().clearHistory(SCENARIO_A);
    fail.finishClear = false;

    expect(first.status).toBe("failed");
    expect(repeat.status).toBe("failed");
    expect(first.reason).toBe("storage");
    expect(first.requestId).not.toBe(repeat.requestId);
    expect(first.operationId).not.toBe(repeat.operationId);

    const durable = await bridge().clearFacts();
    expectDurableMatch(first, durable);
    expectDurableMatch(repeat, durable);
  });

  it("reports a global failure's proven configuration fact", async () => {
    await selectActiveThread(SCENARIO_A);
    fail.finishClear = true;

    const facts = await bridge().clearAll(SCENARIO_A);

    expect(facts.status).toBe("failed");
    expect(facts.scope).toBe("all");
    expect(facts.scenarioId).toBeNull();
    // The fence committed before finish threw, so the credential really is gone.
    expect(facts.configurationOutcome).toBe("deleted");
    expectDurableMatch(facts, await bridge().clearFacts());
  });
});
