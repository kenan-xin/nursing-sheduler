// F4 — named readiness strategies.
//
// "The page is ready" is five separate claims, and a suite that conflates them
// flakes on whichever one it left out. Each is a named, separately callable
// strategy here:
//
//   1. hydration     — the real T04 lifecycle reports `ready` behind HydrationGate
//   2. route marker  — the row's OWN existing screen/fixture marker is visible
//   3. fonts         — `document.fonts.ready` has resolved
//   4. portals       — no Base UI popup is mid-open or mid-close
//   5. stable frames — two consecutive animation frames agree on layout, and no
//                      finite animation is still running
//
// A fixed sleep is never a correctness signal anywhere in this file. The one
// timing primitive used is `requestAnimationFrame`, which is a real paint event,
// not a guess about how long one takes.
//
// Screenshot mode adds a sixth condition by REMOVING a source of nondeterminism:
// a test-only root attribute suppresses non-semantic motion and caret blinking,
// and the same readiness contract then applies unchanged.

import { expect, type Page } from "@playwright/test";
import type { V2Row } from "./v2-surface-matrix";

/** How long any single readiness condition may take before it is a failure. */
export const READINESS_TIMEOUT_MS = 15_000;

/** The test-only root attribute that suppresses motion for screenshot capture. */
export const SCREENSHOT_ATTRIBUTE = "data-v2-screenshot";

interface ReadinessWindow {
  __nsStore?: {
    hot: { getState(): { hydrationStatus: string } };
  };
}

function context(row: V2Row, strategy: string): string {
  return `${row.route} (owner ${row.owner}, readiness ${row.readiness.strategy}/${strategy})`;
}

/** The page's first heading, or a note that it has none — for failure text. */
async function visibleHeading(page: Page): Promise<string> {
  return page
    .evaluate(() => document.querySelector("h1, h2")?.textContent?.trim() ?? "(no heading)")
    .catch(() => "(unreadable)");
}

// ---------------------------------------------------------------------------
// 1. Hydration
// ---------------------------------------------------------------------------

/**
 * Wait for the durable store's hydration state machine to leave
 * `unhydrated`/`hydrating`. This is the REAL store signal, not a proxy: the
 * shell renders a skeleton until it flips, and `mutateScenario` no-ops before
 * it, so seeding any earlier writes nothing.
 *
 * `recoverable-error` is treated as a hard failure rather than a settled state.
 * It means the persisted record could not be read — which, given every row
 * starts from a reset, would mean the reset itself is broken.
 */
