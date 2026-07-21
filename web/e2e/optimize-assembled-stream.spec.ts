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

const REPO_ROOT = resolve(__dirname, "../..");
const TINY_YAML = readFileSync(
  resolve(REPO_ROOT, "core/tests/testcases/basics/01_1nurse_1shift_1day.yaml"),
  "utf-8",
);
const LARGE_YAML = readFileSync(
  resolve(REPO_ROOT, "core/tests/testcases/real/large-ward-with-87-people-2025-11.yaml"),
  "utf-8",
);

const FIRST_BYTE_TIMEOUT = 15_000;
const COMPLETION_TIMEOUT = 90_000;
const KEEPALIVE_WINDOW = 12_000;
const REPLAY_SNAPSHOT_KEY = "nurse.optimize.e2e-replay-snapshot";

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
}

async function readSseObs(page: Page): Promise<SseObservations> {
  return page.evaluate(() => {
    const obs = (window as unknown as { __nsSseObs?: SseObservations }).__nsSseObs;
    return {
      sseResponseAt: obs?.sseResponseAt ?? null,
      sseFirstByteAt: obs?.sseFirstByteAt ?? null,
      sseChunks: obs?.sseChunks ?? [],
      eventLastEventIds: obs?.eventLastEventIds ?? [],
    };
  });
}

function rawSseIds(chunks: string[]): string[] {
  return Array.from(chunks.join("").matchAll(/^id:\s*(.+?)\r?$/gm), (match) => match[1]);
}

interface ReplaySnapshot {
  cursor: string | null;
  rawIds: string[];
}

/** Freeze the observation wrapper's current SSE body, allow already-delivered
 * frames to finish committing, then atomically capture cursor + raw IDs and
 * initiate reload. The e2e-only snapshot key is ignored by the application and
 * removed immediately after the new document reads it. */
async function captureReplaySnapshotAndReload(page: Page): Promise<ReplaySnapshot> {
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.evaluate(async (snapshotKey) => {
      const e2eWindow = window as unknown as {
        __nsFreezeSseForReplay?: () => Promise<unknown>;
        __nsSseObs?: SseObservations;
      };
      await e2eWindow.__nsFreezeSseForReplay?.();

      let cursor: string | null = null;
      let stableReads = 0;
      for (let attempt = 0; attempt < 20 && stableReads < 3; attempt += 1) {
        const rawSession = sessionStorage.getItem("nurse.optimize.session");
        let nextCursor: string | null = null;
        if (rawSession) {
          try {
            nextCursor = (JSON.parse(rawSession) as { lastCursor?: string }).lastCursor ?? null;
          } catch {
            nextCursor = null;
          }
        }
        stableReads = nextCursor !== null && nextCursor === cursor ? stableReads + 1 : 0;
        cursor = nextCursor;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const chunks = e2eWindow.__nsSseObs?.sseChunks ?? [];
      const rawIds = Array.from(
        chunks.join("").matchAll(/^id:\s*(.+?)\r?$/gm),
        (match) => match[1],
      );
      sessionStorage.setItem(snapshotKey, JSON.stringify({ cursor, rawIds }));
      window.location.reload();
    }, REPLAY_SNAPSHOT_KEY),
  ]);

  return page.evaluate((snapshotKey) => {
    const raw = sessionStorage.getItem(snapshotKey);
    sessionStorage.removeItem(snapshotKey);
    return raw ? (JSON.parse(raw) as ReplaySnapshot) : { cursor: null, rawIds: [] };
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

/** Read the persisted session cursor from sessionStorage (null if absent). */
async function readPersistedCursor(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem("nurse.optimize.session");
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as { lastCursor?: string }).lastCursor ?? null;
    } catch {
      return null;
    }
  });
}

test.describe("T16f assembled Browser → Next → FastAPI stream gate", () => {
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

    // Atomically preserve the exact durable cursor and every raw frame ID seen
    // before reload, then start reload in that same browser task.
    const { cursor: cursorBefore, rawIds: preReloadIds } =
      await captureReplaySnapshotAndReload(page);
    expect(cursorBefore).not.toBeNull();
    expect(cursorBefore!.length).toBeGreaterThan(0);
    expect(preReloadIds.length).toBeGreaterThan(0);
    expect(preReloadIds).toContain(cursorBefore);
    await expect(page.getByTestId("screen")).toBeVisible({ timeout: 10_000 });

    // The FIRST post-reload events request must present the exact cursor captured
    // above. A wrong, older, different, or null cursor fails.
    await expect
      .poll(async () => (await readSseObs(page)).eventLastEventIds[0], { timeout: 15_000 })
      .toBe(cursorBefore);

    const preReloadSet = new Set(preReloadIds);
    // Require raw post-reload evidence that contains no old ID, contains at
    // least one new ID, and has committed one of those exact new IDs durably.
    await expect
      .poll(
        async () => {
          const postReloadIds = rawSseIds((await readSseObs(page)).sseChunks);
          const persisted = await readPersistedCursor(page);
          return (
            postReloadIds.length > 0 &&
            postReloadIds.every((id) => !preReloadSet.has(id)) &&
            persisted !== null &&
            !preReloadSet.has(persisted) &&
            postReloadIds.includes(persisted)
          );
        },
        { timeout: 20_000, intervals: [500] },
      )
      .toBe(true);

    const postReloadObs = await readSseObs(page);
    const postReloadIds = rawSseIds(postReloadObs.sseChunks);
    const cursorAfter = await readPersistedCursor(page);
    expect(cursorAfter).not.toBeNull();
    expect(postReloadObs.eventLastEventIds[0]).toBe(cursorBefore);
    expect(postReloadIds.length).toBeGreaterThan(0);
    expect(postReloadIds.every((id) => !preReloadSet.has(id))).toBe(true);
    expect(postReloadIds).toContain(cursorAfter);
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
    if (process.env.ASSEMBLED_SKIP_ABORT_NAVIGATION !== "1") {
      await page.goto("/about");
    }
    await expect(page).toHaveURL(/\/about$/);
    await page.waitForTimeout(2_000);
  });
});
