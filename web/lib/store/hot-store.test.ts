import { describe, expect, it } from "vitest";
import { INITIAL_OPTIMIZE_RUN_VIEW, reduceRunView } from "@/lib/optimize/run-view";
import { createHotStore } from "./hot-store";
import { installTestAuthority } from "./test-authority";

// The hot store's contract is that ephemeral churn — SSE frames, run-view updates,
// UI scratch, drafts, an in-flight paint — costs ZERO durable writes.
//
// Post-T03 that is measured against the repository rather than against the persist
// middleware's `setItem`: a durable write is a COMMIT now, so the assertion is
// "no commit row appeared", which is both stronger and no longer coupled to a
// storage seam that has been deleted.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Durable commits recorded for the currently selected scenario. */
async function commitCount(harness: Awaited<ReturnType<typeof installTestAuthority>>) {
  const scenarioId = harness.authorityStore.getState().scenarioId!;
  return harness.db.scenarioCommits.where("scenarioId").equals(scenarioId).count();
}

describe("hot store never triggers a durable write", () => {
  it("100 run-state updates cause 0 durable scenario commits", async () => {
    const harness = await installTestAuthority();
    const baseline = await commitCount(harness);
    const hot = createHotStore();

    for (let i = 0; i < 100; i++) {
      hot.getState().setRun({ phase: "running", progress: i / 100 });
    }
    hot.getState().setRun({ phase: "running", progress: 0.99 });
    await flush();

    expect(hot.getState().run.progress).toBe(0.99);
    expect(await commitCount(harness)).toBe(baseline);
  });

  it("run/ui/draft churn stays in the hot store", () => {
    const hot = createHotStore();
    hot.getState().setUi({ selectedPerson: "p1" });
    hot.getState().setDraft("staff-form", { id: "p2" });
    hot.getState().setRun({ phase: "queued", jobId: "job-1" });

    expect(hot.getState().ui).toEqual({ selectedPerson: "p1" });
    expect(hot.getState().drafts).toEqual({ "staff-form": { id: "p2" } });
    expect(hot.getState().run.jobId).toBe("job-1");

    hot.getState().clearDraft("staff-form");
    expect(hot.getState().drafts).toEqual({});
  });

  it("resetEphemeral clears run/runView/ui/drafts/paint but keeps hydrationStatus", () => {
    const hot = createHotStore();
    hot.getState().setHydrationStatus("ready");
    hot.getState().setRun({ phase: "running", jobId: "job-1" });
    hot.getState().setRunView(
      reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
        type: "submit-started",
        anonymized: true,
        peopleCount: 3,
      }),
    );
    hot.getState().setUi({ selectedPerson: "p1" });
    hot.getState().setDraft("d", { x: 1 });
    hot.getState().beginPaint();
    hot.getState().stagePaintDayState("p1", "2026-01-01", { kind: "leave" });

    hot.getState().resetEphemeral();

    expect(hot.getState().run.phase).toBe("idle");
    expect(hot.getState().runView).toEqual(INITIAL_OPTIMIZE_RUN_VIEW);
    expect(hot.getState().ui).toEqual({});
    expect(hot.getState().drafts).toEqual({});
    expect(hot.getState().paint).toBeNull();
    // Status is deliberately preserved (owned by the lifecycle transition).
    expect(hot.getState().hydrationStatus).toBe("ready");
  });

  it("run view churn stays in the hot store and triggers zero durable commits", async () => {
    const harness = await installTestAuthority();
    const baseline = await commitCount(harness);
    const hot = createHotStore();

    let view = INITIAL_OPTIMIZE_RUN_VIEW;
    view = reduceRunView(view, { type: "submit-started", anonymized: false, peopleCount: 2 });
    for (let i = 0; i < 50; i += 1) {
      view = reduceRunView(view, {
        type: "progress",
        point: {
          source: "s",
          currentBestScore: i,
          elapsedSeconds: i,
          solutionIndex: i,
          commentCount: null,
        },
      });
      hot.getState().setRunView(view);
    }

    expect(hot.getState().runView.progress).toHaveLength(50);
    expect(hot.getState().runView.latestScore).toBe(49);
    expect(await commitCount(harness)).toBe(baseline);
  });

  it("resetRun and resetRunView both restore the zero run view", () => {
    const hot = createHotStore();
    hot.getState().setRunView(
      reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
        type: "submit-started",
        anonymized: true,
        peopleCount: 1,
      }),
    );
    hot.getState().resetRunView();
    expect(hot.getState().runView).toEqual(INITIAL_OPTIMIZE_RUN_VIEW);

    hot.getState().setRunView(
      reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
        type: "submit-started",
        anonymized: true,
        peopleCount: 1,
      }),
    );
    hot.getState().resetRun();
    expect(hot.getState().runView).toEqual(INITIAL_OPTIMIZE_RUN_VIEW);
  });

  it("resetRun, resetRunView, and resetEphemeral each bump runGeneration", () => {
    const hot = createHotStore();
    const gen0 = hot.getState().runGeneration;
    expect(gen0).toBe(0);

    hot.getState().resetRunView();
    expect(hot.getState().runGeneration).toBe(gen0 + 1);

    hot.getState().resetRun();
    expect(hot.getState().runGeneration).toBe(gen0 + 2);

    hot.getState().resetEphemeral();
    expect(hot.getState().runGeneration).toBe(gen0 + 3);
  });

  it("setRunView does NOT bump runGeneration (only reset paths revoke)", () => {
    const hot = createHotStore();
    const gen = hot.getState().runGeneration;
    hot.getState().setRunView(
      reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
        type: "submit-started",
        anonymized: true,
        peopleCount: 1,
      }),
    );
    expect(hot.getState().runGeneration).toBe(gen);
  });
});
