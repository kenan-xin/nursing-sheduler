// Assembled Browser → Next → FastAPI streaming release gate.
// Runs only against the live Compose stack with no /api interception.

import { expect, test, type Page } from "@playwright/test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  ABORT_BOUNDS,
  ABORT_TEST_TIMEOUT,
  CLEANUP_BOUNDS,
  cleanupKnownJobs,
  finishSubmitObservation,
  FIRST_BYTE_TIMEOUT,
  JUDGE_POLL_TIMEOUT,
  judgeReplayEvidence,
  KEEPALIVE_WINDOW,
  observeOptimizeSubmit,
  OBSERVATION_EVALUATE_BOUND,
  REPLAY_BOUNDS,
  REPLAY_TEST_TIMEOUT,
  RESUMED_HEADER_TIMEOUT,
  RESUMED_SCREEN_TIMEOUT,
  runObservedSubmitAction,
  TINY_BOUNDS,
  TINY_TEST_TIMEOUT,
  type CleanupOutcome,
  type ResumedRequest,
  type SubmitObserver,
  type SubmitObservation,
} from "./support/optimize-durable";

const REPO_ROOT = resolve(__dirname, "../..");
const TINY_YAML = readFileSync(
  resolve(REPO_ROOT, "core/tests/testcases/basics/01_1nurse_1shift_1day.yaml"),
  "utf-8",
);
const LARGE_YAML = readFileSync(
  resolve(REPO_ROOT, "core/tests/testcases/real/large-ward-with-87-people-2025-11.yaml"),
  "utf-8",
);

const REPLAY_SNAPSHOT_KEY = "nurse.optimize.e2e-replay-snapshot";
const OPTIMIZE_SESSION_KEY = "nurse.optimize.session";

/** Transparent observation only: the product still consumes the real response body. */
const SSE_OBSERVATION_SCRIPT = `
(function() {
  var obs = {
    sseResponseAt: null,
    sseFirstByteAt: null,
    sseChunks: [],
    eventRequests: [],
  };
  window.__nsSseObs = obs;
  var originalFetch = window.fetch;
  var replayFrozen = false;
  var activeStreams = [];

  window.__nsFreezeSseForReplay = function() {
    replayFrozen = true;
    return Promise.allSettled(activeStreams.map(function(stream) {
      if (stream.closed) return Promise.resolve();
      stream.closed = true;
      try { stream.controller.close(); } catch (e) {}
      return stream.reader.cancel('e2e replay snapshot').catch(function() {});
    }));
  };

  function extractLastEventId(input, init) {
    try {
      if (init && init.headers) {
        var initHeaders = new Headers(init.headers);
        var fromInit = initHeaders.get('Last-Event-ID');
        if (fromInit) return fromInit;
      }
      if (input && input.headers && typeof input.headers.get === 'function') {
        return input.headers.get('Last-Event-ID') || null;
      }
    } catch (e) {}
    return null;
  }

  window.fetch = function(input, init) {
    var authoredUrl = typeof input === 'string' ? input : (input && input.url) || '';
    var isEvents = authoredUrl.indexOf('/events') !== -1;
    if (isEvents) {
      obs.eventRequests.push({
        url: new URL(String(authoredUrl), window.location.href).href,
        lastEventId: extractLastEventId(input, init),
      });
      if (replayFrozen) return new Promise(function() {});
    }
    return originalFetch.apply(this, arguments).then(function(response) {
      if (!isEvents || !response.body || !(response.headers.get('content-type') || '').includes('text/event-stream')) {
        return response;
      }
      obs.sseResponseAt = Date.now();
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var streamState = { reader: reader, controller: null, closed: false };
      var wrapped = new ReadableStream({
        start: function(controller) {
          streamState.controller = controller;
          activeStreams.push(streamState);
        },
        pull: function(controller) {
          return reader.read().then(function(result) {
            if (streamState.closed) return;
            if (result.done) { streamState.closed = true; controller.close(); return; }
            if (obs.sseFirstByteAt === null) obs.sseFirstByteAt = Date.now();
            obs.sseChunks.push(decoder.decode(result.value, { stream: true }));
            controller.enqueue(result.value);
          }, function(error) {
            if (!streamState.closed) controller.error(error);
          });
        },
        cancel: function(reason) {
          streamState.closed = true;
          return reader.cancel(reason);
        },
      });
      return new Response(wrapped, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
  };
})();
`;

