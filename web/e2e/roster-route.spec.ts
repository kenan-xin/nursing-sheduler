// G4 closure — the dedicated /roster route is reachable, reloadable and
// responsive in both modes, and the Optimize route's completed result offers
// the prototype-faithful `Open & adjust roster` CTA guarded by a structurally
// loadable capture. These tests are the e2e half of the discoverability
// contract; the unit half lives in nav-config.test.ts and
// run-status-panel.test.tsx.

import { expect, test, type Page } from "@playwright/test";

async function gotoReadyHome(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("home-screen")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __nsStore?: unknown }).__nsStore),
  );
}

test.describe("G4 — dedicated /roster route reachability", () => {
  // Opt into the store seam (test-bridge.tsx) before any page script runs, so
  // `gotoReadyHome`'s hydration wait has something to wait for. The e2e suite runs
  // against a PRODUCTION build, where nothing else exposes the store.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("the dedicated /roster route renders the prototype page header", async ({ page }) => {
    await page.goto("/roster");
    await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "Roster");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review & adjust the roster");
    await expect(page.getByText("Output · Roster")).toBeVisible();
  });

  test("direct navigation to /roster survives a full reload", async ({ page }) => {
    await page.goto("/roster");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review & adjust the roster");
    await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "Roster");
  });

  test("the Roster nav entry appears under Output, immediately after Optimise & Export", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    const outputGroup = page.getByTestId("nav-group-output");
    const links = outputGroup.locator('[data-testid^="nav-link-"]');
    // ORDER, not just presence: Roster sits immediately after Optimise & Export,
    // and Export Layout stays deferred, so the group is exactly these two.
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute("data-testid", "nav-link-/optimize-and-export");
    await expect(links.nth(1)).toHaveAttribute("data-testid", "nav-link-/roster");
  });

  test("the Roster nav entry is reachable from desktop sidebar in both modes", async ({ page }) => {
    await gotoReadyHome(page);
    await expect(page.getByTestId("nav-link-/roster")).toBeVisible();

    await page.getByTestId("mode-toggle-advanced").click();
    await expect(page.getByTestId("nav-link-/roster")).toBeVisible();
    await page.getByTestId("nav-link-/roster").click();
    await expect(page).toHaveURL(/\/roster$/);
    await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "Roster");
  });

  test("the Roster nav entry is reachable from the mobile drawer (<640px)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await gotoReadyHome(page);
    await page.getByTestId("mobile-nav-trigger").click();
    const drawer = page.getByTestId("mobile-nav-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId("nav-link-/roster")).toBeVisible();
    await drawer.getByTestId("nav-link-/roster").click();
    await expect(page).toHaveURL(/\/roster$/);
    await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "Roster");
  });

  test("Guided Home does not add a seventh workflow step for Roster", async ({ page }) => {
    await gotoReadyHome(page);
    // Six workflow cards in Guided mode — the Roster destination is OUTSIDE
    // the six-step workflow and appears only in persistent navigation.
    const cards = page.getByTestId("home-wizard-grid").locator('[data-testid^="home-card-"]');
    await expect(cards).toHaveCount(6);
    await expect(page.getByTestId("home-card-/roster")).toHaveCount(0);
    await expect(page.getByTestId("home-progress")).toContainText("of 6");
  });

  test("Advanced Home shows the prototype-aligned Roster editor card", async ({ page }) => {
    await gotoReadyHome(page);
    await page.getByTestId("mode-toggle-advanced").click();
    const card = page.getByTestId("home-adv-/roster");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Roster");
    await expect(card).toContainText("View & manually adjust results");
    await card.click();
    await expect(page).toHaveURL(/\/roster$/);
  });
});
