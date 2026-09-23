// T10 — the orchestrator's full lifecycle, exercised through a fake runtime.
//
// Every acceptance state is covered: trusted/stale/mismatched open gating, every
// closed outcome (feasible, still-infeasible, inconclusive, failed, cancelled,
// not-started), first-feasible stop, explicit compare, five-candidate cap,
// exhaustion, capacity rejection, transport failure, poll timeout, interruption at
// each stage, scenario-changed-mid-search, and the tested-candidate Preview
// handoff. The fake runtime records every durable write so a test can assert the
// search row's final state without IndexedDB.

import { describe, expect, it } from "vitest";
import { proposalScenario } from "@/lib/proposal/test-support";
import type { AssistantCommandV1 } from "@/lib/proposal/commands";
import type { InfoSemanticProfile } from "@/app/api/info/types";
import type { JobBasis, JobResponse, JobState, OptimizationOutcome } from "@/lib/bff/types";
import type { RecoveryClassification } from "@/lib/optimize/basis/recovery";
import type { OptimizeBasisRecordV2 } from "@/lib/optimize/basis/basis-row";
import type { ScenarioUiState } from "@/lib/scenario";
import type { BasisSubmissionFields } from "@/lib/optimize/basis/basis-record";
import {
  runDiagnosticSearch,
  type CapturedGeneration,
  type DiagnosticRuntime,
  type SubmitCandidateTransport,
  type SubmitCandidateTransportResult,
} from "./diagnostic-orchestrator";
import type { DiagnosticSearchRecordV1 } from "./search-record";

const NOW = new Date("2026-08-07T12:00:00Z");
const PARENT_BASIS = "p".repeat(64);

const PROFILE: InfoSemanticProfile = {
  submission_contract_version: "optimize-yaml-v1",
  solver_semantic_version: "ortools/cp-sat@1",
  backend_capability_version: "nurse-scheduling-backend@1",
};

const GUARD: readonly CapturedGeneration[] = [
  { scopeKey: "global", generation: 1 },
  { scopeKey: "scenario:scenario-1", generation: 1 },
];

/** A candidate command that validates against proposalScenario: relax the day requirement. */
const VALID_COMMAND: AssistantCommandV1 = {
  type: "set_staffing_requirement_people",
  ruleId: "req-day",
  requiredNumPeople: 1,
};

/** A candidate command that targets a rule that does not exist (host rejects). */
const UNKNOWN_COMMAND: AssistantCommandV1 = {
  type: "set_staffing_requirement_people",
  ruleId: "no-such-rule",
  requiredNumPeople: 1,
};

interface FakeRuntimeOptions {
  recovery?: RecoveryClassification;
  scenario?: ScenarioUiState | null;
  scenarioRevision?: number;
  profile?: InfoSemanticProfile | null;
  /** What the submit returns, per call index. */
  submit?: SubmitCandidateTransportResult[];
  /** What each poll returns, keyed by jobId. */
  poll?: Record<string, JobResponse>;
  /** Whether the turn is active at each isTurnActive check. */
  turnActive?: boolean | boolean[];
  /** Throw on poll (timeout / network). */
  pollThrows?: boolean;
  /**
   * Corrupt the identity the server echoes for a polled job.
   *
   * By default the fake behaves like a healthy backend: it echoes back exactly the
   * basis fields the browser submitted, which is what makes the identity check pass.
   * A test that wants a mismatch overrides one field here.
   */
  echoOverride?: Partial<JobBasis>;
}

interface FakeRuntime extends DiagnosticRuntime {
  writes: DiagnosticSearchRecordV1[];
  cancelled: string[];
  /** Job ids registered as owned-and-cancellable, in order. */
  registered: string[];
  /** Job ids dropped from the cancellation registry, in order. */
  unregistered: string[];
  /** The basis claim submitted for each candidate, in submission order. */
  submitted: BasisSubmissionFields[];
}

function makeFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const writes: DiagnosticSearchRecordV1[] = [];
  const cancelled: string[] = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  const submitted: BasisSubmissionFields[] = [];
  /** jobId -> the basis the browser actually claimed for it. */
  const claimed = new Map<string, BasisSubmissionFields>();
  let submitIndex = 0;
  let turnCheckIndex = 0;
  const scenario = options.scenario === undefined ? proposalScenario() : options.scenario;

  const runtime: DiagnosticRuntime = {
    now: () => NOW,
    async classifyRecovery() {
      return (
        options.recovery ?? { state: "trusted", diagnosisEnabled: true, reason: "basis_match" }
      );
    },
    async readCurrentScenario() {
      if (scenario === null) return null;
      return {
        scenarioId: "scenario-1",
        documentRevision: options.scenarioRevision ?? 5,
        document: scenario,
      };
    },
    async readSemanticProfile() {
      return options.profile === undefined ? PROFILE : options.profile;
    },
    isTurnActive(_turnEpoch: number) {
      const active = options.turnActive;
      if (Array.isArray(active)) {
        return active[Math.min(turnCheckIndex++, active.length - 1)];
      }
      return active ?? true;
    },
    async captureGenerations() {
      return GUARD;
    },
    async putSearch(record) {
      writes.push(record);
    },
    async putBasis(_record: OptimizeBasisRecordV2) {
      // no-op: the basis row is tested in T08.
    },
    async bindAcceptedCandidateBasis(basisId, verify) {
      const row: OptimizeBasisRecordV2 = {
        basisId,
        schemaVersion: 2,
        scenarioId: "scenario-1",
        documentRevision: 5,
        submissionDigest: "i".repeat(64),
        basis: {
          schemaVersion: 2,
          submissionContractVersion: PROFILE.submission_contract_version,
          workspaceSchemaVersion: "1",
          serializerVersion: "canonical-strict-yaml-v1",
          anonymizationMode: "none",
          inputSha256: "i".repeat(64),
          normalizedOptions: { solver: "ortools/cp-sat", prettify: false, timeoutSeconds: 90 },
          solverSemanticVersion: PROFILE.solver_semantic_version,
          backendCapabilityVersion: PROFILE.backend_capability_version,
        },
        ownerKind: "candidate",
        attemptId: "a",
        jobId: null,
        parentBasisId: PARENT_BASIS,
        transformDigest: "t",
        submittedYaml: "yaml",
        createdAt: NOW.toISOString(),
        expiresAt: null,
      };
      return verify(row);
    },
    async submitDiagnostic(
      input: SubmitCandidateTransport,
    ): Promise<SubmitCandidateTransportResult> {
      submitted.push(input.basis);
      const results = options.submit ?? [];
      const result =
        results[Math.min(submitIndex++, results.length - 1)] ??
        ({
          ok: true,
          job: makeJob("completed", "feasible"),
        } satisfies SubmitCandidateTransportResult);
      if (result.ok) claimed.set(result.job.id, input.basis);
      return result;
    },
    async pollUntilTerminal({ jobId, shouldAbort }): Promise<JobResponse> {
      // A real poll re-reads `shouldAbort` between attempts, so an interruption ends
      // the wait rather than running out the per-candidate budget. The fake honours
      // the same contract, which is what makes the interruption cases real.
      if (shouldAbort()) throw new Error("poll aborted");
      if (options.pollThrows) throw new Error("poll failed");
      const job = options.poll?.[jobId];
      if (job === undefined) throw new Error(`no fake poll result for ${jobId}`);
      return withEchoedIdentity(job, claimed.get(jobId), options.echoOverride);
    },
    async cancelJob(jobId: string) {
      cancelled.push(jobId);
    },
    registerJob(jobId: string) {
      registered.push(jobId);
    },
    unregisterJob(jobId: string) {
      unregistered.push(jobId);
    },
  };
  return { ...runtime, writes, cancelled, registered, unregistered, submitted };
}

/**
 * Make the polled job echo the identity the browser actually claimed.
 *
 * The orchestrator's identity check compares the server's `request.basis` against
 * what it believes it submitted, so a fixture with hardcoded digests would fail every
 * case for the wrong reason. Echoing is what a healthy backend does; `override` is
 * how a test injects a specific disagreement.
 */
function withEchoedIdentity(
  job: JobResponse,
  claim: BasisSubmissionFields | undefined,
  override: Partial<JobBasis> | undefined,
): JobResponse {
  if (job.request.basis === null || claim === undefined) return job;
  return {
    ...job,
    request: {
      ...job.request,
      basis: {
        ...job.request.basis,
        basis_id: claim.basis_id,
        input_sha256: claim.input_sha256,
        parent_basis_id: claim.parent_basis_id ?? null,
        transform_digest: claim.transform_digest ?? null,
        ...override,
      },
    },
  };
}

