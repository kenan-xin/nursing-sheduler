// Framework-agnostic heartbeat scheduler (tech-plan §3, critique #12). Extracted
// from the React hook so the cadence + trigger + stop behavior is unit-testable
// with fake timers and injected event targets (no DOM/renderer needed).
//
// `beat()` returns whether to keep going: the hook returns false on a heartbeat
// 404/409 (job gone / already finished), which stops the scheduler.

export type EventTargetLike = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface HeartbeatOptions {
  intervalMs: number;
  beat: () => Promise<boolean> | boolean;
  // `document` for `visibilitychange`, `window` for `online` (injectable in tests).
  visibilityTarget: EventTargetLike;
  onlineTarget: EventTargetLike;
  isVisible: () => boolean;
}

export interface HeartbeatController {
  stop: () => void;
}

// Fires `beat()` immediately, then every `intervalMs`, plus on tab re-focus and
// network resume. Stops (and detaches every listener/timer) on the first `beat()`
// that resolves false, or when `stop()` is called.
export function startHeartbeat(options: HeartbeatOptions): HeartbeatController {
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (interval !== undefined) clearInterval(interval);
    options.visibilityTarget.removeEventListener("visibilitychange", onVisibility);
    options.onlineTarget.removeEventListener("online", onOnline);
  };

  const runBeat = () => {
    if (stopped) return;
    void Promise.resolve(options.beat()).then((keepGoing) => {
      if (!keepGoing) stop();
    });
  };

  const onVisibility = () => {
    if (options.isVisible()) runBeat();
  };
  const onOnline = () => runBeat();

  options.visibilityTarget.addEventListener("visibilitychange", onVisibility);
  options.onlineTarget.addEventListener("online", onOnline);
  interval = setInterval(runBeat, options.intervalMs);
  runBeat();

  return { stop };
}