interface SseObservations {
  sseResponseAt: number | null;
  sseFirstByteAt: number | null;
  sseChunks: string[];
  eventRequests: ResumedRequest[];
}

async function withBound<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readSseObs(page: Page): Promise<SseObservations> {
  return withBound(
    "sse observation evaluate",
    OBSERVATION_EVALUATE_BOUND,
    page.evaluate(() => {
      const obs = (window as unknown as { __nsSseObs?: SseObservations }).__nsSseObs;
      return {
        sseResponseAt: obs?.sseResponseAt ?? null,
        sseFirstByteAt: obs?.sseFirstByteAt ?? null,
        sseChunks: obs?.sseChunks ?? [],
        eventRequests: obs?.eventRequests ?? [],
      };
    }),
  );
}

async function injectYaml(page: Page, yaml: string): Promise<void> {
  await withBound(
    "inject observation script",
    REPLAY_BOUNDS.injectObservationScript,
    page.addInitScript(SSE_OBSERVATION_SCRIPT),
  );
  await withBound(
    "inject fixture yaml",
    REPLAY_BOUNDS.injectFixtureYaml,
    page.addInitScript((value) => {
      (window as unknown as { __NS_DURABLE_FIXTURE_YAML?: string }).__NS_DURABLE_FIXTURE_YAML =
        value;
    }, yaml),
  );
}

async function gotoFixture(page: Page): Promise<void> {
  await page.goto("/optimize-durable-fixture", { timeout: REPLAY_BOUNDS.gotoFixtureNavigation });
  await expect(page.getByTestId("optimize-durable-fixture")).toBeVisible({
    timeout: REPLAY_BOUNDS.fixtureRootVisible,
  });
  await expect(page.getByTestId("screen")).toBeVisible({ timeout: REPLAY_BOUNDS.screenVisible });
  const toggle = page.getByRole("switch", { name: /Anonymize/i });
  const checked = await toggle.getAttribute("aria-checked", {
    timeout: REPLAY_BOUNDS.anonymizeAttributeRead,
  });
  if (checked === "true") {
    await toggle.click({ timeout: REPLAY_BOUNDS.anonymizeToggleClick });
  }
  await expect(toggle).toHaveAttribute("aria-checked", "false", {
    timeout: REPLAY_BOUNDS.anonymizeCheckedAssertion,
  });
  await expect(page.getByTestId("optimize-submit")).toBeEnabled({
    timeout: REPLAY_BOUNDS.submitEnabledAssertion,
  });
}

interface ReplaySnapshot {
  cursorBefore: string | null;
  preReloadIds: string[];
  preReloadRequests: ResumedRequest[];
  sessionJobIdDiagnostic: string | null;
  pageOrigin: string | null;
}