function makeJob(
  state: JobState,
  outcome: OptimizationOutcome,
  over: Partial<JobResponse> = {},
): JobResponse {
  const id = over.id ?? "job_cand_1";
  const basis: JobBasis = {
    basis_id: "c".repeat(64),
    schema_version: 2,
    submission_contract_version: PROFILE.submission_contract_version,
    workspace_schema_version: "1",
    serializer_version: "canonical-strict-yaml-v1",
    anonymization_mode: "none",
    input_sha256: "i".repeat(64),
    normalized_options: { solver: "ortools/cp-sat", prettify: false, timeout_seconds: 90 },
    solver_semantic_version: PROFILE.solver_semantic_version,
    backend_capability_version: PROFILE.backend_capability_version,
    parent_basis_id: PARENT_BASIS,
    transform_digest: "t".repeat(32),
  };
  return {
    id,
    state,
    terminal: ["completed", "cancelled", "failed"].includes(state),
    queue_position: null,
    created_at: NOW.toISOString(),
    expires_at: "2026-08-08T00:00:00Z",
    started_at: null,
    finished_at: null,
    request: {
      input_name: "in",
      solver: "ortools/cp-sat",
      prettify: false,
      timeout_seconds: 90,
      purpose: "assistant_diagnostic",
      basis,
    },
    result: {
      outcome,
      score: null,
      solver_status: "ok",
      termination_reason:
        outcome === "infeasible"
          ? "infeasibility_proven"
          : outcome === "inconclusive"
            ? "solver_timeout_no_solution"
            : "feasible",
    },
    error: null,
    controls: { cancellable: true, early_completion_available: false },
    links: { self: "", events: "", cancellation: "", early_completion: "", schedule: null },
    ...over,
  };
}

function accepted(job: JobResponse): SubmitCandidateTransportResult {
  return { ok: true, job };
}

function rejected(code: string, message = "rejected"): SubmitCandidateTransportResult {
  return { ok: false, code, message };
}

function proposed(count: number, command: AssistantCommandV1 = VALID_COMMAND) {
  return Array.from({ length: count }, (_, i) => ({
    candidateId: `cand-${i}`,
    commands: [command],
    rationale: "test",
  }));
}

const PARENT = {
  basisId: PARENT_BASIS,
  jobId: "job_parent",
  scenarioId: "scenario-1",
  documentRevision: 5,
};

// --- Open gating -----------------------------------------------------------

