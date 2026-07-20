// T16e — bounded client-side optimize observability.
//
// The screen emits a small, closed set of run observations (queue depth, job
// duration, cancellation, cursor recovery, worker/restart loss, and the
// download/cleanup outcomes) so an operator watching the browser console — or a
// test — can see the run's shape without any backend metric. This is deliberately
// a CLIENT/BFF-only surface: it never calls the backend and invents no server
// metric. Emissions are bounded (a fixed-size ring buffer) so a long or noisy run
// can never grow memory without limit, and the sink is injectable so tests observe
// without touching the console.

/** The closed set of observations the Optimize screen emits. */
export type OptimizeObservation =
  // The server-authoritative queue position moved (queue depth for this run).
  | { kind: "queue-position"; jobId: string; position: number }
  // A run reached a terminal state; `durationMs` is wall-clock since submit when known.
  | {
      kind: "job-duration";
      jobId: string;
      outcome: "completed" | "cancelled" | "failed";
      durationMs: number | null;
    }
  // The user requested cancellation.
  | { kind: "cancellation"; jobId: string }
  // The durable stream recovered from an expired/invalid opaque cursor.
  | { kind: "cursor-recovery"; jobId: string | null; reason: "expired" | "invalid" }
  // The run failed because its worker/process was lost or restarted.
  | { kind: "worker-loss"; jobId: string }
  // A terminal cleanup attempt settled.
  | { kind: "cleanup"; jobId: string; result: "cleaned" | "failed" | "abandoned" };

/** One emitted observation, stamped with the client wall-clock at emit time. */
export interface ObservedOptimizeEvent {
  observation: OptimizeObservation;
  at: number;
}

/** A sink receives every emitted event. The default writes one console line. */
export type OptimizeObservabilitySink = (event: ObservedOptimizeEvent) => void;

/** The bounded observability surface the screen holds and drives. */
export interface OptimizeObservability {
  emit(observation: OptimizeObservation): void;
  /** The most-recent events (oldest → newest), for tests and in-tab inspection. */
  snapshot(): ObservedOptimizeEvent[];
}

/** Default retained-event budget; a noisy run keeps only the most recent window. */
export const OPTIMIZE_OBSERVABILITY_MAX_EVENTS = 100;

/** The stable console tag so emitted lines are greppable and never mistaken for app logs. */
export const OPTIMIZE_OBSERVABILITY_TAG = "[optimize:observability]";

const consoleSink: OptimizeObservabilitySink = (event) => {
  // A single structured line — no backend call, no metric library.
  console.info(OPTIMIZE_OBSERVABILITY_TAG, event.observation.kind, event);
};

/** A sink that delivers nothing. The default: the bounded in-memory buffer is the
 *  surface, so a long or noisy run never emits unbounded console lines. */
const silentSink: OptimizeObservabilitySink = () => {};

export interface CreateOptimizeObservabilityOptions {
  /** An explicit sink. Takes precedence over `console`. */
  sink?: OptimizeObservabilitySink;
  /** Opt into console delivery. Default false — console output is NOT the default,
   *  so the feature never emits unbounded console lines in production. */
  console?: boolean;
  max?: number;
  now?: () => number;
}

/**
 * Build a bounded observability instance. Every emission is appended to a
 * fixed-size ring buffer (oldest entries evicted first) — the always-bounded
 * observability surface — and forwarded to the sink. Console delivery is OPT-IN
 * (`console: true`); by default nothing is written to the console, so a long or
 * noisy run cannot spam it while `snapshot()` stays stable and testable.
 */
export function createOptimizeObservability(
  options: CreateOptimizeObservabilityOptions = {},
): OptimizeObservability {
  const sink = options.sink ?? (options.console ? consoleSink : silentSink);
  const max = options.max ?? OPTIMIZE_OBSERVABILITY_MAX_EVENTS;
  const now = options.now ?? (() => Date.now());
  const buffer: ObservedOptimizeEvent[] = [];

  return {
    emit(observation) {
      const event: ObservedOptimizeEvent = { observation, at: now() };
      buffer.push(event);
      if (buffer.length > max) buffer.splice(0, buffer.length - max);
      sink(event);
    },
    snapshot() {
      return buffer.slice();
    },
  };
}
