// T03F1 finding 6 — the 50-entry session bound must bound RETAINED PAYLOADS, not
// just cursor entries; and finding 8 — the repository refuses invalid documents and
// suppresses semantic no-ops.
//
// Both suites fail against the reviewed implementation: it attached full
// before/after snapshots to Undo/Redo navigation facts (which pruning never walked)
// and left superseded branch payloads live, so repeated Undo/Redo and undo-branch
// cycles grew durable storage without limit.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { isRepositoryError } from "./errors";
import { createHarness, sampleScenario } from "./test-support";
import type { ScenarioRepository } from "./repository";
import type { LeaseOwner } from "./types";

async function ownedScenario(repo: ScenarioRepository, tabId = "tab-1") {
  const selection = await repo.selectOrSwitchScenario({
    tabId,
    target: { kind: "load", scenario: sampleScenario() },
  });
  return { scenarioId: selection.envelope.scenarioId, owner: selection.owner! };
}

async function edit(repo: ScenarioRepository, owner: LeaseOwner, rangeStart: string) {
  const envelope = await repo.read(owner.scenarioId);
  return repo.commit({
    owner,
    expectedScenarioId: owner.scenarioId,
    expectedDocumentRevision: envelope.documentRevision,
    command: { type: "patch_scenario", patch: { rangeStart } },
  });
}

/** How many commits still carry reversal material. */
async function livePayloadCount(
  db: ReturnType<typeof createHarness>["db"],
  scenarioId: string,
): Promise<number> {
  const commits = await db.scenarioCommits.where("scenarioId").equals(scenarioId).toArray();
  return commits.filter((commit) => commit.reversiblePayload !== null).length;
}

describe("retained reversal payloads stay bounded", () => {
  it("Undo/Redo navigation facts carry no reversal payload at all", async () => {
    const { repo, db } = createHarness();
    const { scenarioId, owner } = await ownedScenario(repo);
    await edit(repo, owner, "2026-06-01");

    await repo.undo({
      owner,
      expectedDocumentRevision: (await repo.read(scenarioId)).documentRevision,
    });
    await repo.redo({
      owner,
      expectedDocumentRevision: (await repo.read(scenarioId)).documentRevision,
    });

    const commits = await db.scenarioCommits.where("scenarioId").equals(scenarioId).toArray();
    const navigation = commits.filter((c) => c.kind === "undo" || c.kind === "redo");
    expect(navigation).toHaveLength(2);
    // Nothing reverses an Undo — the cursor moves instead — so a payload here is a
    // full scenario document retained for no reader, and pruning never walked them.
    for (const fact of navigation) expect(fact.reversiblePayload).toBeNull();
    // The FACTS survive, which is what keeps the history honest.
    for (const fact of navigation) expect(fact.commitId).toBeTruthy();
  });

  it("repeated Undo/Redo cycles do not grow retained payloads", async () => {
    const { repo, db } = createHarness();
    const { scenarioId, owner } = await ownedScenario(repo);
    await edit(repo, owner, "2026-06-01");
    const baseline = await livePayloadCount(db, scenarioId);

    for (let i = 0; i < 12; i += 1) {
      await repo.undo({
        owner,
        expectedDocumentRevision: (await repo.read(scenarioId)).documentRevision,
      });
      await repo.redo({
        owner,
        expectedDocumentRevision: (await repo.read(scenarioId)).documentRevision,
      });
    }

    expect(await livePayloadCount(db, scenarioId)).toBe(baseline);
    // ...while every navigation fact is still durably recorded.
    const commits = await db.scenarioCommits.where("scenarioId").equals(scenarioId).toArray();
    expect(commits.filter((c) => c.kind === "undo")).toHaveLength(12);
    expect(commits.filter((c) => c.kind === "redo")).toHaveLength(12);
  });

  it("a superseded branch keeps its FACT but drops its payload", async () => {
    const { repo, db } = createHarness();
    const { scenarioId, owner } = await ownedScenario(repo);
    const branched = await edit(repo, owner, "2026-06-01");

    await repo.undo({
      owner,
      expectedDocumentRevision: (await repo.read(scenarioId)).documentRevision,
    });
    // A new edit while undone supersedes the branch — it can never be redone again.
    await edit(repo, owner, "2026-07-01");

    const superseded = await db.scenarioCommits.get(branched.commit!.commitId);
    expect(superseded?.supersededAt).not.toBeNull();
    expect(superseded?.reversiblePayload).toBeNull();
    expect(superseded?.payloadState).toBe("pruned");
  });

  it("undo-branch cycles keep retained payloads under the session bound", async () => {
    const { repo, db } = createHarness({ historyLimit: 5 });
    const { scenarioId, owner } = await ownedScenario(repo);

    for (let i = 0; i < 15; i += 1) {
      await edit(repo, owner, `2026-06-${String((i % 28) + 1).padStart(2, "0")}`);
      await repo.undo({
        owner,
        expectedDocumentRevision: (await repo.read(scenarioId)).documentRevision,
      });
    }

    // Every cycle branched over the previous edit. Retained payloads stay bounded.
    expect(await livePayloadCount(db, scenarioId)).toBeLessThanOrEqual(5);
    // The append-only facts are all still there.
    const commits = await db.scenarioCommits.where("scenarioId").equals(scenarioId).toArray();
    expect(commits.length).toBeGreaterThanOrEqual(30);
  });
});

