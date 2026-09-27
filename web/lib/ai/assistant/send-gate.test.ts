import { describe, expect, it, vi } from "vitest";

import { createEmptyScenarioUiState } from "@/lib/scenario";
import { emptyAssistantSettings, type AssistantSettingsV1 } from "./records";
import {
  authorizeLaunchAuthority,
  authorizeLaunchIdentity,
  claimLaunchAuthority,
  describeRefusal,
  prepareSend,
  type LaunchAuthorityDeps,
  type LaunchIdentityInput,
  type LaunchLiveInput,
  type LiveAuthorityProjection,
  type PrepareSendDeps,
  type SendPlan,
  type SendRefusal,
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
    deleteTurnMessages: vi.fn(async () => ({ removed: 1 })),
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

// RETRY REPLACES THE FAILED TURN, AND THE GATE IS WHAT AUTHORISES THE REPLACEMENT.
//
// The deletion sits INSIDE preparation, after every refusal and before the history
// the run will hydrate is read. That placement is the guarantee, not tidiness: a
// retry that is refused (not ready, not this tab's, an interruption still settling)
// must leave the failed turn exactly where it is, and a retry that proceeds must not
// see its own question twice -- once from the failed turn on disk, once as the
// message this send is about to add.
describe("a retry that replaces a failed turn", () => {
  it("deletes the failed turn BEFORE reading the history the run hydrates", async () => {
    const order: string[] = [];
    const d = deps({
      deleteTurnMessages: vi.fn(async () => {
        order.push("replace");
        return { removed: 1 };
      }),
      readThreadMessages: vi.fn(async () => {
        order.push("hydrate");
        return [];
      }),
    });

    const result = await prepareSend(
      {
        text: "and the 16th?",
        turnEpoch: 2,
        busy: false,
        interrupting: false,
        replaceTurnId: "turn-failed",
      },
      d,
    );

    expect(result.ok).toBe(true);
    expect(d.deleteTurnMessages).toHaveBeenCalledWith("turn-failed");
    expect(order).toEqual(["replace", "hydrate"]);
  });

  it("leaves the failed turn alone for an ordinary send", async () => {
    const d = deps();

    await prepareSend({ text: "hello", turnEpoch: 1, busy: false, interrupting: false }, d);

    expect(d.deleteTurnMessages).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the assistant is not ready",
      { text: "hello", turnEpoch: 1, busy: false, interrupting: false },
      { readSettings: vi.fn(async () => ({ ...READY, enabled: false })) },
    ],
    [
      "a turn is already in flight",
      { text: "hello", turnEpoch: 1, busy: true, interrupting: false },
      {},
    ],
    [
      "an interruption is still settling",
      { text: "hello", turnEpoch: 1, busy: false, interrupting: true },
      {},
    ],
    [
      "this tab does not own the scenario",
      { text: "hello", turnEpoch: 1, busy: false, interrupting: false },
      { readWriterContext: vi.fn(async () => null) },
    ],
  ] as const)(
    "does not replace the failed turn when the retry is refused because %s",
    async (_label, input, overrides) => {
      const d = deps(overrides as Partial<PrepareSendDeps>);

      const result = await prepareSend({ ...input, replaceTurnId: "turn-failed" }, d);

      expect(result.ok).toBe(false);
      expect(d.deleteTurnMessages).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a clear has moved the generations under it", "fenced"],
    ["the turn row is already gone", "missing"],
  ] as const)(
    "refuses when %s, rather than resending beside the failed turn",
    async (_l, outcome) => {
      const d = deps({ deleteTurnMessages: vi.fn(async () => outcome) });

      const result = await prepareSend(
        {
          text: "and the 16th?",
          turnEpoch: 2,
          busy: false,
          interrupting: false,
          replaceTurnId: "turn-failed",
        },
        d,
      );

      // Unreplaceable means the question would be asked TWICE, which is the defect the
      // replacement exists to prevent. Nothing was prepared and nothing was sent.
      expect(result).toEqual({ ok: false, reason: "cleared" });
      expect(d.recordPreparingTurn).not.toHaveBeenCalled();
    },
  );
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

/** The authority projection as it stands while the turn's basis is still current. */
const LIVE: LiveAuthorityProjection = {
  scenarioId: WRITER.scenarioId,
  documentRevision: WRITER.documentRevision,
  isOwner: true,
};

function live(plan: SendPlan, overrides: Partial<LaunchLiveInput> = {}): LaunchLiveInput {
  return {
    plan,
    boundThreadId: plan.threadId,
    liveTurnEpoch: plan.turnEpoch,
    interrupting: false,
    busy: false,
    activeRunId: null,
    live: LIVE,
    ...overrides,
  };
}

function identity(
  plan: SendPlan,
  overrides: Partial<LaunchIdentityInput> = {},
): LaunchIdentityInput {
  // The claim a launch that has just reread its persisted authority would carry.
  return { ...live(plan), claim: WRITER, ...overrides };
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

// The window this closes: the durable rereads are followed by the streaming-state
// write, and an ordinary same-tab commit or a peer's lease advance in that gap moves
// no turn epoch, invalidates no turn row and requires no interruption. So the
// synchronous check has to compare document authority itself -- from the claim that
// was reread after the last durable write, and from the projection as it stands with
// no await in between.
describe("document and lease authority in the synchronous check", () => {
  const claimAs = (change: Partial<WriterContext> | null): Partial<LaunchIdentityInput> => ({
    claim: change === null ? null : { ...WRITER, ...change },
  });
  const liveAs = (change: Partial<LiveAuthorityProjection>): Partial<LaunchIdentityInput> => ({
    live: { ...LIVE, ...change },
  });

  const CASES: readonly [string, Partial<LaunchIdentityInput>, SendRefusal][] = [
    ["a launch carrying no persisted claim at all", claimAs(null), "not_writer"],
    [
      "a claim whose scenario is not the prepared one",
      claimAs({ scenarioId: "scenario-b" }),
      "not_writer",
    ],
    ["a claim under a lease epoch the turn never saw", claimAs({ leaseEpoch: 5 }), "not_writer"],
    [
      "a claim at a revision the turn was not prepared against",
      claimAs({ documentRevision: 13 }),
      "revoked",
    ],
    ["a commit published after the claim was taken", liveAs({ documentRevision: 13 }), "revoked"],
    ["ownership lost after the claim was taken", liveAs({ isOwner: false }), "not_writer"],
    [
      "a scenario switched after the claim was taken",
      liveAs({ scenarioId: "scenario-b" }),
      "not_writer",
    ],
  ];

  it.each(CASES)("refuses %s", async (_label, overrides, reason) => {
    const plan = await planFor();
    expect(authorizeLaunchIdentity(identity(plan, overrides))).toEqual({ ok: false, reason });
  });
});

describe("the launch claim", () => {
  it("returns the persisted authority a launch may run under", async () => {
    const plan = await planFor();

    await expect(
      claimLaunchAuthority(plan, { readWriterContext: async () => WRITER }),
    ).resolves.toEqual({ ok: true, writer: WRITER });
  });

  const CLAIM_CASES: readonly [string, WriterContext | null, SendRefusal][] = [
    ["ownership was lost after the durable rereads", null, "not_writer"],
    [
      "the scenario switched after the durable rereads",
      { ...WRITER, scenarioId: "scenario-b" },
      "not_writer",
    ],
    ["the lease advanced after the durable rereads", { ...WRITER, leaseEpoch: 5 }, "not_writer"],
    [
      "the schedule was committed after the durable rereads",
      { ...WRITER, documentRevision: 13 },
      "revoked",
    ],
  ];

  it.each(CLAIM_CASES)("refuses when %s", async (_label, writer, reason) => {
    const plan = await planFor();

    await expect(
      claimLaunchAuthority(plan, { readWriterContext: async () => writer }),
    ).resolves.toEqual({ ok: false, reason });
  });
});

describe("the durable half of the launch authorization", () => {
  it("authorises a turn whose whole basis is unchanged", async () => {
    const plan = await planFor();
    await expect(authorizeLaunchAuthority(live(plan), authorityDeps(plan))).resolves.toEqual({
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
        authorizeLaunchAuthority(live(plan), authorityDeps(plan, overrides)),
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
          live(plan),
          authorityDeps(plan, { readThread: async () => ({ ...thread!, state }) }),
        ),
      ).resolves.toEqual({ ok: false, reason: "cleared" });
    },
  );

  it("refuses a turn an interruption already settled", async () => {
    const plan = await planFor();

    await expect(
      authorizeLaunchAuthority(
        live(plan),
        authorityDeps(plan, {
          readTurn: async () => ({ ...plan.turn, state: "detached" as const }),
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "revoked" });
  });

  it("still applies the synchronous checks after the durable rereads", async () => {
    const plan = await planFor();

    await expect(
      authorizeLaunchAuthority(live(plan, { liveTurnEpoch: 99 }), authorityDeps(plan)),
    ).resolves.toEqual({ ok: false, reason: "revoked" });
  });
});
