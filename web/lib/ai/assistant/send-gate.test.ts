import { describe, expect, it, vi } from "vitest";

import { createEmptyScenarioUiState } from "@/lib/scenario";
import { emptyAssistantSettings, type AssistantSettingsV1 } from "./records";
import { describeRefusal, prepareSend, type PrepareSendDeps } from "./send-gate";
import type { WriterContext } from "./writer-context";
import { SENTINEL_KEY, TEST_MODEL } from "./test-support";

const READY: AssistantSettingsV1 = {
  ...emptyAssistantSettings(new Date("2026-08-06T00:00:00.000Z")),
  enabled: true,
  apiKey: SENTINEL_KEY,
  modelId: TEST_MODEL,
  modelSource: "catalog",
  probedAt: "2026-08-06T00:00:00.000Z",
};

const WRITER: WriterContext = {
  scenarioId: "scenario-a",
  documentRevision: 12,
  leaseEpoch: 4,
  scenario: { ...createEmptyScenarioUiState(), rangeStart: "2026-09-01", rangeEnd: "2026-09-30" },
};

function deps(overrides: Partial<PrepareSendDeps> = {}): PrepareSendDeps {
  return {
    readSettings: vi.fn(async () => READY),
    readWriterContext: vi.fn(async (): Promise<WriterContext | null> => WRITER),
    selectActiveThread: vi.fn(async (scenarioId: string) => ({
      threadId: "thread-1",
      schemaVersion: 1 as const,
      scenarioId,
      state: "active" as const,
      globalGeneration: 0,
      scenarioGeneration: 0,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    })),
    readThreadMessages: vi.fn(async () => []),
    recordPreparingTurn: vi.fn(async (input) => ({
      ...input,
      turnId: "turn-1",
      schemaVersion: 1 as const,
      state: "preparing" as const,
      terminalReason: null,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    })),
    newRunId: () => "run-1",
    runtimeInstanceId: () => "instance-1",
    ...overrides,
  };
}

describe("the send gate refuses before it prepares", () => {
  it("refuses empty text without reading settings or ownership at all", async () => {
    const d = deps();

    for (const text of ["", "   ", "\n\t"]) {
      expect(await prepareSend({ text, turnEpoch: 1, busy: false }, d)).toEqual({
        ok: false,
        reason: "empty_message",
      });
    }
    expect(d.readSettings).not.toHaveBeenCalled();
    expect(d.readWriterContext).not.toHaveBeenCalled();
  });

  it("refuses a second concurrent turn on the same thread", async () => {
    const d = deps();
    expect(await prepareSend({ text: "hello", turnEpoch: 1, busy: true }, d)).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(d.recordPreparingTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["AI disabled", { ...READY, enabled: false }],
    ["no key", { ...READY, apiKey: null }],
    ["no model", { ...READY, modelId: null }],
  ])("refuses when not ready (%s) and never touches ownership", async (_label, settings) => {
    const d = deps({ readSettings: vi.fn(async () => settings as AssistantSettingsV1) });

    expect(await prepareSend({ text: "hello", turnEpoch: 1, busy: false }, d)).toEqual({
      ok: false,
      reason: "not_ready",
    });
    // Readiness is checked FIRST on purpose: a disabled app must not even ask about
    // the writer lease, let alone reach a network boundary.
    expect(d.readWriterContext).not.toHaveBeenCalled();
    expect(d.recordPreparingTurn).not.toHaveBeenCalled();
  });

  it("refuses when this tab does not own scenario editing, and records no turn", async () => {
    const d = deps({ readWriterContext: vi.fn(async () => null) });

    expect(await prepareSend({ text: "hello", turnEpoch: 1, busy: false }, d)).toEqual({
      ok: false,
      reason: "not_writer",
    });
    expect(d.selectActiveThread).not.toHaveBeenCalled();
    expect(d.recordPreparingTurn).not.toHaveBeenCalled();
  });

  it("has user-facing guidance for every refusal", () => {
    for (const reason of ["not_ready", "not_writer", "busy", "empty_message"] as const) {
      const text = describeRefusal(reason);
      expect(text.length).toBeGreaterThan(10);
      // No refusal message may hint at the credential's contents.
      expect(text).not.toContain(SENTINEL_KEY);
    }
  });
});

describe("a prepared send", () => {
  it("binds the turn to the reread envelope's identity, revision and lease epoch", async () => {
    const d = deps();

    const result = await prepareSend(
      { text: "  why is this infeasible?  ", turnEpoch: 9, busy: false },
      d,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({
      threadId: "thread-1",
      scenarioId: "scenario-a",
      documentRevision: 12,
      leaseEpoch: 4,
      modelId: TEST_MODEL,
      runId: "run-1",
      turnEpoch: 9,
      text: "why is this infeasible?",
    });
    expect(result.plan.turn.state).toBe("preparing");
    // The context is built from the PERSISTED document, not the live projection.
    expect(result.plan.scenario.rangeStart).toBe("2026-09-01");
  });

  it("selects the thread from the envelope's scenario id, not from a remembered one", async () => {
    const d = deps({
      readWriterContext: vi.fn(async () => ({ ...WRITER, scenarioId: "scenario-switched" })),
    });

    const result = await prepareSend({ text: "hello", turnEpoch: 1, busy: false }, d);

    expect(d.selectActiveThread).toHaveBeenCalledWith("scenario-switched");
    expect(result.ok && result.plan.scenarioId).toBe("scenario-switched");
  });

  it("persists the preparing turn BEFORE returning a plan the caller could run", async () => {
    const order: string[] = [];
    const d = deps({
      readThreadMessages: vi.fn(async () => {
        order.push("hydrate");
        return [];
      }),
      recordPreparingTurn: vi.fn(async (input) => {
        order.push("turn");
        return {
          ...input,
          turnId: "turn-1",
          schemaVersion: 1 as const,
          state: "preparing" as const,
          terminalReason: null,
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        };
      }),
    });

    await prepareSend({ text: "hello", turnEpoch: 1, busy: false }, d);

    expect(order).toEqual(["hydrate", "turn"]);
  });

  it("stamps the runtime instance so a restart detaches instead of reattaching", async () => {
    const d = deps({ runtimeInstanceId: () => null });

    const result = await prepareSend({ text: "hello", turnEpoch: 1, busy: false }, d);

    expect(result.ok && result.plan.turn.runtimeInstanceId).toBeNull();
  });
});
