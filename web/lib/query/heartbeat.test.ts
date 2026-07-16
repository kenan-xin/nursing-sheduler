import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHeartbeat } from "@/lib/query/heartbeat";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function harness(beat: () => Promise<boolean> | boolean) {
  const visibilityTarget = new EventTarget();
  const onlineTarget = new EventTarget();
  let visible = true;
  const controller = startHeartbeat({
    intervalMs: 5_000,
    beat,
    visibilityTarget,
    onlineTarget,
    isVisible: () => visible,
  });
  return {
    controller,
    visibilityTarget,
    onlineTarget,
    setVisible: (value: boolean) => {
      visible = value;
    },
  };
}

describe("startHeartbeat", () => {
  it("fires immediately and then on a 5 s cadence", async () => {
    const beat = vi.fn(() => true);
    const { controller } = harness(beat);

    expect(beat).toHaveBeenCalledTimes(1); // immediate

    await vi.advanceTimersByTimeAsync(5_000);
    expect(beat).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(beat).toHaveBeenCalledTimes(3);

    controller.stop();
  });

  it("refires on visibilitychange (when visible) and online", async () => {
    const beat = vi.fn(() => true);
    const { controller, visibilityTarget, onlineTarget, setVisible } = harness(beat);

    expect(beat).toHaveBeenCalledTimes(1);

    visibilityTarget.dispatchEvent(new Event("visibilitychange"));
    expect(beat).toHaveBeenCalledTimes(2);

    onlineTarget.dispatchEvent(new Event("online"));
    expect(beat).toHaveBeenCalledTimes(3);

    // Hidden tab does not beat.
    setVisible(false);
    visibilityTarget.dispatchEvent(new Event("visibilitychange"));
    expect(beat).toHaveBeenCalledTimes(3);

    controller.stop();
  });

  it("stops permanently when a beat resolves false (heartbeat 409/404)", async () => {
    const beat = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    harness(beat);

    expect(beat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0); // flush the `false` resolution → stop()

    await vi.advanceTimersByTimeAsync(20_000);
    expect(beat).toHaveBeenCalledTimes(1); // no further beats after stop
  });

  it("detaches timer and listeners on stop()", async () => {
    const beat = vi.fn(() => true);
    const { controller, visibilityTarget, onlineTarget } = harness(beat);

    controller.stop();

    visibilityTarget.dispatchEvent(new Event("visibilitychange"));
    onlineTarget.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(beat).toHaveBeenCalledTimes(1); // only the immediate beat
  });
});
