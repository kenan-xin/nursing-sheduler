import { expect, test, type Page } from "@playwright/test";

// G8 — the ratified persisted desktop sidebar collapse.
//
// The prototype has always specified a `≥920px` rail that toggles between the
// expanded panel and a 60px icon rail, persisted under `ns-side-collapsed`
// (prototype README, "Collapsible sidebar"). DESIGN.md's deviation matrix used
// to exclude it; the user superseded that exclusion, and the matrix now records
// the shipped 280/60 pair.
//
// Every claim here is a MEASURED box or a real reload. The jsdom suites
// (components/shell/side-collapse.test.ts, compact-rail.test.tsx) already pin
// the store, the pre-paint script and the compact content contract; what only a
// browser can prove is the geometry, the persistence across a real navigation,
// the main column's width gain, and the below-920 independence.

const EXPANDED = 280;
const COMPACT = 60;

async function gotoHome(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("home-screen")).toBeVisible();
}

async function railWidth(page: Page): Promise<number> {
  const box = await page.getByTestId("desktop-sidebar").boundingBox();
  if (box === null) throw new Error("no desktop rail");
  return box.width;
}

async function mainWidth(page: Page): Promise<number> {
  const box = await page.getByTestId("top-bar").boundingBox();
  if (box === null) throw new Error("no top bar");
  return box.width;
}

test.describe("G8 desktop sidebar collapse — geometry and persistence", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test("collapses 280 → 60 and expands back, and the main column gains the difference", async ({
    page,
  }) => {
    await gotoHome(page);
    expect(await railWidth(page)).toBeCloseTo(EXPANDED, 0);
    const mainExpanded = await mainWidth(page);

    const toggle = page.getByTestId("side-collapse-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-label", "Collapse sidebar");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await toggle.click();
    await expect(page.getByTestId("desktop-sidebar")).toHaveAttribute("data-collapsed", "true");
    await expect
      .poll(() => railWidth(page), { message: "rail settles at the compact width" })
      .toBeCloseTo(COMPACT, 0);

    // The whole point of the feature: the content plane gets the 220px back.
    const mainCompact = await mainWidth(page);
    expect(mainCompact - mainExpanded).toBeCloseTo(EXPANDED - COMPACT, 0);

    // The control re-labels itself for the move it now makes.
    await expect(toggle).toHaveAttribute("aria-label", "Expand sidebar");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();
    await expect(page.getByTestId("desktop-sidebar")).toHaveAttribute("data-collapsed", "false");
    await expect.poll(() => railWidth(page)).toBeCloseTo(EXPANDED, 0);
    expect(await mainWidth(page)).toBeCloseTo(mainExpanded, 0);
  });

  test("the preference survives a real reload, with no expanded flash first", async ({ page }) => {
    await gotoHome(page);
    await page.getByTestId("side-collapse-toggle").click();
    await expect.poll(() => railWidth(page)).toBeCloseTo(COMPACT, 0);

    expect(await page.evaluate(() => localStorage.getItem("ns-side-collapsed"))).toBe("1");

    await page.reload();
    await expect(page.getByTestId("home-screen")).toBeVisible();

    // The pre-paint script puts the compact width on <html> BEFORE the first
    // frame, so this is never a 280px paint that was corrected afterwards.
    expect(
      await page.evaluate(() => document.documentElement.getAttribute("data-side-collapsed")),
    ).toBe("1");
    expect(await railWidth(page)).toBeCloseTo(COMPACT, 0);
    await expect(page.getByTestId("desktop-sidebar")).toHaveAttribute("data-collapsed", "true");
    // The interior hold is released once React has adopted the preference.
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-side-ready")))
      .toBe("1");
    await expect(page.getByTestId("sidebar-nav")).toBeVisible();
  });

  test("the preference survives navigation between routes", async ({ page }) => {
    await gotoHome(page);
    await page.getByTestId("side-collapse-toggle").click();
    await expect.poll(() => railWidth(page)).toBeCloseTo(COMPACT, 0);

    await page.getByTestId("nav-link-/dates").click();
    await expect(page).toHaveURL(/\/dates$/);
    expect(await railWidth(page)).toBeCloseTo(COMPACT, 0);
  });

  test("a collapsed rail still reaches every destination, named and operable", async ({ page }) => {
    await gotoHome(page);

    const expandedLinks = await page
      .getByTestId("sidebar-nav")
      .getByRole("button")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));

    await page.getByTestId("side-collapse-toggle").click();
    await expect.poll(() => railWidth(page)).toBeCloseTo(COMPACT, 0);

    const compactLinks = await page
      .getByTestId("sidebar-nav")
      .getByRole("button")
      .evaluateAll((els) =>
        els.map((el) => ({
          id: el.getAttribute("data-testid"),
          name: el.getAttribute("aria-label"),
          title: el.getAttribute("title"),
          width: el.getBoundingClientRect().width,
          height: el.getBoundingClientRect().height,
        })),
      );

    // Nothing was dropped...
    expect(compactLinks.map((l) => l.id)).toEqual(expandedLinks);
    for (const link of compactLinks) {
      // ...every icon-only row is NAMED, and its tooltip says the same thing...
      expect(link.name, `accessible name for ${link.id}`).toBeTruthy();
      expect(link.title).toBe(link.name);
      // ...and it is the prototype's 40×38 icon button.
      expect(link.width).toBeCloseTo(40, 0);
      expect(link.height).toBeCloseTo(38, 0);
    }

    // The active destination stays announced and visibly distinct.
    const active = page.getByTestId("nav-link-/");
    await expect(active).toHaveAttribute("aria-current", "page");

    // Keyboard reaches and activates a compact row.
    await page.getByTestId("nav-link-/dates").focus();
    await expect(page.getByTestId("nav-link-/dates")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/dates$/);
  });

  test("the collapsed rail keeps a usable mode control and theme footer", async ({ page }) => {
    await gotoHome(page);
    await page.getByTestId("side-collapse-toggle").click();
    await expect.poll(() => railWidth(page)).toBeCloseTo(COMPACT, 0);

    const mode = page.getByTestId("mode-toggle");
    await expect(mode).toBeVisible();
    await expect(mode).toHaveText("GUI");
    await expect(mode).toHaveAttribute("aria-label", "Guided mode — switch to Advanced");
    await mode.click();
    await expect(page.getByTestId("mode-toggle")).toHaveText("ADV");

    // The footer keeps the one control it can afford; the two-line identity well
    // (which needs 280px and must not ellipsize) is dropped, not squeezed.
    await expect(
      page.getByTestId("desktop-sidebar").getByRole("button", { name: /Switch to .* theme/ }),
    ).toBeVisible();
    await expect(page.getByTestId("sidebar-identity")).toHaveCount(0);

    // Nothing overflows the 60px rail.
    const overflow = await page
      .getByTestId("desktop-sidebar")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("no document-level horizontal overflow in either state, at either desktop width", async ({
    page,
  }) => {
    await gotoHome(page);
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const collapse of [true, false]) {
        const isCollapsed =
          (await page.getByTestId("desktop-sidebar").getAttribute("data-collapsed")) === "true";
        if (isCollapsed !== collapse) await page.getByTestId("side-collapse-toggle").click();
        await expect(page.getByTestId("desktop-sidebar")).toHaveAttribute(
          "data-collapsed",
          String(collapse),
        );
        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        expect(overflows, `no overflow at ${width}, collapsed=${collapse}`).toBe(false);
      }
    }
  });
});

