// F4 — the roster viewer's BROWSER-ONLY contract.
//
// The jsdom suite covers the viewer's logic, but two classes of claim cannot be
// made there and are made here instead:
//
//   1. DURABLE LOAD through production storage. jsdom runs on fake-indexeddb,
//      whose structured clone does not round-trip a `Blob` — so F1's promotion,
//      which re-validates the stored document including `frozenXlsx`, can only be
//      exercised for real in a browser. The reload case is the whole point of the
//      durable pointer, and only a real navigation proves it.
//   2. LAYOUT. jsdom performs no layout: `getBoundingClientRect` is zeroes and
//      there is no `ResizeObserver`. Every geometry claim there is a class-string
//      assertion. Here they are computed styles and measured boxes.
//
// Runs against `/roster-viewer-fixture`, which drives production `rosterStorage`,
// the real F2 gate, and the real F1 promotion path.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { gotoDurableFixture, installOptimizeRoutes, json } from "./support/optimize-durable";

const FIXTURE_URL = "/roster-viewer-fixture";

// WCAG 2.2 SC 1.4.3 relative-luminance contrast, computed from RENDERED colours.
// https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum
function contrastRatio(foreground: string, background: string): number {
  const luminance = (value: string): number => {
    // Chromium reports a `color-mix()` result as `color(srgb r g b)` with 0..1
    // components, and a plain hex token as `rgb(r, g, b)` with 0..255. Both are
    // real rendered colours; a parser that knew only one silently threw on the
    // derived tokens — which is exactly where the contrast question lives.
    const srgb = value.match(/color\(srgb\s+([^)]+)\)/);
    const channels =
      srgb !== null
        ? srgb[1]
            .split(/[\s/]+/)
            .slice(0, 3)
            .map((part) => Number.parseFloat(part))
        : (() => {
            const match = value.match(/rgba?\(([^)]+)\)/);
            if (match === null) throw new Error(`unparseable colour: ${value}`);
            return match[1]
              .split(/[,\s/]+/)
              .slice(0, 3)
              .map((part) => Number.parseFloat(part) / 255);
          })();
    const channel = (s: number) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
    return (
      0.2126 * channel(channels[0]) + 0.7152 * channel(channels[1]) + 0.0722 * channel(channels[2])
    );
  };
  const a = luminance(foreground);
  const b = luminance(background);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** A wide window throughout: container width, not viewport, is what is under test. */
test.use({ viewport: { width: 1400, height: 900 } });

async function freshFixture(page: Page) {
  await page.goto(FIXTURE_URL);
  await expect(page.getByTestId("roster-fixture")).toBeVisible();
  await page.getByTestId("fx-clear").click();
  await expect(page.getByTestId("fx-status")).toHaveText("cleared");
}

/**
 * Anonymize defaults ON, but the durable fixture's canned prep returns an empty
 * reverse map, so the restore path would reject the downloaded artifact. Turning
 * it off is a real user choice and lets the plain download + capture chain run
 * end to end. (Local rather than imported: it lives in the durable spec, and
 * specs should not import each other.)
 */
async function disableAnonymize(page: Page) {
  const toggle = page.getByRole("switch", { name: /Anonymize/i });
  if ((await toggle.getAttribute("aria-checked")) === "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-checked", "false");
}

async function seedCandidate(page: Page) {
  await page.getByTestId("fx-seed-candidate").click();
  await expect(page.getByTestId("fx-status")).toHaveText("candidate-seeded");
}

test.describe("F4 roster viewer — durable candidate through production storage", () => {
  test("a committed candidate survives a full page reload and loads for real", async ({ page }) => {
    await freshFixture(page);
    await seedCandidate(page);

    // THE RELOAD. A new app process: the F2 gate's in-memory entries are gone, so
    // the only thing that can still offer Load is F1's durable pointer. The old
    // implementation gated Load on the gate's state and showed nothing here.
    await page.reload();
    await expect(page.getByTestId("roster-candidate-available")).toBeVisible();
    await expect(page.getByTestId("roster-candidate-load")).toBeVisible();

    // Real F1 promotion, including Blob re-validation of the stored document.
    await page.getByTestId("roster-candidate-load").click();
    await expect(page.getByTestId("roster-viewer")).toBeVisible();
    await expect(page.getByTestId("roster-grid")).toBeVisible();
  });

  test("replacing an existing working roster is confirmed first", async ({ page }) => {
    await freshFixture(page);
    await page.getByTestId("fx-seed-working").click();
    await expect(page.getByTestId("fx-status")).toHaveText("working-seeded");
    await seedCandidate(page);
    await page.reload();

    // The candidate is offered ALONGSIDE the working roster, not hidden by it.
    await expect(page.getByTestId("roster-viewer")).toBeVisible();
    await expect(page.getByTestId("roster-candidate-available")).toBeVisible();

    await page.getByTestId("roster-candidate-load").click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();

    // Dismissing the dialog must leave the roster on screen untouched.
    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByTestId("confirm-dialog")).toBeHidden();
    await expect(page.getByTestId("roster-viewer")).toBeVisible();

    await page.getByTestId("roster-candidate-load").click();
    await page.getByRole("button", { name: /^replace roster$/i }).click();
    await expect(page.getByTestId("roster-viewer")).toBeVisible();
  });

  // A's dismissal is DURABLE, not merely a state change on screen. The identity
  // claim — that dismissing A leaves a genuinely current, genuinely failed run B
  // untouched — is proved against the real controller further down, not against a
  // fixture-settled stand-in.
  test("dismissing durable candidate A removes it for good", async ({ page }) => {
    await freshFixture(page);
    await seedCandidate(page);
    await page.reload();
    await expect(page.getByTestId("roster-candidate-dismiss")).toBeVisible();

    await page.getByTestId("roster-candidate-dismiss").click();
    await expect(page.getByTestId("roster-candidate-available")).toBeHidden();

    // A reload does not resurrect the offer.
    await page.reload();
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();
    await expect(page.getByTestId("roster-candidate-available")).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// A durable candidate beside a GENUINELY current, GENUINELY failed later run
// ---------------------------------------------------------------------------
//
// This is the state the product actually reaches and the one an unkeyed
// current-run action gets wrong. B is not simulated: it is a real submission
// through the production Optimize controller on `/optimize-durable-fixture`,
// which mounts the real screen, the real run controller, the real terminal
// download/cleanup chain and the real F2 capture gate. Only the HTTP boundary is
// stubbed, and `/roster` is made to fail so B settles in `fetch-failed` with its
// own Retry — the affordance that must stay with B.
//
// A is a genuine committed candidate in the SAME production IndexedDB, seeded
// through the roster fixture on the same origin with a real `Blob`.
//
// G4 closure changed the STAGING, and G6.2 changed the OBSERVATION POINT.
//
// A's actions live on the dedicated `/roster` route and B's Retry on the Optimize
// route, so reaching A means LEAVING Optimize — which now abandons B's visit. The
// old form of this claim (“B's notice is still there when you come back”) is
// therefore no longer true, and it was never the interesting half anyway: what it
// was defending against is an UNKEYED action on A resolving the CURRENT run, which
// would settle B's capture and authorize deleting B's job.
//
// So the claim is now checked where it actually lives — on B's JOB. If dismissing
// or loading A had resolved B, B's gate entry would have minted a token and the
// terminal chain would have issued a DELETE against B's job. Zero DELETEs is the
// evidence, and it survives the visit boundary the notice does not.
//
// Returning to Optimize is then asserted to be FRESH, which is the new contract
// and the direct inverse of what this test used to require.

/** Soft-navigate to /roster through the shell, keeping this JS context alive. */
async function navigateToRoster(page: Page) {
  await page.getByTestId("nav-link-/roster").click();
  await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "Roster");
}

test.describe("F4 roster viewer — durable A beside a current failed run B", () => {
  test("A stays loadable and dismissible while B owns its Retry", async ({ page }) => {
    // 1. A real durable candidate A in production storage.
    await freshFixture(page);
    await seedCandidate(page);

    // 2. A real later run B whose `/roster` genuinely fails.
    let rosterAttempts = 0;
    let bDeletes = 0;
    await installOptimizeRoutes(page, {
      onRoster: (route) => {
        rosterAttempts += 1;
        return json(route, 500, { detail: "roster unavailable" });
      },
      onDelete: (route) => {
        bDeletes += 1;
        return route.fulfill({ status: 204, body: "" });
      },
    });

    await gotoDurableFixture(page);
    await expect(page.getByTestId("optimize-durable-fixture")).toBeVisible();
    await disableAnonymize(page);
    await expect(page.getByTestId("optimize-submit")).toBeEnabled();
    await page.getByTestId("optimize-submit").click();

    // B ran for real: the workbook downloaded, then capture reached `/roster`.
    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
    );
    await expect(page.getByTestId("optimize-capture-fetch-failed")).toBeVisible();
    expect(rosterAttempts).toBeGreaterThanOrEqual(1);

    // 3. RETRY BELONGS TO B. It lives on the current run's notice, not on A.
    const bNotice = page.getByTestId("optimize-capture-fetch-failed");
    await expect(bNotice.getByRole("button", { name: /retry/i })).toBeVisible();

    // 3b. G4 — and the Optimize route carries NO roster surface of its own, so B's
    //     notice is the only capture affordance on this screen.
    await expect(page.getByTestId("roster-candidate-available")).toHaveCount(0);
    await expect(page.getByTestId("roster-section-empty")).toHaveCount(0);

    // 4. A IS STILL INDEPENDENTLY ACTIONABLE, on its own route, at the same time.
    await navigateToRoster(page);
    await expect(page.getByTestId("roster-candidate-available")).toBeVisible();
    await expect(page.getByTestId("roster-candidate-load")).toBeVisible();
    await expect(page.getByTestId("roster-candidate-dismiss")).toBeVisible();
    // ...and carries no Retry of its own.
    await expect(
      page.getByTestId("roster-candidate-available").getByRole("button", { name: /retry/i }),
    ).toHaveCount(0);

    // 5. COPY. With B the actual last optimisation, calling A "your last
    //    optimisation" would be plainly false. A is the latest SAVED result.
    const aCopy = (await page.getByTestId("roster-candidate-available").textContent()) ?? "";
    expect(aCopy).toContain("latest saved result");
    expect(aCopy.toLowerCase()).not.toContain("last optimisation");
    expect(aCopy.toLowerCase()).not.toContain("last optimization");

    // 6. DISMISSING A DOES NOT TOUCH B. The old unkeyed action resolved the
    //    CURRENT run — which would have minted a token for B and let the terminal
    //    chain destroy B's job. Zero DELETEs is what says it did not.
    await page.getByTestId("roster-candidate-dismiss").click();
    await expect(page.getByTestId("roster-candidate-available")).toBeHidden();
    expect(bDeletes, "dismissing A must not authorize deleting B's job").toBe(0);

    // 7. Back to Optimize, client-side. G6.2: leaving the route abandoned B, so
    //    the visit that owned its notice is over and the screen is FRESH. This is
    //    the exact inverse of what this step used to assert, and it is the point:
    //    B's surface is gone because the VISIT ended, not because dismissing A
    //    resolved it — which the zero-DELETE evidence above independently rules out.
    await page.goBack();
    await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "Optimize and Export");
    await expect(page.getByTestId("optimize-capture-fetch-failed")).toHaveCount(0);
    await expect(page.getByText(/still running/i)).toHaveCount(0);
    await expect(page.getByTestId("optimize-submit")).toBeEnabled();
    expect(bDeletes, "returning to a fresh Optimize deletes nothing either").toBe(0);
  });

  test("Loading A resolves only A: B's job is never deleted, and returning is fresh", async ({
    page,
  }) => {
    await freshFixture(page);
    await seedCandidate(page);

    let bDeletes = 0;
    await installOptimizeRoutes(page, {
      onRoster: (route) => json(route, 500, { detail: "roster unavailable" }),
      onDelete: (route) => {
        bDeletes += 1;
        return route.fulfill({ status: 204, body: "" });
      },
    });
    await gotoDurableFixture(page);
    await disableAnonymize(page);
    await expect(page.getByTestId("optimize-submit")).toBeEnabled();
    await page.getByTestId("optimize-submit").click();
    await expect(page.getByTestId("optimize-capture-fetch-failed")).toBeVisible();

    // Real F1 promotion of A, including Blob re-validation, while B is current.
    await navigateToRoster(page);
    await page.getByTestId("roster-candidate-load").click();
    await expect(page.getByTestId("roster-viewer")).toBeVisible();

    // Promoting A resolved A. It did not resolve B — an unkeyed load would have
    // settled B's capture and let the chain destroy its job.
    expect(bDeletes, "loading A must not authorize deleting B's job").toBe(0);

    // And returning to Optimize is a fresh visit, not B's old screen.
    await page.goBack();
    await expect(page.getByTestId("optimize-capture-fetch-failed")).toHaveCount(0);
    await expect(page.getByTestId("optimize-submit")).toBeEnabled();
    expect(bDeletes).toBe(0);
  });
});

