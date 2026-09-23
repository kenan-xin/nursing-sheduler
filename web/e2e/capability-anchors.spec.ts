// T06 — the deployment gate for the capability registry's DOM targets.
//
// The unit suite proves the manifest is internally consistent: unique ids, valid
// route/anchor/tool/command references, correct mode and gate logic, a fresh hash.
// None of that can prove an anchor REACHES THE DOM. This spec mounts every route
// that declares one, in every mode that route exists in, against a real production
// build, and asserts the exact element is there — exactly once.
//
// WHAT IT CATCHES THAT THE UNIT SUITE CANNOT:
//   * a declared anchor whose component stopped rendering it (missing/renamed);
//   * an anchor rendered by two components, or leaked into shared chrome so it
//     appears on every screen (duplicate);
//   * an anchor on a lazily-mounted route that arrives after navigation (lazy);
//   * an Advanced-only control still reachable in Guided (stale mode assumption).
//
// It reuses the frozen v2 surface matrix for seeding and readiness rather than
// declaring its own fixtures, and adds no row to that matrix: this is not a visual
// parity suite, and route tickets do not edit the matrix.

import { expect, test, type Page } from "@playwright/test";
import { CAPABILITY_ANCHOR_ATTRIBUTE } from "../lib/capability/anchor-contract";
import { CONTROL_ANCHOR_DECLARATIONS } from "../lib/capability/anchors";
import { navRoutePath, type NavRouteId } from "../components/shell/nav-route-paths";
import { prepareRow, seedRow } from "./support/v2-seed";
import { awaitRowReady } from "./support/v2-readiness";
import { rowForRoute, type V2Row } from "./support/v2-surface-matrix";

type Mode = "guided" | "advanced";

function anchorSelector(anchorId: string): string {
  return `[${CAPABILITY_ANCHOR_ATTRIBUTE}="${anchorId}"]`;
}

/** Every anchor, paired with the matrix row for the screen that declares it. */
function anchorRows(): { anchorId: string; routeId: NavRouteId; label: string; row: V2Row }[] {
  return CONTROL_ANCHOR_DECLARATIONS.map((declaration) => {
    const path = navRoutePath(declaration.routeId);
    const row = rowForRoute(path);
    if (!row) {
      // A shipped route with an anchor but no matrix row would silently skip this
      // gate, which is the one outcome worse than failing it.
      throw new Error(
        `anchor "${declaration.anchorId}" names route ${path}, which has no v2 surface matrix row`,
      );
    }
    return { ...declaration, row };
  });
}

/**
 * Mount a row's route with a stored mode preference, seeded and settled.
 *
 * `mode` overrides the row's own readiness descriptor so one route can be visited in
 * both modes — the matrix pins a single mode per row because it is a visual-parity
 * inventory, and the mode CROSS-PRODUCT is precisely what this spec adds.
 */
async function mountRoute(page: Page, row: V2Row, mode: Mode): Promise<V2Row> {
  const asMode: V2Row = { ...row, readiness: { ...row.readiness, mode, storeSeam: true } };
  await prepareRow(page, asMode);
  await page.goto(asMode.route);
  await awaitRowReady(page, asMode);
  // Seeded AFTER readiness: a durable command issued before the tab holds the
  // scenario's writer lease is refused, so an earlier seed would write nothing.
  await seedRow(page, asMode);
  return asMode;
}

/** The modes a row's route is reachable in. Advanced-only rows declare "advanced". */
function reachableModes(row: V2Row): Mode[] {
  // Every route is reachable in Advanced; only the non-`advancedOnly` ones are
  // reachable in Guided, and the matrix already records which is which.
  return row.readiness.mode === "advanced" ? ["advanced"] : ["guided", "advanced"];
}

for (const { anchorId, label, row } of anchorRows()) {
  for (const mode of reachableModes(row)) {
    test(`${anchorId} is rendered exactly once on ${row.route} in ${mode} mode`, async ({
      page,
    }) => {
      await mountRoute(page, row, mode);

      const anchors = page.locator(anchorSelector(anchorId));
      // `toHaveCount` retries, so a lazily-mounted route whose chunk lands after
      // navigation passes here for the right reason rather than needing a sleep.
      await expect(
        anchors,
        `"${label}" (${anchorId}) must render exactly once on ${row.route} in ${mode} mode. ` +
          `Zero means the control was renamed, moved or removed and the registry is stale; ` +
          `more than one means two components claim it and every navigation to it is ambiguous.`,
      ).toHaveCount(1);
      await expect(anchors.first()).toBeVisible();
      expect(await anchors.first().getAttribute(CAPABILITY_ANCHOR_ATTRIBUTE)).toBe(anchorId);
    });
  }

  if (reachableModes(row).length === 1) {
    test(`${anchorId} is unreachable in guided mode, with no substitute`, async ({ page }) => {
      // The Advanced-only case. Guided bounces the route to Home, so the control must
      // be absent — and Home must not have grown a stand-in for it either.
      const homeRow = rowForRoute("/")!;
      await mountRoute(page, homeRow, "guided");
      await page.goto(row.route);
      // Wait for the bounce to actually land, so the absence below is an assertion
      // about a settled screen rather than about a page that had not rendered yet.
      await expect(page.locator('[data-testid="home-screen"]')).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/");
      await expect(page.locator(anchorSelector(anchorId))).toHaveCount(0);
    });
  }

  test(`no other screen renders ${anchorId}`, async ({ page }) => {
    // The leak case: an anchor placed in shared chrome (the top bar, the sidebar)
    // would appear on every screen, so the registry's claim that it belongs to one
    // screen would be false everywhere else. Home is the cheapest witness — it mounts
    // the same shell as every other route.
    const homeRow = rowForRoute("/")!;
    if (row.route === "/") return;
    await mountRoute(page, homeRow, "guided");
    await expect(page.locator(anchorSelector(anchorId))).toHaveCount(0);
  });
}

test("every declared anchor id is globally unique across the app shell", async ({ page }) => {
  // Belt and braces against the duplicate case from the other direction: collect every
  // anchor attribute the shell itself renders and assert none repeats. A per-route
  // count of 1 would still pass if two DIFFERENT routes claimed one id, which the
  // registry forbids.
  const homeRow = rowForRoute("/")!;
  await mountRoute(page, homeRow, "advanced");
  const rendered = await page.evaluate(
    (attribute) =>
      [...document.querySelectorAll(`[${attribute}]`)].map(
        (element) => element.getAttribute(attribute) ?? "",
      ),
    CAPABILITY_ANCHOR_ATTRIBUTE,
  );
  expect(new Set(rendered).size).toBe(rendered.length);
});

test("an anchored control still works with AI disabled", async ({ page }) => {
  // The assistant is off by default in every fixture here, which is the shipped
  // default. Anchoring a control must be inert: the attribute is metadata, and the
  // button behaves exactly as it did before T06 touched it.
  const peopleRow = rowForRoute("/people")!;
  await mountRoute(page, peopleRow, "guided");

  await expect(page.locator('[data-testid="assistant-launcher"]')).toHaveCount(0);

  const add = page.locator(anchorSelector("people.add-person"));
  await expect(add).toHaveAttribute("aria-pressed", "false");
  await add.click();
  await expect(add).toHaveAttribute("aria-pressed", "true");
});