test.describe("G8 desktop sidebar collapse — the mobile drawer is untouched", () => {
  test("below 920px there is no collapse control, and the drawer renders expanded", async ({
    page,
  }) => {
    // Arrive with the DESKTOP preference already collapsed. The drawer must be
    // completely unaffected by it — this is the exact case the prototype's
    // "always renders expanded regardless of the collapsed state" rule names.
    await page.addInitScript(() => localStorage.setItem("ns-side-collapsed", "1"));
    await page.setViewportSize({ width: 820, height: 900 });
    await gotoHome(page);

    // The attribute is still on <html> (it is a desktop preference, not a
    // viewport fact), but nothing below 920px consumes it.
    expect(
      await page.evaluate(() => document.documentElement.getAttribute("data-side-collapsed")),
    ).toBe("1");
    await expect(page.getByTestId("desktop-sidebar")).toBeHidden();
    await expect(page.getByTestId("side-collapse-toggle")).toBeHidden();

    await page.getByTestId("mobile-nav-trigger").click();
    const drawer = page.getByTestId("mobile-nav-drawer");
    await expect(drawer).toBeVisible();

    // Expanded: 250px, the full two-line identity well, the two-segment mode
    // tablist, and nav rows that show their LABELS.
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeCloseTo(250, 0);
    await expect(drawer.getByTestId("sidebar-identity")).toBeVisible();
    await expect(drawer.getByTestId("mode-toggle")).toHaveAttribute("role", "tablist");
    await expect(drawer.getByTestId("sidebar-nav")).toHaveAttribute("data-collapsed", "false");
    await expect(drawer.getByTestId("nav-link-/dates")).toContainText("Dates");
  });

  test("the desktop preference is still honoured when the window widens again", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("ns-side-collapsed", "1"));
    await page.setViewportSize({ width: 820, height: 900 });
    await gotoHome(page);
    await expect(page.getByTestId("desktop-sidebar")).toBeHidden();

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
    expect(await railWidth(page)).toBeCloseTo(COMPACT, 0);
  });
});
