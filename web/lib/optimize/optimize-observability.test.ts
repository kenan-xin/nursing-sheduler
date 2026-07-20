import { describe, expect, it, vi } from "vitest";
import {
  OPTIMIZE_OBSERVABILITY_MAX_EVENTS,
  createOptimizeObservability,
  type ObservedOptimizeEvent,
} from "./optimize-observability";

describe("createOptimizeObservability", () => {
  it("forwards each observation to the sink stamped with the injected clock", () => {
    const events: ObservedOptimizeEvent[] = [];
    let clock = 1000;
    const obs = createOptimizeObservability({ sink: (e) => events.push(e), now: () => clock });

    obs.emit({ kind: "cancellation", jobId: "opt_1" });
    clock = 2000;
    obs.emit({ kind: "worker-loss", jobId: "opt_1" });

    expect(events).toEqual([
      { observation: { kind: "cancellation", jobId: "opt_1" }, at: 1000 },
      { observation: { kind: "worker-loss", jobId: "opt_1" }, at: 2000 },
    ]);
  });

  it("exposes an ordered snapshot independent of the live buffer", () => {
    const obs = createOptimizeObservability({ sink: vi.fn(), now: () => 0 });
    obs.emit({ kind: "queue-position", jobId: "opt_1", position: 3 });
    const first = obs.snapshot();
    obs.emit({ kind: "queue-position", jobId: "opt_1", position: 2 });

    expect(first).toHaveLength(1);
    expect(obs.snapshot()).toHaveLength(2);
    expect(obs.snapshot().map((e) => e.observation)).toEqual([
      { kind: "queue-position", jobId: "opt_1", position: 3 },
      { kind: "queue-position", jobId: "opt_1", position: 2 },
    ]);
  });

  it("bounds retained events, evicting the oldest first", () => {
    const obs = createOptimizeObservability({ sink: vi.fn(), max: 3, now: () => 0 });
    for (let position = 0; position < 6; position += 1) {
      obs.emit({ kind: "queue-position", jobId: "opt_1", position });
    }
    expect(obs.snapshot().map((e) => e.observation.kind)).toEqual([
      "queue-position",
      "queue-position",
      "queue-position",
    ]);
    expect(obs.snapshot().map((e) => (e.observation as { position: number }).position)).toEqual([
      3, 4, 5,
    ]);
  });

  it("defaults to a generous but finite retained-event budget", () => {
    const obs = createOptimizeObservability({ sink: vi.fn(), now: () => 0 });
    for (let i = 0; i < OPTIMIZE_OBSERVABILITY_MAX_EVENTS + 25; i += 1) {
      obs.emit({ kind: "cancellation", jobId: "opt_1" });
    }
    expect(obs.snapshot()).toHaveLength(OPTIMIZE_OBSERVABILITY_MAX_EVENTS);
  });

  it("does NOT write to the console by default (no unbounded console spam)", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const obs = createOptimizeObservability({ now: () => 0 });
      for (let i = 0; i < 5; i += 1) obs.emit({ kind: "cancellation", jobId: "opt_1" });
      expect(spy).not.toHaveBeenCalled();
      // The bounded buffer is still the observability surface.
      expect(obs.snapshot()).toHaveLength(5);
    } finally {
      spy.mockRestore();
    }
  });

  it("delivers to the console only when console delivery is opted in", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const obs = createOptimizeObservability({ console: true, now: () => 0 });
      obs.emit({ kind: "cancellation", jobId: "opt_1" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
