// T16f — deterministic durable-stream ACCEPTANCE journeys.
//
// These drive the REAL Optimize & Export screen (mounted by the env-gated
// `/optimize-durable-fixture`, which wires the real run controller, T16q session
// transaction, SSE parser, reconnect loop, terminal download/restore, cleanup, and
// recovery) and intercept the same-origin `/api/**` boundary with deterministic,
// contract-valid fixtures (`support/optimize-durable.ts`). Unlike the presentational
// `optimize-screen.spec.ts`, each test exercises submit → stream → terminal →
// download → cleanup end to end through the genuine client pipeline in a real
// browser. It makes NO claim about the Browser → Next → FastAPI transport itself —
// that is the release-blocking assembled Compose gate
// (`optimize-assembled-stream.spec.ts` + `make verify-stream`); here the transport
// is stubbed so the client behaviour is deterministic.
//
// Durable requirement matrix (ticket → executed evidence):
//
//   Requirement              | Browser test (this spec)                            | Assembled gate / vitest
//   -------------------------|------------------------------------------------------|---------------------------
//   queue position           | "queued position renders"                            | —
//   progress                 | happy-path stream (progressed frames)                | assembled: live stream
//   phase                    | "phase_changed reaches rendered log"                 | run-view.test.ts:604
//   controls (cancel/finish) | "server controls" / finish-now                       | —
//   optimal                  | "optimal run"                                        | assembled: tiny job
//   feasible                 | "finish-now"                                         | —
//   infeasible / no-artifact | "infeasible"                                         | —
//   cancel                   | "cancels to terminal"                                | assembled: live cancel
//   finish-now               | "finish-now"                                         | —
//   queue capacity           | "capacity error renders"                             | —
//   cursor expired recovery  | "cursor-expired recovery reconnects"                 | event-stream.test.ts:345
//   invalid cursor recovery  | "invalid-cursor recovery reconnects"                  | event-stream.test.ts:403
//   missing job              | "missing-job recovery"                               | event-stream.test.ts:325
//   missing artifact         | "completed-but-missing artifact"                     | —
//   worker-lost              | "worker-lost release" (dismiss executed)              | —
//   reload/resume            | "anonymized reload"                                  | assembled: live replay
//   cleanup retry            | "cleanup-failure retry"                              | assembled: tiny DELETE
//   cleanup abandon          | "cleanup abandon"                                    | —
//   cancelled dismiss        | "cancelled dismiss"                                  | —
//   degraded activation      | —                                                    | session-recovery.integration.test.tsx:527
//   anonymized restore       | "anonymized reload"                                  | restore-people-ids.test.ts
//   real browser download    | "anonymized reload"                                  | assembled: tiny download

import { expect, test, type Page, type Route } from "@playwright/test";
import {
  OPTIMIZE_SESSION_SCHEMA_VERSION,
  OPTIMIZE_SESSION_STORAGE_KEY,
  type ActiveOptimizeSession,
} from "@/lib/optimize/session-transaction";
import {
  cancelledJob,
  completedJob,
  DURABLE_FIXTURE_URL,
  failedJob,
  gotoDurableFixture,
  installOptimizeRoutes,
  json,
  JOB_ID,
  phaseChangedFrame,
  queuedJob,
  resultAvailableFrame,
  runningFrame,
  runningJob,
  sse,
  terminalFrame,
  xlsx,
} from "./support/optimize-durable";

/** A live-running stream: delivers one `running` frame (enough for the
 *  controller to enter the active lifecycle and render the server controls)
 *  then closes. The controller polls + reconnects on the close, and a control
 *  POST (cancel / finish-now) drives the terminal transition. The accompanying
 *  `onPoll` MUST keep returning a running job so the run stays live across
 *  reconnects until the user acts. */
function liveRunningEvents() {
  return (route: Route) => sse(route, [runningFrame("c1")]);
}

