import { describe, expect, it, vi } from "vitest";

import { createEmptyScenarioUiState } from "@/lib/scenario";
import { emptyAssistantSettings, type AssistantSettingsV1 } from "./records";
import {
  authorizeLaunchAuthority,
  authorizeLaunchIdentity,
  describeRefusal,
  prepareSend,
  type LaunchAuthorityDeps,
  type LaunchIdentityInput,
  type PrepareSendDeps,
  type SendPlan,
} from "./send-gate";
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
      interruptionTrigger: null,
      globalGeneration: 2,
      scenarioGeneration: 5,
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
      expect(
        await prepareSend({ text, turnEpoch: 1, busy: false, interrupting: false }, d),
      ).toEqual({
        ok: false,
        reason: "empty_message",
      });
    }
    expect(d.readSettings).not.toHaveBeenCalled();
    expect(d.readWriterContext).not.toHaveBeenCalled();
  });

  it("refuses a second concurrent turn on the same thread", async () => {
    const d = deps();
    expect(
      await prepareSend({ text: "hello", turnEpoch: 1, busy: true, interrupting: false }, d),
    ).toEqual({
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

    expect(
      await prepareSend({ text: "hello", turnEpoch: 1, busy: false, interrupting: false }, d),
    ).toEqual({
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

    expect(
      await prepareSend({ text: "hello", turnEpoch: 1, busy: false, interrupting: false }, d),
    ).toEqual({
      ok: false,
      reason: "not_writer",
    });
    expect(d.selectActiveThread).not.toHaveBeenCalled();
    expect(d.recordPreparingTurn).not.toHaveBeenCalled();
  });

  it("refuses while an interruption is still settling, before any provider contact", async () => {
    const d = deps();

    expect(
      await prepareSend({ text: "hello", turnEpoch: 1, busy: false, interrupting: true }, d),
    ).toEqual({ ok: false, reason: "interrupting" });
    // Stop and Clear history both leave a Ready configuration behind, so readiness
    // cannot be what closes this door.
    expect(d.readSettings).not.toHaveBeenCalled();
    expect(d.recordPreparingTurn).not.toHaveBeenCalled();
  });

  it("refuses when the thread was cleared between selection and the turn write", async () => {
    const d = deps({ recordPreparingTurn: vi.fn(async () => null) });

    expect(
      await prepareSend({ text: "hello", turnEpoch: 1, busy: false, interrupting: false }, d),
    ).toEqual({ ok: false, reason: "cleared" });
  });

  it("has user-facing guidance for every refusal", () => {
    for (const reason of [
      "not_ready",
      "not_writer",
      "busy",
      "empty_message",
      "interrupting",
      "cleared",
      "revoked",
    ] as const) {
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
      { text: "  why is this infeasible?  ", turnEpoch: 9, busy: false, interrupting: false },
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
      // Carried from the turn row, so every write for this send is fenced on the
      // exact generations the turn was authorised under.
      globalGeneration: 2,
      scenarioGeneration: 5,
    });
    expect(result.plan.turn.state).toBe("preparing");
    // The context is built from the PERSISTED document, not the live projection.
    expect(result.plan.scenario.rangeStart).toBe("2026-09-01");
  });

  it("selects the thread from the envelope's scenario id, not from a remembered one", async () => {
    const d = deps({
      readWriterContext: vi.fn(async () => ({ ...WRITER, scenarioId: "scenario-switched" })),
    });

    const result = await prepareSend(
      { text: "hello", turnEpoch: 1, busy: false, interrupting: false },
      d,
    );

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
          interruptionTrigger: null,
          globalGeneration: 0,
          scenarioGeneration: 0,
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        };
      }),
    });

    await prepareSend({ text: "hello", turnEpoch: 1, busy: false, interrupting: false }, d);

    expect(order).toEqual(["hydrate", "turn"]);
  });

  it("stamps the runtime instance so a restart detaches instead of reattaching", async () => {
    const d = deps({ runtimeInstanceId: () => null });

    const result = await prepareSend(
      { text: "hello", turnEpoch: 1, busy: false, interrupting: false },
      d,
    );

    expect(result.ok && result.plan.turn.runtimeInstanceId).toBeNull();
  });

  it("captures the configuration identity it was prepared against", async () => {
    const result = await prepareSend(
      { text: "hello", turnEpoch: 1, busy: false, interrupting: false },
      deps(),
    );

    // Non-secret by construction: model, probe time and row revision, never the key.
    expect(result.ok && result.plan.configurationIdentity).toContain(TEST_MODEL);
    expect(result.ok && result.plan.configurationIdentity).not.toContain(SENTINEL_KEY);
  });
});

// ---------------------------------------------------------------------------
// The final launch authorization
// ---------------------------------------------------------------------------

async function planFor(overrides: Partial<PrepareSendDeps> = {}): Promise<SendPlan> {
  const result = await prepareSend(
    { text: "why is this infeasible?", turnEpoch: 9, busy: false, interrupting: false },
    deps(overrides),
  );
  if (!result.ok) throw new Error(`expected a plan, got ${result.reason}`);
  return result.plan;
}

