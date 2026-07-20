import { describe, expect, it, vi } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { INITIAL_OPTIMIZE_RUN_VIEW, reduceRunView } from "@/lib/optimize/run-view";
import { createMemoryStorage } from "./persistence";
import { createScenarioStore } from "./scenario-store";
import { createHotStore } from "./hot-store";

/** In-memory durable storage with a spied `setItem` to count persist writes. */
function spyStorage(): StateStorage & { writes: () => number } {
  const mem = createMemoryStorage();
  const setItem = vi.fn((name: string, value: string) => mem.setItem(name, value));
  return {
    getItem: (name) => mem.getItem(name),
    setItem,
    removeItem: (name) => mem.removeItem(name),
    writes: () => setItem.mock.calls.length,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("hot store never triggers a durable write", () => {
  it("100 SSE progress updates cause 0 scenario persist writes", async () => {
    const storage = spyStorage();
    createScenarioStore({ createStorage: () => storage });
    const hot = createHotStore();

    for (let i = 0; i < 100; i++) {
      hot.getState().pushProgress({ phase: "running", progress: i / 100 });
    }
    hot.getState().setRun({ phase: "running", progress: 0.99 });
    await flush();

    expect(hot.getState().progress).toHaveLength(100);
    expect(storage.writes()).toBe(0);
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

  it("resetEphemeral clears run/runView/progress/ui/drafts/paint but keeps hydrationStatus", () => {
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
    hot.getState().pushProgress({ progress: 0.5 });
    hot.getState().setUi({ selectedPerson: "p1" });
    hot.getState().setDraft("d", { x: 1 });
    hot.getState().beginPaint();
    hot.getState().stagePaintDayState("p1", "2026-01-01", { kind: "leave" });

    hot.getState().resetEphemeral();

    expect(hot.getState().run.phase).toBe("idle");
    expect(hot.getState().runView).toEqual(INITIAL_OPTIMIZE_RUN_VIEW);
    expect(hot.getState().progress).toEqual([]);
    expect(hot.getState().ui).toEqual({});
    expect(hot.getState().drafts).toEqual({});
    expect(hot.getState().paint).toBeNull();
    // Status is deliberately preserved (owned by the lifecycle transition).
    expect(hot.getState().hydrationStatus).toBe("ready");
  });

  it("run view churn stays in the hot store and triggers zero durable writes", () => {
    const storage = spyStorage();
    createScenarioStore({ createStorage: () => storage });
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
    expect(storage.writes()).toBe(0);
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
