// A new period from a past schedule, through the authority (plq5 P3): the card's Create
// re-derives from the past schedule, refuses one that changed since the Preview, and
// otherwise is a Load that records where it came from. The past schedule is not written.

import { beforeEach, describe, expect, it } from "vitest";
import {
  persistThreadMessages,
  readThreadMessages,
  readThreadsForScenario,
  selectActiveThread,
} from "@/lib/ai/assistant/history-repo";
import { deriveNewPeriod, type PastRoster } from "@/lib/proposal";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { useAuthorityStore } from "./authority";
import { assistantProposalCommands, scenarioCommands } from "./commands";
import { loadScenario } from "./lifecycle";
import { createRosterStorageForDb } from "./roster-storage";
import { stateSpine } from "./spine";
import { installTestAuthority, type TestAuthority } from "./test-authority";

let harness: TestAuthority;

const APRIL: ScenarioUiState = {
  ...createEmptyScenarioUiState(),
  meta: { apiVersion: "alpha", description: "Ward 3" },
  rangeStart: "2026-04-01",
  rangeEnd: "2026-04-30",
  staff: [{ id: "ana" }, { id: "bo" }],
  shifts: [{ id: "D" }, { id: "N" }],
  reqData: [{ uid: "l", person: "ana", date: "02", kind: "leave" }],
};

function rosterFor(lastShift: string): PastRoster {
  const calendar = Array.from({ length: 30 }, (_, i) => ({
    iso: `2026-04-${String(i + 1).padStart(2, "0")}`,
    weekday: "Mon",
    weekend: false,
    holiday: false,
  }));
  const row = (last: string) =>
    calendar.map((_, i) =>
      i === 29 ? { kind: "shift" as const, shiftId: last } : { kind: "off" as const },
    );
  return {
    context: {
      people: [{ id: "ana" }, { id: "bo" }],
      shiftTypes: [{ id: "D" }, { id: "N" }],
      calendar,
      baselineMinimums: [],
      leaveCreditMinutes: null,
    },
    solvedDays: [row(lastShift), row("D")],
    edits: [],
  };
}

async function saveRoster(scenarioId: string, roster: PastRoster, revision: number | null) {
  const storage = createRosterStorageForDb(() => harness.db, scenarioId);
  await storage.promoteDocumentToWorking({
    document: roster,
    validate: (document) => ({ ok: true, document }),
    expectedWorkingRevision: revision,
    expectedClearEpoch: await storage.getClearEpoch(),
  });
}

/** April with a roster, then October open: the state the user asks from. */
async function aprilThenOctober(): Promise<string> {
  expect((await loadScenario(APRIL)).ok).toBe(true);
  const april = useAuthorityStore.getState().scenarioId!;
  await saveRoster(april, rosterFor("N"), null);
  await loadScenario({ ...APRIL, rangeStart: "2026-10-01", rangeEnd: "2026-10-31", reqData: [] });
  return april;
}

async function requestFor(april: string, range = { start: "2026-05-01", end: "2026-05-31" }) {
  const past = (await assistantProposalCommands.readPastSchedule(april))!;
  const derived = deriveNewPeriod(past.scenario, past.roster, range);
  if (!derived.ok) throw new Error(derived.message);
  return {
    sourceScenarioId: april,
    rangeStart: range.start,
    rangeEnd: range.end,
    expectedSourceRevision: past.documentRevision,
    expectedDigest: derived.plan.digest,
  };
}

beforeEach(async () => {
  harness = await installTestAuthority();
});

describe("reading a past schedule", () => {
  it("returns its document and roster without switching or writing", async () => {
    const april = await aprilThenOctober();
    const before = useAuthorityStore.getState();
    const aprilBefore = await harness.db.scenarioEnvelopes.get(april);

    const past = await assistantProposalCommands.readPastSchedule(april);
    expect(past).toMatchObject({ scenarioId: april, name: "Ward 3 · April 2026" });
    expect(past?.roster?.context.people).toHaveLength(2);
    expect(useAuthorityStore.getState().scenarioId).toBe(before.scenarioId);
    expect(await harness.db.scenarioEnvelopes.get(april)).toEqual(aprilBefore);
    expect(await assistantProposalCommands.readPastSchedule("nope")).toBeNull();
  });
});

