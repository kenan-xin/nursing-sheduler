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
  ABORT_BOUNDS,
  ABORT_TEST_TIMEOUT,
  FIRST_BYTE_TIMEOUT,
  JUDGE_POLL_TIMEOUT,
  judgeEventsAuthority,
  judgeReplayEvidence,
  KEEPALIVE_WINDOW,
  OBSERVATION_EVALUATE_BOUND,
  OPTIMIZE_SESSION_RECORD_KEY,
  OWNERSHIP_RECOVERY_BOUND,
  parseEventsRequestUrl,
  recoverAcceptedOwnership,
  releaseLiveJobs,
  settleAcceptedOwnership,
  REPLAY_BOUNDS,
  REPLAY_TEST_TIMEOUT,
  RESUMED_HEADER_TIMEOUT,
  RESUMED_SCREEN_TIMEOUT,
  TINY_BOUNDS,
  TINY_TEST_TIMEOUT,
  trackAcceptedJobs,
  type AcceptedJobTracker,
  type OwnershipRecovery,
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

// Printed immediately before the abort lane's URL assertion, in negative-control mode
// only, so `docker/verify-stream.sh` can tell "failed AT the intended assertion" from
// "failed somewhere else with familiar-looking words in the message". Kept in sync
// with the `NEG_SENTINEL` literal in that script.
const ABORT_CONTROL_SENTINEL = "R6_ABORT_CONTROL_AT_URL_ASSERTION";

// The abort lane's URL-settle window now lives in `ABORT_BOUNDS.abortUrlSettle`,
// alongside every other bound that lane spends, so its total is derived from the
// same enumerated object as tiny's and replay's.
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
    // EVERY url this wrapper classified as events-related, in request order. It is
    // recorded unfiltered on purpose: the judge parses each one against the exact
    // canonical contract and fails closed on anything malformed or foreign, so a
    // url that cannot be parsed is evidence of a defect, never an absence.
    // (No backticks in this comment: it lives inside a template literal.)
    eventUrls: [],
    // Job ids from every accepted POST /api/optimize (HTTP 202). Recorded so the
    // test can arm cleanup ownership from the accepted submission itself, before
    // any bounded assertion runs.
    acceptedJobIds: [],
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
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    // No regex literal here on purpose. This script lives inside a template
    // literal, where a backslash escape is consumed before the browser ever sees
    // it, so an escaped slash inside a pattern would emit a line comment instead.
    // (No backticks and no backslashes in this comment, for the same reason.)
    var submitPath = String(url).split('?')[0];
    var isSubmit = method === 'POST' &&
      (submitPath === '/api/optimize' || submitPath.endsWith('/api/optimize'));
    var isEvents = url.indexOf('/events') !== -1;
    if (isSubmit) {
      // Clone before anyone reads the body, so the controller's own read is
      // untouched. Recorded as soon as the server accepts, which is the earliest
      // point at which a job exists to own.
      return originalFetch.apply(this, arguments).then(function(response) {
        if (response.status === 202) {
          response.clone().json().then(function(body) {
            if (body && typeof body.id === 'string' && body.id.length > 0) {
              obs.acceptedJobIds.push(body.id);
            }
          }).catch(function() {});
        }
        return response;
      });
    }
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
  acceptedJobIds: string[];
}

async function readSseObs(page: Page): Promise<SseObservations> {
  // Bounded like every other observation evaluate: `page.evaluate` takes no timeout
  // parameter, so without this the call would be governed only by the test total
  // and the budget entry for it would be an estimate rather than a ceiling.
  return withBound(
    "sse observation evaluate",
    OBSERVATION_EVALUATE_BOUND,
    page.evaluate(() => {
      const obs = (window as unknown as { __nsSseObs?: SseObservations }).__nsSseObs;
      return {
        sseResponseAt: obs?.sseResponseAt ?? null,
        sseFirstByteAt: obs?.sseFirstByteAt ?? null,
        sseChunks: obs?.sseChunks ?? [],
        eventLastEventIds: obs?.eventLastEventIds ?? [],
        eventUrls: obs?.eventUrls ?? [],
        acceptedJobIds: obs?.acceptedJobIds ?? [],
      };
    }),
  );
}

