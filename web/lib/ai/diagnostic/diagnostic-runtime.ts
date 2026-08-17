// T10 — the real DiagnosticRuntime: composes the authority adapter, the live
// scenario projection, the semantic-profile fetch, and the imperative transport
// helpers into the `DiagnosticRuntime` seam the orchestrator consumes.
//
// This module is the ONE place the browser's real I/O meets the orchestrator's pure
// decision logic. It holds no logic of its own: every effect delegates to a seam
// that already has its own tests (the authority adapter, the transport helpers, the
// recovery classifier), so the orchestrator's behavioural guarantees carry through
// unchanged.

import { getScenarioAuthority } from "@/lib/store/spine";
import { pickScenario, useScenarioStore } from "@/lib/store";
import { readAuthoritativeScenarioIdentity } from "@/lib/store/commands";
import {
  classifyRecovery,
  type RecoveryClassification,
  type ServerJobFacts,
} from "@/lib/optimize/basis/recovery";
import {
  postCancelOptimizeJob,
  pollOptimizeJobUntilTerminal,
  postOptimizeJob,
} from "@/lib/query/optimize";
import { OptimizeApiError } from "@/lib/bff/errors";
import { parseInfoPayload } from "@/app/api/info/validate";
import type { InfoSemanticProfile } from "@/app/api/info/types";
import type { JobResponse } from "@/lib/bff/types";
import { registerOwnedDiagnosticJob, unregisterOwnedDiagnosticJob } from "./diagnostic-canceller";
import type { DiagnosticSearchRecordV1 } from "./search-record";

/**
 * Raised at a diagnostic effect boundary when the turn lost authority mid-search.
 *
 * A THROW rather than a quiet return, because these boundaries sit inside the
 * orchestrator's own control flow: returning a benign value would let it carry on to
 * the next candidate. The tool handler converts it into the ordinary superseded
 * answer, so nothing about it reaches a user.
 */
export class DiagnosticAuthorityRevokedError extends Error {
  constructor(readonly boundary: string) {
    super(`diagnostic authority revoked before ${boundary}`);
    this.name = "DiagnosticAuthorityRevokedError";
  }
}
import {
  runDiagnosticSearch,
  type DiagnosticRuntime,
  type SubmitCandidateTransport,
  type SubmitCandidateTransportResult,
} from "./diagnostic-orchestrator";

/**
 * Fetch the backend semantic profile imperatively (the orchestrator runs outside
 * React and so cannot use `useOptimizeServerInfo`). Reuses the SAME strict parser
 * the BFF route uses, so an untrusted payload fails closed rather than binding a
 * garbage profile into a candidate basis.
 */
export async function fetchSemanticProfile(
  signal?: AbortSignal,
): Promise<InfoSemanticProfile | null> {
  try {
    const response = await fetch("/api/info", { cache: "no-store", signal });
    const body = await response.json().catch(() => null);
    const parsed = parseInfoPayload(body, response.status);
    return parsed?.semantic_profile ?? null;
  } catch {
    return null;
  }
}

