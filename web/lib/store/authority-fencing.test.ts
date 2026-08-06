// T03F1 findings 3, 5, 7 and 8 at the AUTHORITY layer.
//
// Every test here fails against the reviewed implementation: lifecycle work ran on
// its own timeline (so a stale continuation could clear a newer owner), a single
// failed command pinned the write status at `error` forever, a publish failure only
// set a flag instead of fencing later writes, and a duplicated tab shared its
// opener's identity.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import { useAuthorityStore } from "./authority";
import { drainScenarioCommands, scenarioCommands } from "./commands";
import { stateSpine } from "./spine";
import { installTestAuthority, type TestAuthority } from "./test-authority";

const { scenario } = stateSpine;

let harness: TestAuthority;

beforeEach(async () => {
  harness = await installTestAuthority();
});

describe("stale lifecycle continuations cannot clear a newer owner", () => {
  it("a heartbeat rejection from a superseded era does not go read-only", async () => {
    // The race: this tab's heartbeat fails because a peer took over, the user takes
    // editing back, and only THEN does the rejection resolve. Acting on it cleared an
    // ownership the tab legitimately held.
    const peer = await installTestAuthority({
      databaseName: harness.databaseName,
      install: false,
    });
    await peer.authority.initialize();
    await peer.authority.takeover();
    // This tab is now superseded; its next heartbeat will be refused.
    const rejected = harness.authority.heartbeat();

    // The user takes editing back before the rejection is handled.
    const retaken = await harness.authority.takeover();
    expect(retaken.ok).toBe(true);

    await rejected;
    await drainScenarioCommands();

    // Still the owner: the stale rejection belonged to an era that has ended.
    expect(useAuthorityStore.getState().ownership).toBe("owner");
    const outcome = await scenarioCommands.mutate({ rangeStart: "2026-06-01" });
    expect(outcome.ok).toBe(true);
  });

  it("a reconcile that read the OLD scenario cannot republish it over a switch", async () => {
    // `reconcile` is serialized with commands now. Loose, a reconcile that had
    // already read scenario A resolved after a queued switch to B and republished A.
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    const first = useAuthorityStore.getState().scenarioId;

    // Issue both without awaiting, reconcile first.
    const reconciled = scenarioCommands.reconcile();
    const switched = harness.authority.newScenario();

    await Promise.all([reconciled, switched]);
    await drainScenarioCommands();

    // The switch is the last thing the user asked for, and it stands.
    expect(useAuthorityStore.getState().scenarioId).not.toBe(first);
    expect(scenario.getState().rangeStart).toBe("");
    expect(useAuthorityStore.getState().ownership).toBe("owner");
  });
});

describe("write status follows the LATEST settled command", () => {
  it("a later success clears an earlier failure", async () => {
    // Only a `writing` status could settle to `saved`, so one failure pinned the
    // badge at "Save failed" for the rest of the session and kept the unload guard
    // armed over work that had actually saved.
    const failing = await scenarioCommands.mutate({ staff: "not a roster" } as never);
    expect(failing.ok).toBe(false);
    expect(useAuthorityStore.getState().writeStatus).toBe("error");

    const succeeding = await scenarioCommands.mutate({ rangeStart: "2026-04-01" });

    expect(succeeding.ok).toBe(true);
    expect(useAuthorityStore.getState().writeStatus).toBe("saved");
  });
});

describe("a publish failure hard-fences every later write", () => {
  it("commands are refused until an authoritative reload", async () => {
    // `reloadRequired` used to be a notice only. The projection no longer describes
    // the committed document, so every later patch is computed from the wrong state —
    // and would commit successfully, overwriting real work.
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    const committed = await harness.db.scenarioEnvelopes.get(
      useAuthorityStore.getState().scenarioId!,
    );

    // Force the publish step to fail on the next commit.
    const setState = vi.spyOn(scenario, "setState").mockImplementation(() => {
      throw new Error("projection publish failed");
    });
    await scenarioCommands.mutate({ rangeStart: "2026-05-01" });
    setState.mockRestore();

    expect(useAuthorityStore.getState().reloadRequired).toBe(true);

    const later = await scenarioCommands.mutate({ rangeEnd: "2099-12-31" });
    expect(later).toMatchObject({ ok: false, reason: "reload-required" });
    // Undo is fenced too — it would reverse against a view nobody can trust.
    expect(await scenarioCommands.undo()).toMatchObject({
      ok: false,
      reason: "reload-required",
    });

    // Nothing after the publish failure reached the durable envelope.
    const envelope = await harness.db.scenarioEnvelopes.get(
      useAuthorityStore.getState().scenarioId!,
    );
    expect(envelope?.scenario.rangeEnd).toBe(committed?.scenario.rangeEnd);
  });

  it("a New/Load switch is fenced too", async () => {
    useAuthorityStore.setState({ reloadRequired: true });
    expect(await harness.authority.newScenario()).toMatchObject({
      ok: false,
      reason: "reload-required",
    });
  });
});

describe("corrupt durable state produces no editable authority", () => {
  it("bring-up fails rather than publishing an empty workspace", async () => {
    // An unreadable legacy record used to come up as a healthy blank workspace. The
    // shell's `recoverable-error` surface is the only honest place to land.
    const databaseName = `nurse-scheduler-corrupt-${Math.trunc(Date.now() % 1e9)}`;
    const seeded = await installTestAuthority({ databaseName, install: false });
    await seeded.db.keyval.put({ key: "nurse-scheduler/scenario", value: "{ not json" });
    seeded.db.close();

    const fresh = await installTestAuthority({ databaseName, install: false });
    await expect(fresh.authority.initialize()).rejects.toThrow(/could not be read/i);
    // No scenario was minted, so there is nothing to edit and nothing to lose.
    expect(await fresh.db.scenarioEnvelopes.count()).toBe(0);
    expect((await fresh.db.keyval.get("nurse-scheduler/scenario"))?.value).toBe("{ not json");
  });
});

describe("the empty-scenario baseline is unchanged", () => {
  it("a fresh scenario still publishes the empty default", async () => {
    await harness.authority.newScenario();
    expect(scenario.getState().rangeStart).toBe(createEmptyScenarioUiState().rangeStart);
  });
});
