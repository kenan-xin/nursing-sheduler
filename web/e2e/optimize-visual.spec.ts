import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  OPTIMIZE_SESSION_SCHEMA_VERSION,
  OPTIMIZE_SESSION_STORAGE_KEY,
  type ActiveOptimizeSession,
} from "@/lib/optimize/session-transaction";
import {
  installOptimizeRoutes,
  JOB_ID,
  runningFrame,
  runningJob,
  json,
  sse,
} from "./support/optimize-durable";

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

/** Resolve a shadow token to its computed value on this page, via a probe. */
async function resolveShadow(page: Page, token: string) {
  return page.evaluate((t) => {
    const probe = document.createElement("div");
    probe.style.boxShadow = `var(${t})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).boxShadow;
    probe.remove();
    return value;
  }, token);
}

/**
 * The three type faces, resolved live. Every mono assertion below is guarded on
 * these being mutually distinct: if the three tokens ever collapsed onto one
 * stack (a missing font variable, a failed `next/font` load) then "resolves the
 * mono face" would be trivially true everywhere and would prove nothing.
 */
async function resolveFaces(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    document.body.appendChild(probe);
    const read = (token: string) => {
      probe.style.fontFamily = `var(${token})`;
      return getComputedStyle(probe).fontFamily;
    };
    const faces = {
      mono: read("--ff-mono"),
      body: read("--ff-body"),
      heading: read("--ff-heading"),
    };
    probe.remove();
    return faces;
  });
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

// ---------------------------------------------------------------------------
// R6 Round 9B — the mono data face, on RESOLVED paint
// ---------------------------------------------------------------------------
//
// `optimize-v2-roles.test.tsx` pins the authored contract (which class, on which
// element, with the size/weight/ink retained). It cannot prove that the class
// resolves to a genuinely different family, because jsdom never loads a font. So
// these read `getComputedStyle().fontFamily` in a real Chromium, against the three
// token stacks resolved live on the same page, with their mutual distinctness as
// an explicit precondition.

test.describe("R6 Optimize & Export — data-bearing values resolve the mono face", () => {
  test("every data value on the harness resolves mono, and its prose does not", async ({
    page,
  }) => {
    await gotoReady(page, "/optimize-screen-fixture", "light");
    await expect(page.getByTestId("optimize-fixture")).toBeVisible();

    const faces = await resolveFaces(page);
    expect(
      new Set([faces.mono, faces.body, faces.heading]).size,
      "mono, body and display must be three distinct stacks for this to discriminate",
    ).toBe(3);

    const running = page.getByTestId("fx-running");
    const completed = page.getByTestId("fx-completed");
    const log = page.getByTestId("fx-eventlog");

    const targets = [
      { label: "live incumbent score", locator: running.getByTestId("optimize-score") },
      {
        label: "terminal solver status",
        locator: completed.getByTestId("optimize-summary-solver-status"),
      },
      {
        label: "terminal final score",
        locator: completed.getByTestId("optimize-summary-final-score"),
      },
      { label: "terminal elapsed", locator: completed.getByTestId("optimize-summary-elapsed") },
      { label: "event count", locator: log.getByTestId("optimize-event-count") },
      { label: "event time", locator: log.getByTestId("optimize-event-time").first() },
    ];

    for (const target of targets) {
      await expect(target.locator, `${target.label} is rendered`).toBeVisible();
      const resolved = await target.locator.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(resolved, `${target.label} resolves the mono data face`).toBe(faces.mono);
      expect(resolved, `${target.label} is not the display face`).not.toBe(faces.heading);
    }

    // The controls: prose beside the data must NOT have been swept into mono.
    const prose = [
      {
        label: "score explainer",
        // Exact: the nested chart header opens with the same sentence.
        locator: running.getByText("Higher scores are better.", { exact: true }),
      },
      { label: "job detail line", locator: running.getByTestId("optimize-job-detail") },
    ];
    for (const control of prose) {
      await expect(control.locator, `${control.label} is rendered`).toBeVisible();
      const resolved = await control.locator.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(resolved, `${control.label} is prose, not data`).not.toBe(faces.mono);
      expect(resolved, `${control.label} stays on the body face`).toBe(faces.body);
    }
  });

  test("the chart tooltip's four values resolve mono while its captions do not", async ({
    page,
  }) => {
    await gotoReady(page, "/optimize-screen-fixture", "light");
    const running = page.getByTestId("fx-running");
    await expect(running.getByTestId("progress-chart")).toBeVisible();

    const faces = await resolveFaces(page);
    expect(new Set([faces.mono, faces.body, faces.heading]).size).toBe(3);

    // The tooltip exists only while a point is inspected. Drive the keyboard
    // inspector — the same surface a keyboard-only user reaches.
    await running.getByRole("group", { name: /Progress data points/ }).focus();
    const tooltip = running.getByTestId("progress-chart-tooltip");
    await expect(tooltip).toBeVisible();

    for (const testId of [
      "progress-chart-tooltip-elapsed",
      "progress-chart-tooltip-score",
      "progress-chart-tooltip-comments",
      "progress-chart-tooltip-solution",
    ]) {
      const value = tooltip.getByTestId(testId);
      await expect(value, `${testId} is rendered`).toBeVisible();
      expect(
        await value.evaluate((el) => getComputedStyle(el).fontFamily),
        `${testId} resolves the mono data face`,
      ).toBe(faces.mono);
    }

    // The "elapsed" noun and the dt captions are prose on the body face.
    const captions = await tooltip
      .locator("dt")
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).fontFamily));
    expect(captions.length).toBeGreaterThan(0);
    for (const caption of captions) expect(caption).toBe(faces.body);
  });

  test("the real route's own event count resolves the mono face", async ({ page }) => {
    await gotoReady(page, "/optimize-and-export", "light");
    await expect(page.getByTestId("optimize-event-log")).toBeVisible();

    const faces = await resolveFaces(page);
    expect(new Set([faces.mono, faces.body, faces.heading]).size).toBe(3);

    const count = page.getByTestId("optimize-event-count");
    await expect(count).toHaveText("0");
    expect(await count.evaluate((el) => getComputedStyle(el).fontFamily)).toBe(faces.mono);

    // The "events" noun beside it is the prose half of the same line.
    const line = count.locator("xpath=..");
    await expect(line).toHaveText("0 events");
    expect(await line.evaluate((el) => getComputedStyle(el).fontFamily)).toBe(faces.body);
  });
});

// ---------------------------------------------------------------------------
// R6 Round 9B — the page-plane recovery notices sit on a real rung of the ladder
// ---------------------------------------------------------------------------
//
// The two NEUTRAL recovery states used to render the inset `--panel` well
// directly onto the L0 route root: a recessed plane with no plane to be recessed
// into, which DESIGN.md §4 forbids twice over ("nothing floats free on it", and a
// well lives "*inside* an L1 card"). Both are now the L1 role.
//
// These run against the REAL product route — not the presentational harness —
// because the harness never rendered these two states at all, which is precisely
// why the defect survived. Recovery is driven through the genuine T16b inspection
// path: a seeded durable session record for the attached case, and a denied read
// of that record's own key for the storage-unavailable case.

const PRODUCT_ROUTE = "/optimize-and-export";

/** Deny reads of the durable recovery record only — every other sessionStorage
 *  key still works, so this reproduces the real `storage-error` classification
 *  without breaking the framework's own use of the same API. */
async function denyRecoveryRecordAccess(page: Page) {
  await page.addInitScript((key: string) => {
    const real = window.sessionStorage;
    const denied = (): never => {
      throw new Error("sessionStorage is unavailable.");
    };
    const stub = {
      getItem: (k: string) => (k === key ? denied() : real.getItem(k)),
      setItem: (k: string, v: string) => (k === key ? denied() : real.setItem(k, v)),
      removeItem: (k: string) => (k === key ? denied() : real.removeItem(k)),
      clear: () => real.clear(),
      key: (i: number) => real.key(i),
    };
    Object.defineProperty(stub, "length", { get: () => real.length });
    Object.defineProperty(window, "sessionStorage", { configurable: true, get: () => stub });
  }, OPTIMIZE_SESSION_STORAGE_KEY);
}

/** Seed a valid ACTIVE durable session so T16b recovery resolves to `attached`. */
async function seedAttachedSession(page: Page) {
  const record: ActiveOptimizeSession = {
    schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
    ownerId: "owner-r6-visual-attached",
    phase: "active",
    jobId: JOB_ID,
    anonymized: false,
    runOptions: { prettify: false, timeout: 300 },
    peopleCount: 0,
    reverseMap: [],
    lastCursor: "c0",
  };
  await page.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), {
    key: OPTIMIZE_SESSION_STORAGE_KEY,
    value: JSON.stringify(record),
  });
  // Keep the resumed run live and deterministic; an unstubbed /api/** would
  // reach the dev server's real proxy.
  await installOptimizeRoutes(page, {
    onPoll: (route) => json(route, 200, runningJob()),
    onEvents: (route) => sse(route, [runningFrame("c1")]),
  });
}

/**
 * The full ladder claim for one page-mounted neutral notice, on resolved paint:
 * it is L1, it is NOT the well it used to be, and the plane it is mounted on is
 * genuinely L0. Every expected value is resolved from a token on the same page.
 */
async function expectSeatedAtL1(page: Page, testId: string) {
  const notice = page.getByTestId(testId);
  await expect(notice, `${testId} is rendered`).toBeVisible();

  const surface = await resolveVar(page, "backgroundColor", "--surface");
  const panel = await resolveVar(page, "backgroundColor", "--panel");
  const bg = await resolveVar(page, "backgroundColor", "--bg");
  const line = await resolveVar(page, "color", "--line");
  const sh1 = await resolveShadow(page, "--sh-1");
  // Premise: the three planes must differ, or none of this discriminates.
  expect(new Set([surface, panel, bg]).size, "L0, L1 and the well tone must differ").toBe(3);

  const paint = await notice.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      bg: s.backgroundColor,
      border: s.borderColor,
      shadow: s.boxShadow,
      radius: s.borderRadius,
    };
  });
  expect(paint.bg, `${testId} sits on --surface`).toBe(surface);
  expect(paint.bg, `${testId} is no longer the well tone`).not.toBe(panel);
  expect(paint.border, `${testId} takes the primary --line edge`).toBe(line);
  // `toContain`, not equality: Tailwind composes its shadow utility out of
  // several layers and emits zero-alpha placeholders for the ring/inset slots it
  // is not using, so the resolved token is the tail of a longer list.
  expect(paint.shadow, `${testId} carries --sh-1`).toContain(sh1);
  expect(paint.shadow, `${testId} is raised, never inset (§4 rule 1)`).not.toContain("inset");
  expect(paint.radius, `${testId} is a 16px card`).toBe("16px");

  // Hierarchy: the mount point is the L0 route root itself. This is the whole
  // reason the well was illegal, so it is asserted rather than assumed — if the
  // notice were ever nested inside a card, the well would become correct again
  // and this test would be pinning the wrong treatment.
  const host = await notice.evaluate((el) => {
    const parent = el.parentElement!;
    const s = getComputedStyle(parent);
    return {
      testId: parent.getAttribute("data-testid"),
      level: parent.getAttribute("data-level"),
      bg: s.backgroundColor,
      shadow: s.boxShadow,
    };
  });
  expect(host.testId, `${testId} is a direct child of the route root`).toBe("screen");
  expect(host.level, "the route root is the L0 page plane").toBe("page");
  expect(host.bg).toBe(bg);
  expect(host.shadow, "L0 is flat").toBe("none");
  expect(paint.bg, "the notice reads as a surface ON the plane, not as the plane").not.toBe(
    host.bg,
  );
}

test.describe("R6 Optimize & Export — page-plane recovery notices (real route)", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`storage-unavailable is seated at L1 on the page plane (${theme})`, async ({ page }) => {
      await denyRecoveryRecordAccess(page);
      await gotoReady(page, PRODUCT_ROUTE, theme);
      await expect(page.getByTestId("screen")).toBeVisible();
      await expectSeatedAtL1(page, "optimize-storage-error");
    });

    test(`an attached resume is seated at L1 on the page plane (${theme})`, async ({ page }) => {
      await seedAttachedSession(page);
      await gotoReady(page, PRODUCT_ROUTE, theme);
      await expect(page.getByTestId("screen")).toBeVisible();
      await expectSeatedAtL1(page, "optimize-resumed");
    });
  }

  // The status-tinted notices must NOT have been swept along with the fix: their
  // tint plus a matching semantic border is already a self-contained page banner,
  // and it is the treatment the prototype authors for one.
  test("a status-tinted page notice keeps its tint and takes no L1 fill (dark)", async ({
    page,
  }) => {
    await denyRecoveryRecordAccess(page);
    await gotoReady(page, PRODUCT_ROUTE, "dark");
    await expect(page.getByTestId("optimize-storage-error")).toBeVisible();

    // The readiness banner is the route's other page-plane callout, and an empty
    // store always fails readiness, so it renders on a bare visit.
    const banner = page.getByTestId("optimize-readiness");
    await expect(banner).toBeVisible();
    const paint = await banner.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, radius: s.borderRadius, placement: el.dataset.placement };
    });
    expect(paint.bg).toBe(await resolveVar(page, "backgroundColor", "--warntint"));
    expect(paint.bg).not.toBe(await resolveVar(page, "backgroundColor", "--surface"));
    expect(paint.radius, "a tinted island stays a 12px inset island").toBe("12px");
  });
});

// ---------------------------------------------------------------------------
// R6 Round 9B — the prototype comparison behind the recorded deviation
// ---------------------------------------------------------------------------

/** Every prototype screen that authors a page-level NEUTRAL note strip. */
const PROTOTYPE_NEUTRAL_NOTE_SCREENS = [
  "ScreenCards.dc.html",
  "ScreenRequests.dc.html",
  "ScreenRules.dc.html",
] as const;

/**
 * The prototype's own authored declaration for a page-level neutral note, read
 * from the canonical source at test time. Extracting it (rather than restating
 * it) is what makes this a comparison: if the prototype ever changes that
 * treatment, this stops matching and the recorded deviation must be revisited.
 */
function prototypeNeutralNoteStyles(): Array<{ screen: string; style: string }> {
  const dir = join(__dirname, "..", "..", "docs", "design_prototype", "source");
  return PROTOTYPE_NEUTRAL_NOTE_SCREENS.map((screen) => {
    const html = readFileSync(join(dir, screen), "utf8");
    const match = html.match(
      /style="([^"]*border:1px solid var\(--line\);background:var\(--panel\);[^"]*)"/,
    );
    if (match === null) {
      throw new Error(`no page-level neutral note strip found in ${screen}`);
    }
    return { screen, style: match[1] };
  });
}

test.describe("R6 Optimize & Export — measured against the prototype's page-level note", () => {
  test("the product deviates exactly where DESIGN.md §4 says it must", async ({ page }) => {
    await denyRecoveryRecordAccess(page);
    await gotoReady(page, PRODUCT_ROUTE, "light");
    await expect(page.getByTestId("optimize-storage-error")).toBeVisible();

    // Premise: all three canonical screens still author the same treatment.
    const authored = prototypeNeutralNoteStyles();
    expect(authored).toHaveLength(PROTOTYPE_NEUTRAL_NOTE_SCREENS.length);

    // Resolve the prototype's authored declaration in THIS Chromium, against the
    // very tokens the port ships, so the two treatments are measured on one page
    // rather than compared across two renderers. The prototype's substring
    // compatibility CSS is deliberately absent — DESIGN.md §1 forbids porting it,
    // so the authored declaration is the whole of its authority.
    const measured = await page.evaluate(
      (styles: string[]) => {
        return styles.map((style) => {
          const probe = document.createElement("div");
          probe.setAttribute("style", style);
          document.body.appendChild(probe);
          const s = getComputedStyle(probe);
          const paint = {
            bg: s.backgroundColor,
            border: s.borderColor,
            shadow: s.boxShadow,
            radius: s.borderRadius,
          };
          probe.remove();
          return paint;
        });
      },
      authored.map((a) => a.style),
    );

    const panel = await resolveVar(page, "backgroundColor", "--panel");
    const surface = await resolveVar(page, "backgroundColor", "--surface");
    const line = await resolveVar(page, "color", "--line");

    for (const [i, paint] of measured.entries()) {
      const screen = authored[i].screen;
      // What the prototype actually does: a FLAT `--panel` strip on the page
      // plane, with the primary `--line` edge, no shadow and no radius.
      expect(paint.bg, `${screen} authors the well tone`).toBe(panel);
      expect(paint.border, `${screen} authors the --line edge`).toBe(line);
      expect(paint.shadow, `${screen} authors no cast at all`).toBe("none");
      expect(paint.radius, `${screen} authors no radius`).toBe("0px");
    }

    const ours = await page.getByTestId("optimize-storage-error").evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, border: s.borderColor, shadow: s.boxShadow };
    });

    // THE DEVIATION, stated as a measurement: same edge token, different plane.
    // §4 has no rung for a `--panel` surface mounted on L0, so the product seats
    // the notice at L1 instead. Recorded in DESIGN.md §1's deviation matrix.
    expect(ours.border, "the edge token is kept").toBe(line);
    expect(ours.bg, "the plane is not").toBe(surface);
    expect(ours.bg, "and it is genuinely a different plane from the prototype's").not.toBe(panel);
    expect(ours.shadow, "L1 carries the outer cast the prototype's flat strip has not").not.toBe(
      "none",
    );
  });
});