describe("creating the new period", () => {
  it("creates and opens May with April's ward, rules and rest history, and keeps April", async () => {
    const april = await aprilThenOctober();
    const aprilBefore = await harness.db.scenarioEnvelopes.get(april);

    expect(await assistantProposalCommands.createNewPeriod(await requestFor(april))).toEqual({
      ok: true,
    });

    const state = useAuthorityStore.getState();
    expect(state).toMatchObject({ ownership: "owner", derivedFrom: "Ward 3 · April 2026" });
    expect(state.scenarioId).not.toBe(april);
    const may = stateSpine.scenario.getState();
    expect(may).toMatchObject({ rangeStart: "2026-05-01", rangeEnd: "2026-05-31", reqData: [] });
    expect(may.staff[0]!.history).toEqual(["OFF", "OFF", "OFF", "OFF", "OFF", "OFF", "N"]);
    expect(await harness.db.scenarioEnvelopes.get(april)).toEqual(aprilBefore);

    const rows = await scenarioCommands.listSchedules();
    expect(rows.find((row) => row.scenarioId === state.scenarioId)).toMatchObject({
      derivedFrom: "Ward 3 · April 2026",
      hasRoster: false,
      rangeStart: "2026-05-01",
    });
  });

  it("continues October's conversation in May; October keeps its own thread", async () => {
    const april = await aprilThenOctober();
    const october = useAuthorityStore.getState().scenarioId!;
    const config = { db: harness.db };
    const thread = await selectActiveThread(october, config);
    await persistThreadMessages(
      [
        { id: "m1", role: "user", content: "Based on April, create May." },
        { id: "m2", role: "assistant", content: "Here is May. Press Create." },
      ],
      {
        threadId: thread.threadId,
        scenarioId: october,
        modelId: "test/model",
        turnId: "turn-1",
        globalGeneration: thread.globalGeneration,
        scenarioGeneration: thread.scenarioGeneration,
        createdAt: new Date().toISOString(),
      },
      config,
    );
    const octoberBefore = await readThreadMessages(thread.threadId, config);

    expect((await assistantProposalCommands.createNewPeriod(await requestFor(april))).ok).toBe(
      true,
    );
    const may = useAuthorityStore.getState().scenarioId!;

    // The panel's own lookup finds the carried thread, with the same messages.
    const carried = await selectActiveThread(may, config);
    expect(carried.threadId).not.toBe(thread.threadId);
    const copies = await readThreadMessages(carried.threadId, config);
    expect(copies.map((m) => [m.seq, m.role, m.content])).toEqual(
      octoberBefore.map((m) => [m.seq, m.role, m.content]),
    );
    expect(copies.every((m) => m.scenarioId === may && m.turnId === null)).toBe(true);
    expect(copies.map((m) => m.messageId)).not.toContain("m1");

    // October keeps its thread, unchanged, and suspended.
    const [kept] = await readThreadsForScenario(october, config);
    expect(kept).toMatchObject({ threadId: thread.threadId, state: "historical" });
    expect(await readThreadMessages(thread.threadId, config)).toEqual(octoberBefore);
  });

  it("a Preview prepared on October before Create cannot be applied after it", async () => {
    const april = await aprilThenOctober();
    const prepared = await assistantProposalCommands.prepare({
      proposalId: crypto.randomUUID(),
      threadId: "thread-1",
      turnId: "turn-1",
      registryStamp: { appBuildVersion: "test-build", manifestSha256: "test-manifest" },
      commands: [
        {
          type: "set_roster_range",
          start: "2026-10-01",
          end: "2026-10-15",
          importPublicHolidays: false,
        },
      ],
      rationale: "Because you asked.",
      evidence: [],
      outcome: "untested",
    });
    if (!prepared.ok) throw new Error("prepare failed");

    expect((await assistantProposalCommands.createNewPeriod(await requestFor(april))).ok).toBe(
      true,
    );
    const may = useAuthorityStore.getState().documentRevision;

    const applied = await assistantProposalCommands.apply({
      proposalId: prepared.proposal.proposalId,
      receiptId: crypto.randomUUID(),
    });
    expect(applied.ok).toBe(false);
    expect(useAuthorityStore.getState().documentRevision).toBe(may);
    expect(stateSpine.scenario.getState().rangeEnd).toBe("2026-05-31");
  });

  it("refuses when April's document changed since the preview", async () => {
    const april = await aprilThenOctober();
    const request = await requestFor(april);
    const october = useAuthorityStore.getState().scenarioId;
    await scenarioCommands.openSchedule(april);
    await scenarioCommands.mutate({ staff: [...APRIL.staff, { id: "cai" }] });
    await scenarioCommands.openSchedule(october!);

    expect(await assistantProposalCommands.createNewPeriod(request)).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(useAuthorityStore.getState().scenarioId).toBe(october);
  });

  it("refuses when April's roster changed since the preview", async () => {
    const april = await aprilThenOctober();
    const request = await requestFor(april);
    await saveRoster(april, rosterFor("D"), 1);
    expect(await assistantProposalCommands.createNewPeriod(request)).toEqual({
      ok: false,
      reason: "changed",
    });
  });

  it("refuses the source revision inside the switch, not only before it", async () => {
    const april = await aprilThenOctober();
    const request = await requestFor(april);
    const past = (await assistantProposalCommands.readPastSchedule(april))!;
    await expect(
      harness.authority["repository"].selectOrSwitchScenario({
        tabId: harness.tabId,
        target: {
          kind: "derive",
          scenario: past.scenario,
          derivedFrom: { scenarioId: april, title: past.name },
          expectedSourceRevision: request.expectedSourceRevision + 1,
        },
        acquire: false,
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
  });

  it("says the source is gone when it was deleted", async () => {
    const april = await aprilThenOctober();
    const request = await requestFor(april);
    expect(await scenarioCommands.deleteSchedule(april)).toEqual({ ok: true });
    expect(await assistantProposalCommands.createNewPeriod(request)).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});
