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
  auditCoverageAfterRelease,
  FIRST_BYTE_TIMEOUT,
  judgeEventsAuthority,
  judgeVolatileJobIdTexts,
  KEEPALIVE_WINDOW,
  OBSERVATION_EVALUATE_BOUND,
  OPTIMIZE_SESSION_RECORD_KEY,
  OWNERSHIP_RECOVERY_BOUND,
  recoverAcceptedOwnership,
  releaseLiveJobs,
  settleAcceptedOwnership,
  REPLAY_BOUNDS,
  REPLAY_TEST_TIMEOUT,
  TINY_BOUNDS,
  TINY_TEST_TIMEOUT,
  trackAcceptedJobs,
  VOLATILE_JOB_ID_SELECTOR,
  type AcceptedJobTracker,
  type OwnershipRecovery,
  type OwnershipSettlement,
} from "./support/optimize-durable";
import {
  ABORT_CONTROL_SENTINEL,
  auditTerminalExpect,
  guardTerminalExpect,
} from "./support/abort-control-reporter";
import { ABORT_HANDOFF_ENV, publishAbortHandoff } from "./support/abort-handoff";

const REPO_ROOT = resolve(__dirname, "../..");
const TINY_YAML = readFileSync(
  resolve(REPO_ROOT, "core/tests/testcases/basics/01_1nurse_1shift_1day.yaml"),
  "utf-8",
);
const LARGE_YAML = readFileSync(
  resolve(REPO_ROOT, "core/tests/testcases/real/large-ward-with-87-people-2025-11.yaml"),
  "utf-8",
);

// The sentinel printed immediately before the abort lane's URL assertion, in
// negative-control mode only, so `docker/verify-stream.sh` can tell "failed AT the
// intended assertion" from "failed somewhere else with familiar-looking words in the
// message". Imported from the reporter that also reads it back, rather than restated
// here, so the spec and the report cannot drift; the shell half stays in sync with the
// `NEG_SENTINEL` literal in that script.

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

/**
 * Atomically capture the live stream's job authority and every raw frame id.
 *
 * WAS `captureReplaySnapshotAndReload`. It froze the SSE body and reloaded, to
 * stage a resume; G6.2 retired resume, so it observes instead. Still ONE evaluate,
 * because the point survives the change: the job authority has to be read in the
 * same browser task as the evidence it authorises, not re-derived afterwards from
 * something that evidence itself supplied.
 */
