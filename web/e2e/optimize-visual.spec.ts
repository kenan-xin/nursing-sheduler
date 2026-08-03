import { expect, test, type Page } from "@playwright/test";

// R6 route-local visual/geometry proof for the migrated Optimize & Export surface.
//
// The universal v2 battery (`v2-visual-system.spec.ts`, run for all four R6 rows in
// both `chromium` and `v2-touch`) already proves No-Black, the declared semantic
// roles, axe AA, scrim provenance, status/solid-fill pairing and coarse-pointer
// targets. This spec asserts what the battery does NOT: the surface LADDER inside
// each route card (an L1 card whose nested chart is a `--panel` well with an INSET
// cast, which is what DESIGN.md §4 rule 5 actually requires), the selective
// geometry (16px card / 12px well / 0px data grid), and the resolved status
// tint↔ink pairing in DARK mode — the discriminating theme, where each status base
// and ink tier resolve to DIFFERENT colours, so a tint painted with a neutral or
// base ink is a real defect rather than a theoretical one.
//
// Every assertion compares raw computed values against tokens resolved live on the
// same page. No `Math.round`, no hard-coded hexes.

async function gotoReady(page: Page, url: string, theme: "light" | "dark") {
  await page.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("ns-theme", t);
      } catch {}
    },
    [theme] as const,
  );
  await page.goto(url);
}