async function seedAndOpen(page: Page) {
  await gotoDurableFixture(page);
  await expect(page.getByTestId("optimize-durable-fixture")).toBeVisible();
  await expect(page.getByTestId("screen")).toBeVisible();
  // Anonymize defaults ON, but the canned `prepare` returns an empty reverse
  // map, so the restore path would reject the downloaded artifact. Turn the
  // toggle OFF (a real user choice) so the plain download + cleanup chain runs
  // end to end; the anonymized restore path stays proven in vitest.
  await disableAnonymize(page);
  // Server identity must resolve online before Optimize enables.
  await expect(page.getByTestId("optimize-submit")).toBeEnabled();
}

/** Turn the (default-on) Anonymize toggle off so a completed run downloads the
 *  server artifact directly (no anonymized-id restoration). The anonymized restore
 *  path is proven separately in vitest (restore-people-ids-in-xlsx.test.ts,
 *  use-optimize-terminal.test.tsx); these journeys prove the plain download +
 *  cleanup chain in a real browser. */
async function disableAnonymize(page: Page) {
  const toggle = page.getByRole("switch", { name: /Anonymize/i });
  if ((await toggle.getAttribute("aria-checked")) === "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-checked", "false");
}

const STALE_RECOVERY_CURSOR = "v1.stale.cursor";
const RECOVERED_RUNNING_CURSOR = "c-recovered-running";
const RECOVERED_RESULT_CURSOR = "c-recovered-result";
const RECOVERED_TERMINAL_CURSOR = "c-recovered-terminal";

interface CursorResetBoundary {
  phase: string | null;
  jobId: string | null;
  hasLastCursor: boolean;
  lastCursor: string | null;
}

async function seedActiveRecovery(page: Page, cursor: string): Promise<void> {
  const record: ActiveOptimizeSession = {
    schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
    ownerId: "owner-e2e-cursor-recovery",
    phase: "active",
    jobId: JOB_ID,
    anonymized: false,
    runOptions: { prettify: false, timeout: 300 },
    peopleCount: 0,
    reverseMap: [],
    lastCursor: cursor,
  };
  await page.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), {
    key: OPTIMIZE_SESSION_STORAGE_KEY,
    value: JSON.stringify(record),
  });
}

async function readCursorResetBoundary(page: Page): Promise<CursorResetBoundary> {
  return page.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    if (!raw) {
      return { phase: null, jobId: null, hasLastCursor: false, lastCursor: null };
    }
    const record = JSON.parse(raw) as {
      phase?: string;
      jobId?: string;
      lastCursor?: string;
    };
    return {
      phase: record.phase ?? null,
      jobId: record.jobId ?? null,
      hasLastCursor: Object.prototype.hasOwnProperty.call(record, "lastCursor"),
      lastCursor: record.lastCursor ?? null,
    };
  }, OPTIMIZE_SESSION_STORAGE_KEY);
}

async function hasAppliedRecoveredTerminal(page: Page): Promise<boolean> {
  const boundary = await readCursorResetBoundary(page);
  const eventLog =
    (await page
      .getByTestId("optimize-event-log")
      .textContent()
      .catch(() => "")) ?? "";
  return (
    boundary.lastCursor === RECOVERED_TERMINAL_CURSOR &&
    eventLog.includes("outcome=optimal") &&
    eventLog.includes("state=completed")
  );
}

