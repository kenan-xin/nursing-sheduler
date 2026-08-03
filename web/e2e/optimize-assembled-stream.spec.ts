// T16f — the ASSEMBLED Browser → Next → FastAPI streaming release gate.
//
// Unlike `optimize-durable-stream.spec.ts` (which stubs `/api/**` via
// `page.route` to drive deterministic client behavior), this spec runs ONLY
// against the live direct Compose stack brought up by `make verify-stream`.
// It drives the REAL Optimize screen against the REAL Next BFF + FastAPI
// backend with ZERO route interception — proving the assembled protocol path
// the ticket requires.
//
// Observations are captured by a transparent fetch-wrapper (`addInitScript`)
// that records — but does NOT modify — SSE response timing, raw body chunks
// (for keepalive detection), and Last-Event-ID reconnect headers. The
// controller's SSE parser processes the response exactly as before; the
// wrapper is observation-only.
//
// Run via: ASSEMBLED_BASE_URL=http://localhost:<port> pnpm exec playwright test
//          --config playwright.assembled.config.ts

import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FIRST_BYTE_TIMEOUT,
  JUDGE_POLL_TIMEOUT,
  judgeReplayEvidence,
  KEEPALIVE_WINDOW,
  REPLAY_TEST_TIMEOUT,
  RESUMED_HEADER_TIMEOUT,
  RESUMED_SCREEN_TIMEOUT,
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

const COMPLETION_TIMEOUT = 90_000;
const REPLAY_SNAPSHOT_KEY = "nurse.optimize.e2e-replay-snapshot";
const OPTIMIZE_SESSION_KEY = "nurse.optimize.session";

// Every phase bound and the derived total budget live in `support/optimize-durable`
// so the derivation itself is unit-testable; see the block above
// `REPLAY_PHASE_BOUNDS` there for why the default per-test budget was insufficient
// by construction, and how the abandoned solve contaminated the next test.

/**
 * A transparent fetch-wrapper injected BEFORE the page's own scripts. It
 * records SSE-response observations without modifying any response:
 *
 * - `sseResponseAt`: absolute timestamp (ms) when the SSE response HEADERS
 *   arrived — proves the browser received the actual SSE response, not just
 *   that the POST activated the job.
 * - `sseFirstByteAt`: absolute timestamp when the first body CHUNK arrived —
 *   the real "first byte" of the stream.
 * - `sseChunks`: concatenated raw body chunks — used to detect a genuine
 *   `: keepalive` comment (as distinct from repeated job frames).
 * - `eventLastEventIds`: every events-request Last-Event-ID in request order,
 *   including `null`, so the first post-reload request is asserted exactly.
 *
 * The wrapper returns a NEW Response with a wrapped ReadableStream that tees
 * chunks to both the recorder and the consumer. The controller reads from the
 * wrapped stream; the original response.body is consumed by the wrapper's own
 * reader (only one reader per stream, hence the tee).
 */