function identity(plan: SendPlan, overrides: Partial<LaunchIdentityInput> = {}) {
  return {
    plan,
    boundThreadId: plan.threadId,
    liveTurnEpoch: plan.turnEpoch,
    interrupting: false,
    busy: false,
    activeRunId: null,
    ...overrides,
  } satisfies LaunchIdentityInput;
}

function authorityDeps(
  plan: SendPlan,
  overrides: Partial<LaunchAuthorityDeps> = {},
): LaunchAuthorityDeps {
  return {
    readSettings: async () => READY,
    readWriterContext: async () => WRITER,
    readThread: async () => ({
      threadId: plan.threadId,
      schemaVersion: 1 as const,
      scenarioId: plan.scenarioId,
      state: "active" as const,
      globalGeneration: plan.globalGeneration,
      scenarioGeneration: plan.scenarioGeneration,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    }),
    readTurn: async () => plan.turn,
    ...overrides,
  };
}

describe("the synchronous half of the launch authorization", () => {
  it("authorises a turn that is still the live one", async () => {
    const plan = await planFor();
    expect(authorizeLaunchIdentity(identity(plan))).toEqual({ ok: true });
  });

  it.each([
    [
      "an interruption that has been requested but not settled",
      { interrupting: true },
      "interrupting",
    ],
    ["an epoch that moved during preparation", { liveTurnEpoch: 10 }, "revoked"],
    ["a run already in flight", { busy: true }, "busy"],
    ["another send that won the race to launch", { activeRunId: "run-other" }, "busy"],
    ["a panel bound to a different thread", { boundThreadId: "thread-other" }, "not_writer"],
  ] as const)("refuses %s", async (_label, overrides, reason) => {
    const plan = await planFor();
    expect(authorizeLaunchIdentity(identity(plan, overrides))).toEqual({ ok: false, reason });
  });

  it("accepts the run it published for itself", async () => {
    const plan = await planFor();
    expect(authorizeLaunchIdentity(identity(plan, { activeRunId: plan.runId }))).toEqual({
      ok: true,
    });
  });
});

describe("the durable half of the launch authorization", () => {
  it("authorises a turn whose whole basis is unchanged", async () => {
    const plan = await planFor();
    await expect(authorizeLaunchAuthority(identity(plan), authorityDeps(plan))).resolves.toEqual({
      ok: true,
    });
  });

  const settingsAs = (change: Partial<AssistantSettingsV1>): Partial<LaunchAuthorityDeps> => ({
    readSettings: async (): Promise<AssistantSettingsV1> => ({ ...READY, ...change }),
  });
  const writerAs = (change: Partial<WriterContext> | null): Partial<LaunchAuthorityDeps> => ({
    readWriterContext: async (): Promise<WriterContext | null> =>
      change === null ? null : { ...WRITER, ...change },
  });

  it.each([
    ["AI turned off", settingsAs({ enabled: false }), "not_ready"],
    ["the key removed", settingsAs({ apiKey: null }), "not_ready"],
    ["the model replaced", settingsAs({ modelId: "vendor/other" }), "revoked"],
    [
      "the key replaced under the same model",
      settingsAs({ probedAt: "2026-08-06T00:00:01.000Z" }),
      "revoked",
    ],
    ["ownership lost", writerAs(null), "not_writer"],
    ["the scenario switched", writerAs({ scenarioId: "scenario-b" }), "not_writer"],
    ["the lease reissued under a new epoch", writerAs({ leaseEpoch: 5 }), "not_writer"],
    ["the document committed under it", writerAs({ documentRevision: 13 }), "revoked"],
    [
      "the thread deleted",
      { readThread: async (): Promise<null> => null } satisfies Partial<LaunchAuthorityDeps>,
      "cleared",
    ],
    [
      "the turn deleted by a clear",
      { readTurn: async (): Promise<null> => null } satisfies Partial<LaunchAuthorityDeps>,
      "cleared",
    ],
  ] as const)(
    "refuses after %s, before any provider contact",
    async (_label, overrides, reason) => {
      const plan = await planFor();

      await expect(
        authorizeLaunchAuthority(identity(plan), authorityDeps(plan, overrides)),
      ).resolves.toEqual({ ok: false, reason });
    },
  );

  it.each(["cleared", "historical"] as const)(
    "refuses when the thread became %s during preparation",
    async (state) => {
      const plan = await planFor();
      const thread = await authorityDeps(plan).readThread(plan.threadId);

      await expect(
        authorizeLaunchAuthority(
          identity(plan),
          authorityDeps(plan, { readThread: async () => ({ ...thread!, state }) }),
        ),
      ).resolves.toEqual({ ok: false, reason: "cleared" });
    },
  );

  it("refuses a turn an interruption already settled", async () => {
    const plan = await planFor();

    await expect(
      authorizeLaunchAuthority(
        identity(plan),
        authorityDeps(plan, {
          readTurn: async () => ({ ...plan.turn, state: "detached" as const }),
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "revoked" });
  });

  it("still applies the synchronous checks after the durable rereads", async () => {
    const plan = await planFor();

    await expect(
      authorizeLaunchAuthority(identity(plan, { liveTurnEpoch: 99 }), authorityDeps(plan)),
    ).resolves.toEqual({ ok: false, reason: "revoked" });
  });
});