describe("runDiagnosticSearch — open gating", () => {
  it("opens and runs a candidate when recovery is trusted and the scenario matches", async () => {
    const rt = makeFakeRuntime({
      submit: [accepted(makeJob("completed", "feasible"))],
      poll: { job_cand_1: makeJob("completed", "feasible") },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(result.search.status).toBe("completed");
    expect(result.search.stopReason).toBe("first_feasible");
    expect(result.search.candidates[0]!.outcome!.outcome).toBe("tested-feasible");
    expect(result.previewCandidate).not.toBeNull();
  });

  it("blocks opening when recovery is local-only and records the failure reason", async () => {
    const rt = makeFakeRuntime({
      recovery: { state: "local-only", diagnosisEnabled: false, reason: "server_job_missing" },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(result.search.status).toBe("failed");
    expect(result.search.stopReason).toBe("recovery_blocked");
    expect(result.search.failureReason).toMatch(/no longer be diagnosed/i);
    expect(result.search.candidates).toHaveLength(0);
    expect(result.previewCandidate).toBeNull();
  });

  it("blocks opening when the scenario has moved (basis not current)", async () => {
    const rt = makeFakeRuntime({ scenarioRevision: 99 });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(result.search.stopReason).toBe("recovery_blocked");
    expect(result.search.failureReason).toMatch(/out of date/i);
  });
});

// --- Closed outcomes -------------------------------------------------------

describe("runDiagnosticSearch — closed outcome mapping", () => {
  it("maps a completed+feasible job to tested-feasible", async () => {
    const rt = makeFakeRuntime({
      submit: [accepted(makeJob("completed", "feasible"))],
      poll: { job_cand_1: makeJob("completed", "feasible") },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(result.search.candidates[0].outcome).toMatchObject({
      outcome: "tested-feasible",
      evidence: "feasibility",
    });
  });

  it("maps a completed+infeasible job to tested-still-infeasible", async () => {
    const rt = makeFakeRuntime({
      submit: [accepted(makeJob("completed", "infeasible"))],
      poll: { job_cand_1: makeJob("completed", "infeasible") },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(result.search.candidates[0].outcome).toMatchObject({
      outcome: "tested-still-infeasible",
    });
    expect(result.search.stopReason).toBe("exhausted");
    expect(result.previewCandidate).toBeNull();
  });

  it("maps a completed+inconclusive job to inconclusive", async () => {
    const rt = makeFakeRuntime({
      submit: [accepted(makeJob("completed", "inconclusive"))],
      poll: { job_cand_1: makeJob("completed", "inconclusive") },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(result.search.candidates[0].outcome).toMatchObject({
      outcome: "inconclusive",
      evidence: "no-proof",
    });
  });

  it("maps a failed job to failed (no evidence)", async () => {
    const rt = makeFakeRuntime({
      submit: [
        accepted(
          makeJob("failed", "infeasible", {
            error: { code: "process_timeout", message: "x" },
            result: null,
          }),
        ),
      ],
      poll: {
        job_cand_1: makeJob("failed", "infeasible", {
          error: { code: "process_timeout", message: "x" },
          result: null,
        }),
      },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(result.search.candidates[0].outcome).toMatchObject({
      outcome: "failed",
      evidence: "none",
      reason: "process_timeout",
    });
  });

  it("maps a cancelled job to cancelled", async () => {
    const rt = makeFakeRuntime({
      submit: [
        accepted(
          makeJob("cancelled", "feasible", {
            error: { code: "cancelled", message: "x" },
            result: null,
          }),
        ),
      ],
      poll: {
        job_cand_1: makeJob("cancelled", "feasible", {
          error: { code: "cancelled", message: "x" },
          result: null,
        }),
      },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(result.search.candidates[0].outcome).toMatchObject({ outcome: "cancelled" });
  });
});

// --- Stop logic ------------------------------------------------------------

describe("runDiagnosticSearch — stop logic", () => {
  it("stops at the first feasible candidate when compare is false", async () => {
    const rt = makeFakeRuntime({
      submit: [
        accepted(makeJob("completed", "infeasible", { id: "job-1" })),
        accepted(makeJob("completed", "feasible", { id: "job-2" })),
        accepted(makeJob("completed", "feasible", { id: "job-3" })),
      ],
      poll: {
        "job-1": makeJob("completed", "infeasible", { id: "job-1" }),
        "job-2": makeJob("completed", "feasible", { id: "job-2" }),
      },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(3),
      },
      rt,
    );
    // Only two candidates were submitted (infeasible, then feasible stops).
    expect(result.search.candidates).toHaveLength(2);
    expect(result.search.stopReason).toBe("first_feasible");
  });

  it("continues past feasible and stops at cap when compare is true", async () => {
    const submit = Array.from({ length: 5 }, (_, i) =>
      accepted(makeJob("completed", "feasible", { id: `job-${i + 1}` })),
    );
    const poll: Record<string, JobResponse> = {};
    for (let i = 0; i < 5; i += 1)
      poll[`job-${i + 1}`] = makeJob("completed", "feasible", { id: `job-${i + 1}` });
    const rt = makeFakeRuntime({ submit, poll });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: true,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(6),
      },
      rt,
    );
    expect(result.search.candidates).toHaveLength(5);
    expect(result.search.stopReason).toBe("compare_complete");
  });

  it("stops with exhausted when all proposed candidates are infeasible", async () => {
    const rt = makeFakeRuntime({
      submit: [
        accepted(makeJob("completed", "infeasible", { id: "job-1" })),
        accepted(makeJob("completed", "infeasible", { id: "job-2" })),
      ],
      poll: {
        "job-1": makeJob("completed", "infeasible", { id: "job-1" }),
        "job-2": makeJob("completed", "infeasible", { id: "job-2" }),
      },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(2),
      },
      rt,
    );
    expect(result.search.stopReason).toBe("exhausted");
  });

  it("never submits more than five candidates even if more are proposed", async () => {
    const submit = Array.from({ length: 6 }, (_, i) =>
      accepted(makeJob("completed", "infeasible", { id: `job-${i + 1}` })),
    );
    const poll: Record<string, JobResponse> = {};
    for (let i = 0; i < 6; i += 1)
      poll[`job-${i + 1}`] = makeJob("completed", "infeasible", { id: `job-${i + 1}` });
    const rt = makeFakeRuntime({ submit, poll });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(6),
      },
      rt,
    );
    expect(result.search.candidates).toHaveLength(5);
    expect(result.search.stopReason).toBe("cap_reached");
  });
});

// --- Failures + capacity ---------------------------------------------------

describe("runDiagnosticSearch — capacity rejection + failures", () => {
  it("records a capacity rejection as not-started and continues to the next candidate", async () => {
    const rt = makeFakeRuntime({
      submit: [
        rejected("diagnostic_capacity_reserved"),
        accepted(makeJob("completed", "feasible", { id: "job-2" })),
      ],
      poll: { "job-2": makeJob("completed", "feasible", { id: "job-2" }) },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(2),
      },
      rt,
    );
    expect(result.search.candidates[0]!.outcome).toMatchObject({
      outcome: "not-started",
      reason: "diagnostic_capacity_reserved",
    });
    expect(result.search.candidates[1]!.outcome!.outcome).toBe("tested-feasible");
    expect(result.search.stopReason).toBe("first_feasible");
  });

  it("records a transport rejection as not-started transport_rejected", async () => {
    const rt = makeFakeRuntime({ submit: [rejected("validation", "bad")] });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(result.search.candidates[0].outcome).toMatchObject({
      outcome: "not-started",
      reason: "transport_rejected",
    });
  });

  it("records a host-rejected candidate (invalid commands) as not-started without submission", async () => {
    const rt = makeFakeRuntime({
      submit: [accepted(makeJob("completed", "feasible"))],
      poll: { job_cand_1: makeJob("completed", "feasible") },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: [{ candidateId: "c0", commands: [UNKNOWN_COMMAND], rationale: null }],
      },
      rt,
    );
    expect(result.search.candidates[0]!.rejection).not.toBeNull();
    expect(result.search.candidates[0]!.outcome!.outcome).toBe("not-started");
    expect(result.search.candidates[0]!.jobId).toBeNull();
  });

  it("settles a poll failure (timeout/network) as failed/unclassified", async () => {
    const rt = makeFakeRuntime({
      submit: [accepted(makeJob("running", "feasible"))],
      pollThrows: true,
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(result.search.candidates[0].outcome).toMatchObject({
      outcome: "failed",
      reason: "unclassified_failure",
    });
  });
});

// --- Interruption ----------------------------------------------------------

describe("runDiagnosticSearch — interruption at every stage", () => {
  it("stops before preparing the first candidate when the turn is already inactive", async () => {
    const rt = makeFakeRuntime({ turnActive: false });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(2),
      },
      rt,
    );
    expect(result.search.status).toBe("interrupted");
    expect(result.search.candidates).toHaveLength(0);
  });

  it("cancels the running job and closes the search when the turn goes inactive during polling", async () => {
    const rt = makeFakeRuntime({
      // Active at the first check (before candidate 1), inactive during poll.
      turnActive: [true, false],
      submit: [accepted(makeJob("running", "feasible"))],
      poll: {
        job_cand_1: makeJob("cancelled", "feasible", {
          error: { code: "cancelled", message: "x" },
          result: null,
        }),
      },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(2),
      },
      rt,
    );
    expect(result.search.status).toBe("interrupted");
    expect(rt.cancelled).toContain("job_cand_1");
  });

  it("fails closed when the scenario changes mid-search (parent untrusted)", async () => {
    // First readCurrentScenario returns scenario-1; the per-candidate re-read returns
    // a different scenario id by swapping the scenario after the first call.
    let callCount = 0;
    const rt = makeFakeRuntime({
      submit: [accepted(makeJob("completed", "feasible"))],
      poll: { job_cand_1: makeJob("completed", "feasible") },
    });
    rt.readCurrentScenario = async () => {
      callCount += 1;
      if (callCount <= 1)
        return { scenarioId: "scenario-1", documentRevision: 5, document: proposalScenario() };
      // Mid-search: the scenario identity moved.
      return { scenarioId: "scenario-other", documentRevision: 5, document: proposalScenario() };
    };
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(result.search.status).toBe("failed");
    expect(result.search.stopReason).toBe("parent_untrusted");
  });
});

// --- Identity binding on the real path -------------------------------------

describe("runDiagnosticSearch — identity must bind before a result is evidence", () => {
  it("submits the candidate under the diagnostic purpose bound to its parent", async () => {
    const rt = makeFakeRuntime({
      submit: [accepted(makeJob("completed", "feasible"))],
      poll: { job_cand_1: makeJob("completed", "feasible") },
    });
    await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    // The claim names the parent it hangs off and the transform it applied. Without
    // both, the backend cannot tell a candidate from an ordinary run.
    expect(rt.submitted[0]!.parent_basis_id).toBe(PARENT_BASIS);
    expect(rt.submitted[0]!.transform_digest).toEqual(expect.any(String));
    expect(rt.submitted[0]!.transform_digest).not.toBe("");
  });

  it.each([
    ["a different parent", { parent_basis_id: "x".repeat(64) }],
    ["a different transform", { transform_digest: "z".repeat(32) }],
    ["different submitted bytes", { input_sha256: "z".repeat(64) }],
    ["a different candidate basis", { basis_id: "y".repeat(64) }],
  ])("quarantines a FEASIBLE result the server attributes to %s", async (_label, echoOverride) => {
    const rt = makeFakeRuntime({
      submit: [accepted(makeJob("completed", "feasible"))],
      poll: { job_cand_1: makeJob("completed", "feasible") },
      echoOverride,
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    // The solver really did prove SOMETHING feasible, but not demonstrably the
    // change we prepared — so it must never read as tested evidence, and must never
    // become an Apply-capable Preview.
    expect(result.search.candidates[0]!.outcome!.outcome).toBe("failed");
    expect(result.search.candidates[0]!.rejection).not.toBeNull();
    expect(result.previewCandidate).toBeNull();
    expect(result.search.stopReason).not.toBe("first_feasible");
  });
});

// --- Cancellation ownership ------------------------------------------------

describe("runDiagnosticSearch — cancellation ownership", () => {
  it("registers an accepted job BEFORE polling and drops it once settled", async () => {
    // Registering after the search returned would be too late by construction: by
    // then there is nothing left to cancel. The order asserted here is the whole
    // guarantee that a T05 interruption can reach a running diagnostic.
    const order: string[] = [];
    const rt = makeFakeRuntime({
      submit: [accepted(makeJob("completed", "feasible"))],
      poll: { job_cand_1: makeJob("completed", "feasible") },
    });
    const register = rt.registerJob.bind(rt);
    const poll = rt.pollUntilTerminal.bind(rt);
    rt.registerJob = (jobId) => {
      order.push(`register:${jobId}`);
      register(jobId);
    };
    rt.pollUntilTerminal = async (input) => {
      order.push(`poll:${input.jobId}`);
      return poll(input);
    };
    rt.unregisterJob = (jobId) => order.push(`unregister:${jobId}`);

    await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(order).toEqual(["register:job_cand_1", "poll:job_cand_1", "unregister:job_cand_1"]);
  });

  it("cancels and deregisters a job whose poll hit the per-candidate deadline", async () => {
    // Leaving a solve running that nothing is waiting on is exactly the capacity
    // leak the ordinary reserve exists to prevent.
    const rt = makeFakeRuntime({
      submit: [accepted(makeJob("running", "feasible"))],
      pollThrows: true,
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(rt.cancelled).toEqual(["job_cand_1"]);
    expect(rt.unregistered).toEqual(["job_cand_1"]);
    expect(result.search.candidates[0]!.outcome).toMatchObject({ outcome: "failed" });
  });
});

// --- Preview handoff -------------------------------------------------------

describe("runDiagnosticSearch — Preview handoff", () => {
  it("returns the first tested-feasible candidate as the Preview candidate", async () => {
    const rt = makeFakeRuntime({
      submit: [
        accepted(makeJob("completed", "infeasible", { id: "job-1" })),
        accepted(makeJob("completed", "feasible", { id: "job-2" })),
      ],
      poll: {
        "job-1": makeJob("completed", "infeasible", { id: "job-1" }),
        "job-2": makeJob("completed", "feasible", { id: "job-2" }),
      },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(2),
      },
      rt,
    );
    expect(result.previewCandidate).not.toBeNull();
    expect(result.previewCandidate?.index).toBe(1);
    expect(result.previewCandidate?.outcome!.outcome).toBe("tested-feasible");
  });

  it("returns no Preview candidate when no candidate was feasible", async () => {
    const rt = makeFakeRuntime({
      submit: [accepted(makeJob("completed", "infeasible"))],
      poll: { job_cand_1: makeJob("completed", "infeasible") },
    });
    const result = await runDiagnosticSearch(
      {
        searchId: "s1",
        threadId: null,
        turnId: null,
        turnEpoch: 1,
        leaseEpoch: 1,
        compare: false,
        parent: PARENT,
        parentExpiresAt: null,
        proposed: proposed(1),
      },
      rt,
    );
    expect(result.previewCandidate).toBeNull();
  });
});
