// Phase-1 deployment invariant: EXACTLY ONE Next `web` instance.
//
// This is a correctness limit for active AI runs, not a capacity setting. The
// transient runner keeps active replay/abort state in process memory only, so a
// second replica would silently route `connect`/`stop` to a process that never
// held the run — the browser would see a detached turn on a healthy system, or
// worse, an operator would assume cross-instance continuity that does not exist.
// Scaling the web tier is blocked until a later plan chooses run-token affinity or
// a privacy-reviewed shared runner. The Python optimizer scales independently
// under its own Redis claim fencing; this bound is web-only.

export const PHASE_1_MAX_WEB_INSTANCES = 1;

/** Declared web replica count. Unset means the Compose default of one. */
export const WEB_REPLICAS_ENV = "NS_WEB_REPLICAS";

export class MultiInstanceAiConfigurationError extends Error {
  constructor(declared: string) {
    super(
      `${WEB_REPLICAS_ENV}=${declared} claims more than one Next web instance. Phase-1 ` +
        `AI runtime containment supports exactly ${PHASE_1_MAX_WEB_INSTANCES}: active run ` +
        `replay/abort state is process-local, so a second replica cannot serve connect/stop ` +
        `for a run it never started. Scale the optimizer instead, or land run-token affinity first.`,
    );
    this.name = "MultiInstanceAiConfigurationError";
  }
}

/**
 * Throws when the deployment claims multi-instance AI continuity. A blank or unset
 * value is the supported default (one instance); a non-numeric value is a
 * misconfiguration and fails closed rather than being read as one.
 */
export function assertSingleWebInstance(
  env: Record<string, string | undefined> = process.env,
): void {
  const declared = env[WEB_REPLICAS_ENV]?.trim();
  if (!declared) return;

  const replicas = Number(declared);
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > PHASE_1_MAX_WEB_INSTANCES) {
    throw new MultiInstanceAiConfigurationError(declared);
  }
}