/** Capture all pre-reload facts and initiate reload in the same browser task. */
async function captureReplaySnapshotAndReload(page: Page): Promise<ReplaySnapshot> {
  await Promise.all([
    page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: REPLAY_BOUNDS.reloadNavigation,
    }),
    withBound(
      "freeze + pre-reload snapshot evaluate",
      REPLAY_BOUNDS.freezeAndSnapshotEvaluate,
      page.evaluate(
        async ([snapshotKey, sessionKey]) => {
          const e2eWindow = window as unknown as {
            __nsFreezeSseForReplay?: () => Promise<unknown>;
            __nsSseObs?: SseObservations;
          };
          await e2eWindow.__nsFreezeSseForReplay?.();

          const readSession = (): { jobId: string | null; cursor: string | null } => {
            const raw = sessionStorage.getItem(sessionKey);
            if (!raw) return { jobId: null, cursor: null };
            try {
              const parsed = JSON.parse(raw) as {
                phase?: string;
                jobId?: string;
                lastCursor?: string;
              };
              return {
                jobId: parsed.phase === "active" ? (parsed.jobId ?? null) : null,
                cursor: parsed.lastCursor ?? null,
              };
            } catch {
              return { jobId: null, cursor: null };
            }
          };

          let cursorBefore: string | null = null;
          let sessionJobIdDiagnostic: string | null = null;
          let stableReads = 0;
          for (let attempt = 0; attempt < 20 && stableReads < 3; attempt += 1) {
            const next = readSession();
            stableReads =
              next.cursor !== null && next.cursor === cursorBefore ? stableReads + 1 : 0;
            cursorBefore = next.cursor;
            sessionJobIdDiagnostic = next.jobId;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }

          const chunks = e2eWindow.__nsSseObs?.sseChunks ?? [];
          const preReloadIds = Array.from(
            chunks.join("").matchAll(/^id:\s*(.+?)\r?$/gm),
            (match) => match[1],
          );
          const preReloadRequests = (e2eWindow.__nsSseObs?.eventRequests ?? []).slice();
          sessionStorage.setItem(
            snapshotKey,
            JSON.stringify({
              cursorBefore,
              preReloadIds,
              preReloadRequests,
              sessionJobIdDiagnostic,
              pageOrigin: window.location.origin,
            }),
          );
          window.location.reload();
        },
        [REPLAY_SNAPSHOT_KEY, OPTIMIZE_SESSION_KEY] as const,
      ),
    ),
  ]);

  return withBound(
    "post-reload snapshot read evaluate",
    REPLAY_BOUNDS.snapshotReadEvaluate,
    page.evaluate((snapshotKey) => {
      const raw = sessionStorage.getItem(snapshotKey);
      sessionStorage.removeItem(snapshotKey);
      return raw
        ? (JSON.parse(raw) as ReplaySnapshot)
        : {
            cursorBefore: null,
            preReloadIds: [],
            preReloadRequests: [],
            sessionJobIdDiagnostic: null,
            pageOrigin: null,
          };
    }, REPLAY_SNAPSHOT_KEY),
  );
}

interface ReplayObservation {
  replayIds: string[];
  cursorAfter: string | null;
  pageOrigin: string | null;
  firstResumedRequest: ResumedRequest | null;
  postReloadRequests: ResumedRequest[];
}

/** Replay ids, persisted cursor and every resumed request are one atomic observation. */
async function readReplayObservation(page: Page): Promise<ReplayObservation> {
  return withBound(
    "replay observation evaluate",
    OBSERVATION_EVALUATE_BOUND,
    page.evaluate(() => {
      const obs = (window as unknown as { __nsSseObs?: SseObservations }).__nsSseObs;
      const replayIds = Array.from(
        (obs?.sseChunks ?? []).join("").matchAll(/^id:\s*(.+?)\r?$/gm),
        (match) => match[1],
      );
      let cursorAfter: string | null = null;
      const raw = sessionStorage.getItem("nurse.optimize.session");
      if (raw) {
        try {
          cursorAfter = (JSON.parse(raw) as { lastCursor?: string }).lastCursor ?? null;
        } catch {
          cursorAfter = null;
        }
      }
      const postReloadRequests = (obs?.eventRequests ?? []).slice();
      return {
        replayIds,
        cursorAfter,
        pageOrigin: window.location.origin,
        firstResumedRequest: postReloadRequests[0] ?? null,
        postReloadRequests,
      };
    }),
  );
}

function emptyCleanup(ids: string[], failure: string): CleanupOutcome {
  return { ok: false, ids, removedIds: [], steps: [], failures: [failure] };
}

/**
 * The abort lane's only handoff to the shell: the accepted-slot ids in slot order,
 * duplicates intact, written atomically via a same-directory temp file and rename.
 *
 * The payload carries NO pass/fail, reason or verdict field. The shell decides
 * authority from cardinality and readability alone, and audits new BFF log entries
 * before it cleans anything up — so cleanup can never manufacture its own evidence.
 */
function writeAcceptedSlotHandoff(target: string, slotIds: readonly string[]): void {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(slotIds), "utf-8");
  renameSync(temporary, target);
}

