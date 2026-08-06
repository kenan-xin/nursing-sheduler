// T10 — the diagnostic search orchestrator.
//
// This module is the ASYNC DRIVER that turns one model-proposed bounded candidate
// list into settled evidence. It owns no storage and no transport of its own: every
// effect is an injected seam (`DiagnosticRuntime`), so the full search lifecycle —
// open, validate, submit, poll, settle, stop, interrupt — is testable without
// IndexedDB or a network.
//
// WHAT IT ENFORCES STRUCTURALLY:
//   • Trusted-basis gating: a search opens only when recovery is trusted and the
//     basis still matches the current scenario (search-policy).
//   • Host-validated immutable copies: candidates apply through the SAME T07
//     operation layer the manual editor uses, so no model argument bypasses
//     validation.
//   • Exact identity binding: every accepted candidate is bound through the T08
//     `bindAcceptedJob` integrity check; a mismatch quarantines the candidate.
//   • Sequential bounded execution: at most five candidates, one at a time, with a
//     90-second per-candidate budget, stopping at the first tested-feasible result
//     unless the user asked to compare (search-policy).
//   • T05 interruption across every stage: the turn epoch is re-checked before each
//     candidate and during polling, and the DiagnosticCanceller requests backend
//     cancellation of the owned running job.
//   • Closed outcome mapping: every terminal backend fact passes through
//     `mapJobToProductOutcome`, so an unknown fact fails closed as failed/unclassified.
//
// WHAT IT DOES NOT DO: roster repair, parallel solving, model Apply, causal claims,
// or anything beyond the T07 command subset. Those are hard boundaries, not goals.

import { toCanonicalScenarioDocument } from "@/lib/scenario";
import type { ScenarioUiState } from "@/lib/scenario";
import { prepareOptimizeSubmission, type PrepareOptimizeSubmissionResult } from "@/lib/scenario";
import { applyAssistantCommands } from "@/lib/proposal/operations";
import { commandsDigest } from "@/lib/proposal/proposal";
import { deriveProposalDiff } from "@/lib/proposal/diff";
import {
  buildOptimizeBasis,
  bindAcceptedJob,
  type BasisSubmissionFields,
} from "@/lib/optimize/basis/basis-record";
import type { OptimizeBasisRecordV2 } from "@/lib/optimize/basis/basis-row";
import type { InfoSemanticProfile } from "@/app/api/info/types";
import {
  mapJobToProductOutcome,
  notStarted,
  UNCLASSIFIED_FAILURE,
} from "@/lib/optimize/outcome-mapping";
import { isDiagnosticCapacityRejection } from "./queue-state";
import {
  mayOpenSearch,
  deriveStopDecision,
  computeTransformDigest,
  candidateIdentityState,
} from "./search-policy";
import {
  appendRejectedCandidate,
  appendSubmittedCandidate,
  closeSearch,
  openDiagnosticSearch,
  settleCandidate,
  type DiagnosticCandidate,
  type DiagnosticSearchRecordV1,
} from "./search-record";
import type { RecoveryClassification } from "@/lib/optimize/basis/recovery";
import type { AssistantCommandV1 } from "@/lib/proposal/commands";
import type { JobResponse } from "@/lib/bff/types";
import type { ProductOutcomeView } from "@/lib/optimize/outcome-mapping";

/** One model-proposed candidate: typed commands + rationale. */
export interface ProposedCandidate {
  candidateId: string;
  commands: readonly AssistantCommandV1[];
  rationale: string | null;
}

/** The injected effect surface. Every external interaction is a seam. */
export interface DiagnosticRuntime {
  /** Classify the failed ordinary run's recovery against current local/server state. */
  classifyRecovery(parentBasisId: string, parentJobId: string): Promise<RecoveryClassification>;
  /** The current scenario identity + persisted document. Null when unreadable. */
  readCurrentScenario(): Promise<{
    scenarioId: string;
    documentRevision: number;
    document: ScenarioUiState;
  } | null>;
  /** The backend semantic profile just read from `/info`. */
  readSemanticProfile(): Promise<InfoSemanticProfile | null>;
  /** Whether the turn that opened this search is still the authorised one. */
  isTurnActive(turnEpoch: number): boolean;
  now(): Date;