/**
 * Enforce a bound on work Playwright cannot bound itself.
 *
 * `page.evaluate` and the composite reload step take no per-call timeout, so a
 * budget entry for them would otherwise be an estimate rather than a ceiling.
 * Racing them against a rejecting timer makes each one a genuinely enforced phase,
 * which is what lets `REPLAY_TEST_TIMEOUT` be a complete sum.
 */
async function withBound<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its ${ms}ms bound`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
   * EVERY events-request url observed before the reload, verbatim and unfiltered.
   * `judgeEventsAuthority` parses each against the exact canonical contract and
   * fails closed on any malformed or foreign one; the judge is fed a job id only
   * when that passes AND agrees with `sessionJobId`.
   */
  eventUrls: string[];
  /** The page's own origin, captured in the same task as the evidence. */
  pageOrigin: string | null;
}

/** Freeze the observation wrapper's current SSE body, allow already-delivered
 * frames to finish committing, then atomically capture cursor + raw IDs and
 * initiate reload. The e2e-only snapshot key is ignored by the application and
 * removed immediately after the new document reads it. */
async function captureReplaySnapshotAndReload(page: Page): Promise<ReplaySnapshot> {
  // Both halves are explicitly bounded: the navigation by Playwright's own
  // parameter, the evaluate by `withBound` because `page.evaluate` accepts no
  // timeout. Without that, the budget entry for this step would be an estimate
  // rather than a ceiling.
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
          // Second authority: EVERY events url the wrapper classified, carried out
          // verbatim and unfiltered. Parsing and rejection happen in the judge, so
          // nothing can be silently discarded here.
          const eventUrls = (e2eWindow.__nsSseObs?.eventUrls ?? []).slice();
          sessionStorage.setItem(
            snapshotKey,
            JSON.stringify({
              cursor,
              rawIds,
              sessionJobId,
              eventUrls,
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
        : { cursor: null, rawIds: [], sessionJobId: null, eventUrls: [], pageOrigin: null };
    }, REPLAY_SNAPSHOT_KEY),
  );
}

// TWO sequential `addInitScript` calls, each with its own enforced bound and its
// own budget key. `addInitScript` takes no timeout parameter, so without
// `withBound` these were governed only by the test total — and a single shared
// entry could not distinguish an omitted call from a fast one.
async function injectYaml(page: Page, yaml: string): Promise<void> {
  await withBound(
    "inject observation script",
    REPLAY_BOUNDS.injectObservationScript,
    page.addInitScript(SSE_OBSERVATION_SCRIPT),
  );
  await withBound(
    "inject fixture yaml",
    REPLAY_BOUNDS.injectFixtureYaml,
    page.addInitScript((y) => {
      (window as unknown as { __NS_DURABLE_FIXTURE_YAML?: string }).__NS_DURABLE_FIXTURE_YAML = y;
    }, yaml),
  );
}

// Every wait here carries an EXPLICIT local timeout rather than inheriting
// Playwright's action/navigation defaults. That is what makes `REPLAY_BOUNDS` a
// real ceiling: `page.goto` alone would otherwise permit 30s, and four default
// web-first expectations another 20s, none of it visible in the budget.
async function gotoFixture(page: Page): Promise<void> {
  await page.goto("/optimize-durable-fixture", {
    timeout: REPLAY_BOUNDS.gotoFixtureNavigation,
  });
  await expect(page.getByTestId("optimize-durable-fixture")).toBeVisible({
    timeout: REPLAY_BOUNDS.fixtureRootVisible,
  });
  await expect(page.getByTestId("screen")).toBeVisible({
    timeout: REPLAY_BOUNDS.screenVisible,
  });
  // Anonymize defaults ON; turn it OFF for the tiny job (no restoration needed).
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

interface ReplayObservation {
  rawIds: string[];
  cursor: string | null;
  /**
   * The page's OWN origin, captured in the same observation as the evidence it
   * authorises. Independent of every URL under test, which is what lets an
   * absolute events URL be bound rather than merely parsed.
   */
  pageOrigin: string | null;
  firstLastEventId: string | null;
  /** The URL of the FIRST resumed events request, captured with its header. */
  firstEventUrl: string | null;
  /** Every post-reload events URL, unfiltered, for the anchored authority check. */
  eventUrls: string[];
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
  return withBound(
    "replay observation evaluate",
    OBSERVATION_EVALUATE_BOUND,
    page.evaluate(() => {
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
      // The first resumed request's URL and its `Last-Event-ID` are read in the SAME
      // task and at the SAME index, so the pair genuinely describes one request. The
      // header alone was assertable before, which left a wrong or malformed first
      // TARGET invisible whenever a correct request followed it.
      return {
        rawIds,
        cursor,
        pageOrigin: window.location.origin,
        firstLastEventId: obs?.eventLastEventIds?.[0] ?? null,
        firstEventUrl: obs?.eventUrls?.[0] ?? null,
        eventUrls: (obs?.eventUrls ?? []).slice(),
      };
    }),
  );
}

test.describe("T16f assembled Browser → Next → FastAPI stream gate", () => {
  // Release EVERY live job the positive tests submit, so a failure cannot leave a
  // solve burning the host for the form's 300s default and starve the NEXT test's
  // fixture mount. That is the exact correlated failure recorded earlier: one 30s
  // timeout produced 29/2 because the abort case could not mount within 5s
  // afterwards.
  //
  // Ownership is a NODE-SIDE tracker registered before submit, not a test-body side
  // effect. It used to be assigned from inside an `expect.poll` callback, which is
  // the right seam on a successful callback — but Playwright races the callback
  // against the poll deadline without cancelling or awaiting the loser, so a losing
  // callback could arm an accepted 202 AFTER this hook had already copied an empty
  // array. A probe of the installed runtime showed `hookSnapshot: []` at timeout and
  // `armed: ["job-timeout-race"]` 121ms later: an orphaned job plus ownership state
  // leaking into the next test.
  //
  // The tracker's lifecycle is explicit and the hook DRAINS it before snapshotting,
  // so no ownership mutation can outlive the snapshot, and there is no second
  // abandonable callback anywhere in the design.
  //
  // The abort test is deliberately NOT tracked: it is SUPPOSED to walk away from a
  // live stream (that is the mechanism it proves), it is the last test in the file,
  // and the gate tears the stack down after it — so it is left alone rather than
  // risk perturbing the BFF log audit baselined around it.
  //
  // This runs in `afterEach` rather than a `finally` because Playwright abandons a
  // timed-out test body but still runs hooks, which is precisely the case this
  // exists for.
  //
  // Deliberately NOT added to the three enumerated budgets: Playwright counts
  // `afterEach` inside the test timeout, so on a maximally slow run this hook can be
  // truncated. That is safe here in the only sense that matters — a truncated hook
  // makes the test TIME OUT, i.e. red, so it cannot manufacture a false green. The
  // budgets therefore stay exactly as pinned (they bound the test bodies), and this
  // hook's own bounds (`ACCEPTED_PENDING_SETTLE_MS`, `OWNERSHIP_RECOVERY_BOUND`,
  // `CLEANUP_BOUNDS`) are documented at their definitions instead.
  let acceptedTracker: AcceptedJobTracker | null = null;
  test.afterEach(async ({ page, request }, testInfo) => {
    const tracker = acceptedTracker;
    acceptedTracker = null;
    // Drain BEFORE the snapshot, and take the drain's own verdict rather than just
    // its ids. The previous hook awaited a `void` drain, copied `ids()`, disposed,
    // and reported success — so a submission still pending at the settle bound, or
    // an accepted 202 whose body would not read, produced `armed jobs: (none)` and
    // `cleanup ok` while a solver could be running. Now unresolved ownership must be
    // RECOVERED from the page's own session record or the hook fails.
    let trackerStats = { started: 0, failed: 0 };
    let jobIds: string[] = [];
    let settlementNotes: string[] = [];
    let settlementFailures: string[] = [];
    if (tracker !== null) {
      const drained = await tracker.drain();
      trackerStats = tracker.stats();

      // Independent authority, consulted ONLY when the tracker fell short. The
      // product writes the active session record (job id included) as part of
      // accepting the 202, so it is produced by the page rather than by the CDP
      // response stream — exactly the failures that defeat the tracker leave it
      // intact. Bounded, because `page.evaluate` takes no timeout.
      let recovery: OwnershipRecovery | null = null;
      if (!drained.resolved) {
        recovery = await recoverAcceptedOwnership({
          readSessionRecord: () =>
            withBound(
              "ownership recovery read",
              OWNERSHIP_RECOVERY_BOUND,
              page.evaluate(
                (key) => window.sessionStorage.getItem(key),
                OPTIMIZE_SESSION_RECORD_KEY,
              ),
            ),
        });
      }

      // Dispose AFTER settling the drain, and take disposal's own report: detaching
      // the listeners is the instant ownership can be lost silently, so anything
      // still in flight then is unresolved rather than finished.
      const disposal = tracker.dispose();
      const settlement = settleAcceptedOwnership(drained, recovery, disposal);
      jobIds = settlement.ids;
      settlementNotes = settlement.notes;
      settlementFailures = settlement.failures;
    }

    // Cancel -> poll to terminal -> DELETE, asserting the documented status at each
    // step. The previous hook POSTed cancel and DELETEd immediately, checked no
    // status, and treated only a transport exception as failure — so on a RUNNING
    // job it took the documented 409 path (DELETE is legal only after terminal) and
    // finished "successfully" with the solve still alive.
    const outcome = await releaseLiveJobs(jobIds, {
      post: async (url, timeout) => {
        const res = await request.post(url, { timeout });
        return { status: res.status(), body: await res.text() };
      },
      delete: async (url, timeout) => {
        const res = await request.delete(url, { timeout });
        return { status: res.status(), body: await res.text() };
      },
      get: async (url, timeout) => {
        const res = await request.get(url, { timeout });
        return { status: res.status(), body: await res.text() };
      },
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    });

    // ALWAYS attach, before any decision about throwing. `releaseLiveJobs` converts
    // a rejected transport into a named failure rather than propagating it, so this
    // line is reachable on every path.
    const report = [
      `armed jobs: ${jobIds.length === 0 ? "(none)" : jobIds.join(", ")}`,
      `tracker: ${trackerStats.started} accepted-response read(s), ${trackerStats.failed} unreadable`,
      ...settlementNotes,
      ...outcome.steps,
      ...settlementFailures,
      ...outcome.failures,
    ].join("\n");
    await testInfo.attach("live-job-cleanup", {
      body: report,
      contentType: "text/plain",
    });

    // Cleanup is successful only when BOTH the release converged AND ownership was
    // fully accounted for. Releasing an empty set is not success when the reason the
    // set is empty is that we could not name the job.
    if (outcome.ok && settlementFailures.length === 0) return;
    // Never replace the primary failure: if the test already failed, the cleanup
    // trace is attached above and that is all. But a cleanup failure on an
    // otherwise PASSING test means the next lane may be starved, so it must fail
    // the gate rather than pass quietly.
    if (testInfo.status === testInfo.expectedStatus) {
      throw new Error(`live-job cleanup did not converge:\n${report}`);
    }
  });

  test("tiny feasible job: SSE first byte, completion, download, cleanup", async ({ page }) => {
    // This test's own complete budget, derived in `TINY_BOUNDS` from every
    // sequential bound below. Its 90s completion poll could never reach its own
    // bound under Playwright's 30s default — the same incomplete-budget shape the
    // review blocked on for the replay test, in its sibling. No retries, no sleeps,
    // no blanket suite timeout, and the completion poll itself is unchanged.
    test.setTimeout(TINY_TEST_TIMEOUT);

    await injectYaml(page, TINY_YAML);
    await gotoFixture(page);

    // Register ownership BEFORE submit, on the Node side.
    //
    // On the SUCCESS path the product itself releases the job — the terminal
    // auto-chain DELETEs, which is what the slot-freed assertion below proves — so
    // the hook then finds it already gone and takes the documented idempotent 404
    // branch. But a FAILURE between submission and that DELETE (a download that
    // never completes, say) would leave the slot occupied and the next lane would
    // hit `submit-blocked`. Because the tracker is fed by the response event and
    // drained by the hook, a 202 that lands at a poll deadline is still owned.
    acceptedTracker = trackAcceptedJobs(page);

    await page.getByTestId("optimize-submit").click({ timeout: TINY_BOUNDS.submitClick });

    await expect
      .poll(() => acceptedTracker?.ids().length ?? 0, { timeout: TINY_BOUNDS.acceptedIdPoll })
      .toBeGreaterThan(0);

    // Assert the browser observed the actual SSE response (not just that the
    // POST activated the job and controls rendered). This is the real
    // "first response" — the SSE endpoint answered with text/event-stream.
    await expect
      .poll(async () => (await readSseObs(page)).sseResponseAt, {
        timeout: TINY_BOUNDS.sseResponsePoll,
      })
      .not.toBeNull();
    const obs1 = await readSseObs(page);
    // The Node-side tracker and the in-page wrapper must agree on what was accepted.
    // Two independent observations of the same 202, so a divergence is a real defect.
    expect(acceptedTracker!.ids(), "the tracker agrees with the in-page record").toEqual(
      obs1.acceptedJobIds,
    );
    expect(obs1.acceptedJobIds, "exactly one submission was accepted").toHaveLength(1);
    expect(obs1.sseResponseAt).not.toBeNull();
    // And a first body byte arrived (the stream delivered content).
    expect(obs1.sseFirstByteAt).not.toBeNull();
    expect(obs1.sseFirstByteAt! - obs1.sseResponseAt!).toBeLessThan(10_000);

    // Terminal completion: the auto-chain fetches the artifact, restores it,
    // downloads, and DELETEs.
    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
      { timeout: TINY_BOUNDS.completionPoll },
    );

    // Cleanup DELETE freed the single-slot: a new run is allowed.
    await expect(page.getByTestId("optimize-submit")).toBeEnabled({
      timeout: TINY_BOUNDS.slotFreedAssertion,
    });
  });

  test("live job: SSE first byte, genuine keepalive, cursor persistence, strictly-after replay", async ({
    page,
  }) => {
    // This test's own explicit total budget, derived in `REPLAY_BOUNDS` from every
    // sequential bound below. Not a blanket suite timeout, no retries, no sleeps,
    // and no phase bound was relaxed to fit it. (Tiny and the abort lane carry their
    // own derived totals; this one governs only the replay lane.)
    test.setTimeout(REPLAY_TEST_TIMEOUT);

    await injectYaml(page, LARGE_YAML);
    await gotoFixture(page);

    // ARM CLEANUP OWNERSHIP FIRST, on the Node side, before submit.
    //
    // Ownership was previously assigned from inside the poll callback, which loses
    // the race at the deadline: Playwright abandons the losing callback, so it could
    // arm after the hook had already snapshotted. The tracker is fed by the response
    // event and drained by the hook instead, which removes the race rather than
    // moving it.
    acceptedTracker = trackAcceptedJobs(page);

    await page.getByTestId("optimize-submit").click({ timeout: REPLAY_BOUNDS.submitClick });

    await expect
      .poll(() => acceptedTracker?.ids().length ?? 0, {
        timeout: REPLAY_BOUNDS.acceptedJobIdPoll,
      })
      .toBeGreaterThan(0);
    const accepted = (await readSseObs(page)).acceptedJobIds;
    expect(acceptedTracker!.ids(), "the tracker agrees with the in-page record").toEqual(accepted);
    expect(accepted, "exactly one submission was accepted").toHaveLength(1);

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
      eventUrls: preReloadEventUrls,
      pageOrigin: preReloadPageOrigin,
    } = await captureReplaySnapshotAndReload(page);

    // --- Resolve the replay authority, independently of any cursor -------------
    //
    // Three cursor-free facts must line up before anything is trusted: the ACTIVE
    // session record's own `jobId` (written by the activation transaction from the
    // POST 202 response), EVERY events path the browser actually requested parsed
    // against the exact canonical contract, and the id the server accepted at
    // submission. Nothing is filtered: a malformed or foreign events URL is a
    // failure, not an absence.
    expect(sessionJobId, "the active session must name its job").not.toBeNull();
    expect(sessionJobId!.length).toBeGreaterThan(0);
    expect(sessionJobId, "the session's job is the one the server accepted").toBe(accepted[0]);
    expect(preReloadPageOrigin, "the page origin was captured with the evidence").not.toBeNull();
    const preReloadAuthority = judgeEventsAuthority(
      preReloadEventUrls,
      sessionJobId,
      preReloadPageOrigin,
    );
    expect(
      preReloadAuthority.failures,
      "every pre-reload events URL is canonical and targets the active job",
    ).toEqual([]);
    expect(preReloadAuthority.jobIds, "exactly one job's events path was requested").toEqual([
      sessionJobId,
    ]);
    const expectedJobId = sessionJobId!;

    expect(cursorBefore).not.toBeNull();
    expect(cursorBefore!.length).toBeGreaterThan(0);
    expect(preReloadIds.length).toBeGreaterThan(0);
    expect(preReloadIds).toContain(cursorBefore);
    await expect(page.getByTestId("screen")).toBeVisible({ timeout: RESUMED_SCREEN_TIMEOUT });

    // The FIRST post-reload events request must present the exact cursor captured
    // above AND target the active job's canonical path. Both are read from the same
    // observation at the same index, so the pair describes one request — asserting
    // only the header left a wrong, old or malformed first TARGET invisible whenever
    // a correct request happened to follow it.
    await expect
      .poll(async () => (await readReplayObservation(page)).firstLastEventId, {
        timeout: RESUMED_HEADER_TIMEOUT,
      })
      .toBe(cursorBefore);
    const firstResumed = await readReplayObservation(page);
    expect(firstResumed.firstLastEventId).toBe(cursorBefore);
    expect(
      firstResumed.firstEventUrl,
      "the first resumed request has a recorded URL",
    ).not.toBeNull();
    expect(firstResumed.pageOrigin, "the resumed page origin was captured").not.toBeNull();
    const firstResumedTarget = parseEventsRequestUrl(
      firstResumed.firstEventUrl!,
      firstResumed.pageOrigin,
    );
    expect(
      firstResumedTarget.ok ? null : firstResumedTarget.reason,
      "the first resumed URL is a canonical events path",
    ).toBeNull();
    expect(
      firstResumedTarget.ok ? firstResumedTarget.jobId : null,
      "the first resumed request targets the active job",
    ).toBe(expectedJobId);

    // Judge the replay through `judgeReplayEvidence`, whose full truth table —
    // valid / self-consistent-foreign / duplicate / foreign / mixed / stale /
    // missing / malformed — is proved deterministically in
    // `support/optimize-durable.test.ts`, including committed adversarial baselines
    // for every predicate this oracle has previously shipped.
    //
    // AUTHORITY CHAIN. `expectedJobId` comes from the cursor-free sources
    // corroborated above — accepted submission id, ACTIVE session `jobId`, and every
    // canonical events path — never from a cursor. The judge binds `cursorBefore` to
    // it; the assertions immediately above pin the first resumed request's
    // `Last-Event-ID` to that same `cursorBefore` AND its target path to the same
    // job, so the resumed request is bound directly rather than only by inference;
    // and every raw id plus `cursorAfter` is bound to it as well. A fully self-consistent foreign envelope — foreign cursorBefore,
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
    // And every POST-reload events URL is canonical and on the active job too, so
    // the resumed stream cannot have wandered after the first request was checked.
    const resumedAuthority = judgeEventsAuthority(
      snapshot.eventUrls,
      expectedJobId,
      snapshot.pageOrigin,
    );
    expect(
      resumedAuthority.failures,
      "every post-reload events URL is canonical and targets the active job",
    ).toEqual([]);
    expect(resumedAuthority.jobIds).toEqual([expectedJobId]);
    // NOTE: this test does NOT navigate away — the abort is isolated in a
    // separate test so the gate's BFF-log baseline can attribute the cancel
    // to the intended navigation only.
  });

  test("abort propagation: browser disconnect cancels upstream SSE body", async ({ page }) => {
    // This lane's own complete budget, derived in `ABORT_BOUNDS`. It had NO
    // `test.setTimeout` and the assembled config declares no suite timeout, so
    // Playwright's 30s default governed a schedule whose local bounds already summed
    // past 137s — and the submit click below had no explicit action timeout, where the
    // default is 0. That is the same incomplete-budget class already repaired for
    // tiny and replay; this is the third and last instance of it.
    test.setTimeout(ABORT_TEST_TIMEOUT);

    // ISOLATED from the replay test. The gate script baselines the BFF log
    // count IMMEDIATELY before this test and checks for a NEW entry after.
    // No reload, prior test, or curl disconnect can satisfy the audit.
    await injectYaml(page, LARGE_YAML);
    await gotoFixture(page);

    await page.getByTestId("optimize-submit").click({ timeout: ABORT_BOUNDS.submitClick });

    // Confirm the SSE stream is live before aborting.
    await expect
      .poll(async () => (await readSseObs(page)).sseResponseAt, {
        timeout: ABORT_BOUNDS.firstResponsePoll,
      })
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
      const response = await page.goto("/about", { timeout: ABORT_BOUNDS.abortNavigation });
      expect(
        response,
        "page.goto must return a committed navigation response for /about",
      ).not.toBeNull();
      expect(response!.url(), "the committed navigation response is /about").toMatch(/\/about$/);
    }
    // The historical `page.goto` symptom is finally EXPLAINED, and the explanation
    // came from the diagnostic added for it. Reproduced under a deliberately extreme
    // synthetic overload (loadavg ~24 on 10 cores): the navigation response above
    // PASSED — the commit really was `/about` — while `page.url()` still reported the
    // fixture 13 times across the default 5s window. So the main-frame URL lags a
    // committed navigation under host saturation; nothing undoes the navigation, and
    // beforeunload remains disproved.
    //
    // The repair is therefore a bounded wait, not a weaker claim: the assertion is
    // unchanged and still requires the URL to become `/about`; only the settling
    // window is now explicit instead of an implicit 5s default.
    //
    // NEGATIVE-CONTROL SENTINEL, on the line immediately below, in control mode only.
    // `docker/verify-stream.sh` runs this lane with the navigation suppressed and must
    // confirm it goes red for the INTENDED reason. Its classifier used to grep the
    // output for `toHaveURL` and `/about`, which ANY error whose text happens to carry
    // both tokens satisfies — including one thrown a hundred lines earlier. This gives
    // the classifier a position it can trust: nothing that fails before the assertion
    // can print it, and the classifier additionally requires Playwright's exact matcher
    // output plus a `Received string:` still on the fixture, which a hand-thrown error
    // cannot forge. See the negative-control block in that script.
    if (process.env.ASSEMBLED_SKIP_ABORT_NAVIGATION === "1") {
      process.stdout.write(`${ABORT_CONTROL_SENTINEL}\n`);
    }
    await expect(page).toHaveURL(/\/about$/, { timeout: ABORT_BOUNDS.abortUrlSettle });
    // Let the BFF observe and log the upstream cancel before the gate reads its logs.
    await page.waitForTimeout(ABORT_BOUNDS.bffObservationTail);
  });
});