/** Fetch one job's current state for recovery classification (null when gone). */
async function fetchJobFacts(jobId: string, signal?: AbortSignal): Promise<JobResponse | null> {
  try {
    const response = await fetch(`/api/optimize/${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) return null;
    return body as JobResponse;
  } catch {
    return null;
  }
}

/**
 * Build the real DiagnosticRuntime bound to one turn.
 *
 * `turnEpoch` is the epoch the search was authorised under; `isTurnActive` compares
 * it against the live assistant store so an interruption (which closes the
 * authorized epoch) makes every subsequent candidate preparation and poll inert.
 */
export function createDiagnosticRuntime(deps: {
  turnEpoch: number;
  threadId: string | null;
  scenarioId: string | null;
  isTurnActive: (turnEpoch: number) => boolean;
  /**
   * Whether the turn that started this search may still act, checked with the FULL
   * bound identity rather than the epoch alone.
   *
   * A search is the longest thing the assistant does, and the epoch is blind to a
   * same-tab commit and to a lease takeover. Without this, a search could keep
   * submitting solver jobs, writing durable rows and publishing cards for a document
   * revision it no longer describes -- with the outer tool guard suppressing only the
   * eventual sentence, long after the effects landed.
   */
  authorize: () => boolean;
  /** Publish each durable snapshot so the host card follows the search live. */
  publish: (search: DiagnosticSearchRecordV1) => void;
}): DiagnosticRuntime {
  const authority = getScenarioAuthority();

  /** Thrown at an effect boundary once authority is gone. Never surfaces to a user. */
  const refuseIfRevoked = (what: string) => {
    if (!deps.authorize()) throw new DiagnosticAuthorityRevokedError(what);
  };

  return {
    now: () => new Date(),
    isTurnActive: deps.isTurnActive,

    async classifyRecovery(parentBasisId, parentJobId): Promise<RecoveryClassification> {
      const local = await authority.readOptimizeBasis(parentBasisId);
      const serverJob = await fetchJobFacts(parentJobId);
      const server: ServerJobFacts =
        serverJob === null
          ? { kind: "missing" }
          : {
              kind: "present",
              basis: serverJob.request.basis,
              expiresAt: serverJob.expires_at,
            };
      const liveProfile = await fetchSemanticProfile();
      return classifyRecovery({
        local: local ?? null,
        server,
        liveProfile,
        now: new Date(),
      });
    },

    async readCurrentScenario() {
      const identity = await readAuthoritativeScenarioIdentity();
      if (identity === null) return null;
      const document = pickScenario(useScenarioStore.getState());
      return {
        scenarioId: identity.scenarioId,
        documentRevision: identity.documentRevision,
        document,
      };
    },

    async readSemanticProfile() {
      return fetchSemanticProfile();
    },

    async captureGenerations(scenarioId) {
      return authority.captureGenerationsForDiagnostics(scenarioId);
    },

    async putSearch(record, guard) {
      refuseIfRevoked("durable search write");
      await authority.putDiagnosticSearch(record, guard);
      // Publish AFTER the durable write, so the card never shows a state the
      // database does not hold. A write the generation fence dropped publishes
      // nothing new either, because it throws before reaching here.
      //
      // Rechecked across the write's own await: the card is a USER-VISIBLE effect, and
      // showing a stopped turn's search animating is exactly the lie this prevents.
      refuseIfRevoked("search publication");
      deps.publish(record);
    },

    async putBasis(record) {
      refuseIfRevoked("durable basis write");
      await authority.putOptimizeBasis(record);
    },

    async bindAcceptedCandidateBasis(basisId, verify) {
      // Fenced in its own right. It is the first durable write after an accepted job,
      // so a revocation that landed during the POST must not be recorded as evidence
      // this turn is entitled to.
      refuseIfRevoked("accepted basis bind");
      return authority.bindOptimizeBasisJob(basisId, verify);
    },

    async submitDiagnostic(
      input: SubmitCandidateTransport,
    ): Promise<SubmitCandidateTransportResult> {
      // Immediately before the POST: a solver job submitted after the bound revision
      // went stale consumes real backend capacity to test a document nobody asked
      // about any more.
      refuseIfRevoked("diagnostic submission");
      try {
        const job = await postOptimizeJob({
          yamlContent: input.yaml,
          timeout: input.timeoutSeconds,
          purpose: "assistant_diagnostic",
          basis: input.basis,
        });

        // OWNED THE INSTANT IT IS ACCEPTED, before any authority decision.
        //
        // The POST is a real await, and a takeover, a Stop or a commit can land while
        // it is in flight. Deciding first and registering second would leave an
        // accepted backend job that nothing in this browser knows about -- a silent
        // orphan that no interruption can ever cancel. Registration is idempotent, so
        // the orchestrator's own later call is harmless.
        registerOwnedDiagnosticJob({
          jobId: job.id,
          threadId: deps.threadId,
          scenarioId: deps.scenarioId,
          turnEpoch: deps.turnEpoch,
        });

        if (!deps.authorize()) {
          // Ask the backend to give the capacity back. A failure here is NOT swallowed
          // into silence: the job stays registered, so the interruption controller
          // still owns it, still reports it as unconfirmed, and the turn detaches
          // truthfully rather than claiming a cancellation that never happened.
          try {
            await postCancelOptimizeJob(job.id);
          } catch {
            // Deliberately kept owned. See above.
          }
          throw new DiagnosticAuthorityRevokedError("accepted diagnostic job");
        }

        return { ok: true, job };
      } catch (error) {
        // The revocation throw is control flow, not a submission failure.
        if (error instanceof DiagnosticAuthorityRevokedError) throw error;
        if (error instanceof OptimizeApiError) {
          return {
            ok: false,
            code: error.info.code ?? error.info.kind,
            message: error.message,
          };
        }
        return { ok: false, code: "transport_rejected", message: "submission failed" };
      }
    },

    async pollUntilTerminal(input) {
      return pollOptimizeJobUntilTerminal(input);
    },

    async cancelJob(jobId, signal) {
      await postCancelOptimizeJob(jobId, signal);
    },

    registerJob(jobId) {
      registerOwnedDiagnosticJob({
        jobId,
        threadId: deps.threadId,
        scenarioId: deps.scenarioId,
        turnEpoch: deps.turnEpoch,
      });
    },

    unregisterJob(jobId) {
      unregisterOwnedDiagnosticJob(jobId);
    },
  };
}

/**
 * Run a diagnostic search bound to one turn.
 *
 * This is the wrapper the CopilotKit tool calls: it builds the runtime and drives
 * the orchestrator. The owned-job registry is kept in sync BY THE ORCHESTRATOR,
 * through the runtime's `registerJob`/`unregisterJob` seams — a job is registered
 * the moment the backend accepts it and dropped when it settles, so an interruption
 * arriving mid-solve always finds the live job. Registering after the search
 * returned would be too late by construction: by then there is nothing to cancel.
 */
export async function runDiagnosticSearchForTurn(input: {
  searchId: string;
  threadId: string | null;
  turnId: string | null;
  turnEpoch: number;
  leaseEpoch: number;
  compare: boolean;
  parent: { basisId: string; jobId: string; scenarioId: string; documentRevision: number };
  parentExpiresAt: string | null;
  scenarioId: string | null;
  proposed: Parameters<typeof runDiagnosticSearch>[0]["proposed"];
  isTurnActive: (turnEpoch: number) => boolean;
  authorize: () => boolean;
  publish: (search: DiagnosticSearchRecordV1) => void;
}): ReturnType<typeof runDiagnosticSearch> {
  const runtime = createDiagnosticRuntime({
    turnEpoch: input.turnEpoch,
    threadId: input.threadId,
    scenarioId: input.scenarioId,
    isTurnActive: input.isTurnActive,
    authorize: input.authorize,
    publish: input.publish,
  });

  return runDiagnosticSearch(
    {
      searchId: input.searchId,
      threadId: input.threadId,
      turnId: input.turnId,
      turnEpoch: input.turnEpoch,
      leaseEpoch: input.leaseEpoch,
      compare: input.compare,
      parent: input.parent,
      parentExpiresAt: input.parentExpiresAt,
      proposed: input.proposed,
    },
    runtime,
  );
}