const SSE_OBSERVATION_SCRIPT = `
(function() {
  var obs = {
    sseResponseAt: null,
    sseFirstByteAt: null,
    sseChunks: [],
    eventLastEventIds: [],
    // Every events-request URL in request order. The path segment
    // /api/optimize/<jobId>/events is an exact authoritative job boundary that
    // owes nothing to any cursor, so it cross-checks the session's own job id.
    // (No backticks in this comment: it lives inside a template literal.)
    eventUrls: [],
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

  function extractLastEventId(init) {
    if (!init || !init.headers) return null;
    var h = init.headers;
    try {
      if (typeof h.get === 'function') return h.get('Last-Event-ID') || null;
      if (typeof h === 'object') return h['Last-Event-ID'] || h['last-event-id'] || null;
    } catch (e) {}
    return null;
  }

  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var isEvents = url.indexOf('/events') !== -1;
    if (isEvents) {
      var id = extractLastEventId(init) ||
        (input && input.headers && typeof input.headers.get === 'function' ? input.headers.get('Last-Event-ID') : null);
      obs.eventLastEventIds.push(id || null);
      obs.eventUrls.push(String(url));
      // The replay test invokes this e2e-only freeze immediately before its
      // atomic snapshot. Holding any controller reconnect in the old document
      // prevents a late frame from advancing durable storage during teardown.
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
            if (obs.sseFirstByteAt === null) {
              obs.sseFirstByteAt = Date.now();
            }
            obs.sseChunks.push(decoder.decode(result.value, { stream: true }));
            controller.enqueue(result.value);
          }, function(err) {
            if (!streamState.closed) controller.error(err);
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
  eventLastEventIds: Array<string | null>;
  eventUrls: string[];
}

async function readSseObs(page: Page): Promise<SseObservations> {
  return page.evaluate(() => {
    const obs = (window as unknown as { __nsSseObs?: SseObservations }).__nsSseObs;
    return {
      sseResponseAt: obs?.sseResponseAt ?? null,
      sseFirstByteAt: obs?.sseFirstByteAt ?? null,
      sseChunks: obs?.sseChunks ?? [],
      eventLastEventIds: obs?.eventLastEventIds ?? [],
      eventUrls: obs?.eventUrls ?? [],
    };
  });
}

interface ReplaySnapshot {
  cursor: string | null;
  rawIds: string[];
  /**
   * The job the ACTIVE pre-reload session was running, read out of the session
   * record's own `jobId` field — written by the activation transaction from the
   * POST 202 response, entirely separately from any cursor. This is the
   * independent replay authority.
   */
  sessionJobId: string | null;
  /**
   * The job segments of every events-request path observed before the reload, as
   * a second, cursor-independent authority. The judge is fed a job id only when
   * this agrees with `sessionJobId`.
   */
  requestJobIds: string[];
}

/** Freeze the observation wrapper's current SSE body, allow already-delivered
 * frames to finish committing, then atomically capture cursor + raw IDs and
 * initiate reload. The e2e-only snapshot key is ignored by the application and
 * removed immediately after the new document reads it. */
async function captureReplaySnapshotAndReload(page: Page): Promise<ReplaySnapshot> {
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.evaluate(
      async ([snapshotKey, sessionKey]) => {
        const e2eWindow = window as unknown as {
          __nsFreezeSseForReplay?: () => Promise<unknown>;
          __nsSseObs?: SseObservations;
        };
        await e2eWindow.__nsFreezeSseForReplay?.();

        // The session record carries BOTH the active job id and the last committed
        // cursor. Reading them in the same task as the raw frames is what makes the
        // job authority causally simultaneous with the evidence it authorises — not
        // re-derived later from something the evidence itself supplied.
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
              // Only an ACTIVE record names a job; a provisional one has none.
              jobId: parsed.phase === "active" ? (parsed.jobId ?? null) : null,
              cursor: parsed.lastCursor ?? null,
            };
          } catch {
            return { jobId: null, cursor: null };
          }
        };

        let cursor: string | null = null;
        let sessionJobId: string | null = null;
        let stableReads = 0;
        for (let attempt = 0; attempt < 20 && stableReads < 3; attempt += 1) {
          const next = readSession();
          stableReads = next.cursor !== null && next.cursor === cursor ? stableReads + 1 : 0;
          cursor = next.cursor;
          sessionJobId = next.jobId;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const chunks = e2eWindow.__nsSseObs?.sseChunks ?? [];
        const rawIds = Array.from(
          chunks.join("").matchAll(/^id:\s*(.+?)\r?$/gm),
          (match) => match[1],
        );
        // Second authority: the job segment of every events path actually requested.
        const requestJobIds = Array.from(
          new Set(
            (e2eWindow.__nsSseObs?.eventUrls ?? [])
              .map((url) => /\/optimize\/([^/?#]+)\/events/.exec(url)?.[1])
              .filter((id): id is string => typeof id === "string" && id.length > 0)
              .map((id) => decodeURIComponent(id)),
          ),
        );
        sessionStorage.setItem(
          snapshotKey,
          JSON.stringify({ cursor, rawIds, sessionJobId, requestJobIds }),
        );
        window.location.reload();
      },
      [REPLAY_SNAPSHOT_KEY, OPTIMIZE_SESSION_KEY] as const,
    ),
  ]);

  return page.evaluate((snapshotKey) => {
    const raw = sessionStorage.getItem(snapshotKey);
    sessionStorage.removeItem(snapshotKey);
    return raw
      ? (JSON.parse(raw) as ReplaySnapshot)
      : { cursor: null, rawIds: [], sessionJobId: null, requestJobIds: [] };
  }, REPLAY_SNAPSHOT_KEY);
}

async function injectYaml(page: Page, yaml: string): Promise<void> {
  await page.addInitScript(SSE_OBSERVATION_SCRIPT);
  await page.addInitScript((y) => {
    (window as unknown as { __NS_DURABLE_FIXTURE_YAML?: string }).__NS_DURABLE_FIXTURE_YAML = y;
  }, yaml);
}

async function gotoFixture(page: Page): Promise<void> {
  await page.goto("/optimize-durable-fixture");
  await expect(page.getByTestId("optimize-durable-fixture")).toBeVisible();
  await expect(page.getByTestId("screen")).toBeVisible();
  // Anonymize defaults ON; turn it OFF for the tiny job (no restoration needed).
  const toggle = page.getByRole("switch", { name: /Anonymize/i });
  if ((await toggle.getAttribute("aria-checked")) === "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("optimize-submit")).toBeEnabled();
}

interface ReplayObservation {
  rawIds: string[];
  cursor: string | null;
  firstLastEventId: string | null;
}

/**
 * ONE causally ordered snapshot of the raw post-reload frames AND the durable
 * cursor.
 *
 * Reading those two facts as two separate `page.evaluate` calls is a real race on
 * a live 87-person solve: a frame can arrive and commit its cursor in the gap, so
 * `cursor` names an id that is genuinely absent from the earlier `rawIds` capture
 * and `toContain` fails on a stream that is behaving perfectly. That is what made
 * this gate intermittently red (observed 30/1 against neighbouring 31/0 runs on a
 * byte-identical tree).
 *
 * This body is a single synchronous task with no `await`, so no stream callback,
 * parser step or storage write can interleave. The ordering that makes the
 * invariant sound is in the observation wrapper itself: `pull` pushes the chunk
 * into `sseChunks` BEFORE enqueuing it to the controller's parser, so a cursor can
 * only be persisted after its frame was recorded. Within one task, therefore,
 * `cursor` is always already present in `rawIds` — the assertion tests replay
 * ordering, which is the point, and no longer tests two clocks against each other.
 */
async function readReplayObservation(page: Page): Promise<ReplayObservation> {
  return page.evaluate(() => {
    const obs = (window as unknown as { __nsSseObs?: SseObservations }).__nsSseObs;
    const rawIds = Array.from(
      (obs?.sseChunks ?? []).join("").matchAll(/^id:\s*(.+?)\r?$/gm),
      (match) => match[1],
    );
    let cursor: string | null = null;
    const raw = sessionStorage.getItem("nurse.optimize.session");
    if (raw) {
      try {
        cursor = (JSON.parse(raw) as { lastCursor?: string }).lastCursor ?? null;
      } catch {
        cursor = null;
      }
    }
    return { rawIds, cursor, firstLastEventId: obs?.eventLastEventIds?.[0] ?? null };
  });
}

test.describe("T16f assembled Browser → Next → FastAPI stream gate", () => {
  // Release the LIVE job the replay test submits, so a failure in that test cannot
  // leave an 87-person solve burning the host for the form's 300s default and
  // starve the NEXT test's fixture mount. That is the exact correlated failure the
  // review recorded: one 30s timeout produced 29/2 because the abort case could
  // not mount within 5s afterwards.
  //
  // Scoped deliberately: only the replay test sets `liveJobToRelease`. The abort
  // test is SUPPOSED to walk away from a live stream (that is the mechanism it
  // proves), it is the last test in the file, and the gate tears the stack down
  // after it — so it is left alone rather than risk perturbing the BFF log audit
  // that is baselined around it. This runs in `afterEach` rather than a `finally`
  // because Playwright abandons a timed-out test body but still runs hooks, which
  // is precisely the case this exists for.
  let liveJobToRelease: string | null = null;
  test.afterEach(async ({ request }) => {
    const jobId = liveJobToRelease;
    liveJobToRelease = null;
    if (jobId === null) return;
    // Best-effort and non-asserting: this is contamination cleanup, not a proof.
    // A job that already reached terminal simply 404s/409s here.
    try {
      await request.post(`/api/optimize/${encodeURIComponent(jobId)}/cancel`, { timeout: 10_000 });
      await request.delete(`/api/optimize/${encodeURIComponent(jobId)}`, { timeout: 10_000 });
    } catch {
      // Swallowed on purpose: the gate's own teardown is the backstop.
    }
  });

  test("tiny feasible job: SSE first byte, completion, download, cleanup", async ({ page }) => {
    await injectYaml(page, TINY_YAML);
    await gotoFixture(page);

    await page.getByTestId("optimize-submit").click();

    // Assert the browser observed the actual SSE response (not just that the
    // POST activated the job and controls rendered). This is the real
    // "first response" — the SSE endpoint answered with text/event-stream.
    await expect
      .poll(async () => (await readSseObs(page)).sseResponseAt, { timeout: FIRST_BYTE_TIMEOUT })
      .not.toBeNull();
    const obs1 = await readSseObs(page);
    expect(obs1.sseResponseAt).not.toBeNull();
    // And a first body byte arrived (the stream delivered content).
    expect(obs1.sseFirstByteAt).not.toBeNull();
    expect(obs1.sseFirstByteAt! - obs1.sseResponseAt!).toBeLessThan(10_000);

    // Terminal completion: the auto-chain fetches the artifact, restores it,
    // downloads, and DELETEs.
    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
      { timeout: COMPLETION_TIMEOUT },
    );

    // Cleanup DELETE freed the single-slot: a new run is allowed.
    await expect(page.getByTestId("optimize-submit")).toBeEnabled({ timeout: 30_000 });
  });

  test("live job: SSE first byte, genuine keepalive, cursor persistence, strictly-after replay, abort", async ({
    page,
  }) => {
    // The ONE test with an explicit total budget, derived above from its own phase
    // bounds. Not a blanket suite timeout, no retries, no sleeps, and no phase
    // bound was relaxed to fit it.
    test.setTimeout(REPLAY_TEST_TIMEOUT);

    await injectYaml(page, LARGE_YAML);
    await gotoFixture(page);

    await page.getByTestId("optimize-submit").click();

    // Bounded first response: the browser observed the SSE response.
    await expect
      .poll(async () => (await readSseObs(page)).sseResponseAt, { timeout: FIRST_BYTE_TIMEOUT })
      .not.toBeNull();

    // Genuine keepalive: wait for the backend's keepalive interval to elapse,
    // then assert the raw chunks contain a real `: keepalive` comment — NOT
    // just repeated job frames. The gate configures JOB_SSE_KEEPALIVE_SECONDS
    // so at least one arrives within this window.
    await page.waitForTimeout(KEEPALIVE_WINDOW);
    const obsAfterDelay = await readSseObs(page);
    const rawChunks = obsAfterDelay.sseChunks.join("");
    expect(rawChunks).toContain(": keepalive");

    // Atomically preserve the independent job authority, the exact durable cursor,
    // and every raw frame ID seen before reload, then start reload in that same
    // browser task.
    const {
      cursor: cursorBefore,
      rawIds: preReloadIds,
      sessionJobId,
      requestJobIds,
    } = await captureReplaySnapshotAndReload(page);

    // --- Resolve the replay authority, independently of any cursor -------------
    //
    // Two cursor-free sources must agree before either is trusted: the ACTIVE
    // session record's own `jobId` (written by the activation transaction from the
    // POST 202 response) and the job segment of the events paths the browser
    // actually requested. Agreement is asserted here rather than inside the judge,
    // so the judge receives a single already-corroborated value and can never fall
    // back to decoding a cursor.
    expect(sessionJobId, "the active session must name its job").not.toBeNull();
    expect(sessionJobId!.length).toBeGreaterThan(0);
    expect(requestJobIds, "exactly one job's events path was requested").toEqual([sessionJobId]);
    const expectedJobId = sessionJobId!;
    // Release this job if anything below fails (see the `afterEach` rationale).
    liveJobToRelease = expectedJobId;

    expect(cursorBefore).not.toBeNull();
    expect(cursorBefore!.length).toBeGreaterThan(0);
    expect(preReloadIds.length).toBeGreaterThan(0);
    expect(preReloadIds).toContain(cursorBefore);
    await expect(page.getByTestId("screen")).toBeVisible({ timeout: RESUMED_SCREEN_TIMEOUT });

    // The FIRST post-reload events request must present the exact cursor captured
    // above. A wrong, older, different, or null cursor fails.
    await expect
      .poll(async () => (await readSseObs(page)).eventLastEventIds[0], {
        timeout: RESUMED_HEADER_TIMEOUT,
      })
      .toBe(cursorBefore);

    // Judge the replay through `judgeReplayEvidence`, whose full truth table —
    // valid / self-consistent-foreign / duplicate / foreign / mixed / stale /
    // missing / malformed — is proved deterministically in
    // `support/optimize-durable.test.ts`, including committed adversarial baselines
    // for every predicate this oracle has previously shipped.
    //
    // AUTHORITY CHAIN. `expectedJobId` comes from the two cursor-free sources
    // corroborated above, never from a cursor. The judge binds `cursorBefore` to
    // it; the assertion immediately above pins the first resumed request's
    // `Last-Event-ID` to that same `cursorBefore`, so the resumed request is
    // transitively bound too; and every raw id plus `cursorAfter` is bound to it as
    // well. A fully self-consistent foreign envelope — foreign cursorBefore,
    // foreign frames, foreign cursorAfter, all agreeing with each other — is now
    // red, because none of them defines the authority any more.
    //
    // Retained exactly: the ONE atomic snapshot (so frames and the durable cursor
    // cannot advance relative to each other between captures), non-empty evidence,
    // no pre-reload id re-sent, raw-id uniqueness, and the cursor both new and
    // present among the frames.
    const evidenceOf = async () => ({
      ...(await readReplayObservation(page)),
      preReloadIds,
    });
    const toJudged = (snap: Awaited<ReturnType<typeof evidenceOf>>) =>
      judgeReplayEvidence({
        expectedJobId,
        rawIds: snap.rawIds,
        cursorAfter: snap.cursor,
        cursorBefore,
        preReloadIds: snap.preReloadIds,
      });

    await expect
      .poll(async () => toJudged(await evidenceOf()).ok, {
        timeout: JUDGE_POLL_TIMEOUT,
        intervals: [500],
      })
      .toBe(true);

    const snapshot = await evidenceOf();
    const judged = toJudged(snapshot);
    // The failure list is the diagnostic: a red gate names the exact rule and the
    // offending ids rather than only reporting `false`.
    expect(judged.failures, `replay evidence violated the strictly-after contract`).toEqual([]);
    expect(judged.ok).toBe(true);
    expect(snapshot.firstLastEventId).toBe(cursorBefore);
    // NOTE: this test does NOT navigate away — the abort is isolated in a
    // separate test so the gate's BFF-log baseline can attribute the cancel
    // to the intended navigation only.
  });

  test("abort propagation: browser disconnect cancels upstream SSE body", async ({ page }) => {
    // ISOLATED from the replay test. The gate script baselines the BFF log
    // count IMMEDIATELY before this test and checks for a NEW entry after.
    // No reload, prior test, or curl disconnect can satisfy the audit.
    await injectYaml(page, LARGE_YAML);
    await gotoFixture(page);

    await page.getByTestId("optimize-submit").click();

    // Confirm the SSE stream is live before aborting.
    await expect
      .poll(async () => (await readSseObs(page)).sseResponseAt, { timeout: FIRST_BYTE_TIMEOUT })
      .not.toBeNull();

    // The ONLY intentional navigate-away in the assembled suite. The gate first
    // reruns this test with navigation suppressed as an adversarial control; the
    // URL assertion must fail even though Playwright teardown may still close the
    // stream. It then re-baselines BFF logs and runs this real navigation.
    //
    // DIAGNOSTIC, not a repair. One historical run of this gate saw `page.goto`
    // return while the URL stayed on the fixture. The beforeunload explanation
    // originally filed for it is DISPROVED: with genuine sticky activation and a
    // `preventDefault()`ing beforeunload listener installed, `page.goto` still
    // navigates in this harness. The combined cold review reproduced that
    // independently and went further — installing a Playwright dialog listener and
    // explicitly dismissing the prompt DOES yield `net::ERR_ABORTED`, which shows
    // the default no-listener harness this gate runs under is materially different
    // and never reaches that path. Capturing the navigation response distinguishes
    // "the navigation never committed" from "it committed and was undone", so a
    // recurrence names its own mechanism instead of only reporting a stale URL.
    // The assertions below are unchanged in strength.
    if (process.env.ASSEMBLED_SKIP_ABORT_NAVIGATION !== "1") {
      const response = await page.goto("/about");
      expect(
        response,
        "page.goto must return a committed navigation response for /about",
      ).not.toBeNull();
      expect(response!.url(), "the committed navigation response is /about").toMatch(/\/about$/);
    }
    await expect(page).toHaveURL(/\/about$/);
    await page.waitForTimeout(2_000);
  });
});