  // Persistence (generation-fenced). Each write carries the captured generations.
  captureGenerations(scenarioId: string): Promise<readonly CapturedGeneration[]>;
  putSearch(record: DiagnosticSearchRecordV1, guard: readonly CapturedGeneration[]): Promise<void>;
  putBasis(record: OptimizeBasisRecordV2): Promise<void>;
  bindAcceptedCandidateBasis(
    basisId: string,
    verify: (row: OptimizeBasisRecordV2) => OptimizeBasisRecordV2 | null,
  ): Promise<OptimizeBasisRecordV2 | null>;

  // Submission + polling + cancellation.
  submitDiagnostic(input: SubmitCandidateTransport): Promise<SubmitCandidateTransportResult>;
  /**
   * Poll one accepted job to a terminal state.
   *
   * `shouldAbort` is re-read by the implementation between polls, so a T05
   * interruption stops the wait immediately rather than after the full
   * per-candidate budget. It REJECTS on abort or deadline; the orchestrator
   * distinguishes the two by re-asking whether the turn is still active.
   */
  pollUntilTerminal(input: {
    jobId: string;
    deadlineMs: number;
    signal: AbortSignal;
    shouldAbort: () => boolean;
  }): Promise<JobResponse>;
  cancelJob(jobId: string, signal: AbortSignal): Promise<void>;

  /**
   * Record that this tab owns a non-terminal diagnostic job, so the T05
   * interruption controller can request its cancellation.
   *
   * Called the moment the backend accepts a candidate — BEFORE polling starts —
   * because that is the whole window in which an interruption needs to find it.
   */
  registerJob(jobId: string): void;
  /** Drop a settled job from the cancellation registry. */
  unregisterJob(jobId: string): void;
}

/** A captured generation pair for fenced writes (mirrors the repository's fence). */
export interface CapturedGeneration {
  scopeKey: string;
  generation: number;
}

/** The transport-ready candidate submission. */
export interface SubmitCandidateTransport {
  yaml: string;
  /** The T08 basis claim, built by `buildOptimizeBasis` — never assembled by hand. */
  basis: BasisSubmissionFields;
  timeoutSeconds: number;
}

/** The closed result of one submission attempt. */
export type SubmitCandidateTransportResult =
  | { ok: true; job: JobResponse }
  | { ok: false; code: string; message: string };

/** The closed result of the whole search. */
export interface DiagnosticSearchResult {
  search: DiagnosticSearchRecordV1;
  /** The candidate to hand off to T07 Preview, if a tested-feasible one exists. */
  previewCandidate: DiagnosticCandidate | null;
}

/**
 * Run one bounded diagnostic search end to end.
 *
 * The caller supplies the parent run's identity, the turn/lease/generation epochs
 * captured when the search was authorised, and the model's proposed candidate list.
 * This function drives the candidates sequentially, persists the search row through
 * the injected runtime, and returns the final record plus any Preview-eligible
 * candidate.
 *
 * Every await is an interruption boundary: the turn epoch is re-checked before each
 * candidate is prepared, after it is submitted, and during polling. An interruption
 * closes the search as `interrupted` and requests cancellation of the owned running
 * job through the runtime.
 */
