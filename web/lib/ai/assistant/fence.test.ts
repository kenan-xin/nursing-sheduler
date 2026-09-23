import { describe, expect, it } from "vitest";

import {
  GLOBAL_GENERATION_SCOPE,
  scenarioGenerationScope,
  type CapturedGeneration,
} from "@/lib/repository";
import {
  bumpAssistantGeneration,
  captureAssistantGenerations,
  fromGenerationPair,
  readAllGenerationScopes,
  runFenced,
  toGenerationPair,
} from "./fence";
import { createAssistantHarness, type AssistantHarness } from "./test-support";

const TABLES = ["assistantMessages", "assistantGenerations"];

function capture(harness: AssistantHarness, scenarioId: string | null) {
  return harness.db.transaction("rw", ["assistantGenerations"], () =>
    captureAssistantGenerations(harness.db, scenarioId, harness.now()),
  );
}

function bump(harness: AssistantHarness, scopeKey: Parameters<typeof bumpAssistantGeneration>[1]) {
  return harness.db.transaction("rw", ["assistantGenerations"], () =>
    bumpAssistantGeneration(harness.db, scopeKey, harness.now()),
  );
}

/**
 * The kind of check a caller might reasonably perform BEFORE opening its write
 * transaction. It is exactly the read `assertGenerationsUnchanged` does -- just in the
 * wrong place, which is the whole point of the race test below.
 */
async function passesPrecheck(
  harness: AssistantHarness,
  captured: readonly CapturedGeneration[],
): Promise<boolean> {
  for (const entry of captured) {
    const fence = await harness.db.assistantGenerations.get(entry.scopeKey);
    if ((fence?.generation ?? 0) !== entry.generation) return false;
  }
  return true;
}

function message(harness: AssistantHarness, id: string) {
  return {
    messageId: id,
    schemaVersion: 1 as const,
    threadId: "thread-1",
    scenarioId: "scenario-a",
    seq: 0,
    role: "assistant" as const,
    content: "a late chunk",
    toolCalls: null,
    toolCallId: null,
    modelId: null,
    turnId: null,
    globalGeneration: 0,
    scenarioGeneration: 0,
    createdAt: harness.now().toISOString(),
  };
}

describe("capturing generations", () => {
  it("mints both scopes at 0 and returns them as the pair a record stores", async () => {
    const harness = createAssistantHarness();

    const captured = await capture(harness, "scenario-a");

    expect(captured).toEqual([
      { scopeKey: GLOBAL_GENERATION_SCOPE, generation: 0 },
      { scopeKey: "scenario:scenario-a", generation: 0 },
    ]);
    expect(toGenerationPair(captured)).toEqual({ globalGeneration: 0, scenarioGeneration: 0 });
    // Round-trips: a durable row's stored pair rebuilds the exact same capture, which
    // is what makes the fence survive a reload.
    expect(fromGenerationPair("scenario-a", toGenerationPair(captured))).toEqual(captured);
  });

  it("captures the global scope alone when no scenario is selected", async () => {
    const harness = createAssistantHarness();

    expect(await capture(harness, null)).toEqual([
      { scopeKey: GLOBAL_GENERATION_SCOPE, generation: 0 },
    ]);
  });

  it("only ever moves a generation forward, and records when it was cleared", async () => {
    const harness = createAssistantHarness();
    const scope = scenarioGenerationScope("scenario-a");

    expect(await bump(harness, scope)).toEqual({ scopeKey: scope, generation: 1 });
    expect(await bump(harness, scope)).toEqual({ scopeKey: scope, generation: 2 });

    const fence = await harness.db.assistantGenerations.get(scope);
    expect(fence?.generation).toBe(2);
    expect(fence?.clearedAt).toBe(harness.now().toISOString());
  });

  it("reports every scope that has ever existed -- the record Clear all needs", async () => {
    const harness = createAssistantHarness();
    await capture(harness, "scenario-a");
    await capture(harness, "scenario-b");

    expect((await readAllGenerationScopes(harness.db)).sort()).toEqual([
      "global",
      "scenario:scenario-a",
      "scenario:scenario-b",
    ]);
  });
});

describe("the fence is inside the write transaction, not before it", () => {
  it("accepts a write whose captured generations still hold", async () => {
    const harness = createAssistantHarness();
    const captured = await capture(harness, "scenario-a");

    const result = await runFenced(harness.db, TABLES, captured, async () => {
      await harness.db.assistantMessages.put(message(harness, "m1"));
      return "wrote";
    });

    expect(result).toEqual({ outcome: "accepted", value: "wrote" });
    expect(await harness.db.assistantMessages.count()).toBe(1);
  });

  it("REJECTS a write that passed an out-of-transaction precheck and then lost the race", async () => {
    const harness = createAssistantHarness();
    const captured = await capture(harness, "scenario-a");

    // The precheck an optimising caller would perform: at this instant it is true.
    expect(await passesPrecheck(harness, captured)).toBe(true);

    // The user clears while the callback is between its precheck and its write.
    await bump(harness, scenarioGenerationScope("scenario-a"));

    const result = await runFenced(harness.db, TABLES, captured, async () => {
      await harness.db.assistantMessages.put(message(harness, "m1"));
      return "wrote";
    });

    expect(result.outcome).toBe("fenced");
    // Not merely refused AFTERWARDS: the transaction aborted, so the row never landed.
    // A precheck alone would have written it.
    expect(await harness.db.assistantMessages.count()).toBe(0);
  });

  it("is fenced by the GLOBAL scope alone, so Clear all catches a scenario write", async () => {
    const harness = createAssistantHarness();
    const captured = await capture(harness, "scenario-a");
    await bump(harness, GLOBAL_GENERATION_SCOPE);

    const result = await runFenced(harness.db, TABLES, captured, async () => {
      await harness.db.assistantMessages.put(message(harness, "m1"));
      return "wrote";
    });

    expect(result.outcome).toBe("fenced");
  });

  it("is NOT fenced by another scenario's clear", async () => {
    const harness = createAssistantHarness();
    const captured = await capture(harness, "scenario-a");
    await bump(harness, scenarioGenerationScope("scenario-b"));

    const result = await runFenced(harness.db, TABLES, captured, async () => {
      await harness.db.assistantMessages.put(message(harness, "m1"));
      return "wrote";
    });

    expect(result.outcome).toBe("accepted");
  });

  it("cannot be defeated by a capture naming a scope that does not exist yet", async () => {
    const harness = createAssistantHarness();
    // A late writer claiming generation 1 for a scope no row exists for. Treating an
    // absent row as 0 is what makes this a mismatch rather than a pass.
    const forged: CapturedGeneration[] = [{ scopeKey: "scenario:invented", generation: 1 }];

    const result = await runFenced(harness.db, TABLES, forged, async () => {
      await harness.db.assistantMessages.put(message(harness, "m1"));
      return "wrote";
    });

    expect(result.outcome).toBe("fenced");
    expect(await harness.db.assistantMessages.count()).toBe(0);
  });

  it("lets a real storage failure through instead of reporting it as a clear", async () => {
    const harness = createAssistantHarness();
    const captured = await capture(harness, "scenario-a");

    // An unavailable database must not masquerade as "the user cleared this", or the
    // app would silently stop persisting and call it correct behaviour.
    await expect(
      runFenced(harness.db, TABLES, captured, () => {
        throw new Error("IndexedDB is gone");
      }),
    ).rejects.toThrow("IndexedDB is gone");
  });
});
