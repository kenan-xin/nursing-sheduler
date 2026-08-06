import { describe, expect, it, vi } from "vitest";

import { LEASE_TTL_MS } from "@/lib/repository";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import { readWriterContext } from "./writer-context";
import { createAssistantHarness, type AssistantHarness } from "./test-support";

const SCENARIO_ID = "scenario-a";
const TAB_ID = "tab-1";

async function seed(
  harness: AssistantHarness,
  overrides: { ownerTabId?: string; expiresAt?: string; epoch?: number } = {},
): Promise<void> {
  const at = harness.now();
  await harness.db.scenarioEnvelopes.put({
    scenarioId: SCENARIO_ID,
    schemaVersion: 3,
    documentRevision: 12,
    recordRevision: 20,
    acceptedLeaseEpoch: overrides.epoch ?? 4,
    topCommitId: "commit-1",
    historySessionId: "session-1",
    historyCursor: 1,
    scenario: { ...createEmptyScenarioUiState(), rangeStart: "2026-09-01" },
    backupFingerprint: null,
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
  });
  await harness.db.writerLeases.put({
    scenarioId: SCENARIO_ID,
    ownerTabId: overrides.ownerTabId ?? TAB_ID,
    epoch: overrides.epoch ?? 4,
    heartbeatAt: at.toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(at.getTime() + LEASE_TTL_MS).toISOString(),
  });
}

function ownership(isOwner: boolean) {
  return vi.fn(async () => ({
    scenarioId: SCENARIO_ID,
    documentRevision: 12,
    recordRevision: 20,
    isOwner,
  }));
}

describe("the authoritative writer context", () => {
  it("returns the identity, revision, epoch and CONTENT from the persisted envelope", async () => {
    const harness = createAssistantHarness();
    await seed(harness);

    const context = await readWriterContext({
      readOwnership: ownership(true),
      tabId: () => TAB_ID,
      now: harness.now,
    });

    expect(context).toMatchObject({
      scenarioId: SCENARIO_ID,
      documentRevision: 12,
      leaseEpoch: 4,
    });
    // Content and revision come from the same read, so a document can never be
    // labelled with a revision that does not describe it.
    expect(context?.scenario.rangeStart).toBe("2026-09-01");
  });

  it("refuses when no scenario is selected", async () => {
    createAssistantHarness();

    const context = await readWriterContext({
      readOwnership: vi.fn(async () => null),
      tabId: () => TAB_ID,
    });

    expect(context).toBeNull();
  });

  it("refuses when the app's own ownership gate says this tab is not the writer", async () => {
    const harness = createAssistantHarness();
    await seed(harness);

    expect(
      await readWriterContext({
        readOwnership: ownership(false),
        tabId: () => TAB_ID,
        now: harness.now,
      }),
    ).toBeNull();
  });

  it("refuses when the persisted lease names another tab, even if the gate said owner", async () => {
    const harness = createAssistantHarness();
    // The exact race this second read exists for: a peer took over between the
    // ownership read and this one, and its BroadcastChannel hint has not landed.
    await seed(harness, { ownerTabId: "tab-2", epoch: 5 });

    expect(
      await readWriterContext({
        readOwnership: ownership(true),
        tabId: () => TAB_ID,
        now: harness.now,
      }),
    ).toBeNull();
  });

  it("refuses an expired lease", async () => {
    const harness = createAssistantHarness();
    await seed(harness, { expiresAt: harness.now().toISOString() });

    expect(
      await readWriterContext({
        readOwnership: ownership(true),
        tabId: () => TAB_ID,
        now: harness.now,
      }),
    ).toBeNull();
  });

  it("refuses when the lease row is missing entirely", async () => {
    const harness = createAssistantHarness();
    await seed(harness);
    await harness.db.writerLeases.delete(SCENARIO_ID);

    expect(
      await readWriterContext({
        readOwnership: ownership(true),
        tabId: () => TAB_ID,
        now: harness.now,
      }),
    ).toBeNull();
  });
});