export async function runDiagnosticSearch(
  input: {
    searchId: string;
    threadId: string | null;
    turnId: string | null;
    turnEpoch: number;
    leaseEpoch: number;
    compare: boolean;
    parent: { basisId: string; jobId: string; scenarioId: string; documentRevision: number };
    parentExpiresAt: string | null;
    proposed: readonly ProposedCandidate[];
  },
  runtime: DiagnosticRuntime,
): Promise<DiagnosticSearchResult> {
  const now = runtime.now();

  // --- Open gate: trusted recovery + current scenario ----------------------
  const recovery = await runtime.classifyRecovery(input.parent.basisId, input.parent.jobId);
  const current = await runtime.readCurrentScenario();
  const scenarioId = current?.scenarioId ?? "";
  // "Current" means the schedule has not moved since the failed run: the same
  // scenario, at the same revision. An edit after the failure makes the old result
  // out of date, so the search is refused and a fresh ordinary run is offered
  // instead of diagnosing bytes the user has already changed.
  const basisCurrent =
    current !== null &&
    current.scenarioId === input.parent.scenarioId &&
    current.documentRevision === input.parent.documentRevision;

  const gate = mayOpenSearch({ recovery, basisCurrent });
  if (!gate.ok) {
    const search = openDiagnosticSearch({
      searchId: input.searchId,
      scenarioId,
      threadId: input.threadId,
      turnId: input.turnId,
      parent: input.parent,
      turnEpoch: input.turnEpoch,
      leaseEpoch: input.leaseEpoch,
      globalGeneration: 0,
      scenarioGeneration: 0,
      compare: input.compare,
      parentExpiresAt: input.parentExpiresAt,
      now,
    });
    const closed = closeSearch(search, gate.reason, gate.message, now);
    const guard = await runtime.captureGenerations(scenarioId);
    await runtime.putSearch(closed, guard);
    return { search: closed, previewCandidate: null };
  }

  // The current scenario is the authority from here. Capture the generations once;
  // they fence every subsequent search write inside its transaction. (The document
  // itself is re-read per candidate in `runOneCandidate` so a mid-search edit is
  // caught rather than silently testing stale bytes.)
  const guard = await runtime.captureGenerations(scenarioId);
  const search = openDiagnosticSearch({
    searchId: input.searchId,
    scenarioId,
    threadId: input.threadId,
    turnId: input.turnId,
    parent: input.parent,
    turnEpoch: input.turnEpoch,
    leaseEpoch: input.leaseEpoch,
    globalGeneration: guard.find((g) => g.scopeKey === "global")?.generation ?? 0,
    scenarioGeneration: guard.find((g) => g.scopeKey === `scenario:${scenarioId}`)?.generation ?? 0,
    compare: input.compare,
    parentExpiresAt: input.parentExpiresAt,
    now,
  });
  await runtime.putSearch(search, guard);

  // --- Sequential candidate execution ---------------------------------------
  let current2 = search;
  const profile = await runtime.readSemanticProfile();

  for (const proposed of input.proposed) {
    // Interruption boundary: before preparing each candidate.
    if (!runtime.isTurnActive(input.turnEpoch)) {
      current2 = closeSearch(current2, "interrupted", null, runtime.now());
      await runtime.putSearch(current2, guard);
      return finalize(current2);
    }
    // Stop decision: a prior feasible candidate may have ended the search.
    const stop = deriveStopDecision(current2);
    if (stop.action === "stop") {
      current2 = closeSearch(current2, stop.reason, null, runtime.now());
      await runtime.putSearch(current2, guard);
      return finalize(current2);
    }

    current2 = await runOneCandidate(current2, proposed, profile, runtime, guard, input.turnEpoch);

    // After a settled candidate, re-check the stop decision for the next iteration.
    const next = deriveStopDecision(current2);
    if (next.action === "stop") {
      current2 = closeSearch(current2, next.reason, null, runtime.now());
      await runtime.putSearch(current2, guard);
      return finalize(current2);
    }
  }

  // The proposed list is exhausted. If still active, the search completed without
  // a feasible candidate (or with compare exhausted).
  if (current2.status === "open") {
    const reason = current2.compare ? "compare_complete" : "exhausted";
    current2 = closeSearch(current2, reason, null, runtime.now());
    await runtime.putSearch(current2, guard);
  }
  return finalize(current2);
}

