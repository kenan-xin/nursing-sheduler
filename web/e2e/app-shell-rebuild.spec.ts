import { expect, test, type Page } from "@playwright/test";

// T08 REBUILD coverage — the prototype-conformance rebuild of the shell frame
// (BLOCKER 1), the two-mode Home dashboard (BLOCKER 2), the shared SideNav nav
// metadata (MAJOR 3/4), and the persistence status affordance (MAJOR 6). These
// drive the real T04 store through the `window.__nsStore` seam (test-bridge.tsx).

type NsWindow = {
  __nsStore: {
    scenario: { getState(): Record<string, unknown> & { mutateScenario(x: unknown): void } };
    backupStatus(): "none" | "current" | "stale";
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
    // 50px, not the prototype's 56: the bar is `h-14`, and Tailwind's `--spacing`
    // base carries the 0.9 baseline (globals.css), so 14 × 4px × 0.9 = 50.4. The
    // shell scales with the content it frames — 0.9 is what shipped (the density
    // knob was removed in favour of the Compact scale users already had), so the
    // scaled geometry is the intended one, not drift (nursing-sheduler-yea).
    expect(Math.round(bar!.height)).toBe(50);
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
    // Every Advanced-visible destination except Home is a direct entry point
    // (12 of 13 — DL12 §2: Guided's five Set up entries incl. Rules, plus the
    // five raw Constraints editors).
    await expect(page.locator('[data-testid^="home-adv-"]')).toHaveCount(12);
    // Reachability preserved: still routes.
    await page.getByTestId("home-adv-/dates").click();
    await expect(page).toHaveURL(/\/dates$/);
  });

  test("stat strip reflects real scenario data", async ({ page }) => {
    await gotoReadyHome(page);
    await mutate(page, {
      staff: [
        { _k: "p1", id: 1, description: "A" },
        { _k: "p2", id: 2, description: "B" },
      ],
    });
    // Stat strip NURSES tile. Live counts stay on Home (DL12 §2) — the
    // sidebar no longer renders a second, ambiguous count badge per row.
    await expect(page.getByTestId("home-stat-strip")).toContainText("2");
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

  test("M3 — inactive rows are 500, active rows are 600, 38px tall", async ({ page }) => {
    // Home is active on "/", Dates is inactive.
    const homeWeight = await page
      .getByTestId("nav-link-/")
      .evaluate((el) => getComputedStyle(el).fontWeight);
    const datesWeight = await page
      .getByTestId("nav-link-/dates")
      .evaluate((el) => getComputedStyle(el).fontWeight);
    expect(homeWeight).toBe("600");
    expect(datesWeight).toBe("500");

    // Row height is `leading-[normal]` + `py-2.5`, which lands on 38px: the padding
    // is spacing-derived, so it carries the same 0.9 baseline as the top bar above
    // (2 × 2.5 × 4px × 0.9 = 18px) around a normal-leading body line box. The
    // prototype's 42px is the unscaled figure; 38 is that geometry at the shipped
    // scale (nursing-sheduler-yea).
    //
    // Asserted as equality rather than a range on purpose: this row's line-height
    // has regressed before (a `leading-[1.4]` renders a taller box), and only an
    // exact check catches a revert.
    const rowBox = await page.getByTestId("nav-link-/dates").boundingBox();
    expect(Math.round(rowBox!.height)).toBe(38);
  });

  // The identity block is two facts, not the prototype's one short phrase, and
  // neither line may ellipsize at either shipped width. `scrollWidth <=
  // clientWidth` is the discriminating form: the spans are `whitespace-nowrap`,
  // so an over-long line overflows its box and trips this, rather than wrapping
  // and passing vacuously. Both required geometries are covered — the 280px
  // desktop rail here, and the 250px drawer in the coarse test below.
  test("M5 — the desktop rail shows the whole identity, unellipsized", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoReadyHome(page);

    const rail = page.getByTestId("desktop-sidebar");
    await expect(rail.getByTestId("sidebar-identity-name")).toHaveText("Local workspace");
    await expect(rail.getByTestId("sidebar-identity-scope")).toHaveText("This browser");

    for (const testId of ["sidebar-identity-name", "sidebar-identity-scope"]) {
      const fit = await rail.getByTestId(testId).evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(fit.clientWidth, `${testId} must be laid out`).toBeGreaterThan(0);
      expect(
        fit.scrollWidth,
        `${testId} overflows its box in the desktop rail`,
      ).toBeLessThanOrEqual(fit.clientWidth);
    }
  });

  test("M5 — footer is one 36px theme button and no gear", async ({ page }) => {
    // 36, not the v1 34: the v2 SideNav sizes this control at 36px
    // (SideNav.dc.html:66), which is exactly the shared `icon` control token
    // (--ctl). The R1 re-skin therefore dropped the caller-side `size-[34px]`
    // override rather than keeping a one-off geometry for a shared control.
    await expect(page.getByTestId("display-settings-trigger")).toHaveCount(0);
    const theme = page.getByRole("button", { name: /switch to .* theme/i });
    await expect(theme).toBeVisible();
    // RAW dimensions, never rounded — `size-control` is the absolute 36px token,
    // and `Math.round` would accept anything in [35.5, 36.5) as "exactly 36".
    const box = await theme.boundingBox();
    expect(box!.width, "theme control width").toBe(36);
    expect(box!.height, "theme control height").toBe(36);
  });

  // The other half of the M5 contract, extended to the rest of the rail.
  //
  // 36px on a precise pointer and a real 44px target on a coarse one are both
  // required, and the coarse floor must live on the actual control (never a
  // pseudo-element hitbox). This also covers the two rail controls F4's
  // coarse-pointer project structurally CANNOT reach: below 920px the desktop
  // rail is `hidden`, and the drawer that replaces it is closed, so a scanner
  // walking the rendered document never measures a nav row or a mode segment.
  // The drawer is opened here explicitly so both are measured.
  //
  // The coarse context is built here rather than borrowed from F4's `v2-touch`
  // project, because this spec runs only under `chromium` and the claim belongs
  // beside the precise-pointer assertion it qualifies.
  test("M5 — the rail's own controls still meet the coarse-pointer minimum", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
      });
      await gotoReadyHome(page);

      // Assert the pointer state BEFORE measuring: a context that silently
      // stayed fine-pointer would measure the 36/38px precise sizes and "pass"
      // for exactly the wrong reason.
      const media = await page.evaluate(() => ({
        coarse: matchMedia("(pointer: coarse)").matches,
        touchPoints: navigator.maxTouchPoints,
      }));
      expect(media.coarse, "the context must report (pointer: coarse)").toBe(true);
      expect(media.touchPoints).toBeGreaterThanOrEqual(1);

      // Below 920px the rail is a drawer, so open it to reach the footer.
      await page.getByTestId("mobile-nav-trigger").click();
      const theme = page.getByRole("button", { name: /switch to .* theme/i });
      await expect(theme).toBeVisible();

      // RAW dimensions, never rounded. `Math.round` here would be a hole in the
      // oracle rather than tolerance: a control laid out at 43.59375px — an
      // ordinary fractional CSS result, not a contrived one — rounds to 44 and
      // sails through a floor it actually misses. The tokens are absolute
      // integers, so the raw value is what has to clear the threshold.
      const box = await theme.boundingBox();
      expect(box!.width, "theme control width").toBeGreaterThanOrEqual(44);
      expect(box!.height, "theme control height").toBeGreaterThanOrEqual(44);

      // A nav row and both mode segments: 38px / 36px with a precise pointer,
      // and they must grow to the 44px floor here.
      //
      // Scoped to the drawer: the desktop rail is `hidden` rather than
      // unmounted at this width, so both copies of every row are in the DOM.
      const drawer = page.getByTestId("mobile-nav-drawer");
      for (const testId of ["nav-link-/dates", "mode-toggle-guided", "mode-toggle-advanced"]) {
        const control = drawer.getByTestId(testId);
        await expect(control).toBeVisible();
        const controlBox = await control.boundingBox();
        expect(controlBox!.height, `${testId} height`).toBeGreaterThanOrEqual(44);
      }

      // The drawer is the SECOND required identity geometry, and the tighter of
      // the two: 250px against the rail's 280px.
      await expect(drawer.getByTestId("sidebar-identity-name")).toHaveText("Local workspace");
      await expect(drawer.getByTestId("sidebar-identity-scope")).toHaveText("This browser");
      for (const testId of ["sidebar-identity-name", "sidebar-identity-scope"]) {
        const fit = await drawer.getByTestId(testId).evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }));
        expect(fit.clientWidth, `${testId} must be laid out`).toBeGreaterThan(0);
        expect(
          fit.scrollWidth,
          `${testId} overflows its box in the open drawer`,
        ).toBeLessThanOrEqual(fit.clientWidth);
      }
    } finally {
      await context.close();
    }
  });

  // The precise-pointer half of the mode-segment contract. F4's fine-pointer
  // branch only rejects zero-sized controls, and the coarse lane below measures
  // the >=44px floor, so without this a precise segment could drift off the
  // 36px control token with every recorded gate still green.
  test("m7 — both mode segments are exactly 36px on a precise pointer", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoReadyHome(page);

    // Assert the pointer state first: a coarse context would measure the 44px
    // floor and "pass" a 36px assertion for the wrong reason if it ever drifted.
    const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    expect(coarse, "this project must report a precise pointer").toBe(false);

    const rail = page.getByTestId("desktop-sidebar");
    for (const testId of ["mode-toggle-guided", "mode-toggle-advanced"]) {
      const segment = rail.getByTestId(testId);
      await expect(segment).toBeVisible();
      const box = await segment.boundingBox();
      // `min-h-control` is the absolute 36px token; `min-h-9` would resolve
      // through --spacing and its 0.9 baseline to 32.4px.
      //
      // RAW height, never rounded — see the coarse test above. `Math.round`
      // would accept anything in [35.5, 36.5), so a segment laid out at
      // 35.59375px would satisfy an assertion that says "exactly 36".
      expect(box!.height, `${testId} height`).toBe(36);
    }
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