export async function awaitHydration(page: Page, row: V2Row): Promise<void> {
  try {
    await page.waitForFunction(
      () => Boolean((window as unknown as ReadinessWindow).__nsStore),
      undefined,
      { timeout: READINESS_TIMEOUT_MS },
    );
  } catch (err) {
    // A React render error replaces the whole tree with Next's error boundary,
    // which unmounts the store seam. Waiting for a seam that will never come
    // back reads as a timeout and says nothing about the crash that caused it,
    // so the page's own words are attached here.
    throw new Error(
      `${context(row, "hydration")}: the store seam never appeared. ` +
        `Page heading: ${JSON.stringify(await visibleHeading(page))}. ` +
        `A crashed render (bad seed data, missing required field) looks exactly like this.\n` +
        `Original: ${(err as Error).message}`,
    );
  }

  const status = await page.waitForFunction(
    () => {
      const store = (window as unknown as ReadinessWindow).__nsStore;
      const state = store?.hot.getState().hydrationStatus;
      return state === "ready" || state === "recoverable-error" ? state : null;
    },
    undefined,
    { timeout: READINESS_TIMEOUT_MS },
  );

  const resolved = await status.jsonValue();
  if (resolved !== "ready") {
    throw new Error(
      `${context(row, "hydration")}: the durable store hydrated to "${resolved}" instead of "ready". ` +
        `Every row starts from a full storage reset, so a corrupt persisted record here means the reset is broken.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Route / harness marker
// ---------------------------------------------------------------------------

/**
 * Wait for the row's own marker — the screen or fixture element the shipped
 * source already renders. F4 invents no new product markers, so this can never
 * pass for a route that has not actually rendered its screen.
 */
export async function awaitRouteMarker(page: Page, row: V2Row): Promise<void> {
  await expect(
    page.locator(row.readiness.marker).first(),
    `${context(row, "marker")}: expected the row's marker ${row.readiness.marker} to be visible`,
  ).toBeVisible({ timeout: READINESS_TIMEOUT_MS });

  // A route bounced by the mode validity gate still renders a perfectly valid
  // screen — Home's — so the marker alone cannot prove we are where we asked to
  // be. The URL is the part that would differ.
  const pathname = new URL(page.url()).pathname;
  if (pathname !== row.route) {
    throw new Error(
      `${context(row, "marker")}: expected to settle on ${row.route}, but the page is at ${pathname}. ` +
        `An Advanced-only route needs readiness.mode = "advanced" or the route-validity gate redirects it to Home.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Fonts
// ---------------------------------------------------------------------------

/**
 * Wait for `document.fonts.ready`. Three next/font families load with
 * `display: swap`, so text is laid out in a fallback face first — measuring a
 * target rectangle or taking a screenshot before the swap lands compares two
 * different typefaces.
 */
export async function awaitFonts(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

// ---------------------------------------------------------------------------
// 4. Portals
// ---------------------------------------------------------------------------

/**
 * Wait for every Base UI popup to be fully open or fully gone. Base UI marks the
 * transitional frames with `data-starting-style` / `data-ending-style`, and a
 * scrim captured mid-fade computes a partial alpha that is neither the theme
 * scrim nor nothing.
 */
export async function awaitPortals(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        "[data-starting-style], [data-ending-style], [data-state='opening'], [data-state='closing']",
      ).length === 0,
    undefined,
    { timeout: READINESS_TIMEOUT_MS },
  );
}

// ---------------------------------------------------------------------------
// 5. Stable frames
// ---------------------------------------------------------------------------

/**
 * Wait until two consecutive animation frames agree on the document's layout box
 * AND no FINITE animation is still running.
 *
 * Infinite animations are excluded on purpose: the skeleton shimmer and the
 * spinner never finish, so waiting for `getAnimations()` to empty would hang on
 * any page that shows one. What matters for correctness is that nothing is still
 * MOVING INTO PLACE. Screenshot mode removes the infinite ones separately, by
 * suppressing them at the source.
 */
export async function awaitStableFrames(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const measure = () => {
          const el = document.documentElement;
          return `${el.scrollWidth}x${el.scrollHeight}x${document.body.scrollHeight}`;
        };
        const running = () =>
          document
            .getAnimations()
            .filter(
              (a) =>
                a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity,
            ).length;

        const first = measure();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve(measure() === first && running() === 0));
        });
      }),
    undefined,
    { timeout: READINESS_TIMEOUT_MS },
  );
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * The row's full readiness contract, in dependency order. `app-shell` rows wait
 * out hydration first because their marker only exists past the gate; `bare`
 * rows (outside the `(app)` route group) have no gate and no store to wait on.
 */
export async function awaitRowReady(page: Page, row: V2Row): Promise<void> {
  if (row.readiness.strategy === "app-shell") {
    await awaitHydration(page, row);
  }
  await awaitRouteMarker(page, row);
  await awaitFonts(page);
  await awaitPortals(page);
  await awaitStableFrames(page);
}

/**
 * Enter screenshot mode: mark the root and suppress every source of
 * frame-to-frame nondeterminism that is not semantic — animations, transitions,
 * and the text caret.
 *
 * This is authored entirely in test code, keyed on a test-only attribute, so no
 * production stylesheet gains a rule that exists for the benefit of a test. The
 * `!important` is load-bearing: `globals.css`'s reduced-motion block uses it
 * too, and a plain declaration would lose to it.
 */
export async function enterScreenshotMode(page: Page): Promise<void> {
  await page.evaluate(
    (attr) => document.documentElement.setAttribute(attr, ""),
    SCREENSHOT_ATTRIBUTE,
  );
  await page.addStyleTag({
    content: `
      [${SCREENSHOT_ATTRIBUTE}] *,
      [${SCREENSHOT_ATTRIBUTE}] *::before,
      [${SCREENSHOT_ATTRIBUTE}] *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
      }
    `,
  });
  // Re-settle: suppressing motion can itself change layout by snapping a
  // mid-transition element to its end state.
  await awaitStableFrames(page);
}