/**
 * Prepare, submit, and settle ONE candidate.
 *
 * The candidate is applied to an immutable copy through the T07 operation layer,
 * serialized through the exact T08 YAML path, and given its own basis bound to the
 * search's parent. A host-side rejection (commands did not validate) records a
 * `not-started` candidate without submission. A backend admission rejection
 * (capacity reserved) records `not-started` with the capacity reason. An accepted
 * candidate is polled to terminal and mapped to its closed product outcome.
 */
async function runOneCandidate(
  search: DiagnosticSearchRecordV1,
  proposed: ProposedCandidate,
  profile: InfoSemanticProfile | null,
  runtime: DiagnosticRuntime,
  guard: readonly CapturedGeneration[],
  turnEpoch: number,
): Promise<DiagnosticSearchRecordV1> {
  const now = runtime.now();

  // The search row intentionally does not store the document. The runtime's
  // readCurrentScenario() returned it at open time; we re-read it here per candidate
  // so a same-tab edit between candidates fails the identity check below rather than
  // silently testing stale bytes.
  const live = await runtime.readCurrentScenario();
  if (live === null || live.scenarioId !== search.scenarioId) {
    // The scenario moved under the search. Fail closed.
    return closeSearch(search, "parent_untrusted", "scenario_changed_mid_search", now);
  }
  const liveDocument = live.document;

  const operation = applyAssistantCommands(liveDocument, proposed.commands);
  if (!operation.ok) {
    const rejected = appendRejectedCandidate(search, {
      candidateId: proposed.candidateId,
      commands: proposed.commands,
      commandsDigest: commandsDigest(proposed.commands),
      rationale: proposed.rationale,
      rejection: { code: operation.rejection.code, message: operation.rejection.message },
      now,
    });
    await runtime.putSearch(rejected, guard);
    return rejected;
  }

  // 2. Derive the host diff and the transform digest (commands + effect).
  const diff = deriveProposalDiff(liveDocument, operation.next, proposed.commands);
  const transformDigest = computeTransformDigest(proposed.commands, diff);
  const commandsDigestValue = commandsDigest(proposed.commands);

  // 3. Serialize the copied document to exact YAML through the T08 path.
  const canonical = toCanonicalScenarioDocument(operation.next);
  const prepResult: PrepareOptimizeSubmissionResult = prepareOptimizeSubmission(canonical, {
    anonymize: false,
  });
  if (!prepResult.ok) {
    const rejected = appendRejectedCandidate(search, {
      candidateId: proposed.candidateId,
      commands: proposed.commands,
      commandsDigest: commandsDigestValue,
      rationale: proposed.rationale,
      rejection: {
        code: "invalid_value",
        message: "The changed schedule could not be prepared for the solver.",
      },
      now,
    });
    await runtime.putSearch(rejected, guard);
    return rejected;
  }

  // 4. Build the candidate basis (requires a profile + parent + transform).
  if (profile === null) {
    const rejected = appendRejectedCandidate(search, {
      candidateId: proposed.candidateId,
      commands: proposed.commands,
      commandsDigest: commandsDigestValue,
      rationale: proposed.rationale,
      rejection: {
        code: "invalid_value",
        message: "The backend semantic profile is unavailable, so no basis could be claimed.",
      },
      now,
    });
    await runtime.putSearch(rejected, guard);
    return rejected;
  }

  let built;
  try {
    built = await buildOptimizeBasis({
      yaml: prepResult.prep.yaml,
      anonymized: prepResult.prep.anonymized,
      profile,
      options: {
        prettify: false,
        timeoutSeconds: search.candidateTimeoutSeconds,
      },
      scenarioId: search.scenarioId,
      documentRevision: live.documentRevision,
      ownerKind: "candidate",
      attemptId: proposed.candidateId,
      parentBasisId: search.parent.basisId,
      transformDigest,
      now,
    });
  } catch {
    const rejected = appendRejectedCandidate(search, {
      candidateId: proposed.candidateId,
      commands: proposed.commands,
      commandsDigest: commandsDigestValue,
      rationale: proposed.rationale,
      rejection: {
        code: "invalid_value",
        message: "The candidate basis could not be built.",
      },
      now,
    });
    await runtime.putSearch(rejected, guard);
    return rejected;
  }

  // Persist the candidate basis row before submitting (T08: persisted before POST).
  await runtime.putBasis(built.record);

  // The append input is identical whether the backend accepts or refuses the
  // submission — both spent a slot — so it is built once.
  const appendInput = {
    candidateId: proposed.candidateId,
    commands: proposed.commands,
    commandsDigest: commandsDigestValue,
    transformDigest,
    rationale: proposed.rationale,
    diff,
    basisId: built.basisId,
    inputSha256: built.fields.input_sha256,
    parentBasisId: search.parent.basisId,
    now,
  };

  // 5. Submit through the diagnostic purpose. The fields come from the built basis
  //    verbatim: assembling them by hand here would let a future basis field be
  //    silently dropped from the claim.
  const submission = await runtime.submitDiagnostic({
    yaml: prepResult.prep.yaml,
    basis: built.fields,
    timeoutSeconds: search.candidateTimeoutSeconds,
  });

  if (!submission.ok) {
    // Capacity or transport rejection. The attempt spent a slot, so it is appended
    // as a submitted candidate — but with NO job id, which is what keeps it out of
    // every identity and evidence path.
    const reason = isDiagnosticCapacityRejection(submission.code)
      ? "diagnostic_capacity_reserved"
      : "transport_rejected";
    let withCandidate = appendSubmittedCandidate(search, appendInput, null);
    withCandidate = settleCandidate(
      withCandidate,
      proposed.candidateId,
      notStarted(reason),
      runtime.now(),
    );
    await runtime.putSearch(withCandidate, guard);
    return withCandidate;
  }

  // 6. Bind the accepted job to the candidate basis (integrity check).
  const job = submission.job;
  await runtime.bindAcceptedCandidateBasis(built.basisId, (row) =>
    bindAcceptedJob(row, {
      jobId: job.id,
      basisId: job.request.basis?.basis_id ?? null,
      inputSha256: job.request.basis?.input_sha256 ?? null,
      expiresAt: job.expires_at,
    }),
  );

  let withCandidate = appendSubmittedCandidate(search, appendInput, job.id);
  await runtime.putSearch(withCandidate, guard);

  // The job is live and this tab owns it. Register it BEFORE polling: the window in
  // which an interruption needs to find a cancellable job is exactly the window in
  // which we are waiting on it.
  runtime.registerJob(job.id);

  // 7. Poll until terminal (or interruption, or per-candidate deadline).
  const deadlineMs = runtime.now().getTime() + (search.candidateTimeoutSeconds + 30) * 1000;
  const controller = new AbortController();
  const turnInactive = (): boolean => !runtime.isTurnActive(turnEpoch);

  let terminal: JobResponse;
  try {
    terminal = await runtime.pollUntilTerminal({
      jobId: job.id,
      deadlineMs,
      signal: controller.signal,
      shouldAbort: turnInactive,
    });
  } catch {
    // The poll stopped without a terminal fact: an interruption, the per-candidate
    // deadline, or a transport failure. Cancel the job we own either way — leaving a
    // solve running that nothing is waiting on is exactly the capacity leak the
    // ordinary reserve exists to prevent.
    await requestCancel(runtime, job.id, controller.signal);
    if (turnInactive()) {
      withCandidate = settleCandidate(
        withCandidate,
        proposed.candidateId,
        notStarted("transport_rejected"),
        runtime.now(),
      );
      await runtime.putSearch(withCandidate, guard);
      const interrupted = closeSearch(withCandidate, "interrupted", null, runtime.now());
      await runtime.putSearch(interrupted, guard);
      return interrupted;
    }
    // A deadline or transport failure: the candidate produced no evidence. The job
    // may still settle under ordinary retention; it can never re-enter this turn.
    withCandidate = settleCandidate(
      withCandidate,
      proposed.candidateId,
      UNCLASSIFIED_FAILURE,
      runtime.now(),
    );
    await runtime.putSearch(withCandidate, guard);
    return withCandidate;
  } finally {
    runtime.unregisterJob(job.id);
  }

  // The job reached a terminal state, but the turn may have closed while we waited.
  // A late fact belonging to a closed turn is quarantined: it is recorded as history
  // and never becomes evidence, never reaches the model, and never opens a Preview.
  if (turnInactive()) {
    withCandidate = settleCandidate(
      withCandidate,
      proposed.candidateId,
      notStarted("transport_rejected"),
      runtime.now(),
    );
    await runtime.putSearch(withCandidate, guard);
    const interrupted = closeSearch(withCandidate, "interrupted", null, runtime.now());
    await runtime.putSearch(interrupted, guard);
    return interrupted;
  }

  // 8. Map the terminal fact to its closed product outcome. An unknown fact is
  //    already failed/unclassified by the time it leaves the mapping.
  const mapped: ProductOutcomeView =
    mapJobToProductOutcome({
      state: terminal.state,
      terminal: terminal.terminal,
      result: terminal.result,
      error: terminal.error,
    }) ?? UNCLASSIFIED_FAILURE;
  withCandidate = settleCandidate(withCandidate, proposed.candidateId, mapped, runtime.now());

  // 9. Identity must still bind. The server echoes the basis it accepted; if its
  //    parent, transform, input digest, or basis id disagrees with what this browser
  //    believes it submitted, the result describes SOME run but not the one we can
  //    speak for. Quarantine it: it stays visible as a failure, never as evidence.
  const settled = withCandidate.candidates.find((c) => c.candidateId === proposed.candidateId);
  const identity =
    settled === undefined
      ? { ok: false as const, reason: "unsettled" as const }
      : candidateIdentityState(withCandidate, settled, terminal.request.basis);
  if (!identity.ok) {
    withCandidate = settleCandidate(
      withCandidate,
      proposed.candidateId,
      UNCLASSIFIED_FAILURE,
      runtime.now(),
    );
    withCandidate = markCandidateQuarantined(withCandidate, proposed.candidateId, identity.reason);
  }

  await runtime.putSearch(withCandidate, guard);
  return withCandidate;
}

/** Best-effort backend cancellation. A refusal never becomes the caller's problem. */
async function requestCancel(
  runtime: DiagnosticRuntime,
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await runtime.cancelJob(jobId, signal);
  } catch {
    // The job may still finish under ordinary retention; this turn is done with it.
  }
}

/** Record why a settled candidate's identity failed to bind. */
function markCandidateQuarantined(
  search: DiagnosticSearchRecordV1,
  candidateId: string,
  reason: string,
): DiagnosticSearchRecordV1 {
  return {
    ...search,
    candidates: search.candidates.map((candidate) =>
      candidate.candidateId === candidateId
        ? {
            ...candidate,
            rejection: {
              code: reason,
              message:
                "This test result does not match the change it was supposed to test, " +
                "so it is not being used as evidence.",
            },
          }
        : candidate,
    ),
  };
}

/** Select the first tested-feasible candidate for Preview handoff, if any. */
function finalize(search: DiagnosticSearchRecordV1): DiagnosticSearchResult {
  for (const candidate of search.candidates) {
    if (candidate.outcome?.outcome === "tested-feasible") {
      return { search, previewCandidate: candidate };
    }
  }
  return { search, previewCandidate: null };
}