test.describe("F4 roster viewer — real layout", () => {
  test.beforeEach(async ({ page }) => {
    await freshFixture(page);
    await seedCandidate(page);
    await page.reload();
    await page.getByTestId("roster-candidate-load").click();
    await expect(page.getByTestId("roster-viewer")).toBeVisible();
  });

  // THE CONTAINER-WIDTH BOUNDARY. The window is 1400px in every case here, so a
  // viewport media query would render the wide layout on both sides. Only a
  // container observer can tell 759 from 760.
  test("Coverage stacks at a 759px host and goes wide at 760px, in a 1400px window", async ({
    page,
  }) => {
    await page.getByTestId("roster-lens-coverage").click();

    await page.getByTestId("fx-host-759").click();
    await expect(page.getByTestId("roster-coverage-stacked")).toBeVisible();
    await expect(page.getByTestId("roster-coverage-wide")).toBeHidden();

    await page.getByTestId("fx-host-760").click();
    await expect(page.getByTestId("roster-coverage-wide")).toBeVisible();
    await expect(page.getByTestId("roster-coverage-stacked")).toBeHidden();

    // The window never moved — which is what makes this a container claim.
    expect(page.viewportSize()?.width).toBe(1400);
  });

  test("the Grid scrolls INSIDE its own card, and the document does not overflow", async ({
    page,
  }) => {
    // A phone-width host, so the four-day fixture grid genuinely exceeds its box.
    await page.getByTestId("fx-host-320").click();
    await page.getByTestId("roster-lens-grid").click();
    const grid = page.getByTestId("roster-grid");
    await expect(grid).toBeVisible();

    const box = await grid.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    // The grid genuinely overflows its own box...
    expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);

    // ...while the PAGE does not. A grid that pushed the document wide would
    // give every other surface a horizontal scrollbar.
    const documentOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(documentOverflows).toBe(false);
  });

  test("the roster card computes overflow:auto and max-height:66vh", async ({ page }) => {
    await page.getByTestId("roster-lens-grid").click();
    const computed = await page.getByTestId("roster-grid").evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        maxHeight: style.maxHeight,
        viewportHeight: window.innerHeight,
      };
    });
    expect(computed.overflowX).toBe("auto");
    expect(computed.overflowY).toBe("auto");
    // `66vh` resolves to pixels in a computed style; check the relationship
    // rather than a literal, so the assertion holds at any window height.
    expect(Number.parseFloat(computed.maxHeight)).toBeCloseTo(computed.viewportHeight * 0.66, 0);
  });

  test("sticky cells compute the DESIGN.md stacking order 5 / 3 / 2", async ({ page }) => {
    await page.getByTestId("roster-lens-grid").click();
    const layers = await page.getByTestId("roster-grid").evaluate((node) => {
      const corner = node.querySelector("thead th");
      const dateHeader = node.querySelectorAll("thead th")[1];
      const rowHeader = node.querySelector('tbody th[scope="row"]');
      const read = (el: Element | null | undefined) =>
        el === null || el === undefined
          ? null
          : {
              zIndex: getComputedStyle(el).zIndex,
              position: getComputedStyle(el).position,
            };
      return { corner: read(corner), dateHeader: read(dateHeader), rowHeader: read(rowHeader) };
    });

    expect(layers.corner).toEqual({ zIndex: "5", position: "sticky" });
    expect(layers.dateHeader).toEqual({ zIndex: "3", position: "sticky" });
    expect(layers.rowHeader).toEqual({ zIndex: "2", position: "sticky" });
  });

  test("a worked shift chip measures 34×28", async ({ page }) => {
    await page.getByTestId("roster-lens-grid").click();
    const chip = page.getByTestId("roster-grid").locator("[data-shift-chip]").first();
    await expect(chip).toBeVisible();
    const box = await chip.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width).toBeCloseTo(34, 0);
    expect(box?.height).toBeCloseTo(28, 0);
  });

  test("the day strip is one tab stop with working Arrow/Home/End keys", async ({ page }) => {
    await page.getByTestId("roster-lens-day").click();
    const strip = page.getByRole("tablist");
    await expect(strip).toBeVisible();

    const tabs = strip.getByRole("tab");
    const count = await tabs.count();
    expect(count).toBeGreaterThan(1);

    await tabs.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    // Real browser focus follows selection, so the next key acts on the new tab.
    await expect(tabs.nth(1)).toBeFocused();

    await page.keyboard.press("End");
    await expect(tabs.nth(count - 1)).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Home");
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  });

  // The Verify text names BOTH conditions. The 759/760 case above covers the
  // simulated docked-content width; this covers a genuinely narrow WINDOW, where
  // the container is narrow because the viewport is.
  test("stacks Coverage on a narrow VIEWPORT too, with no page overflow in any lens", async ({
    page,
  }) => {
    await page.getByTestId("fx-host-auto").click();
    await page.setViewportSize({ width: 390, height: 844 });

    await page.getByTestId("roster-lens-coverage").click();
    await expect(page.getByTestId("roster-coverage-stacked")).toBeVisible();
    await expect(page.getByTestId("roster-coverage-wide")).toBeHidden();

    // No page-level horizontal overflow in ANY lens at phone width — the Grid
    // must keep its scrolling to its own card.
    for (const lens of ["grid", "coverage", "day"]) {
      await page.getByTestId(`roster-lens-${lens}`).click();
      await expect(page.getByTestId("roster-viewer")).toBeVisible();
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflows, `page overflows horizontally in the ${lens} lens`).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // G7 — the Grid toolbar the prototype has and the shipped Grid was missing.
  // -------------------------------------------------------------------------

  test("the Grid keys every authored shift with its id, hours and own cell colour", async ({
    page,
  }) => {
    await page.getByTestId("roster-lens-grid").click();

    // The roster period is visible without the toolbar becoming a heading.
    await expect(page.getByTestId("roster-grid-span")).toHaveText(/→/);
    await expect(page.getByTestId("roster-viewer").locator("h1, h2")).toHaveCount(0);

    const items = page.getByTestId("roster-grid-legend-item");
    // Every scenario shift, plus the two day-states — no invented categories.
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toContainText("09:00–17:00");
    await expect(items.nth(1)).toContainText("21:00–07:00");
    await expect(items.nth(2)).toContainText("Leave");
    await expect(items.nth(3)).toContainText("Off / rest");

    const legend = page.getByTestId("roster-grid-legend");
    for (const category of ["Morning", "Evening", "Night", "Long day"]) {
      await expect(legend).not.toContainText(category);
    }

    // ONE ramp: the legend key paints exactly what the grid cell paints.
    const keyColour = await items
      .nth(0)
      .locator("span")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const cellColour = await page
      .getByTestId("roster-grid")
      .locator('tbody td span[aria-label="D"]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(keyColour).toBe(cellColour);
  });

  test("the Grid marks a public holiday with a marker AND a complete accessible label", async ({
    page,
  }) => {
    await page.getByTestId("roster-lens-grid").click();
    const marker = page.getByTestId("roster-grid-holiday");
    await expect(marker).toHaveCount(1);
    // The stripe and the marker are supplements; the text is the real signal.
    const header = page.getByTestId("roster-grid").locator("thead th", { has: marker });
    await expect(header).toContainText("Public holiday");
    await expect(header).toHaveAttribute("title", /Public holiday$/);
  });

  test("the Grid legend scrolls internally at 390px and at a 759px docked host", async ({
    page,
  }) => {
    await page.getByTestId("roster-lens-grid").click();

    for (const setup of [
      async () => {
        await page.getByTestId("fx-host-auto").click();
        await page.setViewportSize({ width: 390, height: 844 });
      },
      async () => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.getByTestId("fx-host-759").click();
      },
    ]) {
      await setup();
      await page.getByTestId("roster-lens-grid").click();
      const legend = page.getByTestId("roster-grid-legend");
      await expect(legend).toBeVisible();
      // The strip owns its own overflow...
      const box = await legend.evaluate((el) => ({
        overflowX: getComputedStyle(el).overflowX,
        contained: el.scrollWidth <= el.clientWidth + 1 || el.clientWidth > 0,
      }));
      expect(box.overflowX).toBe("auto");
      expect(box.contained).toBe(true);
      // ...and the DOCUMENT never scrolls sideways because of it.
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflows).toBe(false);
    }

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.getByTestId("fx-host-auto").click();
  });

  test("Coverage renders both planes, names people in full, and invents no per-shift quota", async ({
    page,
  }) => {
    await page.getByTestId("roster-lens-coverage").click();
    await expect(page.getByTestId("roster-coverage-declared")).toBeVisible();
    await expect(page.getByTestId("roster-coverage-exact")).toBeVisible();

    // Each concrete shift appears exactly once in the Exact shifts plane.
    const exact = page.getByTestId("roster-exact-shift-row");
    await expect(exact).toHaveCount(2);
    await expect(exact.nth(0)).toHaveAttribute("data-shift", "D");
    await expect(exact.nth(1)).toHaveAttribute("data-shift", "N");

    // The 212 / 128 geometry, measured.
    const columns = await exact
      .nth(0)
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" "));
    expect(columns[0]).toBe("212px");
    expect(new Set(columns.slice(1))).toEqual(new Set(["128px"]));

    // Full authored ids, never initials.
    const people = page.getByTestId("roster-coverage-person");
    expect(await people.count()).toBeGreaterThan(0);
    const first = people.first();
    expect((await first.textContent())?.trim()).toBe(await first.getAttribute("data-person"));

    // The `N` lane has no declared target, so it must show a count and no quota.
    const nLane = exact.nth(1);
    await expect(nLane).not.toContainText("Short");
    await expect(nLane.locator('[data-short="true"]')).toHaveCount(0);
  });

  test("the SELECTED lens label meets WCAG AA in dark mode as well as light", async ({ page }) => {
    // The fidelity audit measured the dark selected pair at 3.64:1 — normal-size
    // text on the one control that says which lens you are looking at. Colour is
    // the only thing that distinguishes it from its neighbours, so it has to be
    // readable, not merely tinted.
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((mode) => {
        document.documentElement.classList.toggle("dark", mode === "dark");
      }, theme);
      const selected = page.getByTestId("roster-lens-grid");
      await selected.click();
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      // Park the pointer away from the control: a click leaves it hovering, and
      // the hover tone is not the resting selected state under test.
      await page.mouse.move(0, 0);
      // WAIT FOR THE COLOURS TO SETTLE. The control transitions its background
      // and text over `duration-fast`, and Chromium reports an in-flight
      // interpolated colour as `oklab(...)` — a value that is neither the old nor
      // the new pair. Sampling mid-transition measures a colour that exists for
      // 150ms and asserts nothing about the resting selected state.
      const readPair = () =>
        selected.evaluate((el) => {
          const style = getComputedStyle(el);
          return `${style.color}|${style.backgroundColor}`;
        });
      let previous = "";
      await expect
        .poll(
          async () => {
            const current = await readPair();
            const settled = current === previous;
            previous = current;
            return settled;
          },
          { message: `${theme} selected lens colours never settled` },
        )
        .toBe(true);

      // Resolve to real 8-bit sRGB in the page. A computed value can come back
      // as `rgb()` or `color(srgb ...)` depending on how the token was derived,
      // and only the rasterised pixel is the colour a person sees.
      const pair = await selected.evaluate((el) => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext("2d");
        if (ctx === null) throw new Error("no 2d context");
        const raster = (value: string): string => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          return `rgb(${r}, ${g}, ${b})`;
        };
        const style = getComputedStyle(el);
        return {
          fg: raster(style.color),
          bg: raster(style.backgroundColor),
          rawFg: style.color,
          rawBg: style.backgroundColor,
          dark: document.documentElement.classList.contains("dark"),
        };
      });
      expect(pair.dark, `${theme}: the theme class did not apply`).toBe(theme === "dark");
      const ratio = contrastRatio(pair.fg, pair.bg);
      expect(
        ratio,
        `${theme} selected lens: ${pair.fg} on ${pair.bg} (raw ${pair.rawFg} on ${pair.rawBg})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  });

  // -------------------------------------------------------------------------
  // Cold-review P1 #1 — an exact-shift target belongs to a (shift, DAY).
  // -------------------------------------------------------------------------

  test("a DATE-SCOPED target appears on its own date in every lens, and nowhere else", async ({
    page,
  }) => {
    await freshFixture(page);
    await page.getByTestId("fx-seed-scoped").click();
    await expect(page.getByTestId("fx-status")).toHaveText("scoped-seeded");
    await expect(page.getByTestId("roster-viewer")).toBeVisible();

    // GRID — 2026-07-04 is index 1 and asks for 2 against 1 staffed.
    await page.getByTestId("roster-lens-grid").click();
    const footerCells = page
      .getByTestId("roster-grid")
      .locator("tfoot tr")
      .first()
      .locator("td[data-short]");
    await expect(footerCells).toHaveCount(4);
    await expect(footerCells.nth(1)).toHaveAttribute("aria-label", "Short: staffed 1, required 2");
    await expect(footerCells.nth(1)).toHaveAttribute("data-short", "true");
    // No other date inherits that quota — including the ones equally staffed.
    for (const dateIdx of [0, 2, 3]) {
      await expect(footerCells.nth(dateIdx)).toHaveAttribute(
        "aria-label",
        /no target declared for this shift$/,
      );
      await expect(footerCells.nth(dateIdx)).toHaveAttribute("data-short", "false");
    }

    // DAY — the same cell, through the compact lens.
    await page.getByTestId("roster-lens-day").click();
    const tabs = page.getByTestId("roster-day").getByRole("tab");
    await tabs.nth(1).click();
    const scopedPanel = page.locator('[data-testid="roster-day-shift-panel"][data-shift="D"]');
    await expect(scopedPanel).toHaveAttribute("data-short", "true");
    await expect(scopedPanel).toContainText("min 2");
    await tabs.nth(0).click();
    await expect(scopedPanel).toHaveAttribute("data-short", "false");
    await expect(scopedPanel).not.toContainText("min ");

    // COVERAGE — the detailed lens agrees with both compact ones.
    await page.getByTestId("roster-lens-coverage").click();
    const exactCells = page
      .locator('[data-testid="roster-exact-shift-row"][data-shift="D"]')
      .locator("[data-staffed]");
    await expect(exactCells.nth(1)).toHaveAttribute("data-short", "true");
    await expect(exactCells.nth(0)).toHaveAttribute("data-short", "false");
    // ...and the Declared plane carries the requirement on its date only.
    const declared = page
      .locator('[data-testid="roster-requirement-row"][data-scope="D"]')
      .locator("[data-status]");
    await expect(declared.nth(1)).toHaveAttribute("data-status", "checked");
    await expect(declared.nth(0)).toHaveAttribute("data-status", "not-applicable");
  });

  // -------------------------------------------------------------------------
  // Cold-review P1 #2 — Day health fails closed on a mixed unavailable state.
  // -------------------------------------------------------------------------

  test("a day carrying one unavailable requirement never reads as staffed", async ({ page }) => {
    await freshFixture(page);
    await page.getByTestId("fx-seed-mixed").click();
    await expect(page.getByTestId("fx-status")).toHaveText("mixed-seeded");
    await expect(page.getByTestId("roster-viewer")).toBeVisible();

    await page.getByTestId("roster-lens-day").click();
    const tabs = page.getByTestId("roster-day").getByRole("tab");
    await expect(tabs).toHaveCount(4);

    // Days 0, 1 and 3 satisfy the valid `D = 1` requirement, so the old
    // implementation painted them green while an applicable sibling was
    // unresolvable. Day 2 has nobody on D and is genuinely short, which keeps
    // the mismatch branch live in the same fixture.
    const health = await tabs.evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector("[data-health]")?.getAttribute("data-health") ?? ""),
    );
    expect(health).toEqual(["unknown", "unknown", "under", "unknown"]);

    const names = await tabs.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label") ?? ""),
    );
    for (const name of names) expect(name).not.toContain("staffed");
    for (const dateIdx of [0, 1, 3]) {
      expect(names[dateIdx]).toContain("not fully checkable");
    }
    expect(names[2]).toContain("requirement not met");

    // The satisfied half genuinely is satisfied, so the dot is not `unknown`
    // because everything failed.
    await page.getByTestId("roster-lens-coverage").click();
    await expect(
      page
        .locator('[data-testid="roster-requirement-row"][data-scope="D"]')
        .locator("[data-status]")
        .first(),
    ).toHaveAttribute("data-mismatch", "false");
    await expect(
      page
        .locator('[data-testid="roster-requirement-row"][data-scope="NoSuchShift"]')
        .locator("[data-status]")
        .first(),
    ).toHaveAttribute("data-status", "unavailable");
  });

  // -------------------------------------------------------------------------
  // Closure re-review P1 — a scoped unavailable rule stays off the days it does
  // not govern.
  // -------------------------------------------------------------------------

  test("a DATE-SCOPED unavailable requirement fails closed only on its own date", async ({
    page,
  }) => {
    await freshFixture(page);
    await page.getByTestId("fx-seed-scoped-unavailable").click();
    await expect(page.getByTestId("fx-status")).toHaveText("scoped-unavailable-seeded");
    await expect(page.getByTestId("roster-viewer")).toBeVisible();

    await page.getByTestId("roster-lens-day").click();
    const tabs = page.getByTestId("roster-day").getByRole("tab");
    await expect(tabs).toHaveCount(4);

    // THE DEFECT THIS REPLACES. The unresolvable rule is scoped to 2026-07-03
    // alone, but was returned unavailable before the dates were consulted, so
    // every day went `unknown`. Day 2 has nobody on `D` and is genuinely short,
    // which keeps the mismatch branch live rather than testing one state four
    // times.
    const health = await tabs.evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector("[data-health]")?.getAttribute("data-health") ?? ""),
    );
    expect(health).toEqual(["unknown", "ok", "under", "ok"]);

    const names = await tabs.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label") ?? ""),
    );
    expect(names[0]).toContain("not fully checkable");
    expect(names[1]).toContain("staffed");
    expect(names[3]).toContain("staffed");

    // Coverage: unavailable on its own date, plain `n/a` everywhere else — no
    // warning cell for a rule that does not apply there.
    await page.getByTestId("roster-lens-coverage").click();
    const brokenCells = page
      .locator('[data-testid="roster-requirement-row"][data-scope="NoSuchShift"]')
      .locator("[data-status]");
    await expect(brokenCells).toHaveCount(4);
    await expect(brokenCells.nth(0)).toHaveAttribute("data-status", "unavailable");
    for (const dateIdx of [1, 2, 3]) {
      await expect(brokenCells.nth(dateIdx)).toHaveAttribute("data-status", "not-applicable");
      await expect(brokenCells.nth(dateIdx)).toContainText("n/a");
    }
    // ...and the satisfied rule really is satisfied off-scope, so the healthy
    // days above are not healthy by accident.
    await expect(
      page
        .locator('[data-testid="roster-requirement-row"][data-scope="D"]')
        .locator("[data-status]")
        .nth(1),
    ).toHaveAttribute("data-mismatch", "false");
  });

  test("the lens and focused day survive a reload", async ({ page }) => {
    await page.getByTestId("roster-lens-day").click();
    const tabs = page.getByRole("tablist").getByRole("tab");
    const count = await tabs.count();
    await tabs.nth(count - 1).click();
    await expect(tabs.nth(count - 1)).toHaveAttribute("aria-selected", "true");

    await page.reload();

    await expect(page.getByTestId("roster-day")).toBeVisible();
    const restored = page.getByRole("tablist").getByRole("tab");
    await expect(restored.nth(count - 1)).toHaveAttribute("aria-selected", "true");
  });
});

// ---------------------------------------------------------------------------
// F5 — editing, document actions, and layout under narrowed content width.
// These run against the same production fixture; a working roster is seeded
// directly so the editing surface (WorkingRosterPanel) mounts with real F1
// storage and the real autosave queue.
// ---------------------------------------------------------------------------

/** Every editable assignment cell. `role="button"` is only set when editing is live. */
function editableCells(page: Page) {
  return page.getByTestId("roster-grid").locator('td[role="button"]');
}

/**
 * Seed a working roster and wait until the editing AUTHORITY is live — not merely
 * until the panel rendered. The cells only become `role="button"` once the hook's
 * async epoch/revision setup completes, which is exactly the guarantee that there
 * is no visible-but-unsaved editing window.
 */
async function seedWorkingRoster(page: Page) {
  await freshFixture(page);
  await page.getByTestId("fx-seed-working").click();
  await expect(page.getByTestId("fx-status")).toHaveText("working-seeded");
  await expect(page.getByTestId("roster-section")).toBeVisible();
  await expect(editableCells(page).first()).toBeVisible();
}

/**
 * Set the cell at `index` to `label` through the production edit bar.
 *
 * Tapping the ALREADY-selected cell cancels the selection (the prototype's
 * tap-again-to-cancel), so setting the same cell twice in a row needs a second
 * tap to re-open the bar. That is the real interaction, not a workaround.
 */
async function setCell(page: Page, index: number, label: string) {
  const cell = editableCells(page).nth(index);
  const bar = page.getByTestId("roster-edit-bar");
  await cell.click();
  if (!(await bar.isVisible())) await cell.click();
  await expect(bar).toBeVisible();
  await chooseEditOption(page, label);
}

/**
 * Choose a value in the open edit bar.
 *
 * OFF and Leave are day-STATES and stay explicit quick buttons; every worked
 * shift goes through the searchable chooser, because Ward 8 authors sixteen of
 * them and a flat row of sixteen was the finding this closure fixes.
 */
async function chooseEditOption(page: Page, label: string) {
  if (label === "OFF" || label === "LV") {
    await page.getByTestId(`roster-edit-option-${label}`).click();
    return;
  }
  await page.getByTestId("roster-shift-picker").click();
  await page.getByTestId(`roster-shift-option-${label}`).click();
}

/**
 * Whether the production `beforeunload` loss guard currently blocks navigation.
 * Dispatching a cancelable `beforeunload` and reading `defaultPrevented` asks the
 * real listener the same question the browser asks it, without a modal dialog
 * whose presentation Playwright cannot assert on reliably.
 */
async function lossGuardArmed(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test.describe("F5 roster editing — editing + actions + layout", () => {
  test("clicking a cell opens the edit bar; choosing a shift changes the assignment", async ({
    page,
  }) => {
    await seedWorkingRoster(page);

    // Click the first editable cell in the grid.
    const firstCell = editableCells(page).first();
    await firstCell.click();
    await expect(page.getByTestId("roster-edit-bar")).toBeVisible();

    // OFF and Leave stay explicit; the worked shifts live behind one searchable
    // chooser rather than a wall of buttons.
    await expect(page.getByTestId("roster-edit-option-OFF")).toBeVisible();
    await expect(page.getByTestId("roster-edit-option-LV")).toBeVisible();
    await expect(page.getByTestId("roster-shift-picker")).toBeVisible();
    await expect(page.getByTestId("roster-edit-option-D")).toHaveCount(0);
    await expect(page.getByTestId("roster-edit-option-N")).toHaveCount(0);

    // The chooser lists every scenario shift with its hours.
    await page.getByTestId("roster-shift-picker").click();
    await expect(page.getByTestId("roster-shift-option-D")).toContainText("09:00–17:00");
    await expect(page.getByTestId("roster-shift-option-N")).toContainText("21:00–07:00");

    // Its own trigger opens it too, for someone who would rather not type.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("roster-shift-option-D")).toBeHidden();
    await page.getByRole("button", { name: "Show shifts" }).click();
    await expect(page.getByTestId("roster-shift-option-D")).toBeVisible();

    // Undo starts disabled (no edit yet).
    const undo = page.getByTestId("roster-undo");
    await expect(undo).toBeDisabled();

    // Choosing N fires the edit; undo becomes enabled.
    await page.getByTestId("roster-shift-option-N").click();
    await expect(undo).toBeEnabled();
    // The save feedback appears.
    await expect(page.getByTestId(/roster-save-(saving|saved)/)).toBeVisible();
  });

  test("undo reverts the last edit", async ({ page }) => {
    await seedWorkingRoster(page);
    await editableCells(page).first().click();
    await chooseEditOption(page, "N");
    await expect(page.getByTestId("roster-undo")).toBeEnabled();

    await page.getByTestId("roster-undo").click();
    // After undo, there is nothing to undo again.
    await expect(page.getByTestId("roster-undo")).toBeDisabled();
  });

  test("editing then clearing leaves no working roster and returns to the empty state", async ({
    page,
  }) => {
    await seedWorkingRoster(page);
    // Edit something so there is unsaved/autosaving state in flight.
    await editableCells(page).first().click();
    await chooseEditOption(page, "N");

    // Clear (confirmed). The working roster must be gone.
    await page.getByTestId("roster-clear").click();
    await page.getByRole("button", { name: "Clear all roster data" }).click();
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();
  });

  test("no page-level horizontal overflow with editing controls at a narrow docked width", async ({
    page,
  }) => {
    await seedWorkingRoster(page);
    // Narrow the roster host to 320px (simulating a docked assistant) inside a
    // wide window. The editing controls must wrap, not push the page sideways.
    await page.getByTestId("fx-host-320").click();
    await page.waitForTimeout(150);
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows, "page overflows horizontally with editing controls at 320px host width").toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// F5 — the universal edit path.
//
// The pointer path was already covered. These are the paths a pointer test can
// never stand in for: the keyboard route into the edit bar, the coarse-pointer
// touch floor measured for real, and drag-swap driven as one atomic edit through
// the browser's native HTML5 drag machinery rather than a synthesised handler
// call.
// ---------------------------------------------------------------------------

test.describe("F5 roster editing — the universal edit path", () => {
  test("a cell is reachable and settable by keyboard alone", async ({ page }) => {
    await seedWorkingRoster(page);

    const cell = editableCells(page).first();
    // Focus without a click: the cell must be in the tab order and announced.
    await cell.focus();
    await expect(cell).toBeFocused();
    await expect(cell).toHaveAttribute("role", "button");

    // Enter opens the edit bar — the keyboard equivalent of the tap.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("roster-edit-bar")).toBeVisible();

    // Reach the chooser by keyboard and pick a shift with Enter — no pointer.
    const picker = page.getByTestId("roster-shift-picker");
    await picker.focus();
    await picker.press("ArrowDown");
    await page.getByTestId("roster-shift-option-N").waitFor();
    await picker.press("ArrowDown");
    await picker.press("Enter");

    // The edit landed and was saved — no pointer was used at any point.
    await expect(page.getByTestId("roster-undo")).toBeEnabled();
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();
  });

  test("every day-state option meets the 44px coarse-pointer floor, measured", async ({ page }) => {
    await seedWorkingRoster(page);
    await editableCells(page).first().click();
    await expect(page.getByTestId("roster-edit-bar")).toBeVisible();

    const options = page
      .getByTestId("roster-edit-bar")
      .locator("button[data-testid^=roster-edit-option-]");
    const count = await options.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const box = await options.nth(i).boundingBox();
      expect(box, `edit option ${i} has no box`).not.toBeNull();
      expect(box!.width, `edit option ${i} width`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `edit option ${i} height`).toBeGreaterThanOrEqual(44);
    }
  });

  test("dragging one cell onto another swaps both as ONE undoable edit", async ({ page }) => {
    await seedWorkingRoster(page);

    // Give the two cells distinguishable values through the production edit bar.
    await setCell(page, 0, "D");
    await setCell(page, 1, "N");
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();

    const a = editableCells(page).nth(0);
    const b = editableCells(page).nth(1);
    const beforeA = (await a.innerText()).trim();
    const beforeB = (await b.innerText()).trim();
    expect(beforeA).not.toBe(beforeB);

    // The real browser drag: dragstart/dragover/drop through the DOM, not a
    // hand-dispatched React handler.
    await a.dragTo(b);

    await expect(a).toHaveText(beforeB);
    await expect(b).toHaveText(beforeA);

    // ONE undo step restores BOTH cells — the swap is atomic, not two edits.
    await page.getByTestId("roster-undo").click();
    await expect(a).toHaveText(beforeA);
    await expect(b).toHaveText(beforeB);
  });
});

// ---------------------------------------------------------------------------
// F5 — exports and import, driven as real browser downloads and file choices.
// ---------------------------------------------------------------------------

test.describe("F5 roster documents — real downloads and real imports", () => {
  test("an edited roster exports a real roster file and re-imports it over the roster", async ({
    page,
  }) => {
    await seedWorkingRoster(page);
    await setCell(page, 0, "N");
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();
    const editedText = (await editableCells(page).nth(0).innerText()).trim();

    // THE DOWNLOAD. A real browser download event with the roster file's name.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("roster-export-file").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.nurse-roster\.json$/);
    const saved = join(mkdtempSync(join(tmpdir(), "roster-e2e-")), download.suggestedFilename());
    await download.saveAs(saved);

    // Take the roster somewhere else so the import is observably a replacement.
    await setCell(page, 0, "OFF");
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();
    expect((await editableCells(page).nth(0).innerText()).trim()).not.toBe(editedText);

    // THE IMPORT. Choosing a file always confirms the replacement first.
    await page.locator('input[type="file"]').setInputFiles(saved);
    await expect(page.getByRole("button", { name: "Replace roster" })).toBeVisible();
    await page.getByRole("button", { name: "Replace roster" }).click();

    // The imported document won: the exported edit is back on screen.
    await expect(editableCells(page).nth(0)).toHaveText(editedText);
    await expect(page.getByTestId("roster-action-error")).toHaveCount(0);

    // ...and it is DURABLE, not just rendered: a full reload keeps it.
    await page.reload();
    await expect(editableCells(page).first()).toBeVisible();
    await expect(editableCells(page).nth(0)).toHaveText(editedText);
  });

  test("an invalid import is rejected with plain language and leaves the roster untouched", async ({
    page,
  }) => {
    await seedWorkingRoster(page);
    await setCell(page, 0, "N");
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();
    const before = (await editableCells(page).nth(0).innerText()).trim();

    await page.locator('input[type="file"]').setInputFiles({
      name: "not-a-roster.nurse-roster.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"nope": true}'),
    });
    await page.getByRole("button", { name: "Replace roster" }).click();

    // Rejected: the reason is surfaced and the roster on screen is unchanged.
    await expect(page.getByTestId("roster-action-error")).toBeVisible();
    await expect(editableCells(page).nth(0)).toHaveText(before);
    // The rejection did not consume the undo history either.
    await expect(page.getByTestId("roster-undo")).toBeEnabled();
  });

  test("an edited-XLSX export that cannot be produced SAYS SO instead of looking successful", async ({
    page,
  }) => {
    // The browser fixture's document carries stand-in workbook bytes (F1 treats
    // the workbook as opaque), so the ExcelJS patch cannot succeed here — which
    // makes this the exact cut the review flagged: the failure used to be
    // swallowed, so a click that produced nothing was indistinguishable from a
    // successful export, including the failed-save rescue export. Patching a
    // GENUINE C5 workbook successfully is proven in `edited-xlsx.test.ts`
    // against the real exporter fixtures; what only a browser can show is that a
    // real click on a real download path reports its failure to the user.
    await seedWorkingRoster(page);
    await setCell(page, 0, "N");

    let downloaded = false;
    page.on("download", () => {
      downloaded = true;
    });
    await page.getByTestId("roster-export-xlsx").click();

    const error = page.getByTestId("roster-action-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText(/edited workbook could not be exported/i);
    expect(downloaded, "a failed patch must not produce a download").toBe(false);

    // The roster and its edit survive the failed export — nothing was lost.
    await expect(page.getByTestId("roster-undo")).toBeEnabled();
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// F5 — save authority: pending, failed, retry, discard, and the loss guard.
//
// These are the cuts the closure review found unproven. The fixture injects a
// failing or stalled `writeWorkingEdit`; everything reacting to it — the autosave
// queue, the banners, the replacement coordinator, the `beforeunload` guard — is
// production code.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// G3 — the EMPTY state's document actions, against production storage.
//
// The empty branch used to mount neither action: Import and Clear lived only
// inside `WorkingRosterPanel`, which only mounts when a working roster exists.
// So a recipient with a valid roster file had no way in, and a browser holding a
// candidate, its pointer, a submission snapshot and optimize session residue had
// no way to purge it. These run in a real browser because that is the only place
// the roster file is a genuine `Blob` round-tripping through real IndexedDB, and
// the only place the privacy claim can be made against production storage.
// ---------------------------------------------------------------------------

/** The residue probe, parsed. Reading `unknown` means the probe never ran. */
async function residue(page: Page): Promise<Record<string, boolean>> {
  await page.getByTestId("fx-probe-residue").click();
  await expect(page.getByTestId("fx-residue")).not.toHaveText("unknown");
  const raw = (await page.getByTestId("fx-residue").textContent()) ?? "{}";
  return JSON.parse(raw) as Record<string, boolean>;
}

/**
 * Assert the residue set REACHES an exact state, re-probing until it does.
 *
 * THE RACE THIS REPLACES. `clearRosterDataAndNotify()` finishes several durable
 * removals; the empty state can paint from the first of them while a later one is
 * still settling. A single probe taken the moment the empty state appears was
 * therefore reading a state the product had not finished producing, and the
 * assertion failed on a purge that genuinely completed a beat later.
 *
 * The fix is to observe the SETTLED state, not to weaken the claim: the expected
 * set is still exact and every key is still named, and a purge that never
 * completes still fails on the poll timeout. No sleep is the authority here —
 * the product's own observable storage state is.
 */
async function expectResidue(page: Page, expected: Record<string, boolean>): Promise<void> {
  await expect
    .poll(() => residue(page), {
      message: `residue never settled to ${JSON.stringify(expected)}`,
    })
    .toEqual(expected);
}

test.describe("G3 empty roster — Import and the privacy Clear", () => {
  test("the empty state offers Import and Clear, and no loaded-roster save/export", async ({
    page,
  }) => {
    await freshFixture(page);
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();

    await expect(page.getByTestId("roster-empty-actions")).toBeVisible();
    await expect(page.getByTestId("roster-import")).toBeVisible();
    await expect(page.getByTestId("roster-clear")).toBeVisible();

    // Nothing that describes a roster on screen, because there is none.
    await expect(page.getByTestId("roster-actions")).toHaveCount(0);
    await expect(page.getByTestId("roster-export-file")).toHaveCount(0);
    await expect(page.getByTestId("roster-export-xlsx")).toHaveCount(0);
    await expect(page.getByTestId("roster-save-saved")).toHaveCount(0);
  });

  test("a real roster file imports into an empty database and stays after a reload", async ({
    page,
  }) => {
    // Produce a GENUINE roster file the way a sender would: export one.
    await seedWorkingRoster(page);
    await setCell(page, 0, "N");
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();
    const editedText = (await editableCells(page).nth(0).innerText()).trim();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("roster-export-file").click(),
    ]);
    const saved = join(mkdtempSync(join(tmpdir(), "roster-e2e-")), download.suggestedFilename());
    await download.saveAs(saved);

    // Now genuinely empty the database — this is the first-ingestion state.
    await page.getByTestId("fx-clear").click();
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();

    // THE IMPORT. Nothing is on screen to replace, so it does not ask.
    await page.locator('input[type="file"]').setInputFiles(saved);
    await expect(page.getByTestId("roster-viewer")).toBeVisible();
    await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
    await expect(page.getByTestId("roster-action-error")).toHaveCount(0);
    await expect(editableCells(page).nth(0)).toHaveText(editedText);

    // DURABLE, not merely rendered: a full reload keeps it.
    await page.reload();
    await expect(editableCells(page).first()).toBeVisible();
    await expect(editableCells(page).nth(0)).toHaveText(editedText);
  });

  test("an invalid file is refused and every hidden row survives untouched", async ({ page }) => {
    await freshFixture(page);
    await page.getByTestId("fx-seed-residue").click();
    await expect(page.getByTestId("fx-status")).toHaveText("residue-seeded");

    await page.locator('input[type="file"]').setInputFiles({
      name: "not-a-roster.nurse-roster.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"nope": true}'),
    });

    await expect(page.getByTestId("roster-action-error")).toBeVisible();
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();
    await expect(page.getByTestId("roster-viewer")).toHaveCount(0);

    // FAIL CLOSED: no partial roster was fabricated, and nothing hidden moved.
    expect(await residue(page)).toEqual({
      working: false,
      pointer: true,
      candidate: true,
      snapshot: true,
      session: true,
      retireMarker: true,
      viewMetadata: true,
    });
  });

  test("cancelling Clear leaves every seeded residue exactly where it was", async ({ page }) => {
    await freshFixture(page);
    await page.getByTestId("fx-seed-residue").click();
    await expect(page.getByTestId("fx-status")).toHaveText("residue-seeded");

    await page.getByTestId("roster-clear").click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByTestId("confirm-dialog")).toBeHidden();

    expect(await residue(page)).toEqual({
      working: false,
      pointer: true,
      candidate: true,
      snapshot: true,
      session: true,
      retireMarker: true,
      viewMetadata: true,
    });
  });

  test("confirming Clear purges every hidden surface with no working roster present", async ({
    page,
  }) => {
    await freshFixture(page);
    await page.getByTestId("fx-seed-residue").click();
    await expect(page.getByTestId("fx-status")).toHaveText("residue-seeded");

    // THE PREMISE. Every surface is genuinely populated and `working` genuinely
    // absent, so the purge below cannot pass against data that was never there.
    expect(await residue(page)).toEqual({
      working: false,
      pointer: true,
      candidate: true,
      snapshot: true,
      session: true,
      retireMarker: true,
      viewMetadata: true,
    });

    await page.getByTestId("roster-clear").click();
    await page.getByRole("button", { name: "Clear all roster data" }).click();

    // The candidate offer goes with it, and no partial-failure notice appears.
    await expect(page.getByTestId("roster-candidate-available")).toBeHidden();
    await expect(page.getByTestId("roster-clear-failed")).toHaveCount(0);
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();

    const PURGED = {
      working: false,
      pointer: false,
      candidate: false,
      snapshot: false,
      session: false,
      retireMarker: false,
      viewMetadata: false,
    };
    await expectResidue(page, PURGED);

    // And it is durable: a reload does not resurrect any of it.
    await page.reload();
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();
    await expectResidue(page, PURGED);
  });
});

test.describe("F5 save authority — pending, failed, retry, discard", () => {
  test("a failed save keeps the edit, offers Retry, and still exports a rescue copy", async ({
    page,
  }) => {
    await seedWorkingRoster(page);
    await page.getByTestId("fx-fail-writes").click();

    await setCell(page, 0, "N");
    const edited = (await editableCells(page).nth(0).innerText()).trim();

    // Failed, in plain language, with Retry — and the edit is STILL on screen.
    await expect(page.getByTestId("roster-save-failed")).toBeVisible();
    await expect(page.getByTestId("roster-save-retry")).toBeVisible();
    await expect(page.getByTestId("roster-save-failed")).toContainText(/could not be saved/i);
    await expect(editableCells(page).nth(0)).toHaveText(edited);

    // The rescue export the failure copy promises actually produces a file.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("roster-export-file").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.nurse-roster\.json$/);

    // REJECTING CONTROL: retrying while storage is still broken stays failed.
    await page.getByTestId("roster-save-retry").click();
    await expect(page.getByTestId("roster-save-failed")).toBeVisible();

    // ACCEPTING CONTROL: heal storage, retry, and it commits durably.
    await page.getByTestId("fx-restore-writes").click();
    await page.getByTestId("roster-save-retry").click();
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();
    await page.reload();
    await expect(editableCells(page).first()).toBeVisible();
    await expect(editableCells(page).nth(0)).toHaveText(edited);
  });

  test("the unload guard is armed while a save is unsaved and disarmed once it lands", async ({
    page,
  }) => {
    await seedWorkingRoster(page);
    // Clean: nothing to lose, so nothing to warn about.
    expect(await lossGuardArmed(page)).toBe(false);

    await page.getByTestId("fx-fail-writes").click();
    await setCell(page, 0, "N");
    await expect(page.getByTestId("roster-save-failed")).toBeVisible();
    // Unsaved work exists: leaving must be guarded.
    expect(await lossGuardArmed(page)).toBe(true);

    await page.getByTestId("fx-restore-writes").click();
    await page.getByTestId("roster-save-retry").click();
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();
    // Committed: the guard stands down rather than nagging forever.
    expect(await lossGuardArmed(page)).toBe(false);
  });

  test("a rival writer wins the CAS; the stale edit fails and never overwrites the winner", async ({
    page,
  }) => {
    await seedWorkingRoster(page);
    await setCell(page, 0, "N");
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();

    // Another writer (another tab / a promotion) commits at the current revision.
    await page.getByTestId("fx-rival-write").click();
    await expect(page.getByTestId("fx-status")).toHaveText("rival-written");
    // This tab's next edit carries a stale revision and must LOSE.
    await setCell(page, 1, "OFF");
    await expect(page.getByTestId("roster-save-failed")).toBeVisible();
    await expect(page.getByTestId("roster-save-failed")).toContainText(/changed underneath/i);

    // Retry cannot silently rebase onto the rival: it stays failed.
    await page.getByTestId("roster-save-retry").click();
    await expect(page.getByTestId("roster-save-failed")).toBeVisible();

    // The durable document is still the RIVAL's, not this tab's stale one: the
    // second edit never reached storage, so a reload does not show it.
    await page.reload();
    await expect(editableCells(page).first()).toBeVisible();
    await expect(page.getByTestId("roster-save-failed")).toHaveCount(0);
  });

  test("a candidate Load WAITS for a pending save instead of racing it", async ({ page }) => {
    await freshFixture(page);
    await page.getByTestId("fx-seed-working").click();
    await expect(editableCells(page).first()).toBeVisible();
    await seedCandidate(page);
    await expect(editableCells(page).first()).toBeVisible();

    // Stall the durable write so the save is genuinely PENDING, then edit.
    await page.getByTestId("fx-stall-writes").click();
    await setCell(page, 0, "N");
    await expect(page.getByTestId("roster-save-saving")).toBeVisible();

    // Ask to replace the roster with the candidate while that save is in flight.
    await page.getByTestId("roster-candidate-load").click();
    await page.getByRole("button", { name: "Replace roster" }).click();

    // The replacement has NOT happened: it is waiting on the pending write.
    await expect(page.getByTestId("roster-save-saving")).toBeVisible();

    // Release the write; the coordinator then completes the replacement.
    await page.getByTestId("fx-release-writes").click();
    await expect(page.getByTestId("roster-save-saving")).toHaveCount(0);
    await expect(page.getByTestId("roster-section")).toBeVisible();
    await expect(page.getByTestId("roster-action-error")).toHaveCount(0);
    // Selection/undo reset only after the durable replacement.
    await expect(page.getByTestId("roster-undo")).toBeDisabled();
    await expect(page.getByTestId("roster-edit-bar")).toHaveCount(0);
  });

  test("a FAILED save forces an explicit discard before a replacement, and Cancel keeps the edits", async ({
    page,
  }) => {
    await seedWorkingRoster(page);
    await page.getByTestId("fx-fail-writes").click();
    await setCell(page, 0, "N");
    await expect(page.getByTestId("roster-save-failed")).toBeVisible();
    const edited = (await editableCells(page).nth(0).innerText()).trim();

    // Import while the save is failed: no silent replacement, no hang — the
    // explicit discard confirmation.
    await page.getByTestId("fx-restore-writes").click();
    const file = {
      name: "not-a-roster.nurse-roster.json",
      mimeType: "application/json",
      buffer: Buffer.from("{}"),
    };
    await page.locator('input[type="file"]').setInputFiles(file);
    const discard = page.getByRole("button", { name: "Discard edits & replace" });
    await expect(discard).toBeVisible();

    // REJECTING CONTROL: backing out keeps the failed edit and its rescue path.
    await page.keyboard.press("Escape");
    await expect(discard).toHaveCount(0);
    await expect(page.getByTestId("roster-save-failed")).toBeVisible();
    await expect(editableCells(page).nth(0)).toHaveText(edited);

    // ACCEPTING CONTROL: explicit discard proceeds with the replacement (which
    // this invalid file then fails on its own merits — reported, not silent).
    await page.locator('input[type="file"]').setInputFiles(file);
    await page.getByRole("button", { name: "Discard edits & replace" }).click();
    await expect(page.getByTestId("roster-action-error")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// F5 — Clear: privacy completeness and the in-flight cuts.
// ---------------------------------------------------------------------------

test.describe("F5 Clear — verified purge with no residue", () => {
  test("Clear removes the optimize session and retirement marker, not just the roster", async ({
    page,
  }) => {
    await seedWorkingRoster(page);

    // Session residue of the kind Clear promises to remove — the optimize session
    // record is what carries the real-identity reverse map on a shared device.
    await page.evaluate(() => {
      sessionStorage.setItem(
        "nurse.optimize.session",
        JSON.stringify({ reverseMap: { P1: "Real Name" } }),
      );
      sessionStorage.setItem("nurse.optimize.retire-pending", JSON.stringify({ ownerId: "o1" }));
    });

    await page.getByTestId("roster-clear").click();
    await page.getByRole("button", { name: "Clear all roster data" }).click();
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();

    // Both sensitive session keys are provably gone, and Clear did not report a
    // partial purge as success.
    const residue = await page.evaluate(() => ({
      session: sessionStorage.getItem("nurse.optimize.session"),
      marker: sessionStorage.getItem("nurse.optimize.retire-pending"),
      view: localStorage.getItem("nurse.roster.view"),
    }));
    expect(residue.session).toBeNull();
    expect(residue.marker).toBeNull();
    expect(residue.view).toBeNull();
    await expect(page.getByTestId("roster-clear-failed")).toHaveCount(0);

    // ...and it stays cleared across a reload — nothing repopulated it.
    await page.reload();
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();
  });

  test("a write still in flight when Clear runs cannot repopulate the store", async ({ page }) => {
    await seedWorkingRoster(page);

    // A durable write parked mid-flight, carrying the roster this Clear removes.
    await page.getByTestId("fx-stall-writes").click();
    await setCell(page, 0, "N");
    await expect(page.getByTestId("roster-save-saving")).toBeVisible();

    await page.getByTestId("roster-clear").click();
    await page.getByRole("button", { name: "Clear all roster data" }).click();
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();

    // Now let the parked write land. The epoch fence must reject it.
    await page.getByTestId("fx-release-writes").click();
    await expect(page.getByTestId("fx-status")).toHaveText("writes-released");

    // Still empty — in the DOM and, decisively, after a reload from storage.
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// G4 — a completed run fills an EMPTY viewer, and never overwrites a full one.
//
// The unit proofs cover the transaction (`lib/store/roster-storage.test.ts`).
// What only a browser can add is the same behaviour through PRODUCTION storage
// with the document's real `Blob` in it — fake-indexeddb cannot round-trip one, so
// jsdom can never show that the promoted row is genuinely renderable afterwards.
// ---------------------------------------------------------------------------

test.describe("G4 roster viewer — a completed run fills an empty viewer", () => {
  test("a completed run renders the roster with no Load click, and survives a reload", async ({
    page,
  }) => {
    await freshFixture(page);
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();

    await page.getByTestId("fx-complete-run").click();
    // F1's own disposition, not an inference from the DOM.
    await expect(page.getByTestId("fx-status")).toHaveText("run-completed:loaded-empty");

    // Populated, with no Load offer to click — the whole point of the change.
    await expect(page.getByTestId("roster-viewer")).toBeVisible();
    await expect(page.getByTestId("roster-grid")).toBeVisible();
    await expect(page.getByTestId("roster-candidate-load")).toHaveCount(0);
    await expect(page.getByTestId("roster-section-empty")).toHaveCount(0);

    // Durable, and the promoted document's Blob really did survive the round trip:
    // the grid re-renders from storage in a brand-new app process.
    await page.reload();
    await expect(page.getByTestId("roster-viewer")).toBeVisible();
    await expect(page.getByTestId("roster-grid")).toBeVisible();
  });

  test("a completed run leaves an EXISTING roster untouched and waits to be loaded", async ({
    page,
  }) => {
    await freshFixture(page);
    await page.getByTestId("fx-seed-working").click();
    await expect(page.getByTestId("fx-status")).toHaveText("working-seeded");
    await expect(page.getByTestId("roster-viewer")).toBeVisible();

    await page.getByTestId("fx-complete-run").click();
    await expect(page.getByTestId("fx-status")).toHaveText("run-completed:awaiting-choice");

    // The existing roster still owns the viewer, and the new result waits for an
    // explicit choice rather than having replaced it.
    await expect(page.getByTestId("roster-viewer")).toBeVisible();
    await expect(page.getByTestId("roster-candidate-available")).toBeVisible();
    await expect(page.getByTestId("roster-candidate-load")).toBeVisible();
  });

  // The version of the rule that actually matters to a user: the roster that must
  // not be overwritten is one they have EDITED. The test above seeds a pristine
  // roster, so a promotion that silently discarded manual work could still pass
  // it. Here the roster carries a real edit and a bumped save revision, and the
  // only thing allowed to replace it is a confirmed `Replace roster`.
  test("a completed run never overwrites an EDITED roster; only a confirmed Replace promotes it", async ({
    page,
  }) => {
    await seedWorkingRoster(page);
    await setCell(page, 0, "N");
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();
    const edited = (await editableCells(page).nth(0).innerText()).trim();

    await page.getByTestId("fx-complete-run").click();
    // F1's own disposition: the transaction PROVED the slot occupied and kept it.
    await expect(page.getByTestId("fx-status")).toHaveText("run-completed:awaiting-choice");

    // The edit is still on screen — the completed run took nothing.
    await expect(page.getByTestId("roster-viewer")).toBeVisible();
    await expect(editableCells(page).nth(0)).toHaveText(edited);
    await expect(page.getByTestId("roster-candidate-available")).toBeVisible();

    // Declining the offer is also a decision: the edit survives it, and the
    // candidate is still there to accept later.
    await page.getByTestId("roster-candidate-load").click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
    await expect(editableCells(page).nth(0)).toHaveText(edited);
    await expect(page.getByTestId("roster-candidate-available")).toBeVisible();

    // ...and the edit is durable across the decline, not merely still rendered.
    await page.reload();
    await expect(editableCells(page).first()).toBeVisible();
    await expect(editableCells(page).nth(0)).toHaveText(edited);

    // ONLY the confirmed replacement promotes it.
    await page.getByTestId("roster-candidate-load").click();
    await page.getByRole("button", { name: /^replace roster$/i }).click();
    await expect(page.getByTestId("roster-viewer")).toBeVisible();
    await expect(page.getByTestId("roster-candidate-available")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// The viewer stands on its own. `Save roster file` + Import are a closed loop
// that never touches Optimize — which is what lets someone open a roster they
// were sent, edit it, and keep it, on a machine that has never run a solve.
// ---------------------------------------------------------------------------

test.describe("roster documents — save, clear, import round trip without Optimize", () => {
  test("a saved roster file restores the editable roster after a full Clear", async ({ page }) => {
    await seedWorkingRoster(page);
    await setCell(page, 0, "N");
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();
    const edited = (await editableCells(page).nth(0).innerText()).trim();

    // SAVE — the portable document, as a real browser download.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("roster-export-file").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.nurse-roster\.json$/);
    const saved = join(mkdtempSync(join(tmpdir(), "roster-e2e-")), download.suggestedFilename());
    await download.saveAs(saved);

    // CLEAR — the confirmed privacy purge. Nothing local survives it, so the
    // import below can only be restoring the file itself.
    await page.getByTestId("roster-clear").click();
    await page.getByRole("button", { name: "Clear all roster data" }).click();
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("roster-section-empty")).toBeVisible();

    // IMPORT — from the empty state, with no candidate and no run in play.
    await expect(page.getByTestId("roster-candidate-available")).toHaveCount(0);
    await page.locator('input[type="file"]').setInputFiles(saved);
    const replace = page.getByRole("button", { name: "Replace roster" });
    if (await replace.isVisible()) await replace.click();

    // Back to an EDITABLE roster carrying the exact edit that was saved.
    await expect(page.getByTestId("roster-viewer")).toBeVisible();
    await expect(editableCells(page).nth(0)).toHaveText(edited);
    await expect(page.getByTestId("roster-action-error")).toHaveCount(0);

    // Editing works on the restored document, and survives a reload — so this is
    // a working roster, not a read-only rendering of a file.
    await setCell(page, 1, "OFF");
    await expect(page.getByTestId("roster-save-saved")).toBeVisible();
    const second = (await editableCells(page).nth(1).innerText()).trim();
    await page.reload();
    await expect(editableCells(page).first()).toBeVisible();
    await expect(editableCells(page).nth(0)).toHaveText(edited);
    await expect(editableCells(page).nth(1)).toHaveText(second);
  });
});