async function proveCursorRecovery(
  page: Page,
  error: {
    status: 400 | 409;
    code: "event_cursor_expired" | "invalid_event_cursor";
    message: string;
    oldestEventId?: string;
  },
): Promise<void> {
  const requestCursors: Array<string | null> = [];
  const pollOutcomes: string[] = [];
  let resetBoundary: CursorResetBoundary | null = null;
  let xlsxAttempts = 0;

  await seedActiveRecovery(page, STALE_RECOVERY_CURSOR);
  await installOptimizeRoutes(page, {
    onEvents: async (route) => {
      const cursor = route.request().headers()["last-event-id"] ?? null;
      requestCursors.push(cursor);
      if (requestCursors.length === 1) {
        return route.fulfill({
          status: error.status,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: error.code,
              message: error.message,
              ...(error.oldestEventId ? { oldest_event_id: error.oldestEventId } : {}),
            },
          }),
        });
      }

      // Observe durable storage at the exact reset boundary, before the second
      // body is released to the parser and commits its fresh cursors.
      resetBoundary = await readCursorResetBoundary(page);
      return sse(route, [
        runningFrame(RECOVERED_RUNNING_CURSOR),
        resultAvailableFrame(RECOVERED_RESULT_CURSOR, "optimal"),
        terminalFrame(RECOVERED_TERMINAL_CURSOR, "completed"),
      ]);
    },
    onPoll: async (route) => {
      if (!(await hasAppliedRecoveredTerminal(page))) {
        pollOutcomes.push("running");
        return json(route, 200, runningJob());
      }
      // The controller requires one authoritative full snapshot to enter its
      // terminal download state. That snapshot is withheld until the exact
      // second-body cursor is durable and both result + terminal frames have
      // crossed the parser/controller/render boundary.
      pollOutcomes.push("completed-after-recovered-terminal");
      return json(route, 200, completedJob(JOB_ID, { outcome: "optimal" }));
    },
    onXlsx: (route) => {
      xlsxAttempts += 1;
      return xlsx(route);
    },
  });

  await gotoDurableFixture(page);
  await expect(page.getByTestId("optimize-durable-fixture")).toBeVisible();
  await expect(page.getByTestId("screen")).toBeVisible();

  await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
    "downloaded successfully",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("optimize-event-log")).toContainText("outcome=optimal");
  await expect(page.getByTestId("optimize-event-log")).toContainText("state=completed");

  expect(requestCursors).toEqual([STALE_RECOVERY_CURSOR, null]);
  expect(resetBoundary).toEqual({
    phase: "active",
    jobId: JOB_ID,
    hasLastCursor: false,
    lastCursor: null,
  });
  expect(pollOutcomes).toContain("running");
  expect(pollOutcomes).toContain("completed-after-recovered-terminal");
  expect(xlsxAttempts).toBe(1);
}

async function proveMissingRecoveredTerminalCannotComplete(page: Page): Promise<void> {
  const requestCursors: Array<string | null> = [];
  const pollOutcomes: string[] = [];
  let xlsxAttempts = 0;

  await seedActiveRecovery(page, STALE_RECOVERY_CURSOR);
  await installOptimizeRoutes(page, {
    onEvents: (route) => {
      requestCursors.push(route.request().headers()["last-event-id"] ?? null);
      if (requestCursors.length === 1) {
        return json(route, 409, {
          error: {
            code: "event_cursor_expired",
            message: "Requested event history is no longer retained.",
            oldest_event_id: "v1.j.0",
          },
        });
      }

      // Mutation control: the recovery body contains the result but omits the
      // exact terminal frame/cursor. A polling implementation that merely saw
      // the second request would incorrectly complete and download here.
      return sse(route, [
        runningFrame(RECOVERED_RUNNING_CURSOR),
        resultAvailableFrame(RECOVERED_RESULT_CURSOR, "optimal"),
      ]);
    },
    onPoll: async (route) => {
      if (await hasAppliedRecoveredTerminal(page)) {
        pollOutcomes.push("incorrect-terminal-unlock");
        return json(route, 200, completedJob(JOB_ID, { outcome: "optimal" }));
      }
      pollOutcomes.push("running");
      return json(route, 200, runningJob());
    },
    onXlsx: (route) => {
      xlsxAttempts += 1;
      return xlsx(route);
    },
  });

  await gotoDurableFixture(page);
  await expect(page.getByTestId("screen")).toBeVisible();
  await expect(page.getByTestId("optimize-event-log")).toContainText("outcome=optimal", {
    timeout: 10_000,
  });
  await expect
    .poll(async () => (await readCursorResetBoundary(page)).lastCursor, { timeout: 10_000 })
    .toBe(RECOVERED_RESULT_CURSOR);

  // Allow another controller poll/reconnect turn; the absent terminal cursor
  // must keep both the terminal UI and artifact request locked.
  await expect.poll(() => pollOutcomes.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1_000);
  expect(requestCursors.slice(0, 2)).toEqual([STALE_RECOVERY_CURSOR, null]);
  expect(pollOutcomes).not.toContain("incorrect-terminal-unlock");
  expect(xlsxAttempts).toBe(0);
  await expect(page.getByTestId("optimize-completed-artifact")).toHaveCount(0);
}