test.describe("T16f assembled Browser → Next → FastAPI stream gate", () => {
  test.describe.configure({ mode: "serial" });

  // Every lane attaches the same accepted-submit observer before its click. They
  // differ only in what happens after the page-close fence: tiny/replay own their
  // job lifecycle in-browser, while abort hands its accepted ids to the shell and
  // performs no cancel, status, delete or final GET of its own.
  type CleanupLane = "lifecycle" | "handoff";
  let submitObserver: SubmitObserver | null = null;
  let cleanupLane: CleanupLane = "lifecycle";

  test.afterEach(async ({ page, request }, testInfo) => {
    const observer = submitObserver;
    const lane = cleanupLane;
    submitObserver = null;
    cleanupLane = "lifecycle";
    if (observer === null) return;

    testInfo.setTimeout(
      testInfo.timeout +
        (lane === "handoff"
          ? CLEANUP_BOUNDS.closeAndSettle + CLEANUP_BOUNDS.report
          : CLEANUP_BOUNDS.hook),
    );
    const observation: SubmitObservation = await finishSubmitObservation(observer, async () => {
      if (!page.isClosed()) await page.close({ runBeforeUnload: false });
    });

    const laneSteps: string[] = [];
    const laneFailures: string[] = [];
    if (lane === "handoff") {
      // Slot order with duplicates preserved: the shell judges cardinality first,
      // then deduplicates physical ids for its own post-audit cleanup.
      const slotIds = observation.acceptedSlots.flatMap((slot) =>
        slot.kind === "id" ? [slot.jobId] : [],
      );
      // A handoff is emitted ONLY with retained authority, plus the single lost case the
      // shell is meant to diagnose itself: every slot readable but more than two of them,
      // which it detects as excess cardinality. Any other loss — a malformed, unreadable
      // or unresolved accepted body, or an unresolved matching request — withholds the
      // file entirely, so the shell sees missing evidence and tears down immediately
      // instead of mistaking a filtered mixed observation for a valid smaller handoff.
      const everySlotReadable = slotIds.length === observation.acceptedSlots.length;
      const excessCardinalityOnly = everySlotReadable && observation.acceptedSlots.length > 2;
      const target = process.env.ASSEMBLED_ABORT_HANDOFF;
      if (target === undefined || target.length === 0) {
        laneFailures.push(
          "ASSEMBLED_ABORT_HANDOFF was unset, so no accepted-slot id could be handed off",
        );
      } else if (observation.lostAuthority && !excessCardinalityOnly) {
        laneFailures.push(
          `accepted-slot handoff withheld: submit authority was lost over ${observation.acceptedSlots.length} accepted slot(s), ${slotIds.length} of them readable`,
        );
      } else {
        try {
          writeAcceptedSlotHandoff(target, slotIds);
          laneSteps.push(`handed off ${slotIds.length} accepted slot id(s) to ${target}`);
        } catch (error) {
          laneFailures.push(
            `accepted-slot handoff write failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } else {
      const cleanup = observation.lostAuthority
        ? emptyCleanup(
            observation.knownIds,
            "lost submit authority; normal known-id cleanup bypassed for immediate containment",
          )
        : await cleanupKnownJobs(observation.knownIds, {
            post: async (url, timeout) => {
              const response = await request.post(url, { timeout });
              return { status: response.status(), body: await response.text() };
            },
            delete: async (url, timeout) => {
              const response = await request.delete(url, { timeout });
              return { status: response.status(), body: await response.text() };
            },
            get: async (url, timeout) => {
              const response = await request.get(url, { timeout });
              return { status: response.status(), body: await response.text() };
            },
            sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
            now: () => Date.now(),
          });
      for (const step of cleanup.steps.filter((value) => value.includes("cleanup success"))) {
        console.log(step);
      }
      laneSteps.push(...cleanup.steps);
      laneFailures.push(...cleanup.failures);
    }

    let report = [
      `matching submit requests: ${observation.matchingRequests}`,
      `accepted slots: ${observation.acceptedSlots.length}`,
      `known jobs: ${observation.knownIds.join(", ") || "(none)"}`,
      ...observation.failures,
      ...laneSteps,
      ...laneFailures,
    ].join("\n");
    const failures = [...observation.failures, ...laneFailures];
    try {
      await withBound(
        "cleanup report attachment",
        CLEANUP_BOUNDS.report,
        testInfo.attach(lane === "handoff" ? "abort-accepted-slot-handoff" : "live-job-cleanup", {
          body: report,
          contentType: "text/plain",
        }),
      );
    } catch (error) {
      const failure = `cleanup report failed: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(failure);
      report += `\n${failure}`;
    }

    // Preserve an existing primary test failure. A clean body still goes red when
    // observation, cleanup, or report propagation fails.
    if (testInfo.status === testInfo.expectedStatus && failures.length > 0) {
      throw new Error(`submit observation or cleanup failed:\n${report}`);
    }
  });

  test("tiny feasible job: SSE first byte, completion, download, cleanup", async ({ page }) => {
    test.setTimeout(TINY_TEST_TIMEOUT);
    await injectYaml(page, TINY_YAML);
    await gotoFixture(page);

    submitObserver = observeOptimizeSubmit(page);
    const downloadPromise = page.waitForEvent("download", { timeout: TINY_BOUNDS.completionPoll });
    await runObservedSubmitAction(
      submitObserver,
      () => page.getByTestId("optimize-submit").click({ timeout: TINY_BOUNDS.submitClick }),
      async () => {
        if (!page.isClosed()) await page.close({ runBeforeUnload: false });
      },
    );
    await expect
      .poll(() => submitObserver?.knownIds().length ?? 0, { timeout: TINY_BOUNDS.acceptedIdPoll })
      .toBeGreaterThan(0);

    await expect
      .poll(async () => (await readSseObs(page)).sseResponseAt, {
        timeout: TINY_BOUNDS.sseResponsePoll,
      })
      .not.toBeNull();
    const first = await readSseObs(page);
    expect(first.sseResponseAt).not.toBeNull();
    expect(first.sseFirstByteAt).not.toBeNull();
    expect(first.sseFirstByteAt! - first.sseResponseAt!).toBeLessThan(10_000);

    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
      { timeout: TINY_BOUNDS.completionPoll },
    );
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/i);
    const downloadPath = await download.path();
    expect(downloadPath, "the browser produced a managed download file").not.toBeNull();
    const workbookBytes = readFileSync(downloadPath!);
    expect(workbookBytes.length).toBeGreaterThan(4);
    expect(workbookBytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    // The product's own successful terminal chain downloads, auto-deletes, and
    // releases its single submit slot before hook cleanup independently proves 404.
    await expect(page.getByTestId("optimize-submit")).toBeEnabled({
      timeout: TINY_BOUNDS.slotFreedAssertion,
    });
  });

  test("live job: SSE first byte, genuine keepalive, cursor persistence, strictly-after replay", async ({
    page,
  }) => {
    test.setTimeout(REPLAY_TEST_TIMEOUT);
    await injectYaml(page, LARGE_YAML);
    await gotoFixture(page);

    submitObserver = observeOptimizeSubmit(page);
    await runObservedSubmitAction(
      submitObserver,
      () => page.getByTestId("optimize-submit").click({ timeout: REPLAY_BOUNDS.submitClick }),
      async () => {
        if (!page.isClosed()) await page.close({ runBeforeUnload: false });
      },
    );
    await expect
      .poll(() => submitObserver?.knownIds().length ?? 0, {
        timeout: REPLAY_BOUNDS.acceptedJobIdPoll,
      })
      .toBeGreaterThan(0);
    const acceptedJobId = submitObserver.knownIds()[0];

    await expect
      .poll(async () => (await readSseObs(page)).sseResponseAt, { timeout: FIRST_BYTE_TIMEOUT })
      .not.toBeNull();
    await page.waitForTimeout(KEEPALIVE_WINDOW);
    expect((await readSseObs(page)).sseChunks.join("")).toContain(": keepalive");

    const before = await captureReplaySnapshotAndReload(page);
    expect(
      before.sessionJobIdDiagnostic,
      "session diagnostic corroborates the accepted POST id",
    ).toBe(acceptedJobId);
    expect(before.pageOrigin).not.toBeNull();
    expect(before.cursorBefore).not.toBeNull();
    expect(before.preReloadIds).toContain(before.cursorBefore);

    await expect(page.getByTestId("screen")).toBeVisible({ timeout: RESUMED_SCREEN_TIMEOUT });
    await expect
      .poll(
        async () => (await readReplayObservation(page)).firstResumedRequest?.lastEventId ?? null,
        {
          timeout: RESUMED_HEADER_TIMEOUT,
        },
      )
      .toBe(before.cursorBefore);

    const evidence = async () => {
      const after = await readReplayObservation(page);
      return {
        acceptedJobId,
        expectedOrigin: after.pageOrigin === before.pageOrigin ? after.pageOrigin : null,
        cursorBefore: before.cursorBefore,
        preReloadIds: before.preReloadIds,
        preReloadRequests: before.preReloadRequests,
        firstResumedRequest: after.firstResumedRequest,
        postReloadRequests: after.postReloadRequests,
        replayIds: after.replayIds,
        cursorAfter: after.cursorAfter,
      };
    };
    await expect
      .poll(async () => judgeReplayEvidence(await evidence()).ok, {
        timeout: JUDGE_POLL_TIMEOUT,
        intervals: [500],
      })
      .toBe(true);
    const judged = judgeReplayEvidence(await evidence());
    expect(judged.failures).toEqual([]);
  });

  test("abort propagation: browser disconnect cancels upstream SSE body", async ({ page }) => {
    test.setTimeout(ABORT_TEST_TIMEOUT);
    await injectYaml(page, LARGE_YAML);
    await gotoFixture(page);

    // The shell owns this job's lifecycle: the observer captures the accepted ids and
    // `afterEach` hands them over without cancelling, deleting or polling anything.
    cleanupLane = "handoff";
    submitObserver = observeOptimizeSubmit(page);
    await runObservedSubmitAction(
      submitObserver,
      () => page.getByTestId("optimize-submit").click({ timeout: ABORT_BOUNDS.submitClick }),
      async () => {
        if (!page.isClosed()) await page.close({ runBeforeUnload: false });
      },
    );
    await expect
      .poll(() => submitObserver?.knownIds().length ?? 0, {
        timeout: ABORT_BOUNDS.firstResponsePoll,
      })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await readSseObs(page)).sseResponseAt, {
        timeout: ABORT_BOUNDS.firstResponsePoll,
      })
      .not.toBeNull();

    // Direct evidence, no negative control: the real navigation must COMMIT a
    // main-frame response on the pre-navigation origin at exactly `/about` with no
    // query or fragment, the page must settle on that exact URL, and the old durable
    // fixture root must be gone. An unrelated exception, assertion failure or timeout
    // here is simply a failed Playwright command.
    const pageOrigin = new URL(page.url()).origin;
    const response = await page.goto("/about", { timeout: ABORT_BOUNDS.abortNavigation });
    expect(
      response,
      "page.goto must return a committed navigation response for /about",
    ).not.toBeNull();
    expect(
      response!.request().isNavigationRequest(),
      "the committed response answers a navigation request",
    ).toBe(true);
    expect(
      response!.frame() === page.mainFrame(),
      "the navigation committed in the main frame",
    ).toBe(true);
    const committed = new URL(response!.url());
    expect(committed.origin, "the committed response shares the pre-navigation origin").toBe(
      pageOrigin,
    );
    expect(committed.pathname, "the committed response path is exactly /about").toBe("/about");
    expect(committed.search, "the committed response carries no query").toBe("");
    expect(committed.hash, "the committed response carries no fragment").toBe("");

    await expect
      .poll(() => page.url(), { timeout: ABORT_BOUNDS.abortUrlSettle })
      .toBe(`${pageOrigin}/about`);
    await expect(page.getByTestId("optimize-durable-fixture")).toHaveCount(0);
    await page.waitForTimeout(ABORT_BOUNDS.bffObservationTail);
  });
});
