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
//   cursor expired recovery  | — (see below)                                        | event-stream.test.ts:345
//   invalid cursor recovery  | — (see below)                                        | event-stream.test.ts:403
//   missing job              | "missing-job recovery"                               | event-stream.test.ts:325
//   missing artifact         | "completed-but-missing artifact"                     | —
//   worker-lost              | "worker-lost release" (dismiss executed)              | —
//   FRESH re-entry           | "a record from an older run is inert on entry"       | optimize-and-export-screen.test.tsx
//   cleanup retry            | "cleanup-failure retry"                              | assembled: tiny DELETE
//   failed cleanup (no abandon) | "a failed cleanup stays the current run"          | —
//   cancelled dismiss        | "cancelled dismiss"                                  | —
//   anonymized restore       | "anonymized run"                                     | restore-people-ids.test.ts
//   real browser download    | "anonymized run"                                     | assembled: tiny download
//
// G6.2 CHANGED WHAT THIS FILE CAN COVER. The three cursor-recovery journeys and
// the reload/resume journey all drove the browser the same way: seed a durable
// ACTIVE record, open the route, and let the boot inspection resume it. Entering
// the route resumes nothing now, so that setup cannot reach the code any more.
// Mid-stream cursor expiry/invalidity is still real and still covered at the unit
// level (`event-stream.test.ts`, `run-view.test.ts`); what is lost here is the
// browser-level proof of it, because the only browser AFFORDANCE that reached it
// was resume. Recorded as a coverage delta, not quietly dropped. In its place this
// spec now proves the property the ticket is actually about: a record from an
// older run is inert on entry.

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
  rosterContainer,
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

const PRIOR_RUN_OWNER = "owner-e2e-prior-run";

/**
 * Seed the exact state the user's screenshot was taken in: a durable ACTIVE
 * record for a job from an EARLIER visit, sitting in the legacy single slot.
 *
 * The legacy key on purpose. It is the shape a tab that ran the previous build
 * would actually be holding, so this is the real upgrade path rather than a
 * synthetic one — and it is the shape that used to be read on boot, resumed, and
 * projected as “An optimisation from this browser is still running”.
 */
