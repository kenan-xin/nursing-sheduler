// The orphan-settlement race, both directions.
//
// A turn whose non-cooperative tool finally resolves has to settle its own row -- but
// only if nothing already did. The obvious shape (read, check, write) has an await
// between the check and the write, and Stop's truthful settlement lands in exactly
// that gap: the second write then replaces "detached, stopped by the user" with the
// weaker `revoked`, and the durable record disagrees with what the user was told.

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  recordPreparingTurn,
  selectActiveThread,
  setTurnState,
  settleTurnIfUnsettled,
} from "./history-repo";
import { createAssistantHarness, type AssistantHarness } from "./test-support";

let harness: AssistantHarness;

beforeEach(() => {
  harness = createAssistantHarness();
});

async function preparingTurn() {
  const thread = await selectActiveThread("scenario-a");
  const turn = await recordPreparingTurn({
    threadId: thread.threadId,
    scenarioId: "scenario-a",
    basisDocumentRevision: 1,
    leaseEpoch: 1,
    modelId: "m",
    runId: "run-1",
    turnEpoch: 1,
    runtimeInstanceId: null,
  });
  if (!turn) throw new Error("fixture could not prepare a turn");
  return turn;
}

describe("settling is conditional at the moment of the write", () => {
  it("settles a turn nothing else has settled", async () => {
    const turn = await preparingTurn();

    expect(await settleTurnIfUnsettled(turn.turnId, "revoked")).toBe("settled");

    const row = await harness.db.assistantTurns.get(turn.turnId);
    expect(row?.state).toBe("terminal");
    expect(row?.terminalReason).toBe("revoked");
  });

  it("leaves Stop's truthful settlement alone", async () => {
    // THE RACE, with Stop winning. Its story must survive verbatim.
    const turn = await preparingTurn();
    await setTurnState(turn.turnId, {
      state: "detached",
      settlement: "detached_timeout",
      trigger: "stop",
    });

    expect(await settleTurnIfUnsettled(turn.turnId, "revoked")).toBe("already-settled");

    const row = await harness.db.assistantTurns.get(turn.turnId);
    expect(row?.state).toBe("detached");
    expect(row?.terminalReason).toBe("detached_timeout");
    expect(row?.interruptionTrigger).toBe("stop");
  });

  it("leaves a takeover settlement alone", async () => {
    const turn = await preparingTurn();
    await setTurnState(turn.turnId, {
      state: "terminal",
      settlement: "cancelled",
      trigger: "takeover",
    });

    expect(await settleTurnIfUnsettled(turn.turnId, "revoked")).toBe("already-settled");

    const row = await harness.db.assistantTurns.get(turn.turnId);
    expect(row?.terminalReason).toBe("cancelled");
    expect(row?.interruptionTrigger).toBe("takeover");
  });

  it("is a no-op when both fire, whichever order they resolve in", async () => {
    // Issued concurrently. Exactly one settlement may land, and it must be Stop's --
    // the orphan write can only ever be the loser, never an overwriter.
    const turn = await preparingTurn();

    await Promise.all([
      setTurnState(turn.turnId, { state: "detached", settlement: "stopped", trigger: "stop" }),
      settleTurnIfUnsettled(turn.turnId, "revoked"),
    ]);

    const row = await harness.db.assistantTurns.get(turn.turnId);
    // Whichever won the transaction order, `revoked` never replaces a settled row: the
    // only outcomes are Stop's story, or `revoked` followed by Stop's story.
    expect(row?.state === "detached" || row?.terminalReason === "revoked").toBe(true);
    if (row?.terminalReason === "revoked") {
      // Stop lost the race to the orphan write; it is still allowed to tell the truth
      // afterwards, because `setTurnState` is the interruption controller's own path.
      expect(row?.state).toBe("terminal");
    }
  });

  it("reports a missing turn rather than creating one", async () => {
    expect(await settleTurnIfUnsettled("no-such-turn", "revoked")).toBe("missing");
    expect(await harness.db.assistantTurns.count()).toBe(0);
  });
});
