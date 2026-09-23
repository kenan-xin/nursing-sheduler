// Which owned diagnostic jobs an interruption actually asks to stop.
//
// THE DEFECT THIS FIXES. Clear all closes every turn in the tab, but it forwarded the
// SELECTED scenario to the diagnostic canceller -- and the canceller treats a non-null
// scenario as a filter. So a user with a running diagnostic in another schedule was
// told the assistant had been stopped and cleared, while that job kept running and the
// backend was never asked to cancel it. Generation fencing still stopped its RESULT
// from being used, which is why nothing else caught it: the leak is in what was asked,
// not in what was believed.
//
// These drive the real product action and the real owned-job registry, so the assertion
// is on the request the canceller genuinely received.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerOwnedDiagnosticJob,
  resetOwnedDiagnosticJobsForTest,
} from "@/lib/ai/diagnostic/diagnostic-canceller";
import {
  setDiagnosticCanceller,
  type DiagnosticCancellationRequest,
} from "./diagnostic-cancellation";
import { assistantActions, hydrateAssistant } from "./store";
import { selectActiveThread } from "./history-repo";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  createAssistantHarness,
  type AssistantHarness,
} from "./test-support";

const SCENARIO_A = "scenario-a";
const SCENARIO_B = "scenario-b";

let harness: AssistantHarness;
let requests: DiagnosticCancellationRequest[];

beforeEach(async () => {
  harness = createAssistantHarness();
  void harness;
  requests = [];
  assistantActions.resetForTest();
  resetOwnedDiagnosticJobsForTest();
  await hydrateAssistant();
  await assistantActions.setEnabled(true);
  await assistantActions.activate({
    apiKey: SENTINEL_KEY,
    modelId: TEST_MODEL,
    modelSource: "catalog",
  });
  // Capture what the controller ASKS FOR, and answer as a real canceller would.
  setDiagnosticCanceller({
    async cancelOwnedJobs(request) {
      requests.push(request);
      return [];
    },
  });
  await selectActiveThread(SCENARIO_A);
  await selectActiveThread(SCENARIO_B);
});

afterEach(() => {
  setDiagnosticCanceller(null);
  resetOwnedDiagnosticJobsForTest();
  vi.restoreAllMocks();
});

describe("Clear all cancels globally", () => {
  it("asks for every owned job, whatever schedule is selected", async () => {
    // The user is looking at A; a diagnostic is running in B as well.
    await assistantActions.clearAll({ threadId: null, scenarioId: SCENARIO_A });

    expect(requests).toHaveLength(1);
    // NULL MEANS EVERY SCENARIO to the canceller's own filter. Passing the selected
    // scenario here is what silently spared every other schedule's jobs.
    expect(requests[0]).toMatchObject({
      trigger: "clear_all",
      threadId: null,
      scenarioId: null,
    });
  });

  it("reaches owned jobs in a scenario the user is not looking at", async () => {
    // The REAL canceller, with real owned jobs in two scenarios.
    const cancelled: string[] = [];
    const { createDiagnosticCanceller } = await import("@/lib/ai/diagnostic/diagnostic-canceller");
    setDiagnosticCanceller(
      createDiagnosticCanceller({
        async cancelJob(jobId) {
          cancelled.push(jobId);
        },
        async readJob() {
          return null;
        },
      }),
    );
    registerOwnedDiagnosticJob({
      jobId: "job-a",
      threadId: null,
      scenarioId: SCENARIO_A,
      turnEpoch: 0,
    });
    registerOwnedDiagnosticJob({
      jobId: "job-b",
      threadId: null,
      scenarioId: SCENARIO_B,
      turnEpoch: 0,
    });

    await assistantActions.clearAll({ threadId: null, scenarioId: SCENARIO_A });

    // BOTH, not just the selected schedule's.
    expect(cancelled.sort()).toEqual(["job-a", "job-b"]);
  });
});

describe("Clear history stays scoped to its captured scenario", () => {
  it("asks only for its own scenario's jobs", async () => {
    await assistantActions.clearHistory({ threadId: null, scenarioId: SCENARIO_A });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      trigger: "clear_history",
      scenarioId: SCENARIO_A,
    });
  });

  it("leaves another scenario's owned job alone", async () => {
    const cancelled: string[] = [];
    const { createDiagnosticCanceller } = await import("@/lib/ai/diagnostic/diagnostic-canceller");
    setDiagnosticCanceller(
      createDiagnosticCanceller({
        async cancelJob(jobId) {
          cancelled.push(jobId);
        },
        async readJob() {
          return null;
        },
      }),
    );
    registerOwnedDiagnosticJob({
      jobId: "job-a",
      threadId: null,
      scenarioId: SCENARIO_A,
      turnEpoch: 0,
    });
    registerOwnedDiagnosticJob({
      jobId: "job-b",
      threadId: null,
      scenarioId: SCENARIO_B,
      turnEpoch: 0,
    });

    await assistantActions.clearHistory({ threadId: null, scenarioId: SCENARIO_A });

    // Scoped deletion means scoped cancellation: B's job is not this clear's business.
    expect(cancelled).toEqual(["job-a"]);
  });
});

describe("Disable is global too", () => {
  it("asks for every owned job rather than the selected scenario's", async () => {
    await assistantActions.setEnabled(false, { threadId: null, scenarioId: SCENARIO_A });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ trigger: "disable", threadId: null, scenarioId: null });
  });
});