async function seedPriorRunRecord(page: Page): Promise<void> {
  const record: ActiveOptimizeSession = {
    schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
    ownerId: PRIOR_RUN_OWNER,
    phase: "active",
    jobId: JOB_ID,
    anonymized: false,
    runOptions: { prettify: false, timeout: 300 },
    peopleCount: 0,
    reverseMap: [],
    capture: {
      status: "staged",
      snapshotRef: PRIOR_RUN_OWNER,
      submissionOrdinal: 1,
    },
  };
  await page.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), {
    key: OPTIMIZE_SESSION_STORAGE_KEY,
    value: JSON.stringify(record),
  });
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
    // No release action: a cancelled run occupies nothing, so there is nothing to
    // dismiss and the exact `Optimize` action is already live.
    await expect(page.getByTestId("optimize-dismiss")).toHaveCount(0);
    await expect(page.getByTestId("optimize-submit")).toBeEnabled();
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

  test("worker-lost reports honestly, offers nothing to press, and blocks nothing", async ({
    page,
  }) => {
    // WAS "dismiss clears the failed terminal and frees the slot". There is no slot
    // to free: records are owner-keyed, so a failed run occupies nothing and the
    // release action it needed is gone with the thing it released.
    await installOptimizeRoutes(page, {
      onEvents: (route) => sse(route, [runningFrame("c1"), terminalFrame("c2", "failed")]),
      onPoll: (route) => json(route, 200, failedJob()),
      onDelete: (route) => route.fulfill({ status: 204, body: "" }),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    await expect(page.getByTestId("optimize-terminal-error")).toContainText("worker");
    for (const retired of ["optimize-resubmit", "optimize-dismiss", "optimize-try-again"]) {
      await expect(page.getByTestId(retired), retired).toHaveCount(0);
    }
    // The one action, live, with nothing explaining a previous run beside it.
    await expect(page.getByTestId("optimize-submit")).toBeEnabled({ timeout: 10_000 });
    await expect(page.getByTestId("optimize-disabled-reason")).toHaveCount(0);
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
          error: { code: "job_capacity_exceeded", message: "The optimisation queue is full." },
        }),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    // Assert the QUEUE-FULL-SPECIFIC copy, not just a generic terminal panel.
    await expect(page.getByTestId("optimize-terminal-error")).toContainText("queue is full", {
      timeout: 10_000,
    });
  });

  // THE SCREENSHOT STATE, in a real browser. Everything the user photographed —
  // the resumed toast, the old capture card, the futile Retry — came from this
  // one durable record being read on entry.
  test("a record from an older run is inert on entry: no resume, no request, no download", async ({
    page,
  }) => {
    const requests: string[] = [];
    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });

    await seedPriorRunRecord(page);
    await installOptimizeRoutes(page, {
      onEvents: (route) => {
        requests.push("events");
        return sse(route, [runningFrame("c1")]);
      },
      onPoll: (route) => {
        requests.push("poll");
        return json(route, 200, runningJob());
      },
      onXlsx: (route) => {
        requests.push("xlsx");
        return xlsx(route);
      },
      onRoster: (route) => {
        requests.push("roster");
        return json(route, 200, rosterContainer());
      },
      onDelete: (route) => {
        requests.push("delete");
        return route.fulfill({ status: 204, body: "" });
      },
    });

    await gotoDurableFixture(page);
    await expect(page.getByTestId("screen")).toBeVisible();
    await disableAnonymize(page);

    // The three elements from the screenshot, each asserted absent by NAME rather
    // than by "the page looks fine".
    await expect(page.getByText("An optimisation from this browser is still running")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("optimize-resumed")).toHaveCount(0);
    await expect(page.getByTestId("optimize-capture-notice")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Retry saving the roster/i })).toHaveCount(0);

    // The exact action is live, and the record did not disable it.
    await expect(page.getByTestId("optimize-submit")).toBeEnabled();

    // Give the old boot chain every chance to fire before claiming it did not.
    await page.waitForTimeout(1_500);
    expect(requests, "entering the route touches the old run's job not at all").toEqual([]);
    expect(downloads, "no file arrives because of a previous run").toBe(0);

    // And a deliberate click still starts exactly one fresh run.
    const submissions: string[] = [];
    await page.route("**/api/optimize", async (route) => {
      if (route.request().method() === "POST") submissions.push("post");
      await route.fallback();
    });
    await page.getByTestId("optimize-submit").click();
    await expect(page.getByTestId("optimize-controls")).toBeVisible({ timeout: 10_000 });
    expect(submissions).toEqual(["post"]);
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

  test("a failed cleanup is invisible: capture still ran before any DELETE", async ({ page }) => {
    // WAS "cleanup failure surfaces retry only; retry releases the slot". The retry
    // surface is gone — cleanup is owner-keyed and cannot stand in a new run's way,
    // so there is nothing here for a user to decide. What still matters, and is
    // still asserted, is the ORDERING the token gate enforces: `/roster` is fetched
    // and settled before any DELETE is authorized.
    let deleteAttempts = 0;
    let rosterAttempts = 0;
    let rosterSeenBeforeFirstDelete: number | null = null;
    await installOptimizeRoutes(page, {
      onRoster: (route) => {
        rosterAttempts += 1;
        return json(route, 200, rosterContainer());
      },
      onDelete: (route) => {
        deleteAttempts += 1;
        // Sampled INSIDE the first DELETE, so the ordering claim is made by the
        // pipeline itself rather than by whichever read happens to run first.
        rosterSeenBeforeFirstDelete ??= rosterAttempts;
        return json(route, 500, { detail: "cleanup failed" });
      },
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    // The download still succeeded; only the server-side release failed.
    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
    );
    await expect.poll(() => deleteAttempts, { timeout: 15_000 }).toBe(1);
    expect(rosterAttempts).toBe(1);
    // Capture ran for real BEFORE any DELETE could be authorized.
    expect(rosterSeenBeforeFirstDelete).toBe(1);

    // And the failure is invisible and non-blocking.
    await expect(page.getByTestId("optimize-cleanup-failed")).toHaveCount(0);
    await expect(page.getByTestId("optimize-cleanup-retry")).toHaveCount(0);
    await expect(page.getByTestId("optimize-cleanup-abandon")).toHaveCount(0);
    await expect(page.getByTestId("optimize-submit")).toBeEnabled();
    await expect(page.getByTestId("optimize-disabled-reason")).toHaveCount(0);
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
    // Reported, not actionable: there is no release to perform.
    await expect(page.getByTestId("optimize-dismiss")).toHaveCount(0);
    await expect(page.getByTestId("optimize-submit")).toBeEnabled({ timeout: 10_000 });
  });

  test("a failed cleanup is honest and retryable — no abandon escape, and it blocks nothing", async ({
    page,
  }) => {
    // The retired workflow, asserted absent. A cleanup that cannot be released used
    // to offer Abandon behind a destructive confirmation that explained backend
    // retention; the settled product has no such action or vocabulary. Retry is the
    // way forward and the notice stays honest.
    //
    // G6.2 INVERTED THE LAST ASSERTION. This used to require that a new run could
    // not start behind an unreleased one — which is the third of the three gates the
    // ticket removed. An old run's unproven cleanup is now owner-keyed: it can
    // finish on its own time without standing between the user and the button.
    await installOptimizeRoutes(page, {
      onDelete: (route) => json(route, 500, { detail: "cleanup failed" }),
    });
    await seedAndOpen(page);

    await page.getByTestId("optimize-submit").click();

    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
    );
    // NO CLEANUP SURFACE AT ALL. The notice, its Retry and the retired Abandon are
    // all gone: cleanup is owner-keyed and invisible, so it is never a user decision.
    await expect(page.getByTestId("optimize-cleanup-failed")).toHaveCount(0);
    await expect(page.getByTestId("optimize-cleanup-retry")).toHaveCount(0);
    await expect(page.getByTestId("optimize-cleanup-abandon")).toHaveCount(0);
    await expect(page.getByTestId("optimize-cleanup-abandoned")).toHaveCount(0);
    await expect(page.getByTestId("confirm-dialog-confirm")).toHaveCount(0);

    // Unreleased, and NOT in the way. The exact primary action stays live, and the
    // screen offers no explanation of a previous run to justify blocking it.
    await expect(page.getByTestId("optimize-submit")).toBeEnabled();
    await expect(page.getByTestId("optimize-disabled-reason")).toHaveCount(0);
    await expect(page.getByText(/still running/i)).toHaveCount(0);
  });

  test("a cancelled run leaves the exact Optimize action live, with nothing to dismiss", async ({
    page,
  }) => {
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

    await expect(page.getByTestId("optimize-dismiss")).toHaveCount(0);
    await expect(page.getByTestId("optimize-submit")).toBeEnabled({ timeout: 10_000 });
  });

  // Was "anonymized reload". The reload is gone — it existed only to prove resume,
  // and a reload is now a fresh entry — but everything the test was actually FOR
  // survives intact and in one visit: a real anonymized run, a real browser
  // download, and the restored identity verified out of the downloaded bytes.
  test("anonymized run: real browser download with the restored ID verified", async ({ page }) => {
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

    // Window flags for the one-person anonymized prep. The fixture's
    // cannedPrepare reads these; the controller keeps the reverseMap on the live
    // activation so the terminal hook can restore P1 → "alice".
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
      onEvents: (route) =>
        sse(route, [
          runningFrame("c1"),
          resultAvailableFrame("c2", "optimal"),
          terminalFrame("c3", "completed"),
        ]),
      onPoll: (route) => json(route, 200, completedJob(JOB_ID, { outcome: "optimal" })),
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

    // The listener goes up BEFORE the click, so it catches the auto-chain download
    // the moment the stream reaches terminal.
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await page.getByTestId("optimize-submit").click();

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
