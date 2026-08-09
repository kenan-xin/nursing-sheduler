// G5 — the ASSEMBLED real-Ward-8 roster journey.
//
// One continuous production session, start to finish, against the live direct
// Compose stack brought up by `make verify-stream`:
//
//   Save & Load file picker -> the exact unchanged Ward 8 YAML
//   -> the real scenario screens -> Optimize (one click) -> a real solve through
//   Browser -> Next BFF -> FastAPI -> Redis -> the real capture/download/cleanup
//   chain -> `Open & adjust roster` -> the production /roster route -> all three
//   lenses -> a UI edit, autosave, reload, undo -> two real browser downloads
//   -> a SECOND real solve that must not touch the roster on screen
//   -> New schedule -> a genuinely fresh origin.
//
// WHAT MAKES THIS DIFFERENT from `optimize-assembled-stream.spec.ts`: that spec
// drives the durable-stream FIXTURE page, because what it proves is the SSE
// protocol. This one is forbidden from using any fixture at all — no
// `page.route`, no stubbed response, no `/roster-viewer-fixture`, no seeded
// IndexedDB, no fabricated roster container. Every surface it touches is a route
// a user can reach, and every byte it asserts on came from the real backend.
//
// Storage is READ raw (`indexedDB.open`), never written and never driven. Asking
// the app's own storage module whether it stored something would be asking the
// code under test to grade itself; opening the database the way an inspector
// would is an independent observation.
//
// Run via: ASSEMBLED_BASE_URL=http://localhost:<port> pnpm exec playwright test
//          --config playwright.assembled.config.ts --grep "real Ward 8"

import { expect, test, type Download, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  auditCoverageAfterRelease,
  OPTIMIZE_SESSION_RECORD_KEY,
  recoverAcceptedOwnership,
  releaseLiveJobs,
  settleAcceptedOwnership,
  trackAcceptedJobs,
  judgeVolatileJobIdTexts,
  VOLATILE_JOB_ID_SELECTOR,
  type AcceptedJobTracker,
  type OwnershipSettlement,
} from "./support/optimize-durable";
import {
  isLoadableSolverStatus,
  judgeResidue,
  judgeResiduePresent,
  judgeReplacement,
  judgeWardDocument,
  judgeWardWorkbook,
  readWardDocumentFacts,
  readWardDocumentMatrices,
  readWardWorkbook,
  STORAGE_KEYS,
  wardDocumentDigest,
  WARD_BOUNDS,
  WARD_EXPECTED,
  WARD_EXPECTED_CALENDAR,
  WARD_EXPECTED_CELL_COUNT,
  WARD_SOLVER_TIMEOUT_SECONDS,
  WARD_TEST_TIMEOUT,
  WARD_YAML_PATH,
  type RosterResidueProbe,
  type WardWorkbookExpectation,
} from "./support/ward-journey";

// ---------------------------------------------------------------------------
// Raw storage observation
// ---------------------------------------------------------------------------

/**
 * Read every roster surface straight out of the browser.
 *
 * Deliberately a single evaluate: a probe split across calls could observe two
 * different moments and report a state that never existed. `crypto.subtle` is
 * required rather than optional — `localhost` is a secure context, and silently
 * skipping the digest would turn the byte-identity proof into a no-op.
 */
async function probeRosterStorage(page: Page): Promise<RosterResidueProbe> {
  return page.evaluate(async (keys) => {
    const probe = {
      databasePresent: false,
      working: null as RosterResidueProbe["working"],
      candidatePointer: null as RosterResidueProbe["candidatePointer"],
      candidateRowKeys: [] as string[],
      snapshotRowKeys: [] as string[],
      scenarioRecordPresent: false,
      optimizeSessionPresent: window.sessionStorage.getItem(keys.optimizeSessionKey) !== null,
      retireMarkerPresent: window.sessionStorage.getItem(keys.optimizeRetirePendingKey) !== null,
      viewMetadataPresent: window.localStorage.getItem(keys.rosterViewPreferenceKey) !== null,
    };

    if (typeof indexedDB.databases !== "function") {
      throw new Error("indexedDB.databases() is unavailable — storage cannot be observed");
    }
    const listed = await indexedDB.databases();
    probe.databasePresent = listed.some((entry) => entry.name === keys.databaseName);
    if (!probe.databasePresent) return probe;

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      // No explicit version: this attaches to whatever the app already created and
      // can never trigger an upgrade that would mutate the store under test.
      const request = indexedDB.open(keys.databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
      request.onblocked = () => reject(new Error("indexedDB open was blocked"));
    });

    const readAll = (storeName: string): Promise<Array<Record<string, unknown>>> =>
      new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(storeName)) {
          resolve([]);
          return;
        }
        const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
        request.onsuccess = () => resolve((request.result ?? []) as Array<Record<string, unknown>>);
        request.onerror = () => reject(request.error ?? new Error(`read ${storeName} failed`));
      });

    try {
      const [rosterRows, metaRows, snapshotRows, keyvalRows] = await Promise.all([
        readAll("roster"),
        readAll("meta"),
        readAll("snapshot"),
        readAll("keyval"),
      ]);

      probe.candidateRowKeys = rosterRows
        .map((row) => String(row.key))
        .filter((key) => key.startsWith(keys.candidateKeyPrefix))
        .sort();
      probe.snapshotRowKeys = snapshotRows
        .map((row) => String(row.key))
        .filter((key) => key.startsWith(keys.snapshotKeyPrefix))
        .sort();
      probe.scenarioRecordPresent = keyvalRows.some(
        (row) => String(row.key) === keys.scenarioPersistKey,
      );

      const pointerRow = metaRows.find((row) => String(row.key) === keys.currentCandidateMetaKey);
      const pointerValue = pointerRow?.value as
        | { jobId?: unknown; candidateVersion?: unknown }
        | null
        | undefined;
      if (
        pointerValue !== null &&
        pointerValue !== undefined &&
        typeof pointerValue.jobId === "string" &&
        typeof pointerValue.candidateVersion === "number"
      ) {
        probe.candidatePointer = {
          jobId: pointerValue.jobId,
          candidateVersion: pointerValue.candidateVersion,
        };
      }

      const workingRow = rosterRows.find((row) => String(row.key) === keys.workingRosterKey);
      if (workingRow !== undefined) {
        const document = workingRow.document as {
          frozenXlsx: Blob;
          edits: readonly unknown[];
        };
        // RAW MATERIAL ONLY. The page hands back the stored bytes; the digest and
        // every Ward-identity judgement are made in Node, where the unit suite can
        // drive the same functions with mutated inputs. A verdict computed in here
        // would be a claim nothing could contradict.
        const workbook = new Uint8Array(await document.frozenXlsx.arrayBuffer());
        let binary = "";
        for (let index = 0; index < workbook.byteLength; index += 1) {
          binary += String.fromCharCode(workbook[index]);
        }
        const source = workingRow.candidateSource as
          | { jobId: string; candidateVersion: number }
          | undefined;
        probe.working = {
          revision: Number(workingRow.revision),
          candidateSource: source ?? null,
          editCount: document.edits.length,
          documentJson: JSON.stringify(document, (key, value) =>
            key === "frozenXlsx" ? "<blob>" : value,
          ),
          workbookBase64: btoa(binary),
        };
      }
    } finally {
      db.close();
    }

    return probe;
  }, STORAGE_KEYS);
}