test.describe("Optimize & Export — durable-stream acceptance journeys", () => {
  test("optimal run streams to completion, auto-downloads, and cleans up", async ({ page }) => {
    await installOptimizeRoutes(page);
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    // Terminal success: the artifact was fetched, restored, and the first browser
    // download completed (the success copy only renders once download === "downloaded").
    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
    );
    await expect(page.getByTestId("optimize-download-again")).toBeVisible();
    // Terminal cleanup (DELETE 204) released the durable record: a new run is allowed.
    await expect(page.getByTestId("optimize-submit")).toBeEnabled();
  });

  test("infeasible run shows the infeasible panel and fabricates no download", async ({ page }) => {
    await installOptimizeRoutes(page, {
      onEvents: (route) =>
        sse(route, [
          runningFrame("c1"),
          resultAvailableFrame("c2", "infeasible"),
          terminalFrame("c3", "completed"),
        ]),
      onPoll: (route) => json(route, 200, completedJob(JOB_ID, { outcome: "infeasible" })),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    await expect(page.getByTestId("optimize-infeasible")).toContainText(
      "no roster satisfies every hard rule",
    );
    await expect(page.getByTestId("optimize-infeasible")).toContainText("infeasibility_proven");
    await expect(page.getByTestId("optimize-download-again")).toHaveCount(0);
  });

  test("a running job renders server controls and cancels to a terminal error", async ({
    page,
  }) => {
    await installOptimizeRoutes(page, {
      onSubmit: (route) => json(route, 202, runningJob()),
      onEvents: liveRunningEvents(),
      onPoll: (route) => json(route, 200, runningJob()),
      onCancel: (route) => json(route, 200, cancelledJob()),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    const controls = page.getByTestId("optimize-controls");
    await expect(controls).toBeVisible();
    await expect(page.getByTestId("optimize-cancel")).toBeEnabled();
    await expect(page.getByTestId("optimize-finish-now")).toBeEnabled();

    await page.getByTestId("optimize-cancel").click();

    await expect(page.getByTestId("optimize-terminal-error")).toContainText("cancelled");
    await expect(page.getByTestId("optimize-dismiss")).toBeVisible();
  });

  test("finish-now yields a downloadable feasible result", async ({ page }) => {
    await installOptimizeRoutes(page, {
      onSubmit: (route) => json(route, 202, runningJob()),
      onEvents: liveRunningEvents(),
      onPoll: (route) => json(route, 200, runningJob()),
      onFinishNow: (route) => json(route, 200, completedJob(JOB_ID, { outcome: "feasible" })),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();
    await expect(page.getByTestId("optimize-finish-now")).toBeEnabled();
    await page.getByTestId("optimize-finish-now").click();

    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
    );
  });

  test("worker-lost release: dismiss clears the failed terminal and frees the slot", async ({
    page,
  }) => {
    await installOptimizeRoutes(page, {
      onEvents: (route) => sse(route, [runningFrame("c1"), terminalFrame("c2", "failed")]),
      onPoll: (route) => json(route, 200, failedJob()),
      onDelete: (route) => route.fulfill({ status: 204, body: "" }),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    await expect(page.getByTestId("optimize-terminal-error")).toContainText("worker");
    await expect(page.getByTestId("optimize-resubmit")).toHaveText(/Resubmit/);

    // Execute the release: dismiss triggers cleanup() → DELETE 204 → reset → idle.
    // This proves the failed-terminal release path (the cold-review gap: the
    // prior test only checked Resubmit was visible, never invoked a release).
    await page.getByTestId("optimize-dismiss").click();
    await expect(page.getByTestId("optimize-submit")).toBeEnabled({ timeout: 10_000 });
    await expect(page.getByTestId("optimize-terminal-error")).toHaveCount(0, { timeout: 10_000 });
  });

  test("queued position renders", async ({ page }) => {
    // The queued state is kept stable (both the stream frame and the poll report
    // queued) so the position renders deterministically. A real queue wait
    // persists — unlike a 0-delay queued→running, which races the idle→live-header
    // panel mount (B2-1's idle empty state). The running transition itself is
    // covered by the running-controls / phase-log tests below.
    await installOptimizeRoutes(page, {
      onSubmit: (route) => json(route, 202, queuedJob(JOB_ID, 2)),
      onPoll: (route) => json(route, 200, queuedJob(JOB_ID, 2)),
      onEvents: (route) =>
        sse(route, [
          {
            id: "c1",
            event: "job.state_changed",
            data: {
              occurred_at: "2026-07-20T00:00:00+00:00",
              state: "queued",
              queue_position: 2,
              cancel_requested: false,
              early_completion_requested: false,
              terminal: false,
              worker_id: null,
              controls: { cancellable: true, early_completion_available: false },
            },
          },
        ]),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    // The job detail line surfaces the queue position for the queued state.
    await expect(page.getByTestId("optimize-job-detail")).toContainText("2");
  });

  test("phase_changed reaches the rendered event log", async ({ page }) => {
    await installOptimizeRoutes(page, {
      // Keep the poll NON-TERMINAL so the stream's frames are the authority.
      onPoll: (route) => json(route, 200, runningJob()),
      onEvents: (route) =>
        sse(route, [
          runningFrame("c1"),
          phaseChangedFrame("c2", "solver", "solve", "Searching for optimal schedule", 1.2),
          resultAvailableFrame("c3", "optimal"),
          terminalFrame("c4", "completed"),
        ]),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    // Cross-layer proof: this text exists only in the job.phase_changed wire
    // frame, so rendering it proves the frame crossed the SSE parser,
    // controller dispatch, run-view reducer, and RunEventLog component.
    const eventLog = page.getByTestId("optimize-event-log");
    await expect(eventLog).toContainText("phase:solve", { timeout: 10_000 });
    await expect(eventLog).toContainText("Searching for optimal schedule");
  });

  test("capacity error renders the queue-full rejection copy", async ({ page }) => {
    await installOptimizeRoutes(page, {
      onSubmit: (route) =>
        json(route, 429, {
          error: { code: "job_capacity_exceeded", message: "The optimization queue is full." },
        }),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    // Assert the QUEUE-FULL-SPECIFIC copy, not just a generic terminal panel.
    await expect(page.getByTestId("optimize-terminal-error")).toContainText("queue is full", {
      timeout: 10_000,
    });
  });

  test("cursor-expired recovery reconnects and reaches terminal", async ({ page }) => {
    await proveCursorRecovery(page, {
      status: 409,
      code: "event_cursor_expired",
      message: "Requested event history is no longer retained.",
      oldestEventId: "v1.j.0",
    });
  });

  test("invalid-cursor recovery reconnects and completes (distinct from expired)", async ({
    page,
  }) => {
    await proveCursorRecovery(page, {
      status: 400,
      code: "invalid_event_cursor",
      message: "Last-Event-ID is not valid for this job.",
    });
  });

  test("cursor recovery cannot complete without the exact second-body terminal cursor", async ({
    page,
  }) => {
    await proveMissingRecoveredTerminalCannotComplete(page);
  });

  test("completed-but-missing artifact surfaces the explicit download failure copy", async ({
    page,
  }) => {
    // A completed job WITH an artifact link, but the xlsx endpoint returns 404.
    let xlsxAttempts = 0;
    await installOptimizeRoutes(page, {
      onEvents: (route) =>
        sse(route, [
          runningFrame("c1"),
          resultAvailableFrame("c2", "optimal"),
          terminalFrame("c3", "completed"),
        ]),
      onPoll: (route) => json(route, 200, completedJob(JOB_ID, { outcome: "optimal" })),
      onXlsx: (route) => {
        xlsxAttempts += 1;
        return json(route, 404, {
          error: { code: "job_artifact_not_found", message: "Artifact expired." },
        });
      },
      onDelete: (route) => route.fulfill({ status: 204, body: "" }),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    // AWAIT the explicit failure copy — not merely the absence of success while
    // a download is pending. The terminal hook's notifyDownloadFailed sets the
    // error message; the panel renders it in an error Callout. This must appear
    // AFTER the fetch attempt resolves with 404, proving the completed job's
    // artifact-missing path was actually exercised.
    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "Artifact expired.",
      { timeout: 15_000 },
    );
    expect(xlsxAttempts).toBe(1);
  });

  test("cleanup failure surfaces retry and abandon; retry releases the slot", async ({ page }) => {
    let deleteAttempts = 0;
    await installOptimizeRoutes(page, {
      onDelete: (route) => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) return json(route, 500, { detail: "cleanup failed" });
        return route.fulfill({ status: 204, body: "" });
      },
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    // The download still succeeded; only the server-side release failed.
    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
    );
    await expect(page.getByTestId("optimize-cleanup-failed")).toBeVisible();
    await expect(page.getByTestId("optimize-cleanup-abandon")).toBeVisible();

    await page.getByTestId("optimize-cleanup-retry").click();

    // A successful retry clears the reserved-slot warning.
    await expect(page.getByTestId("optimize-cleanup-failed")).toHaveCount(0);
    expect(deleteAttempts).toBeGreaterThanOrEqual(2);
  });

  test("missing-job recovery surfaces a terminal error when the job vanishes mid-stream", async ({
    page,
  }) => {
    await installOptimizeRoutes(page, {
      onEvents: (route) =>
        route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "job_not_found", message: "gone" } }),
        }),
      onPoll: (route) => json(route, 404, { error: { code: "job_not_found", message: "gone" } }),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    // The controller classifies job_not_found as job-gone and surfaces a terminal
    // error with a dismiss/release action (cross-layer recovery rendering).
    await expect(page.getByTestId("optimize-terminal-error")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("optimize-dismiss")).toBeVisible();
  });

  test("cleanup abandon frees the local slot, leaving the server job to retention", async ({
    page,
  }) => {
    await installOptimizeRoutes(page, {
      onDelete: (route) => json(route, 500, { detail: "cleanup failed" }),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
    );
    await expect(page.getByTestId("optimize-cleanup-failed")).toBeVisible();

    // Abandon: destructive confirmation dialog → free the LOCAL slot.
    await page.getByTestId("optimize-cleanup-abandon").click();
    await page.getByTestId("confirm-dialog-confirm").click();

    await expect(page.getByTestId("optimize-cleanup-abandoned")).toBeVisible();
    // The local slot is freed — a new run is allowed.
    await expect(page.getByTestId("optimize-submit")).toBeEnabled({ timeout: 10_000 });
  });

  test("cancelled dismiss releases the terminal slot and returns to idle", async ({ page }) => {
    await installOptimizeRoutes(page, {
      onSubmit: (route) => json(route, 202, runningJob()),
      onEvents: liveRunningEvents(),
      onPoll: (route) => json(route, 200, runningJob()),
      onCancel: (route) => json(route, 200, cancelledJob()),
      onDelete: (route) => route.fulfill({ status: 204, body: "" }),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();
    await expect(page.getByTestId("optimize-controls")).toBeVisible();
    await page.getByTestId("optimize-cancel").click();
    await expect(page.getByTestId("optimize-terminal-error")).toContainText("cancelled");

    // Dismiss triggers cleanup() → DELETE 204 → idle (new run allowed).
    await page.getByTestId("optimize-dismiss").click();
    await expect(page.getByTestId("optimize-submit")).toBeEnabled({ timeout: 10_000 });
  });

  test("anonymized reload: persist cursor, reload, real download, restored ID verified", async ({
    page,
  }) => {
    // Build a valid one-person C5 workbook with anonymized ID P1. The workbook
    // matches the exact C5 layout the strict restore module validates (blank
    // A1/A2, date in B1, weekday in B2, P1 at A3, "Score" at A4, "Status" at
    // A5, frozen at B3) so `applyPeopleIdRestoration` can rewrite A3.
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Schedule");
    ws.getCell("B1").value = new Date(2026, 0, 1);
    ws.getCell("B2").value = "Fri";
    ws.getCell("A3").value = "P1";
    ws.getCell("A4").value = "Score";
    ws.getCell("A5").value = "Status";
    ws.views = [{ state: "frozen", xSplit: 1, ySplit: 2, topLeftCell: "B3" }];
    const c5Workbook = Buffer.from(await wb.xlsx.writeBuffer());

    // Stateful events: running-only before reload (cursor persists); full
    // terminal stream after reload (recovery reconnects → terminal → download).
    let hasReloaded = false;

    // Window flags for the one-person anonymized prep. The fixture's
    // cannedPrepare reads these; the controller stores the reverseMap in the
    // session record so the terminal hook can restore P1 → "alice".
    await page.addInitScript(() => {
      const w = window as unknown as {
        __NS_ENABLE_TEST_BRIDGE?: boolean;
        __NS_DURABLE_FIXTURE_PEOPLE_COUNT?: number;
        __NS_DURABLE_FIXTURE_REVERSE_MAP?: [string, string][];
      };
      w.__NS_ENABLE_TEST_BRIDGE = true;
      w.__NS_DURABLE_FIXTURE_PEOPLE_COUNT = 1;
      w.__NS_DURABLE_FIXTURE_REVERSE_MAP = [["P1", "alice"]];
    });

    await installOptimizeRoutes(page, {
      onEvents: (route) => {
        if (!hasReloaded) {
          return sse(route, [runningFrame("c1")]);
        }
        return sse(route, [
          runningFrame("c1"),
          resultAvailableFrame("c2", "optimal"),
          terminalFrame("c3", "completed"),
        ]);
      },
      onPoll: (route) =>
        json(route, 200, hasReloaded ? completedJob(JOB_ID, { outcome: "optimal" }) : runningJob()),
      onXlsx: (route) =>
        route.fulfill({
          status: 200,
          headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content-disposition": 'attachment; filename="schedule.xlsx"',
          },
          body: c5Workbook,
        }),
    });

    await page.goto(DURABLE_FIXTURE_URL);
    await expect(page.getByTestId("screen")).toBeVisible();
    // Keep anonymize ON (default) — this journey exercises the restore path.
    await expect(page.getByTestId("optimize-submit")).toBeEnabled();

    await page.getByTestId("optimize-submit").click();

    // Cursor persistence: the controller committed the running frame and wrote
    // lastCursor to the durable session record.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const raw = sessionStorage.getItem("nurse.optimize.session");
            if (!raw) return null;
            try {
              return (JSON.parse(raw) as { lastCursor?: string }).lastCursor ?? null;
            } catch {
              return null;
            }
          }),
        { timeout: 5_000 },
      )
      .not.toBeNull();

    // Set up the download listener BEFORE reload so it captures the auto-chain
    // download that fires when the reconnected stream reaches terminal.
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });

    // Reload → recovery reads the persisted cursor + reverseMap and reconnects.
    hasReloaded = true;
    await page.reload();
    await expect(page.getByTestId("screen")).toBeVisible({ timeout: 10_000 });

    // Terminal completion → auto-chain → real browser download.
    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
      { timeout: 30_000 },
    );

    // Capture the ACTUAL browser download (not just UI copy). Use
    // Playwright's managed temp path — no explicit file that outlives the test.
    const download = await downloadPromise;
    const downloadPath = await download.path();

    // Independently verify the restored person ID: the server workbook had P1
    // in A3; the client restored it to "alice" using the persisted reverseMap.
    const verifyWb = new ExcelJS.Workbook();
    await verifyWb.xlsx.readFile(downloadPath);
    const restoredId = verifyWb.worksheets[0].getCell("A3").value;
    expect(restoredId).toBe("alice");
    // Playwright manages the temp download path — no explicit cleanup needed.

    // Cleanup DELETE freed the slot after the successful download.
    await expect(page.getByTestId("optimize-submit")).toBeEnabled({ timeout: 10_000 });
  });
});
