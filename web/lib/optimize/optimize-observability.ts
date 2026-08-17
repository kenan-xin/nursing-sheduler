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

/**
 * Why a submission degraded to an ordinary, un-claimed run (T08 basis).
 *
 * A CLOSED, FINITE taxonomy — seven codes, no free text, no interpolation. Emitting a
 * reason string built from an exception message would put unbounded, potentially
 * sensitive content into a client buffer; these are the only values this surface can
 * ever carry.
 *
 * WHY IT EXISTS. Running without a basis is a supported product state, not an error:
 * the assistant is off by default and Optimize must work regardless. But every exit
 * that produced it was silent, and that silence is exactly what let the shipped build
 * carry a completely unwired basis path through T08 and T10 with every gate green —
 * the screen never forwarded the semantic profile, the controller never had a store,
 * and nothing anywhere said so. The degradation stays; the silence does not.
 *
 * Each code names the FIRST condition that stopped the claim, so the emission points
 * at the layer that actually broke rather than at the last one to notice.
 */
export type OptimizeBasisDegradation =
  /** `/api/info` carried no trustworthy semantic profile, so none can be claimed. */
  | "profile-unavailable"
  /** No durable basis authority could be acquired (e.g. IndexedDB unreachable). */
  | "authority-unavailable"
  /** `prettify`/`timeout` were not both explicit, so the bound identity would be a guess. */
  | "options-implicit"
  /** No authoritative scenario identity/revision to bind the basis to. */
  | "scenario-identity-unavailable"
  /** Constructing the basis threw (e.g. Web Crypto absent on an insecure origin). */
  | "basis-build-failed"
  /** The durable pre-POST write of the basis row threw. */
  | "basis-write-failed"
  /** The accepted job could not be bound to its basis row. */
  | "basis-bind-failed";

/**
 * Every degradation code, so a test can force each one rather than the few someone
 * happened to think of. Exhaustiveness is checked against the union below.
 */
export const OPTIMIZE_BASIS_DEGRADATIONS = [
  "profile-unavailable",
  "authority-unavailable",
  "options-implicit",
  "scenario-identity-unavailable",
  "basis-build-failed",
  "basis-write-failed",
  "basis-bind-failed",
] as const satisfies readonly OptimizeBasisDegradation[];

// Both directions, so neither the union nor the list can gain a member alone.
type _EveryDegradationListed =
  OptimizeBasisDegradation extends (typeof OPTIMIZE_BASIS_DEGRADATIONS)[number]
    ? true
    : ["missing from OPTIMIZE_BASIS_DEGRADATIONS", never];
const _degradationsExhaustive: _EveryDegradationListed = true;
void _degradationsExhaustive;

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
  // `retained` is a DELIBERATE non-deletion, and it is not `abandoned`: nothing was
  // given up on. An infeasible run's server record is kept as the bounded evidence
  // T10's diagnostic classifies against, while its local slot is released. Emitting
  // it distinctly keeps "we chose to keep this" separable from "we failed to delete
  // it" and from "the user walked away from it" in the cleanup telemetry.
  | { kind: "cleanup"; jobId: string; result: "cleaned" | "failed" | "abandoned" | "retained" }
  // A submission proceeded WITHOUT an immutable basis claim, and why.
  //
  // `jobId` is null for every reason raised before the POST — which is all of them
  // except `basis-bind-failed`, because the basis is built and written before the job
  // exists. It carries the reason CODE and nothing else: no YAML, no options, no
  // scenario content, no exception text, no credential-adjacent value.
  //
  // Emitted ONLY on degradation. A run that claims a basis emits nothing here, so the
  // absence of this event is itself the success signal.
  | { kind: "basis-degraded"; jobId: string | null; reason: OptimizeBasisDegradation };

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