/**
 * Read ONE stored candidate row raw, so the material a Replace must promote is
 * known before the user confirms.
 *
 * Separate from `probeRosterStorage` on purpose: candidate payloads are large, and
 * the journey needs exactly one of them at exactly one moment.
 */
async function probeCandidateDocument(
  page: Page,
  jobId: string,
): Promise<{ rowRevision: number; documentJson: string; workbookBase64: string } | null> {
  return page.evaluate(
    async ({ keys, targetJobId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(keys.databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
        request.onblocked = () => reject(new Error("indexedDB open was blocked"));
      });
      try {
        const row = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
          const request = db
            .transaction("roster", "readonly")
            .objectStore("roster")
            .get(`${keys.candidateKeyPrefix}${targetJobId}`);
          request.onsuccess = () => resolve(request.result as Record<string, unknown> | undefined);
          request.onerror = () => reject(request.error ?? new Error("candidate read failed"));
        });
        if (row === undefined) return null;
        const document = row.document as { frozenXlsx: Blob };
        const workbook = new Uint8Array(await document.frozenXlsx.arrayBuffer());
        let binary = "";
        for (let index = 0; index < workbook.byteLength; index += 1) {
          binary += String.fromCharCode(workbook[index]);
        }
        return {
          rowRevision: Number(row.revision),
          documentJson: JSON.stringify(document, (key, value) =>
            key === "frozenXlsx" ? "<blob>" : value,
          ),
          workbookBase64: btoa(binary),
        };
      } finally {
        db.close();
      }
    },
    { keys: STORAGE_KEYS, targetJobId: jobId },
  );
}

// ---------------------------------------------------------------------------
// Small journey helpers
// ---------------------------------------------------------------------------

/** A browser download, read back so "a file was produced" means real bytes. */
interface CapturedDownload {
  filename: string;
  bytes: Buffer;
}

/**
 * Read a download to bytes and remove the artifact.
 *
 * The delete is not tidiness — the gate's residue audit counts leftover download
 * artifacts, and a journey that produces four real files must not be the reason
 * the audit fails.
 */
async function consumeDownload(download: Download): Promise<CapturedDownload> {
  const path = await download.path();
  if (path === null) throw new Error("the browser download produced no file on disk");
  const bytes = readFileSync(path);
  const filename = download.suggestedFilename();
  await download.delete();
  return { filename, bytes };
}

/**
 * Parse a workbook with the project's own parser and judge it as Ward 8's.
 *
 * This replaces a four-byte ZIP-magic check. Magic bytes prove a container, not a
 * workbook and certainly not this ward's: a truncated or unrelated archive passed
 * that check happily. `readWardWorkbook` fails closed and `judgeWardWorkbook` names
 * every structural or content mismatch, and the unit suite drives both against a
 * genuinely valid non-workbook ZIP.
 */
async function expectWardWorkbook(
  label: string,
  bytes: Buffer,
  expectation: WardWorkbookExpectation = {},
): Promise<void> {
  const parsed = await readWardWorkbook(bytes);
  expect(parsed.ok, `${label}: ${parsed.ok ? "" : parsed.reason}`).toBe(true);
  if (!parsed.ok) return;
  const verdict = judgeWardWorkbook(parsed.facts, expectation);
  expect(verdict.problems, `${label} is not the Ward 8 schedule`).toEqual([]);
}

/**
 * The workbook text for a viewer chip label. A rest day is a blank cell (the edit
 * patcher writes `""`); leave and worked shifts write their label verbatim.
 */
function workbookTextFor(chipLabel: string): string {
  return chipLabel === "Off" ? "" : chipLabel;
}

/** The aria-label a roster chip carries: the shift id, or `Off` / `Leave`. */
async function readCellState(page: Page, cellIndex: number): Promise<string> {
  const label = await page
    .getByTestId("roster-grid")
    .locator('td[role="button"]')
    .nth(cellIndex)
    .locator("span")
    .first()
    .getAttribute("aria-label");
  if (label === null) throw new Error(`roster cell ${cellIndex} rendered no chip`);
  return label;
}

/** Open the edit bar on one grid cell. */
async function selectCell(page: Page, cellIndex: number, timeout: number): Promise<void> {
  await page.getByTestId("roster-grid").locator('td[role="button"]').nth(cellIndex).click({
    timeout,
  });
  await expect(page.getByTestId("roster-edit-bar")).toBeVisible({ timeout });
}

/** Reach the production Optimize route with the backend online and submit armed. */
async function gotoArmedOptimize(page: Page): Promise<void> {
  await page.goto("/optimize-and-export", { timeout: WARD_BOUNDS.optimizeReady });
  await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "Optimize and Export", {
    timeout: WARD_BOUNDS.optimizeReady,
  });
  await expect(page.getByTestId("optimize-submit")).toBeEnabled({
    timeout: WARD_BOUNDS.optimizeReady,
  });
}

/** Reach the production /roster route. */
async function gotoRoster(page: Page): Promise<void> {
  await page.goto("/roster", { timeout: WARD_BOUNDS.rosterNavigation });
  await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "Roster", {
    timeout: WARD_BOUNDS.rosterNavigation,
  });
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

