import { expect, test, type Page } from "@playwright/test";

// T08 REBUILD coverage — the prototype-conformance rebuild of the shell frame
// (BLOCKER 1), the two-mode Home dashboard (BLOCKER 2), the shared SideNav nav
// metadata (MAJOR 3/4), and the persistence status affordance (MAJOR 6). These
// drive the real T04 store through the `window.__nsStore` seam (test-bridge.tsx).

type NsWindow = {
  __nsStore: {
    scenario: { getState(): Record<string, unknown> & { mutateScenario(x: unknown): void } };
    isDirty(): boolean;
  };
};

async function gotoReadyHome(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("home-screen")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __nsStore?: unknown }).__nsStore),
  );
}

async function mutate(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
});

test.describe("T08 rebuild — shell geometry (BLOCKER 1)", () => {
  test("desktop is a row: full-height rail from the top edge, top bar inside the main column", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoReadyHome(page);

    const rail = await page.getByTestId("desktop-sidebar").boundingBox();
    const bar = await page.getByTestId("top-bar").boundingBox();
    expect(rail).not.toBeNull();
    expect(bar).not.toBeNull();

    // Rail begins at the top-left edge and spans (near) the full viewport height.
    expect(rail!.x).toBeLessThan(2);
    expect(rail!.y).toBeLessThan(2);
    expect(rail!.height).toBeGreaterThan(700);

    // The top bar is contained in the right-hand column: it starts AFTER the rail,
    // it does not span the full viewport above everything.
    expect(bar!.x).toBeGreaterThanOrEqual(rail!.width - 1);
    expect(bar!.y).toBeLessThan(2);
    expect(Math.round(bar!.height)).toBe(56);
  });
});

test.describe("T08 rebuild — two-mode Home (BLOCKER 2)", () => {
  test("Guided shows the stat strip, progress meter and six workflow cards", async ({ page }) => {
    await gotoReadyHome(page);
    await expect(page.getByTestId("home-screen")).toHaveAttribute("data-mode", "guided");
    await expect(page.getByTestId("home-stat-strip")).toBeVisible();
    await expect(page.getByTestId("home-progress")).toBeVisible();
    await expect(page.getByTestId("home-wizard-grid")).toBeVisible();
    await expect(page.locator('[data-testid^="home-card-"]')).toHaveCount(6);
    await expect(page.getByTestId("home-advanced")).toHaveCount(0);
  });

  test("Advanced swaps the body for the explanatory band and direct editor grid", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    // Mode control lives in the SideNav now.
    await page.getByTestId("mode-toggle-advanced").click();

    await expect(page.getByTestId("home-screen")).toHaveAttribute("data-mode", "advanced");
    await expect(page.getByTestId("home-advanced")).toBeVisible();
    await expect(page.getByTestId("home-wizard-grid")).toHaveCount(0);
    // Every committed destination except Home is a direct entry point (12 of 13).
    await expect(page.locator('[data-testid^="home-adv-"]')).toHaveCount(12);
    // Reachability preserved: still routes.
    await page.getByTestId("home-adv-/dates").click();
    await expect(page).toHaveURL(/\/dates$/);
  });

  test("stat strip and nav counts reflect real scenario data", async ({ page }) => {
    await gotoReadyHome(page);
    await mutate(page, {
      staff: [
        { _k: "p1", id: 1, description: "A" },
        { _k: "p2", id: 2, description: "B" },
      ],
    });
    // Stat strip NURSES tile.
    await expect(page.getByTestId("home-stat-strip")).toContainText("2");
    // Sidebar People row carries a live count badge.
    await expect(page.getByTestId("nav-count-/people")).toHaveText("2");
  });

  test("Generate is only 'ready to run' (not Done) when all prerequisites exist but no roster", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    // Satisfy all five setup prerequisites with a valid range — but never run.
    await mutate(page, {
      rangeStart: "2026-02-01",
      rangeEnd: "2026-02-28",
      staff: [{ _k: "p1", id: 1, description: "A" }],
      shifts: [{ _k: "s1", id: "AM", description: "Morning" }],
      reqData: [{ uid: "r1", kind: "leave", person: 1, date: "2026-02-03" }],
      cardsByKind: {
        requirements: [{ uid: "c1", shiftType: "AM", requiredNumPeople: 1, weight: 1 }],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });

    // Five of six ready — Generate is NOT counted as done.
    await expect(page.getByTestId("home-progress")).toContainText("5 of 6 steps ready");
    const generate = page.getByTestId("home-card-/optimize-and-export");
    await expect(generate).toHaveAttribute("data-status", "current");
    await expect(page.getByTestId("home-cta-/optimize-and-export")).toHaveText(/Continue/);
    await expect(page.getByTestId("home-card-/dates")).toHaveAttribute("data-status", "done");
  });

  test("a reversed/invalid date range does not mark the Dates step Done", async ({ page }) => {
    await gotoReadyHome(page);
    await mutate(page, { rangeStart: "2026-02-28", rangeEnd: "2026-02-01" });
    await expect(page.getByTestId("home-card-/dates")).not.toHaveAttribute("data-status", "done");
  });
});