describe("the repository refuses invalid documents inside the transaction", () => {
  it("a structurally invalid patch is refused and commits nothing", async () => {
    const { repo } = createHarness();
    const { scenarioId, owner } = await ownedScenario(repo);
    const before = await repo.read(scenarioId);

    await expect(
      repo.commit({
        owner,
        expectedScenarioId: scenarioId,
        expectedDocumentRevision: before.documentRevision,
        // `staff` must be a list of person objects. The generic patch primitive
        // shallow-applies whatever it is handed, and `pickScenario` allowlists KEYS
        // only — so nothing checked the value before this.
        command: { type: "patch_scenario", patch: { staff: "not a roster" } as never },
      }),
    ).rejects.toSatisfy((error: unknown) => isRepositoryError(error, "invalid_document"));

    const after = await repo.read(scenarioId);
    expect(after.documentRevision).toBe(before.documentRevision);
    expect(after.scenario.staff).toEqual(before.scenario.staff);
  });

  it("a valid patch still commits", async () => {
    const { repo } = createHarness();
    const { owner } = await ownedScenario(repo);
    const result = await edit(repo, owner, "2026-06-01");
    expect(result.commit).not.toBeNull();
  });
});

describe("semantic no-op content commands are suppressed", () => {
  it("a matrix write that changes nothing writes no commit", async () => {
    const { repo } = createHarness();
    const { scenarioId, owner } = await ownedScenario(repo);
    const before = await repo.read(scenarioId);

    // The same cells, rebuilt as fresh objects — which is exactly what a paint fold
    // or a Clear produces, and why a reference test cannot decide this.
    const result = await repo.commit({
      owner,
      expectedScenarioId: scenarioId,
      expectedDocumentRevision: before.documentRevision,
      command: { type: "set_req_data", reqData: structuredClone(before.scenario.reqData) },
    });

    expect(result.commit).toBeNull();
    expect(result.envelope.documentRevision).toBe(before.documentRevision);
    expect((await repo.describeHistory(scenarioId)).contentCount).toBe(0);
  });

  it("a Clear over an already-empty matrix writes no commit", async () => {
    const { repo } = createHarness();
    const selection = await repo.selectOrSwitchScenario({
      tabId: "tab-1",
      target: { kind: "new" },
    });
    const owner = selection.owner!;
    const before = await repo.read(owner.scenarioId);
    expect(before.scenario.reqData).toEqual([]);

    const result = await repo.commit({
      owner,
      expectedScenarioId: owner.scenarioId,
      expectedDocumentRevision: before.documentRevision,
      command: { type: "set_req_data", reqData: [] },
    });

    expect(result.commit).toBeNull();
    expect(result.envelope.documentRevision).toBe(before.documentRevision);
  });

  it("a matrix write that DOES change the cells still commits", async () => {
    const { repo } = createHarness();
    const { scenarioId, owner } = await ownedScenario(repo);
    const before = await repo.read(scenarioId);

    const result = await repo.commit({
      owner,
      expectedScenarioId: scenarioId,
      expectedDocumentRevision: before.documentRevision,
      command: { type: "set_req_data", reqData: [] },
    });

    expect(result.commit).not.toBeNull();
    expect(result.envelope.documentRevision).toBe(before.documentRevision + 1);
  });
});