test.describe("G5 assembled real Ward 8 roster journey", () => {
  // The same ownership contract the sibling assembled spec documents at length:
  // a Node-side tracker armed before every submit, drained and settled in an
  // `afterEach` (which Playwright still runs for an abandoned, timed-out body),
  // so a failure mid-journey cannot leave a real solve burning the host.
  //
  // On the SUCCESS path the product releases both jobs itself — the terminal
  // auto-chain DELETEs, which this journey asserts — so the hook then takes the
  // documented idempotent 404 branch and the coverage audit exempts
  // tracker-observed ids for exactly that reason.
  let acceptedTracker: AcceptedJobTracker | null = null;

  test.afterEach(async ({ page, request }, testInfo) => {
    const tracker = acceptedTracker;
    acceptedTracker = null;
    let jobIds: string[] = [];
    let settlement: OwnershipSettlement | null = null;
    let trackerStats = { started: 0, unaccounted: 0 };

    if (tracker !== null) {
      const drained = await tracker.drain();
      trackerStats = tracker.stats();
      // The page's own session record and the rendered job id are independent
      // authorities, consulted ONLY when the tracker fell short — the failures
      // that defeat a CDP-response tracker leave both intact.
      const recovery = drained.resolved
        ? null
        : await recoverAcceptedOwnership({
            readSessionRecord: () =>
              page.evaluate(
                (key) => window.sessionStorage.getItem(key),
                OPTIMIZE_SESSION_RECORD_KEY,
              ),
            readVolatileJobIds: () =>
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
          });
      settlement = settleAcceptedOwnership(drained, recovery, tracker.dispose());
      jobIds = settlement.ids;
    }

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
    const coverageAudit =
      settlement === null
        ? { ok: true, failures: [] as string[] }
        : auditCoverageAfterRelease(settlement, outcome);

    const report = [
      `armed jobs: ${jobIds.length === 0 ? "(none)" : jobIds.join(", ")}`,
      `tracker: ${trackerStats.started} acceptance(s), ${trackerStats.unaccounted} unaccounted`,
      ...(settlement?.notes ?? []),
      ...outcome.steps,
      ...(settlement?.failures ?? []),
      ...outcome.failures,
      ...coverageAudit.failures,
    ].join("\n");
    await testInfo.attach("ward-journey-job-cleanup", { body: report, contentType: "text/plain" });

    if (outcome.ok && (settlement?.failures ?? []).length === 0 && coverageAudit.ok) return;
    // Never replace the primary failure; but an unreleased job on an otherwise
    // passing journey would starve whatever runs next, so it fails the gate.
    if (testInfo.status === testInfo.expectedStatus) {
      throw new Error(`ward-journey job cleanup did not converge:\n${report}`);
    }
  });

  test("the real Ward 8 scenario runs the whole roster journey end to end", async ({ page }) => {
    // The journey's own ceiling, derived in `WARD_BOUNDS` from every sequential
    // bound it spends. Two real solves could never fit Playwright's 30s default.
    test.setTimeout(WARD_TEST_TIMEOUT);

    // OBSERVATION ONLY. Nothing here modifies a request or a response — there is
    // no `page.route` anywhere in this file, which is what "no interception"
    // means, and these recorders are how the assembled path is evidenced.
    const downloads: Download[] = [];
    page.on("download", (download) => downloads.push(download));
    let downloadCursor = 0;
    const nextDownload = async (timeout: number): Promise<CapturedDownload> => {
      await expect.poll(() => downloads.length, { timeout }).toBeGreaterThan(downloadCursor);
      const download = downloads[downloadCursor];
      downloadCursor += 1;
      return consumeDownload(download);
    };

    // A STRUCTURAL CONTROL over the "no fixture page" contract. Grepping this file
    // proves no fixture is referenced today; recording every URL the main frame
    // actually committed proves it for the run, so a future edit that reaches for
    // a fixture route fails here instead of quietly weakening what is qualified.
    const visitedUrls: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) visitedUrls.push(frame.url());
    });

    const apiCalls: Array<{ line: string; fromServiceWorker: boolean }> = [];
    // A holder rather than a bare `let`: the value is written from a listener, and
    // the read below must not be narrowed to the initializer.
    const submitTransport: {
      observed: boolean;
      originPort: string;
      remote: { ipAddress: string; port: number } | null;
    } = { observed: false, originPort: "", remote: null };
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith("/api/")) return;
      const method = response.request().method();
      apiCalls.push({
        line: `${method} ${url.pathname} ${response.status()}`,
        fromServiceWorker: response.fromServiceWorker(),
      });
      if (method === "POST" && url.pathname === "/api/optimize" && !submitTransport.observed) {
        submitTransport.observed = true;
        submitTransport.originPort = url.port;
        void response
          .serverAddr()
          .then((addr) => {
            submitTransport.remote = addr;
          })
          .catch(() => {});
      }
    });

    // -------------------------------------------------------------------
    // 1. Import the exact file through the real Save & Load picker.
    // -------------------------------------------------------------------
    await test.step("import the Ward 8 YAML through the Save & Load file picker", async () => {
      await page.goto("/save-and-load", { timeout: WARD_BOUNDS.saveAndLoadReady });
      // The hydration gate renders a skeleton until the durable store is ready, so
      // the card being on screen IS the hydration signal — no store seam needed.
      await expect(page.getByTestId("scenario-file-card")).toBeVisible({
        timeout: WARD_BOUNDS.saveAndLoadReady,
      });

      await page.getByTestId("scenario-upload-button").click({ timeout: WARD_BOUNDS.importFile });
      await expect(page.getByTestId("upload-modal")).toBeVisible({
        timeout: WARD_BOUNDS.importFile,
      });
      // THE FILE ITSELF, by path — Playwright reads the bytes off disk, so the
      // browser receives the authoritative scenario rather than a re-serialized
      // copy of it.
      await page.getByTestId("upload-file-input").setInputFiles(WARD_YAML_PATH);

      // The scenario carries no `appVersion`, so the version gate is on the real
      // path. Asserting it (rather than tolerating either branch) keeps the import
      // deterministic: a file that started declaring a version would fail here
      // instead of silently taking a different route.
      await expect(page.getByTestId("confirm-dialog-confirm")).toBeVisible({
        timeout: WARD_BOUNDS.importFile,
      });
      await expect(page.getByText(/does not contain app version information/i)).toBeVisible({
        timeout: WARD_BOUNDS.importFile,
      });
      await page.getByTestId("confirm-dialog-confirm").click({ timeout: WARD_BOUNDS.importFile });
      await expect(page.getByTestId("confirm-dialog-confirm")).toHaveCount(0, {
        timeout: WARD_BOUNDS.importFile,
      });
    });

    // -------------------------------------------------------------------
    // 2. The imported scenario is VISIBLY Ward 8.
    // -------------------------------------------------------------------
    await test.step("the imported scenario is visibly the Ward 8 roster", async () => {
      const bound = WARD_BOUNDS.scenarioFacts;
      await page.goto("/dates", { timeout: bound });
      await expect(page.getByTestId("range-start")).toHaveValue(WARD_EXPECTED.startDate, {
        timeout: bound,
      });
      await expect(page.getByTestId("range-end")).toHaveValue(WARD_EXPECTED.endDate, {
        timeout: bound,
      });
      await expect(page.getByTestId("range-duration")).toHaveText(
        `${WARD_EXPECTED.dayCount} days`,
        { timeout: bound },
      );

      await page.goto("/people", { timeout: bound });
      await expect(page.getByTestId("people-count")).toContainText(
        String(WARD_EXPECTED.peopleCount),
        { timeout: bound },
      );

      await page.goto("/shift-types", { timeout: bound });
      await expect(page.getByTestId("shift-grid")).toBeVisible({ timeout: bound });
      // `allTextContents` and not `allInnerTexts`: the code is rendered through a
      // CSS `uppercase`, and innerText would return the transformed glyphs, which
      // would quietly compare `AM1+` against the authored `am1+`.
      const shiftCodes = await page.locator('[data-testid^="shift-code-"]').allTextContents();
      expect(shiftCodes.map((code) => code.trim()).sort()).toEqual(
        [...WARD_EXPECTED.shiftTypeIds].sort(),
      );
    });

    // -------------------------------------------------------------------
    // 3. One real optimisation, from an origin whose working slot is EMPTY.
    // -------------------------------------------------------------------
    await gotoArmedOptimize(page);

    await test.step("the run screen agrees the scenario is Ward 8", async () => {
      const bound = WARD_BOUNDS.scenarioFacts;
      const statValue = (testId: string) => page.getByTestId(testId).locator("div").first();
      await expect(statValue("optimize-stat-nurses")).toHaveText(
        String(WARD_EXPECTED.peopleCount),
        { timeout: bound },
      );
      await expect(statValue("optimize-stat-days")).toHaveText(String(WARD_EXPECTED.dayCount), {
        timeout: bound,
      });
      await expect(statValue("optimize-stat-shifts")).toHaveText(
        String(WARD_EXPECTED.shiftTypeIds.length),
        { timeout: bound },
      );
    });

    // THE ACCEPTING PRE-STATE for "a first result fills only a PROVEN-empty slot".
    // Without it, "the working roster now exists" would be compatible with a
    // working roster that was already there.
    const beforeFirstRun = await probeRosterStorage(page);
    expect(beforeFirstRun.working, "the working slot starts genuinely empty").toBeNull();
    expect(beforeFirstRun.candidatePointer).toBeNull();
    expect(beforeFirstRun.candidateRowKeys).toEqual([]);

    /** Held so each workbook can be judged against the document it belongs to. */
    let runAArtifact: CapturedDownload | null = null;
    let runBArtifact: CapturedDownload | null = null;

    let jobA = "";
    await test.step("click the exact primary Optimize action, once", async () => {
      // A bounded run limit, typed into the real field. The job cannot outlive it,
      // which is what makes `completionPoll` a ceiling rather than a wish.
      await page.locator("#optimize-timeout").fill(String(WARD_SOLVER_TIMEOUT_SECONDS));
      const submit = page.getByTestId("optimize-submit");
      await expect(submit).toHaveText("Optimize");

      acceptedTracker = trackAcceptedJobs(page);
      await submit.click({ timeout: WARD_BOUNDS.submitClick });

      await expect
        .poll(() => acceptedTracker?.ids().length ?? 0, {
          timeout: WARD_BOUNDS.acceptedIdPoll,
        })
        .toBe(1);
      jobA = acceptedTracker!.ids()[0];
      expect(jobA).not.toBe("");
    });

    await test.step("the real run reaches a loadable completion with a real XLSX", async () => {
      await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
        "downloaded successfully",
        { timeout: WARD_BOUNDS.completionPoll },
      );
      // A real terminal result, not one exact nondeterministic schedule.
      const solverStatus = await page.getByTestId("optimize-summary-solver-status").textContent();
      expect(
        isLoadableSolverStatus(solverStatus),
        `solver status was ${JSON.stringify(solverStatus)}`,
      ).toBe(true);
      await expect(page.getByTestId("optimize-summary-final-score")).not.toHaveText("—");

      runAArtifact = await nextDownload(WARD_BOUNDS.completionPoll);
      expect(runAArtifact.filename).toMatch(/\.xlsx$/);

      // The capture committed, so the product may claim a roster exists.
      await expect(page.getByTestId("optimize-capture-committed")).toBeVisible();
      await expect(page.getByTestId("optimize-open-roster")).toBeVisible();
      // The release DELETE freed the single slot: a second run is permitted.
      await expect(page.getByTestId("optimize-submit")).toBeEnabled({
        timeout: WARD_BOUNDS.slotFreedAssertion,
      });
      // Still exactly one acceptance — one click produced one job.
      expect(acceptedTracker!.ids()).toEqual([jobA]);
    });

    await test.step("the browser really talked to the assembled backend", async () => {
      const lines = apiCalls.map((call) => call.line);
      expect(lines).toContain("POST /api/optimize 202");
      expect(lines).toContain(`GET /api/optimize/${jobA}/events 200`);
      expect(lines).toContain(`GET /api/optimize/${jobA}/roster 200`);
      expect(lines).toContain(`GET /api/optimize/${jobA}/xlsx 200`);
      expect(lines).toContain(`DELETE /api/optimize/${jobA} 204`);
      // The streamed lifecycle reached the screen, not just the wire.
      await expect(page.getByTestId("optimize-event-count")).not.toHaveText("0");
      // Nothing was served by a worker standing in for the network, and the
      // submission reached a real socket on the published assembled port.
      expect(apiCalls.every((call) => !call.fromServiceWorker)).toBe(true);
      await expect
        .poll(() => submitTransport.remote, { timeout: WARD_BOUNDS.acceptedIdPoll })
        .not.toBeNull();
      // The submission crossed a real socket to the published assembled port — the
      // thing an intercepted or locally-fulfilled request could not produce.
      // Unconditional: the assembled base URL always names an explicit port, so a
      // missing one is a broken harness to report, not a check to skip.
      expect(submitTransport.originPort, "the assembled origin names a port").not.toBe("");
      expect(submitTransport.remote?.port).toBe(Number(submitTransport.originPort));
    });

    const afterFirstRun = await probeRosterStorage(page);
    await test.step("the first result filled the proven-empty working slot", () => {
      expect(afterFirstRun.working, "the empty slot was filled").not.toBeNull();
      expect(afterFirstRun.working!.candidateSource).toEqual({
        jobId: jobA,
        candidateVersion: afterFirstRun.candidatePointer!.candidateVersion,
      });
      expect(afterFirstRun.working!.editCount).toBe(0);
      expect(afterFirstRun.candidatePointer?.jobId).toBe(jobA);
    });

    await test.step("run A's workbook carries the roster that was captured", async () => {
      // CONTENT PARITY, not vocabulary. A workbook whose 896 cells were blank, or
      // swapped for other perfectly valid ward shifts, satisfied every axis and
      // every allowed value — it just was not the roster that was solved. The two
      // real authorities now have to agree, cell for cell, on whichever schedule
      // the solver actually produced.
      const matrices = readWardDocumentMatrices(JSON.parse(afterFirstRun.working!.documentJson));
      await expectWardWorkbook("run A's downloaded artifact", runAArtifact!.bytes, {
        matrix: matrices.solved,
      });
    });

    await test.step("the captured roster IS Ward 8, not merely 32 x 28", () => {
      // Lengths are not identity. A capture regression producing a different
      // 32 x 28 calendar, or restoring the wrong person into a row, satisfies every
      // count the viewer can render — so the axes are compared element by element.
      const facts = readWardDocumentFacts(JSON.parse(afterFirstRun.working!.documentJson));
      expect(judgeWardDocument(facts).problems, "the captured document is Ward 8").toEqual([]);
      expect(facts.calendarIsos[0]).toBe("2026-10-01");
      expect(facts.calendarIsos[facts.calendarIsos.length - 1]).toBe("2026-10-28");
      expect(facts.peopleIds).toEqual([...WARD_EXPECTED.peopleIds]);
    });

    // -------------------------------------------------------------------
    // 4. The CTA opens an ALREADY-LOADED roster: no Load click anywhere.
    // -------------------------------------------------------------------
    await test.step("Open & adjust roster reaches a roster that is already loaded", async () => {
      await page.getByTestId("optimize-open-roster").click({
        timeout: WARD_BOUNDS.rosterNavigation,
      });
      await expect(page).toHaveURL(/\/roster$/, { timeout: WARD_BOUNDS.rosterNavigation });
      await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "Roster");
      await expect(page.getByTestId("roster-viewer")).toBeVisible({
        timeout: WARD_BOUNDS.rosterLoaded,
      });
      await expect(page.getByTestId("roster-grid")).toBeVisible();
      // The roster on screen IS this candidate, so there is nothing to offer:
      // no Load control was clicked, and none is presented.
      await expect(page.getByTestId("roster-candidate-available")).toHaveCount(0);
      await expect(page.getByTestId("roster-section-empty")).toHaveCount(0);
    });

    // -------------------------------------------------------------------
    // 5. Structural and semantic invariants across all three lenses.
    // -------------------------------------------------------------------
    await test.step("Grid, Coverage and Day all render the real 32 x 28 document", async () => {
      const bound = WARD_BOUNDS.lensAssertions;
      const grid = page.getByTestId("roster-grid");
      await expect(grid.locator('th[scope="row"]')).toHaveCount(WARD_EXPECTED.peopleCount, {
        timeout: bound,
      });
      await expect(grid.locator('td[role="button"]')).toHaveCount(WARD_EXPECTED_CELL_COUNT, {
        timeout: bound,
      });
      // IDENTITY on screen, not just cardinality: the row headers are the authored
      // Ward 8 nurses, in order, de-anonymised back from the `P#` that went on the
      // wire. The avatar initials are `aria-hidden`, so the name span is the label.
      const rowHeaders = await grid
        .locator('th[scope="row"] span:not([aria-hidden="true"])')
        .allTextContents();
      expect(rowHeaders.map((text) => text.trim())).toEqual([...WARD_EXPECTED.peopleIds]);

      // Solver provenance, rendered "as solved".
      const provenance = page.getByTestId("roster-provenance");
      await expect(provenance).toBeVisible();
      expect(isLoadableSolverStatus(await provenance.locator("span").first().textContent())).toBe(
        true,
      );
      await expect(provenance).toContainText("as solved");

      // COVERAGE AS THIS SCENARIO DEFINES IT — which is not per shift type.
      //
      // Ward 8 sets staffing for a PART OF THE DAY: every headcount requirement is
      // scoped to a shift-type GROUP (`AllMornings`, `AllNights`, ...), and the two
      // that do name a single pattern (`long+`, `night+`) are scoped to
      // `qualifiedPeople: [SeniorStaffNurses]`. `buildBaselineMinimums` excludes
      // both shapes by design — a group requirement is one aggregate equation
      // across its members, and a qualification-scoped one counts only qualified
      // people — so neither is a per-shift headcount minimum.
      //
      // So the honest answer here is that there is no baseline to check against,
      // and the summary says exactly that instead of claiming an all-clear it
      // cannot support. Asserting the EXACT string is the discriminating half: if
      // the derivation ever started inventing per-shift minimums out of group
      // requirements, this fails and the claim gets re-examined rather than
      // silently widening.
      await expect(page.getByTestId("roster-coverage-summary")).toHaveText("Coverage unavailable");

      await page.getByTestId("roster-lens-coverage").click({ timeout: bound });
      const coverage = page
        .getByTestId("roster-coverage-wide")
        .or(page.getByTestId("roster-coverage-stacked"));
      await expect(coverage).toBeVisible({ timeout: bound });
      // The lens still renders the real document: one lane per Ward 8 pattern.
      for (const shiftId of WARD_EXPECTED.shiftTypeIds) {
        await expect(coverage.getByText(shiftId, { exact: true }).first()).toBeVisible({
          timeout: bound,
        });
      }

      await page.getByTestId("roster-lens-day").click({ timeout: bound });
      await expect(page.getByTestId("roster-day")).toBeVisible({ timeout: bound });
      // One tab per day of the real span. SCOPED to the day lens: the app shell
      // also renders a tablist (the Guided/Advanced mode toggle), so an unscoped
      // role query counts its tabs too.
      await expect(page.getByTestId("roster-day").getByRole("tab")).toHaveCount(
        WARD_EXPECTED.dayCount,
        { timeout: bound },
      );

      await page.getByTestId("roster-lens-grid").click({ timeout: bound });
      await expect(grid).toBeVisible({ timeout: bound });
    });

    // -------------------------------------------------------------------
    // 6. One legitimate edit: autosave, reload durability, undo.
    // -------------------------------------------------------------------
    const solvedState = await readCellState(page, 0);
    // A nurse taking the day off is a legitimate roster adjustment; if the solver
    // already gave them the day off, give them the ward's first morning instead.
    const editedState = solvedState === "Off" ? WARD_EXPECTED.shiftTypeIds[0] : "Off";
    const editedOption = editedState === "Off" ? "OFF" : editedState;

    await test.step("a UI edit autosaves and survives a full reload", async () => {
      const bound = WARD_BOUNDS.editAndSave;
      await selectCell(page, 0, bound);
      // The bar offers exactly this ward's shifts plus rest and leave — the edit
      // vocabulary is the real scenario's, not a fixture's.
      const options = await page
        .getByTestId("roster-edit-bar")
        .locator("button[data-testid^=roster-edit-option-]")
        .allTextContents();
      expect(options.map((label) => label.trim()).sort()).toEqual(
        [...WARD_EXPECTED.shiftTypeIds, "OFF", "LV"].sort(),
      );

      await page.getByTestId(`roster-edit-option-${editedOption}`).click({ timeout: bound });
      await expect.poll(() => readCellState(page, 0), { timeout: bound }).toBe(editedState);
      await expect(page.getByTestId("roster-save-saved")).toBeVisible({ timeout: bound });
      await expect(page.getByTestId("roster-provenance")).toContainText("edited since solve");

      await page.reload({ timeout: WARD_BOUNDS.reloadDurability });
      await expect(page.getByTestId("roster-grid")).toBeVisible({
        timeout: WARD_BOUNDS.reloadDurability,
      });
      expect(await readCellState(page, 0), "the edit survived the reload").toBe(editedState);
      await expect(page.getByTestId("roster-save-failed")).toHaveCount(0);
      // Undo is session-scoped, so a fresh document has nothing to undo. That is
      // also the negative control for the undo assertion below.
      await expect(page.getByTestId("roster-undo")).toBeDisabled();
    });

    await test.step("undo restores the roster to the saved edit", async () => {
      const bound = WARD_BOUNDS.undoRestore;
      const secondOption = editedState === "Off" ? WARD_EXPECTED.shiftTypeIds[1] : "OFF";
      const secondState = secondOption === "OFF" ? "Off" : secondOption;
      await selectCell(page, 0, bound);
      await page.getByTestId(`roster-edit-option-${secondOption}`).click({ timeout: bound });
      await expect.poll(() => readCellState(page, 0), { timeout: bound }).toBe(secondState);

      const undo = page.getByTestId("roster-undo");
      await expect(undo).toBeEnabled({ timeout: bound });
      await undo.click({ timeout: bound });
      await expect.poll(() => readCellState(page, 0), { timeout: bound }).toBe(editedState);
      await expect(page.getByTestId("roster-save-saved")).toBeVisible({ timeout: bound });
      await expect(undo).toBeDisabled({ timeout: bound });
    });

    // -------------------------------------------------------------------
    // 7. Both exports produce real browser downloads.
    // -------------------------------------------------------------------
    await test.step("roster-file and edited-XLSX exports download real files", async () => {
      const bound = WARD_BOUNDS.exportDownloads;
      await page.getByTestId("roster-export-file").click({ timeout: bound });
      const rosterFile = await nextDownload(bound);
      expect(rosterFile.filename).toMatch(
        new RegExp(`^roster-${WARD_EXPECTED.startDate}-[0-9a-f]{8}\\.nurse-roster\\.json$`),
      );
      const decoded = JSON.parse(rosterFile.bytes.toString("utf-8")) as {
        schemaVersion: string;
        context: { people: unknown[]; calendar: unknown[] };
        edits: unknown[];
        frozenXlsx: { base64: string };
      };
      expect(decoded.schemaVersion).toBe("roster-file/1");
      // The EXPORT is Ward 8 too, element by element — not merely 32-and-28 long.
      const exportedFacts = readWardDocumentFacts(decoded);
      expect(judgeWardDocument(exportedFacts).problems, "the export is Ward 8").toEqual([]);
      expect(exportedFacts.calendarIsos).toEqual([...WARD_EXPECTED_CALENDAR]);
      // The exported file carries the edit, not just the solved baseline.
      expect(decoded.edits).toHaveLength(1);

      // The EMBEDDED frozen workbook is the immutable baseline: it must parse as
      // this ward's schedule and must still hold the SOLVED value at the edited
      // coordinate. That pairs with the edited export below to prove the document
      // really does keep baseline and overlay apart.
      const exportedMatrices = readWardDocumentMatrices(decoded);
      await expectWardWorkbook(
        "the roster file's embedded frozen workbook",
        Buffer.from(decoded.frozenXlsx.base64, "base64"),
        {
          matrix: exportedMatrices.solved,
          expectCell: { personIdx: 0, dateIdx: 0, text: workbookTextFor(solvedState) },
        },
      );

      await page.getByTestId("roster-export-xlsx").click({ timeout: bound });
      const editedWorkbook = await nextDownload(bound);
      expect(editedWorkbook.filename).toBe(`roster-${WARD_EXPECTED.startDate}-edited.xlsx`);
      // The edited export is judged against the CURRENT matrix — solve plus overlay,
      // derived with the product's own `deriveCurrentDays` — while the frozen
      // workbook above is judged against the solved baseline. Two matrices, two
      // workbooks, one document: that pair is what proves the overlay is applied on
      // export and nowhere else.
      await expectWardWorkbook("the edited XLSX export", editedWorkbook.bytes, {
        requireProvenanceSheet: true,
        matrix: exportedMatrices.current,
        expectCell: { personIdx: 0, dateIdx: 0, text: workbookTextFor(editedState) },
      });
      // ...and the two matrices really do differ, so that pairing is not vacuous.
      expect(exportedMatrices.current).not.toEqual(exportedMatrices.solved);
      await expect(page.getByTestId("roster-action-error")).toHaveCount(0);
    });

    await test.step("a reload still finds the working roster, with no fixture help", async () => {
      await gotoRoster(page);
      await expect(page.getByTestId("roster-viewer")).toBeVisible({
        timeout: WARD_BOUNDS.rosterLoaded,
      });
      expect(await readCellState(page, 0)).toBe(editedState);
    });

    // -------------------------------------------------------------------
    // 8. A SECOND real run must not touch the roster on screen.
    // -------------------------------------------------------------------
    const beforeSecondRun = await probeRosterStorage(page);
    expect(beforeSecondRun.working, "a working roster exists to be protected").not.toBeNull();
    expect(beforeSecondRun.working!.editCount).toBe(1);
    const preserved = beforeSecondRun.working!;
    // CONTENT ONLY — no revision, no row metadata. Confirmed replacement is already
    // required to bump the revision, so a digest that included it could not fail
    // even if the document bytes were untouched.
    const preservedDigest = wardDocumentDigest(preserved);
    const candidateVersionA = beforeSecondRun.candidatePointer!.candidateVersion;

    let jobB = "";
    /** Candidate B's exact durable pointer, captured before any Replace. */
    let candidateB: { jobId: string; candidateVersion: number } | null = null;
    /** ...and the content digest of the payload that pointer names. */
    let candidateBDigest = "";
    await test.step("run the same real optimisation again", async () => {
      await gotoArmedOptimize(page);
      await page.locator("#optimize-timeout").fill(String(WARD_SOLVER_TIMEOUT_SECONDS));
      await page.getByTestId("optimize-submit").click({ timeout: WARD_BOUNDS.secondSubmitClick });
      // The previous run's terminal panel must be GONE before the completion wait,
      // or that wait could be satisfied by the first run's own success text.
      await expect(page.getByTestId("optimize-completed-artifact")).toHaveCount(0, {
        timeout: WARD_BOUNDS.secondAcceptedIdPoll,
      });

      await expect
        .poll(() => acceptedTracker?.ids().length ?? 0, {
          timeout: WARD_BOUNDS.secondAcceptedIdPoll,
        })
        .toBe(2);
      jobB = acceptedTracker!.ids()[1];
      expect(jobB).not.toBe(jobA);

      await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
        "downloaded successfully",
        { timeout: WARD_BOUNDS.secondCompletionPoll },
      );
      runBArtifact = await nextDownload(WARD_BOUNDS.secondCompletionPoll);
      await expect(page.getByTestId("optimize-capture-committed")).toBeVisible();
    });

    await test.step("the working roster and its edit are untouched by the new result", async () => {
      const afterSecondRun = await probeRosterStorage(page);
      // DISCRIMINATING: the candidate genuinely moved on, so "unchanged" is not
      // because nothing happened.
      expect(afterSecondRun.candidatePointer?.jobId).toBe(jobB);
      expect(afterSecondRun.candidatePointer!.candidateVersion).toBeGreaterThan(candidateVersionA);
      // The EXACT pair the user will later choose to load. Pinned now, before any
      // Replace, so the post-replacement source cannot be graded against itself.
      candidateB = afterSecondRun.candidatePointer;

      // READ THE CANDIDATE ITSELF, before anything is promoted. Knowing the exact
      // bytes the user is about to choose is what turns the later check from “the
      // roster changed” into “the roster IS that candidate” — an oracle that holds
      // even when two honest solves of the same scenario coincide.
      const storedCandidate = await probeCandidateDocument(page, jobB);
      expect(storedCandidate, "candidate B is on disk").not.toBeNull();
      // The row's own version and the durable pointer must name the same capture.
      expect(storedCandidate!.rowRevision).toBe(candidateB!.candidateVersion);
      candidateBDigest = wardDocumentDigest(storedCandidate!);
      const candidateDocument = JSON.parse(storedCandidate!.documentJson) as unknown;
      expect(
        judgeWardDocument(readWardDocumentFacts(candidateDocument)).problems,
        "candidate B is Ward 8",
      ).toEqual([]);
      await expectWardWorkbook("run B's downloaded artifact", runBArtifact!.bytes, {
        matrix: readWardDocumentMatrices(candidateDocument).solved,
      });

      expect(wardDocumentDigest(afterSecondRun.working!)).toBe(preservedDigest);
      expect(afterSecondRun.working!.revision).toBe(preserved.revision);
      expect(afterSecondRun.working!.editCount).toBe(1);
      expect(afterSecondRun.working!.candidateSource).toEqual(preserved.candidateSource);
    });

    await test.step("the new result waits as a candidate, and cancelling preserves the roster", async () => {
      await gotoRoster(page);
      await expect(page.getByTestId("roster-candidate-available")).toBeVisible({
        timeout: WARD_BOUNDS.candidateOffer,
      });
      // With a roster on screen the offer is a REPLACEMENT, and it says so.
      await expect(page.getByTestId("roster-candidate-load")).toHaveText("Replace roster");
      await expect(page.getByTestId("roster-viewer")).toBeVisible();
      expect(await readCellState(page, 0)).toBe(editedState);

      await page.getByTestId("roster-candidate-load").click({
        timeout: WARD_BOUNDS.replaceCancelled,
      });
      await expect(page.getByTestId("confirm-dialog-cancel")).toBeVisible({
        timeout: WARD_BOUNDS.replaceCancelled,
      });
      await page.getByTestId("confirm-dialog-cancel").click();
      await expect(page.getByTestId("confirm-dialog-cancel")).toHaveCount(0, {
        timeout: WARD_BOUNDS.replaceCancelled,
      });

      const afterCancel = await probeRosterStorage(page);
      // The ACCEPTING control for the digest: unchanged content hashes the same, so
      // the "changed" assertion after the confirmed Replace means something.
      expect(wardDocumentDigest(afterCancel.working!), "cancel left the roster intact").toBe(
        preservedDigest,
      );
      expect(afterCancel.working!.revision).toBe(preserved.revision);
      expect(await readCellState(page, 0)).toBe(editedState);
      await expect(page.getByTestId("roster-candidate-available")).toBeVisible();
    });

    await test.step("an EXPLICIT Replace is what finally loads the new result", async () => {
      const bound = WARD_BOUNDS.replaceConfirmed;
      await page.getByTestId("roster-candidate-load").click({ timeout: bound });
      await page.getByTestId("confirm-dialog-confirm").click({ timeout: bound });
      // Promoted: the offer is gone because the roster on screen IS that candidate.
      await expect(page.getByTestId("roster-candidate-available")).toHaveCount(0, {
        timeout: bound,
      });
      await expect(page.getByTestId("roster-viewer")).toBeVisible({ timeout: bound });

      const afterReplace = await probeRosterStorage(page);
      // IDENTITY, not difference. Two honest solves of one scenario may produce the
      // same assignment and the same workbook, so “the digest changed” could fail a
      // perfectly correct Replace. What must hold is that the working roster is now
      // the candidate's bytes, under the candidate's exact pointer, on a rewritten
      // row whose source genuinely moved — which also closes the converse hole,
      // where A's bytes stamped with B's source would have passed.
      const verdict = judgeReplacement({
        before: {
          digest: preservedDigest,
          revision: preserved.revision,
          candidateSource: preserved.candidateSource,
        },
        candidate: { digest: candidateBDigest, pointer: candidateB! },
        after: {
          digest: wardDocumentDigest(afterReplace.working!),
          revision: afterReplace.working!.revision,
          candidateSource: afterReplace.working!.candidateSource,
        },
      });
      expect(verdict.problems, "the confirmed Replace loaded exactly candidate B").toEqual([]);
      expect(afterReplace.working!.editCount).toBe(0);
      expect(candidateB!.jobId).toBe(jobB);
      // And what landed is still this ward, not merely something new.
      expect(
        judgeWardDocument(readWardDocumentFacts(JSON.parse(afterReplace.working!.documentJson)))
          .problems,
      ).toEqual([]);
    });

    // -------------------------------------------------------------------
    // 9. Leave a run IN FLIGHT, so the reset has something left to clear.
    // -------------------------------------------------------------------
    // Runs A and B tidied themselves away: their terminal chain released the
    // session record and the submission snapshot. On that tidy path both surfaces
    // are already gone before New schedule, so asserting the reset "cleared" them
    // would prove nothing at all.
    //
    // A user walking away from a running optimisation is the ordinary production
    // way both survive — the record is precisely what lets the run be found again.
    // Nothing is seeded: a real solve is submitted and simply not waited for.
    let jobC = "";
    await test.step("a run left in flight keeps its session record and submission snapshot", async () => {
      await gotoArmedOptimize(page);
      await page.locator("#optimize-timeout").fill(String(WARD_SOLVER_TIMEOUT_SECONDS));
      await page.getByTestId("optimize-submit").click({ timeout: WARD_BOUNDS.thirdSubmitClick });
      await expect
        .poll(() => acceptedTracker?.ids().length ?? 0, {
          timeout: WARD_BOUNDS.thirdAcceptedIdPoll,
        })
        .toBe(3);
      jobC = acceptedTracker!.ids()[2];
      expect(jobC).not.toBe(jobA);
      expect(jobC).not.toBe(jobB);

      // Walk away mid-solve. The `afterEach` ownership hook releases this job, and
      // the gate's durable-store audit proves it left nothing behind.
      await page.goto("/save-and-load", { timeout: WARD_BOUNDS.inFlightHandoff });
      await expect(page.getByTestId("start-over-card")).toBeVisible({
        timeout: WARD_BOUNDS.inFlightHandoff,
      });
      const inFlight = await probeRosterStorage(page);
      expect(inFlight.optimizeSessionPresent, "the in-flight run left its session record").toBe(
        true,
      );
      expect(
        inFlight.snapshotRowKeys.length,
        "the in-flight run left its submission snapshot",
      ).toBeGreaterThan(0);
    });

    const beforeReset = await probeRosterStorage(page);
    // ACCEPTING PRE-STATE. Six surfaces, each established by production behaviour
    // and each proved present here — an absence proof is worth exactly as much as
    // the presence that preceded it. `judgeResiduePresent` documents why the
    // retirement marker is not among them and where its clearing IS proved.
    expect(judgeResiduePresent(beforeReset).remaining).toEqual([]);
    expect(beforeReset.working!.editCount).toBe(0);

    // -------------------------------------------------------------------
    // 10. New schedule leaves the previous run behind.
    // -------------------------------------------------------------------
    await test.step("a confirmed New schedule clears every previous-run surface", async () => {
      const bound = WARD_BOUNDS.newScheduleReset;
      await page.goto("/save-and-load", { timeout: bound });
      await expect(page.getByTestId("start-over-card")).toBeVisible({ timeout: bound });
      await page.getByTestId("new-schedule-button").click({ timeout: bound });
      await expect(page.getByTestId("confirm-dialog-consequences")).toContainText(
        "The saved roster and the last run's result",
        { timeout: bound },
      );
      await page.getByTestId("confirm-dialog-confirm").click({ timeout: bound });
      await expect(page.getByText("New schedule created")).toBeVisible({ timeout: bound });

      const afterReset = await probeRosterStorage(page);
      const verdict = judgeResidue(afterReset);
      expect(verdict.remaining, "nothing from the previous run survives").toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    await test.step("Optimize and /roster both start genuinely fresh", async () => {
      const bound = WARD_BOUNDS.freshStartAssertions;
      await page.goto("/optimize-and-export", { timeout: bound });
      // THE DISCRIMINATING ONE. A surviving session record is what makes Optimize
      // resume the previous run on mount and re-announce it; the run left in flight
      // above is exactly such a record, and the reset removed it. So an idle screen
      // here is a real consequence of the cut, not the default of a page that never
      // had a run behind it.
      await expect(page.getByTestId("optimize-idle")).toBeVisible({ timeout: bound });
      await expect(page.getByTestId("optimize-resumed")).toHaveCount(0);
      await expect(page.getByTestId("optimize-resume-failed")).toHaveCount(0);
      // No capture notice of ANY kind, and none of the reported stale copy. The
      // `Not Found` variant specifically needs a capture driven to `fetch-failed`,
      // which this all-succeeding journey cannot produce without interception — it
      // stays covered by G4's `optimize-capture-composition` and
      // `new-schedule-reset` controls, which establish the notice and prove the
      // confirmed reset removes it.
      await expect(page.getByTestId("optimize-capture-fetch-failed")).toHaveCount(0);
      await expect(page.getByTestId("optimize-capture-committed")).toHaveCount(0);
      await expect(page.getByTestId("optimize-completed-artifact")).toHaveCount(0);
      await expect(page.getByTestId("optimize-open-roster")).toHaveCount(0);
      await expect(page.getByText(/could not be saved/i)).toHaveCount(0);
      await expect(page.getByText(/Not Found/i)).toHaveCount(0);
      // The scenario itself is empty again, so the stat grid cannot be Ward 8's.
      await expect(page.getByTestId("optimize-stat-nurses").locator("div").first()).toHaveText(
        "0",
        { timeout: bound },
      );

      await gotoRoster(page);
      await expect(page.getByTestId("roster-section-empty")).toBeVisible({ timeout: bound });
      await expect(page.getByTestId("roster-viewer")).toHaveCount(0);
    });

    // Three real jobs: A and B released themselves through the product's own
    // terminal chain, C was deliberately walked away from. The `afterEach` proves
    // the exact final 404 for every one of them.
    expect(acceptedTracker!.ids()).toEqual([jobA, jobB, jobC]);
    // Printed, not just attached: the release gate runs this spec through the line
    // reporter, which shows stdout but not attachments — and “which jobs did this
    // attempt actually own” is exactly what a residue audit needs to be checkable
    // against the gate log rather than taken on trust.
    // eslint-disable-next-line no-console
    console.log(`ward journey accepted jobs: A=${jobA} B=${jobB} C=${jobC}`);

    // Every page this journey touched was a production route.
    expect(visitedUrls.length).toBeGreaterThan(0);
    expect(visitedUrls.filter((url) => url.includes("fixture"))).toEqual([]);
  });
});