/** Resolve a CSS variable to its computed value on this page, via a probe. */
async function resolveVar(page: Page, prop: "color" | "backgroundColor", token: string) {
  return page.evaluate(
    ([p, t]) => {
      const probe = document.createElement("div");
      if (p === "color") probe.style.color = `var(${t})`;
      else probe.style.backgroundColor = `var(${t})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe)[p === "color" ? "color" : "backgroundColor"];
      probe.remove();
      return value;
    },
    [prop, token] as const,
  );
}

interface Paint {
  radius: string;
  bg: string;
  color: string;
  shadow: string;
}

async function paintOf(page: Page, testId: string): Promise<Paint> {
  return page.getByTestId(testId).evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderRadius, bg: s.backgroundColor, color: s.color, shadow: s.boxShadow };
  });
}

test.describe("R6 Optimize & Export — migrated route geometry and ladder", () => {
  test("the route's own containers are L1 16px cards with an outer cast", async ({ page }) => {
    await gotoReady(page, "/optimize-and-export", "light");
    await expect(page.getByTestId("screen")).toBeVisible();

    const surface = await resolveVar(page, "backgroundColor", "--surface");
    const bg = await resolveVar(page, "backgroundColor", "--bg");

    for (const testId of [
      "optimize-server-bar",
      "optimize-run-settings-card",
      "optimize-live-result-card",
      "optimize-event-log",
    ]) {
      const paint = await paintOf(page, testId);
      expect(paint.radius, `${testId} is a 16px card`).toBe("16px");
      expect(paint.bg, `${testId} sits on --surface`).toBe(surface);
      expect(paint.shadow, `${testId} carries --sh-1`).not.toBe("none");
      expect(paint.shadow, `${testId} is raised, never inset`).not.toContain("inset");
    }

    // The page plane underneath is L0 and flat — nothing floats free on it.
    const plane = await paintOf(page, "screen");
    expect(plane.bg).toBe(bg);
    expect(plane.shadow).toBe("none");
  });

  // The two cold-review presentation repairs, proved on RESOLVED paint rather than
  // on the authored class — the component-boundary test pins the contract, this
  // pins what Chromium actually computes.
  test("the scenario counts render in the mono data face (DESIGN.md §3)", async ({ page }) => {
    await gotoReady(page, "/optimize-and-export", "light");
    await expect(page.getByTestId("optimize-scenario-stats")).toBeVisible();

    // Resolve the token families live so the assertion never hard-codes a stack.
    const families = await page.evaluate(() => {
      const probe = document.createElement("div");
      document.body.appendChild(probe);
      probe.style.fontFamily = "var(--ff-mono)";
      const mono = getComputedStyle(probe).fontFamily;
      probe.style.fontFamily = "var(--ff-heading)";
      const heading = getComputedStyle(probe).fontFamily;
      probe.remove();
      return { mono, heading };
    });
    expect(families.mono, "the mono and display faces must be distinguishable").not.toBe(
      families.heading,
    );

    for (const testId of [
      "optimize-stat-nurses",
      "optimize-stat-days",
      "optimize-stat-shifts",
      "optimize-stat-rules-on",
    ]) {
      const numeral = page.getByTestId(testId).locator("> div").first();
      const resolved = await numeral.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(resolved, `${testId} numeral resolves the mono data face`).toBe(families.mono);
      expect(resolved, `${testId} numeral is not the display face`).not.toBe(families.heading);
    }
  });

  test("every latest-point marker halos against the --panel plot plane", async ({ page }) => {
    await gotoReady(page, "/optimize-screen-fixture", "light");
    const chart = page.getByTestId("fx-running").getByTestId("progress-chart");
    await expect(chart).toBeVisible();

    const panel = await resolveVar(page, "backgroundColor", "--panel");
    const surface = await resolveVar(page, "backgroundColor", "--surface");
    expect(panel, "the well and L1 tones must differ for this to discriminate").not.toBe(surface);

    // Bound to the exact named instances, with the count premise-guarded: a marker
    // that stops rendering (or a testid that stops matching) fails here instead of
    // silently vacating the assertion. `stroke` is read as a resolved colour, so a
    // `var(--surface)` regression cannot pass by spelling.
    const markers = chart.locator('[data-testid$="-latest-dot"]');
    await expect(markers).toHaveCount(2);
    const ids = await markers.evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    expect(ids).toEqual([
      "progress-chart-score-panel-latest-dot",
      "progress-chart-comment-panel-latest-dot",
    ]);

    const strokes = await markers.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).stroke),
    );
    for (const [i, stroke] of strokes.entries()) {
      expect(stroke, `${ids[i]} halos against the plot plane`).toBe(panel);
      expect(stroke, `${ids[i]} must not halo against L1`).not.toBe(surface);
    }
  });

  test("the scenario stat grid stays square inside its rounded card", async ({ page }) => {
    await gotoReady(page, "/optimize-and-export", "light");
    await expect(page.getByTestId("optimize-scenario-stats")).toBeVisible();

    // DESIGN.md §5: do not round a data structure. The 16px card radius must not
    // leak into the four-cell stat grid or any of its cells.
    const grid = await paintOf(page, "optimize-scenario-stats");
    expect(grid.radius).toBe("0px");

    const cellRadii = await page
      .getByTestId("optimize-scenario-stats")
      .locator("> div")
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderRadius));
    expect(cellRadii).toHaveLength(4);
    for (const radius of cellRadii) expect(radius).toBe("0px");
  });

  // The discriminating ladder case. The chart used to be an L1 `--surface` card
  // nested directly inside another L1 card, which §4 rule 5 forbids; it is now the
  // well. An inset cast is the proof, because a well that regressed to an outer
  // shadow would still look plausible in a screenshot.
  test("the nested progress chart is a --panel well with an INSET cast", async ({ page }) => {
    await gotoReady(page, "/optimize-screen-fixture", "light");
    const chart = page.getByTestId("fx-running").getByTestId("progress-chart");
    await expect(chart).toBeVisible();

    const panel = await resolveVar(page, "backgroundColor", "--panel");
    const paint = await chart.evaluate((el) => {
      const s = getComputedStyle(el);
      return { radius: s.borderRadius, bg: s.backgroundColor, shadow: s.boxShadow };
    });
    expect(paint.bg, "an L1 card inside an L1 card becomes a well").toBe(panel);
    expect(paint.radius, "an inner bordered box takes --r-ctl").toBe("12px");
    expect(paint.shadow, "a well takes the INSET cast, never an outer one").toContain("inset");

    // Its host card is still L1, so the two tones genuinely differ.
    const host = await paintOf(page, "fx-running");
    const surface = await resolveVar(page, "backgroundColor", "--surface");
    expect(host.bg).toBe(surface);
    expect(host.bg).not.toBe(paint.bg);
  });

  // Status pairing on resolved paint, in the theme where base ≠ ink.
  test("status callouts pair their tint with the matching semantic ink (dark)", async ({
    page,
  }) => {
    await gotoReady(page, "/optimize-screen-fixture", "dark");
    await expect(page.getByTestId("optimize-fixture")).toBeVisible();

    const cases = [
      // `scoped` = the testid is on a WRAPPER, so descend to the callout slot.
      { testId: "optimize-readiness", scoped: false, tint: "--warntint", ink: "--warnink" },
      { testId: "optimize-server-offline", scoped: false, tint: "--warntint", ink: "--warnink" },
      { testId: "optimize-terminal-error", scoped: false, tint: "--errortint", ink: "--errorink" },
      {
        testId: "optimize-completed-artifact",
        scoped: true,
        tint: "--successtint",
        ink: "--successink",
      },
    ];

    for (const c of cases) {
      const root = page.getByTestId(c.testId).first();
      const callout = c.scoped ? root.locator("[data-slot='callout']").first() : root;
      await expect(callout, `${c.testId} is rendered`).toBeVisible();

      const paint = await callout.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, radius: s.borderRadius };
      });
      const tint = await resolveVar(page, "backgroundColor", c.tint);
      expect(paint.bg, `${c.testId} background resolves ${c.tint}`).toBe(tint);
      expect(paint.radius, `${c.testId} is a 12px inset island`).toBe("12px");

      const ink = await resolveVar(page, "color", c.ink);
      const base = await resolveVar(page, "color", c.ink.replace("ink", ""));
      // The pairing is only provable where the tiers differ, which is the point of
      // running this in dark mode.
      expect(base, `${c.ink} and its base tier differ in dark mode`).not.toBe(ink);
      const bodyColor = await callout
        .locator("[data-slot='callout-body']")
        .first()
        .evaluate((el) => getComputedStyle(el).color);
      expect(bodyColor, `${c.testId} body resolves the paired ${c.ink}`).toBe(ink);
    }
  });

  test("the neutral callout is the canonical well, not a bordered box (dark)", async ({ page }) => {
    await gotoReady(page, "/optimize-screen-fixture", "dark");
    const probe = page.getByTestId("fx-server-note").getByTestId("optimize-version-note");
    await expect(probe).toBeVisible();

    const paint = await probe.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, shadow: s.boxShadow, radius: s.borderRadius };
    });
    const panel = await resolveVar(page, "backgroundColor", "--panel");
    expect(paint.bg).toBe(panel);
    expect(paint.shadow, "an inset note strip carries --sh-well").toContain("inset");
    expect(paint.radius).toBe("12px");
  });

  test("event-log kind badges pair each tint with its own semantic ink (dark)", async ({
    page,
  }) => {
    await gotoReady(page, "/optimize-screen-fixture", "dark");
    const log = page.getByTestId("fx-eventlog");
    await expect(log.getByTestId("optimize-event-log")).toBeVisible();

    const cases = [
      { kind: "result", tint: "--successtint", ink: "--successink" },
      { kind: "progress", tint: "--brandtint", ink: "--brandink" },
      { kind: "phase", tint: "--warntint", ink: "--warnink" },
      { kind: "lifecycle", tint: "--panel", ink: "--ink2" },
    ];

    for (const c of cases) {
      const badge = log.locator(`[data-kind="${c.kind}"]`).first();
      await expect(badge, `${c.kind} badge is rendered`).toBeVisible();
      const paint = await badge.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, color: s.color, radius: s.borderRadius };
      });
      expect(paint.bg, `${c.kind} badge background resolves ${c.tint}`).toBe(
        await resolveVar(page, "backgroundColor", c.tint),
      );
      expect(paint.color, `${c.kind} badge text resolves the paired ${c.ink}`).toBe(
        await resolveVar(page, "color", c.ink),
      );
      expect(paint.radius, "a chip is 9px").toBe("9px");
    }
  });

  test("the terminal eyebrow uses the INK tier, not the base tier (dark)", async ({ page }) => {
    await gotoReady(page, "/optimize-screen-fixture", "dark");
    const eyebrow = page.getByTestId("fx-completed").getByTestId("optimize-terminal-eyebrow");
    await expect(eyebrow).toBeVisible();

    const color = await eyebrow.evaluate((el) => getComputedStyle(el).color);
    const successink = await resolveVar(page, "color", "--successink");
    const success = await resolveVar(page, "color", "--success");
    // In dark mode the two tiers genuinely differ, so this distinguishes them.
    expect(success).not.toBe(successink);
    expect(color).toBe(successink);

    // §5 retires the decorative leader dot on a status eyebrow.
    expect(await eyebrow.textContent()).not.toContain("●");
  });
});
