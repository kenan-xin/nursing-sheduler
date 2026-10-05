// G4 closure — `New schedule` leaves the previous run behind, in a real browser.
//
// The reported defect: after confirming New schedule, the Optimize route still
// announced `The roster for this run could not be saved — Not Found … Your
// downloaded XLSX is unaffected.` because the reset only replaced the SCENARIO and
// left every roster/session surface of the previous run in the browser.
//
// plq5 P2: New no longer purges the saved roster. Each schedule keeps its own, so the
// previous run's roster stays with the schedule being left (reopened from Recent
// schedules), the new schedule has none, and only the session residue goes.
//
// These are the browser half of that closure. The seeding and the read-back both go
// through the roster fixture's controls, which drive PRODUCTION `rosterStorage` and
// the real sessionStorage/localStorage keys — so what is asserted is stored state in
// a real browser, not a hidden notice. The DOM-level proof that the notice itself
// disappears lives in `components/optimize/optimize-capture-composition.test.tsx`,
// where a real capture can be driven to `fetch-failed` first.

import { expect, test, type Page } from "@playwright/test";

const FIXTURE_URL = "/roster-viewer-fixture";
const SAVE_AND_LOAD_URL = "/save-and-load";
const OPTIMIZE_SESSION_KEY = "nurse.optimize.session";

interface ResidueProbe {
  working: boolean;
  pointer: boolean;
  candidate: boolean;
  snapshot: boolean;
  session: boolean;
  retireMarker: boolean;
  viewMetadata: boolean;
}

async function probeResidue(page: Page): Promise<ResidueProbe> {
  await page.goto(FIXTURE_URL);
  await expect(page.getByTestId("roster-fixture")).toBeVisible();
  await page.getByTestId("fx-probe-residue").click();
  // `unknown` until a probe has actually run, so this can never read a stale
  // "everything absent" that was simply never measured.
  await expect(page.getByTestId("fx-residue")).not.toHaveText("unknown");
  return JSON.parse(await page.getByTestId("fx-residue").innerText()) as ResidueProbe;
}

/** Seed every surface a completed run leaves behind, and prove they are all there. */
async function seedPreviousRun(page: Page): Promise<void> {
  await page.goto(FIXTURE_URL);
  await expect(page.getByTestId("roster-fixture")).toBeVisible();
  await page.getByTestId("fx-clear").click();
  await expect(page.getByTestId("fx-status")).toHaveText("cleared");
  await page.getByTestId("fx-seed-residue").click();
  await expect(page.getByTestId("fx-status")).toHaveText("residue-seeded");

  // ACCEPTING PRE-STATE: the absence assertions later cannot pass vacuously.
  const before = await probeResidue(page);
  expect(before).toMatchObject({
    pointer: true,
    candidate: true,
    snapshot: true,
    session: true,
    retireMarker: true,
    viewMetadata: true,
  });
}

async function gotoSaveAndLoad(page: Page): Promise<void> {
  await page.goto(SAVE_AND_LOAD_URL);
  // The hydration gate renders a skeleton until the durable store reports ready, so
  // the card being visible IS the hydration signal — no store seam needed here.
  await expect(page.getByTestId("start-over-card")).toBeVisible();
}

test.describe("G4 — New schedule leaves the previous run behind", () => {
  test("a confirmed New schedule clears the session residue; the roster stays with its schedule", async ({
    page,
  }) => {
    await seedPreviousRun(page);
    // Bring-up hands the fixture's (pre-P2, unscoped) roster slot to the open schedule.
    await gotoSaveAndLoad(page);

    await page.getByTestId("new-schedule-button").click();
    await expect(page.getByRole("alertdialog")).toContainText(
      "Your current schedule stays in Recent schedules, with its roster",
    );
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page.getByText("New schedule created")).toBeVisible();

    expect(await probeResidue(page)).toMatchObject({
      session: false,
      retireMarker: false,
      viewMetadata: false,
    });
    // The new schedule has no roster of its own: nothing stale is shown.
    await page.goto("/roster");
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();

    // The schedule it left still has its saved result.
    await gotoSaveAndLoad(page);
    // Filtered, not positional: opening it moves it to the top of the list.
    const previous = page.getByTestId("recent-schedule-row").filter({ hasText: "Has roster" });
    await expect(previous).toContainText("Has roster");
    await previous.getByRole("button", { name: /^Open / }).click();
    await expect(previous).toContainText("Open here");
    await page.goto("/roster");
    await expect(page.getByTestId("roster-candidate-available")).toBeVisible();
  });

  test("cancelling changes nothing at all", async ({ page }) => {
    await seedPreviousRun(page);
    await gotoSaveAndLoad(page);

    await page.getByTestId("new-schedule-button").click();
    await page.getByTestId("confirm-dialog-cancel").click();
    await expect(page.getByText("New schedule created")).toHaveCount(0);

    // The candidate and pointer have moved into the open schedule's own slot at
    // bring-up (plq5 P2); everything the fixture probes by its old keys is intact.
    expect(await probeResidue(page)).toMatchObject({
      snapshot: true,
      session: true,
      retireMarker: true,
      viewMetadata: true,
    });
  });

  test("an unverified cleanup never claims New schedule created", async ({ page }) => {
    // A sessionStorage whose removeItem silently no-ops for the optimize session
    // record — the record carrying the real-identity reverse map survives, so the
    // privacy promise is NOT kept and the reset must refuse to claim success.
    // Scoped to that one key so every other storage operation stays real.
    await page.addInitScript((key: string) => {
      const realRemove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function patched(this: Storage, name: string) {
        if (name === key) return;
        return realRemove.call(this, name);
      };
      window.sessionStorage.setItem(key, '{"phase":"active"}');
    }, OPTIMIZE_SESSION_KEY);

    await gotoSaveAndLoad(page);
    await page.getByTestId("new-schedule-button").click();
    await page.getByTestId("confirm-dialog-confirm").click();

    // No false success, plain non-technical guidance, and the button still armed so
    // clicking it again is a real retry.
    await expect(page.getByText("New schedule could not be created")).toBeVisible();
    await expect(page.getByText("New schedule created", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("new-schedule-button")).toBeEnabled();

    // The failure is real: the record the cut could not remove is still there.
    const survived = await page.evaluate(
      (key: string) => window.sessionStorage.getItem(key) !== null,
      OPTIMIZE_SESSION_KEY,
    );
    expect(survived).toBe(true);
  });
});