async function captureLiveStreamSnapshot(page: Page): Promise<ReplaySnapshot> {
  // Explicitly bounded by `withBound`, because `page.evaluate` accepts no timeout.
  // Without that, the budget entry for this step would be an estimate rather than
  // a ceiling.
  await Promise.resolve(
    withBound(
      "live-stream snapshot evaluate",
      REPLAY_BOUNDS.freezeAndSnapshotEvaluate,
      page.evaluate(
        async ([snapshotKey, sessionKey]) => {
          const e2eWindow = window as unknown as {
            __nsFreezeSseForReplay?: () => Promise<unknown>;
            __nsSseObs?: SseObservations;
          };
          // NO FREEZE, NO RELOAD. Both existed to stage a reload-resume, and G6.2
          // retired reload-resume: a reload is a fresh visit that reattaches to
          // nothing. The live stream is left running and simply observed.

          // The session record carries BOTH the active job id and the last committed
          // cursor. Reading them in the same task as the raw frames is what makes the
          // job authority causally simultaneous with the evidence it authorises — not
          // re-derived later from something the evidence itself supplied.
          // G6.2: records are keyed per owner (`nurse.optimize.session.<ownerId>`)
          // and the resume cursor is gone. Reading the one legacy key would return
          // null for every record the product now writes — which is exactly how a
          // harness turns "the session names its job" into a vacuous absence.
          const readSession = (): { jobId: string | null; cursor: string | null } => {
            const prefix = `${sessionKey}.`;
            for (let index = 0; index < sessionStorage.length; index += 1) {
              const key = sessionStorage.key(index);
              if (key === null || !key.startsWith(prefix)) continue;
              const raw = sessionStorage.getItem(key);
              if (!raw) continue;
              try {
                const parsed = JSON.parse(raw) as { phase?: string; jobId?: string };
                // Only an ACTIVE record names a job; a provisional one has none.
                if (parsed.phase === "active" && parsed.jobId) {
                  return { jobId: parsed.jobId, cursor: null };
                }
              } catch {
                // Undecodable bytes name no job. Keep looking rather than claiming one.
              }
            }
            return { jobId: null, cursor: null };
          };

          let cursor: string | null = null;
          let sessionJobId: string | null = null;
          let stableReads = 0;
          // Settles on the JOB ID now, not on a cursor: with the durable cursor
          // removed there is nothing left to converge on, and the id is what the
          // authority chain below is actually built from.
          for (let attempt = 0; attempt < 20 && stableReads < 3; attempt += 1) {
            const next = readSession();
            stableReads = next.jobId !== null && next.jobId === sessionJobId ? stableReads + 1 : 0;
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
          // Handed back through the same e2e-only key the reload form used, so the
          // one-task capture stays one task. The application ignores this key.
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
        },
        [REPLAY_SNAPSHOT_KEY, OPTIMIZE_SESSION_KEY] as const,
      ),
    ),
  );

  return withBound(
    "snapshot read evaluate",
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

// REMOVED with the reload-resume half: `readReplayObservation` read the durable
// resume cursor and the resumed request's `Last-Event-ID`. Neither exists on a
// fresh visit, and the observation wrapper freezes further SSE fetches so the
// reload could stage a resume — so there is nothing left for it to observe.

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
    let trackerStats = { started: 0, unaccounted: 0 };
    let jobIds: string[] = [];
    let settlementNotes: string[] = [];
    let settlementFailures: string[] = [];
    // Kept whole, not just its pieces: the post-release coverage audit needs the
    // `coverage` set to know WHICH ids were standing in for something unnamed.
    let settlement: OwnershipSettlement | null = null;
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
          // THE VOLATILE AUTHORITY. `activateSession` can return
          // `activation-persistence-failed`: the 202 was accepted, a real job is
          // running, and the durable record deliberately STAYS provisional — the id
          // exists only in controller state. The screen renders that live id
          // (`run-status-panel.tsx`), so reading it back is a genuine second authority.
          //
          // Bound to a stable `data-testid` on the id VALUE rather than to the
          // `Job ID:` prose it used to scrape. The prose form coupled a fail-closed
          // ownership gate to user-visible copy and would have matched any other
          // paragraph opening the same way. The page returns only RAW texts; every
          // judgement (absent / multiple / untexted / empty / not-a-bare-id) lives in
          // `judgeVolatileJobIdTexts`, whose truth table is proved in the unit suite.
          // A rejected verdict is thrown, which `recoverAcceptedOwnership` records as a
          // failed recovery — so an unusable answer fails the gate instead of reading
          // as "no job".
          readVolatileJobIds: () =>
            withBound(
              "volatile job id read",
              OWNERSHIP_RECOVERY_BOUND,
              page
                .evaluate(
                  (selector) =>
                    Array.from(document.querySelectorAll(selector)).map((node) => node.textContent),
                  VOLATILE_JOB_ID_SELECTOR,
                )
                .then((texts) => {
                  const verdict = judgeVolatileJobIdTexts(texts);
                  if (!verdict.ok) throw new Error(verdict.reason);
                  return verdict.ids;
                }),
            ),
        });
      }

      // Dispose AFTER settling the drain, and take disposal's own report: detaching
      // the listeners is the instant ownership can be lost silently, so anything
      // still in flight then is unresolved rather than finished.
      const disposal = tracker.dispose();
      settlement = settleAcceptedOwnership(drained, recovery, disposal);
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

    // COVERAGE AUDIT, after release and before the verdict. Cardinality alone cannot
    // tell a real recovered job from a STALE or invented id: both are "new and
    // distinct", and a stale one then releases "successfully" down the documented
    // idempotent 404 branch — so an acceptance we never named would look covered by a
    // job that was never there. Only ids standing in for something unnamed are audited;
    // a tracker-observed id legitimately 404s because the product's own terminal
    // auto-chain already DELETEd it.
    const coverageAudit =
      settlement === null
        ? { ok: true, failures: [] as string[] }
        : auditCoverageAfterRelease(settlement, outcome);

    // ALWAYS attach, before any decision about throwing. `releaseLiveJobs` converts
    // a rejected transport into a named failure rather than propagating it, so this
    // line is reachable on every path.
    const report = [
      `armed jobs: ${jobIds.length === 0 ? "(none)" : jobIds.join(", ")}`,
      `tracker: ${trackerStats.started} acceptance(s), ${trackerStats.unaccounted} unaccounted`,
      ...settlementNotes,
      ...outcome.steps,
      ...settlementFailures,
      ...outcome.failures,
      ...coverageAudit.failures,
    ].join("\n");
    await testInfo.attach("live-job-cleanup", {
      body: report,
      contentType: "text/plain",
    });

    // Cleanup is successful only when the release converged, ownership was fully
    // accounted for, AND every id counted as coverage turned out to exist. Releasing an
    // empty set is not success when the reason the set is empty is that we could not
    // name the job, and releasing a job the backend never had accounts for nothing.
    if (outcome.ok && settlementFailures.length === 0 && coverageAudit.ok) return;
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

  test("live job: SSE first byte, genuine keepalive, canonical events authority", async ({
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

    // Atomically capture the independent job authority and every raw frame id seen
    // so far, in one browser task.
    const {
      cursor: cursorBefore,
      sessionJobId,
      eventUrls: preReloadEventUrls,
      pageOrigin: preReloadPageOrigin,
    } = await captureLiveStreamSnapshot(page);

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
      "every events URL is canonical and targets the active job",
    ).toEqual([]);
    expect(preReloadAuthority.jobIds, "exactly one job's events path was requested").toEqual([
      sessionJobId,
    ]);

    // ------------------------------------------------------------------
    // WHAT THIS TEST NO LONGER PROVES, and why it is stated here rather than
    // quietly dropped.
    //
    // Everything from here used to reload the page and assert that the resumed
    // stream presented the durable cursor as its \`Last-Event-ID\`, then judged the
    // replay strictly-after through \`judgeReplayEvidence\`. That is reload-RESUME,
    // and G6.2 retired it: entering the route is a fresh visit that reattaches to
    // nothing, and the durable cursor it depended on is deleted.
    //
    // The mechanism underneath is NOT gone — an in-visit reconnect still resumes
    // from the cursor the stream tracker holds in memory — but the only browser
    // affordance that reached it from here was the reload. The observation harness
    // freezes every further SSE fetch precisely so a reload can stage that, so it
    // cannot be repointed at an in-visit reconnect without redesigning it.
    //
    // Where the coverage lives now: \`judgeReplayEvidence\`'s full adversarial truth
    // table stays committed in \`support/optimize-durable.test.ts\`, and the reconnect
    // itself in \`lib/query/event-stream.test.ts\`. What this assembled lane still
    // proves — a real socket, a real SSE response, a genuine keepalive comment, and
    // canonical events URLs bound to the accepted job — is asserted above.
    expect(cursorBefore, "the durable resume cursor is deleted, not merely unused").toBeNull();
  });

  // THE WHOLE BODY of this test is wrapped in `auditTerminalExpect`, deliberately, and
  // nothing of it lives outside the wrapper. That wrapper writes its causal mark only
  // when the error object escaping the body is the very object the guarded matcher threw,
  // so a wrapper scoped to only PART of the body could be defeated by catching the
  // failure just outside it and rethrowing a copy. See `support/abort-control-reporter.ts`.
  test("abort propagation: browser disconnect cancels upstream SSE body", async ({
    page,
  }, testInfo) => {
    // THE ABORT AUTHORITY HANDOFF PRODUCER, armed before anything can submit.
    //
    // This lane is the one that walks away from a live job on purpose, so nothing
    // downstream of it — no terminal state, no artifact, no BFF log line — carries the
    // accepted id. `docker/verify-stream.sh` audits the BFF log first and only then
    // releases that job, and it refuses to guess which one it is: the accepted ids have
    // to come from the attempt itself. This tracker is that causal source, and it is a
    // LOCAL binding on purpose — assigning the shared `acceptedTracker` would enlist the
    // suite's release hook, which would cancel the very job the shell must audit and
    // then own.
    const abortTracker = trackAcceptedJobs(page);
    const audited = auditTerminalExpect(testInfo, async () => {
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
      // both tokens satisfies — including one thrown a hundred lines earlier. The
      // sentinel gives the classifier a position it can trust: nothing that fails before
      // the assertion can print it.
      //
      // The assertion itself is GUARDED, which is the other half of that binding. The
      // reporter marks a failing expect step terminal only when the step owns the throw
      // site of a test-level error, and the classifier additionally requires the audit
      // mark this guard and the body wrapper leave behind — so neither a hand-thrown
      // error, nor a caught-and-rethrown copy of this matcher's own text, nor a
      // byte-identical reconstruction of its error can stand in for it.
      if (process.env.ASSEMBLED_SKIP_ABORT_NAVIGATION === "1") {
        process.stdout.write(`${ABORT_CONTROL_SENTINEL}\n`);
      }
      await guardTerminalExpect(() =>
        expect(page).toHaveURL(/\/about$/, { timeout: ABORT_BOUNDS.abortUrlSettle }),
      );
      // Let the BFF observe and log the upstream cancel before the gate reads its logs.
      await page.waitForTimeout(ABORT_BOUNDS.bffObservationTail);
    });

    // Settle the body WITHOUT catching-and-rethrowing a copy: this rejection handler
    // captures the escaped error OBJECT, and the rethrow below is that same object. The
    // audit wrapper has already written its mark by then, so the negative control's
    // object-identity binding is untouched.
    const bodyFailure = await audited.then(
      () => null,
      (error: unknown) => ({ error }),
    );

    // THE HANDOFF, published on BOTH paths. The gate is explicit that a valid handoff is
    // still cleaned up when Playwright failed — containment must not leak a live job —
    // so a red body is exactly when the shell most needs to know which job to release.
    // Bounded, because `drain()` spends its own internal windows and this runs inside
    // the test body's budget (`ABORT_BOUNDS.abortHandoffPublish`).
    let publishFailure: unknown = null;
    let publishNote = "";
    try {
      const drained = await withBound(
        "abort handoff drain",
        ABORT_BOUNDS.abortHandoffPublish,
        abortTracker.drain(),
      );
      // Dispose AFTER the drain and take its own report: detaching the listeners is the
      // instant an acceptance can be lost silently, and `judgeAbortOwnership` refuses to
      // publish anything at all when disposal stranded work.
      const disposal = abortTracker.dispose();
      publishNote = publishAbortHandoff({
        target: process.env[ABORT_HANDOFF_ENV],
        drained,
        disposal,
      }).note;
    } catch (error) {
      abortTracker.dispose();
      publishFailure = error;
      publishNote = error instanceof Error ? error.message : String(error);
    }
    await testInfo.attach("abort-handoff", { body: publishNote, contentType: "text/plain" });

    // The body's failure always wins; a publish failure only surfaces on an otherwise
    // green lane, where it is the difference between the shell owning this job and the
    // shell losing authority over it.
    if (bodyFailure !== null) throw bodyFailure.error;
    if (publishFailure !== null) throw publishFailure;
  });
});