test.describe("T08 rebuild — persistence status (MAJOR 6)", () => {
  test("status settles to Saved after a tracked write and mirrors in Save & Load", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    // Ready ⇒ starts Saved.
    await expect(page.getByTestId("persistence-status")).toHaveAttribute("data-status", "saved");

    // Route to Save & Load while clean (no dirty guard), then dirty the scenario.
    await page.getByTestId("nav-link-/save-and-load").click();
    await expect(
      page.getByTestId("auto-save-status").getByTestId("persistence-badge"),
    ).toHaveAttribute("data-status", "saved");

    await mutate(page, { rangeStart: "2026-02-01", rangeEnd: "2026-02-28" });
    // The queued write settles back to Saved in both the top-bar chip and the badge.
    await expect(page.getByTestId("persistence-status")).toHaveAttribute("data-status", "saved");
    await expect(
      page.getByTestId("auto-save-status").getByTestId("persistence-badge"),
    ).toHaveAttribute("data-status", "saved");
  });
});

// Sidebar prototype-conformance (audit M1–M6, m7 + cold-review Minors). One
// assertion per finding, each naming the finding it closes.
test.describe("T08 rebuild — sidebar prototype-conformance audit", () => {
  test.beforeEach(async ({ page }) => {
    // 1440×900 is the cold-review's measurement baseline (font scale + row height).
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
    await gotoReadyHome(page);
  });

  test("M1 — Home is headerless, then SET UP / OUTPUT / SYSTEM in order", async ({ page }) => {
    // Home group renders no heading; the three labeled groups do, in this order.
    await expect(page.getByTestId("nav-group-home")).toBeVisible();
    await expect(page.getByTestId("nav-group-label-home")).toHaveCount(0);
    await expect(page.getByTestId("nav-group-label-setup")).toHaveText(/set up/i);
    await expect(page.getByTestId("nav-group-label-output")).toHaveText(/output/i);
    await expect(page.getByTestId("nav-group-label-system")).toHaveText(/system/i);

    // Vertical DOM order: home above setup above output above system.
    const ys = await Promise.all(
      ["home", "setup", "output", "system"].map(async (id) => {
        const box = await page.getByTestId(`nav-group-${id}`).boundingBox();
        return box!.y;
      }),
    );
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[1]).toBeLessThan(ys[2]);
    expect(ys[2]).toBeLessThan(ys[3]);
  });

  test("M2 — step number trails the label, not leads", async ({ page }) => {
    const row = page.getByTestId("nav-link-/dates");
    const label = row.locator("span.flex-1");
    const step = row.getByTestId("nav-step-/dates");
    await expect(step).toHaveText("1");
    const labelBox = await label.boundingBox();
    const stepBox = await step.boundingBox();
    expect(labelBox!.x).toBeLessThan(stepBox!.x);
  });

  test("M3 — inactive rows are 500, active rows are 600, 42px tall", async ({ page }) => {
    // Home is active on "/", Dates is inactive.
    const homeWeight = await page
      .getByTestId("nav-link-/")
      .evaluate((el) => getComputedStyle(el).fontWeight);
    const datesWeight = await page
      .getByTestId("nav-link-/dates")
      .evaluate((el) => getComputedStyle(el).fontWeight);
    expect(homeWeight).toBe("600");
    expect(datesWeight).toBe("500");

    // Row height hits the prototype's 42px (leading-[normal] + 10px padding). The
    // previous leading-[1.4] rendered 43.8px → rounds to 44, so this guards a revert.
    const rowBox = await page.getByTestId("nav-link-/dates").boundingBox();
    expect(Math.round(rowBox!.height)).toBe(42);
  });

  test("M5 — footer is one 34px theme button and no gear", async ({ page }) => {
    await expect(page.getByTestId("display-settings-trigger")).toHaveCount(0);
    const theme = page.getByRole("button", { name: /switch to .* theme/i });
    await expect(theme).toBeVisible();
    const box = await theme.boundingBox();
    expect(Math.round(box!.width)).toBe(34);
    expect(Math.round(box!.height)).toBe(34);
  });

  test("m7 — mode control exposes tablist / tab semantics with aria-selected", async ({ page }) => {
    const list = page.getByTestId("mode-toggle");
    await expect(list).toHaveAttribute("role", "tablist");
    await expect(page.getByTestId("mode-toggle-guided")).toHaveAttribute("role", "tab");
    await expect(page.getByTestId("mode-toggle-advanced")).toHaveAttribute("role", "tab");
    await expect(page.getByTestId("mode-toggle-guided")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("mode-toggle-advanced")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  test("m7 — arrow / Home / End keys move focus and select (roving tabindex)", async ({ page }) => {
    const guided = page.getByTestId("mode-toggle-guided");
    const advanced = page.getByTestId("mode-toggle-advanced");

    // Roving tabindex: only the selected tab is a tab stop.
    await expect(guided).toHaveAttribute("tabindex", "0");
    await expect(advanced).toHaveAttribute("tabindex", "-1");

    await guided.focus();
    await expect(guided).toBeFocused();

    // ArrowRight → Advanced is selected + focused (automatic activation).
    await page.keyboard.press("ArrowRight");
    await expect(advanced).toHaveAttribute("aria-selected", "true");
    await expect(advanced).toBeFocused();
    await expect(guided).toHaveAttribute("aria-selected", "false");
    // After the re-render the roving tab stop moved with the selection.
    await expect(advanced).toHaveAttribute("tabindex", "0");
    await expect(guided).toHaveAttribute("tabindex", "-1");

    // ArrowLeft returns focus + selection to Guided.
    await page.keyboard.press("ArrowLeft");
    await expect(guided).toHaveAttribute("aria-selected", "true");
    await expect(guided).toBeFocused();

    // End → Advanced; Home → Guided.
    await page.keyboard.press("End");
    await expect(advanced).toHaveAttribute("aria-selected", "true");
    await expect(advanced).toBeFocused();
    await page.keyboard.press("Home");
    await expect(guided).toHaveAttribute("aria-selected", "true");
    await expect(guided).toBeFocused();
  });

  test("M6 — mobile drawer is 250px and animates at the 220ms base duration", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("mobile-nav-trigger").click();
    const drawer = page.getByTestId("mobile-nav-drawer");
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(Math.round(box!.width)).toBe(250);

    // The popup slides at --dur-base (220ms). The earlier `duration-base` class
    // emitted no utility and fell back to 150ms, so this guards that regression.
    const dur = await drawer.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(dur).toBe("0.22s");
  });
});
