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
//   5. stable frames — a bounded run of consecutive animation frames in which
//                      layout agrees, the DOM does not change, and no finite
//                      animation is in flight
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

/**
 * Consecutive animation frames of observable quiet a settle pass must see before
 * it calls the page settled.
 *
 * A paint-only transition changes no layout box, so layout equality cannot see
 * it — and a transition that has not STARTED yet is invisible to every signal
 * there is. The only defence against a change that is still coming is to keep
 * watching for a bounded window and let the change itself reset the count: the
 * React commit that starts a late transition is a DOM mutation, and the
 * transition it creates is then an animation in flight for as long as it runs.
 *
 * Six frames is roughly 100ms of paint at 60Hz, but the unit is frames, not
 * milliseconds — under CI load the frames stretch and the window stretches with
 * them, which is exactly the behaviour a wall-clock sleep cannot give.
 */
export const STABLE_QUIET_FRAMES = 6;

/**
 * The page-global key a settle pass publishes its own state under.
 *
 * This is observability, not a second readiness framework: the pass already has
 * to carry state across frames (see `awaitStableFrames`), and publishing it lets
 * a failure say WHAT kept the page busy, and lets the F4 proof establish
 * ordering against the pass rather than against the clock.
 */
export const SETTLE_STATE_KEY = "__v2Settle";

/** The observable half of a settle pass. Serializable; read with `readSettleState`. */
export interface V2SettleState {
  /** Incremented once per settle pass, at the frame the pass starts. */
  epoch: number;
  /** Frames observed across the page's lifetime. Only advances during a pass. */
  frame: number;
  /** `frame` when the current pass started. */
  startFrame: number;
  /** Consecutive quiet frames the pass currently holds. */
  quiet: number;
  /** DOM mutations the pass has observed. */
  mutations: number;
  /** The first few mutations, for failure text. */
  samples: string[];
  /** Finite animations in flight at the last observed frame. */
  inFlight: number;
  /** The layout signature at the last observed frame. */
  layout: string;
  /** Whether a pass is currently running. */
  running: boolean;
  /** `frame` at which the pass resolved, or null while it is still running. */
  resolvedFrame: number | null;
}

/** The full in-page pass record. The extra fields are not serializable. */
interface SettlePass extends V2SettleState {
  seenMutations: number;
  observer: MutationObserver | null;
}

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
 * Wait until the page holds `STABLE_QUIET_FRAMES` consecutive animation frames in
 * which the document's layout box agrees with the previous frame, the DOM has
 * not changed, and no FINITE animation is in flight.
 *
 * Three things this has to get right, each of which it got wrong before:
 *
 * 1. **The predicate must be synchronous.** `page.waitForFunction` compares the
 *    value the predicate RETURNS against `false` to decide whether to keep
 *    polling. A predicate that returns a Promise is never `=== false`, so it is
 *    accepted on its first call and its eventual verdict is discarded. The old
 *    body returned `new Promise(...)`, which means this helper had never waited
 *    for anything: it resolved after one poll no matter what it measured.
 *    Measured directly against the pinned Chromium — a predicate resolving
 *    `false` after 400ms returned in 424ms, while a synchronous `false` polled
 *    until its timeout. So the state that has to survive between frames lives on
 *    the page, not in a closure, and each call advances it by exactly one frame.
 *
 * 2. **Layout equality cannot see paint.** A `color` / `background-color` /
 *    `box-shadow` transition changes no box, so a layout comparison is blind to
 *    it and an audit downstream samples an interpolated colour. Animation state
 *    is what sees those, and it is checked every frame.
 *
 * 3. **A transition that has not started yet is invisible to both.** The seeded
 *    React update that starts one commits a DOM change first, so mutations are
 *    observed too and any of them resets the quiet run. The window is what turns
 *    "nothing is happening right now" into "nothing has happened for a bounded
 *    run of real frames", which is the claim an audit actually needs.
 *
 * Infinite animations are excluded on purpose: the skeleton shimmer and the
 * spinner never finish, so waiting for `getAnimations()` to empty would hang on
 * any page that shows one. What matters for correctness is that nothing is still
 * MOVING INTO PLACE. Screenshot mode removes the infinite ones separately, by
 * suppressing them at the source.
 */
export async function awaitStableFrames(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      ({ key, quietFrames, sampleCap }) => {
        const store = window as unknown as Record<string, SettlePass | undefined>;

        const measure = () => {
          const el = document.documentElement;
          return `${el.scrollWidth}x${el.scrollHeight}x${document.body.scrollHeight}`;
        };
        // `pending` counts as in flight. A transition created moments ago has no
        // start time yet, and dropping it here would reopen the very gap the
        // quiet window exists to close.
        const inFlight = () =>
          document.getAnimations().filter((a) => {
            if (a.effect?.getComputedTiming().iterations === Infinity) return false;
            return a.playState === "running" || a.pending;
          }).length;

        const previous = store[key];
        if (!previous || !previous.running) {
          const pass: SettlePass = {
            epoch: (previous?.epoch ?? 0) + 1,
            frame: previous?.frame ?? 0,
            startFrame: previous?.frame ?? 0,
            quiet: 0,
            mutations: 0,
            seenMutations: 0,
            samples: [],
            inFlight: inFlight(),
            layout: measure(),
            running: true,
            resolvedFrame: null,
            observer: null,
          };

          // Attributes and nodes only. A text change cannot create a transition,
          // and a page with a ticking label would otherwise never go quiet.
          const observer = new MutationObserver((records) => {
            pass.mutations += records.length;
            for (const record of records) {
              if (pass.samples.length >= sampleCap) break;
              const node = record.target;
              const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
              const testid = el?.getAttribute("data-testid");
              const name = el
                ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}` +
                  (testid ? `[data-testid="${testid}"]` : "")
                : "(detached)";
              pass.samples.push(
                `${record.type}${record.attributeName ? `:${record.attributeName}` : ""} on ${name}`,
              );
            }
          });
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
          });
          pass.observer = observer;
          store[key] = pass;
          // The opening frame only establishes the baseline. It can never be a
          // quiet frame, because nothing has been compared against anything yet.
          return false;
        }

        const pass = previous;
        pass.frame += 1;
        const layout = measure();
        const flight = inFlight();
        const mutated = pass.mutations !== pass.seenMutations;
        pass.seenMutations = pass.mutations;
        pass.inFlight = flight;
        const stable = layout === pass.layout;
        pass.layout = layout;

        pass.quiet = stable && flight === 0 && !mutated ? pass.quiet + 1 : 0;
        if (pass.quiet < quietFrames) return false;

        pass.resolvedFrame = pass.frame;
        pass.running = false;
        pass.observer?.disconnect();
        pass.observer = null;
        return true;
      },
      { key: SETTLE_STATE_KEY, quietFrames: STABLE_QUIET_FRAMES, sampleCap: 6 },
      { timeout: READINESS_TIMEOUT_MS },
    );
  } catch (err) {
    // Read the pass's own account of what it saw before abandoning it. Without
    // this the failure is a bare timeout, which says nothing about whether the
    // page was animating, mutating or resizing.
    const state = await readSettleState(page).catch(() => null);
    await abandonSettlePass(page).catch(() => undefined);
    throw new Error(
      `stable frames: the page never held ${STABLE_QUIET_FRAMES} consecutive quiet animation ` +
        `frames within ${READINESS_TIMEOUT_MS}ms.` +
        (state
          ? ` Over ${state.frame - state.startFrame} frame(s) it observed ${state.mutations} DOM ` +
            `mutation(s), ended on ${state.inFlight} finite animation(s) in flight at layout ` +
            `${state.layout}, and reached a quiet run of ${state.quiet}. ` +
            `First mutations: ${state.samples.join("; ") || "(none)"}.`
          : "") +
        `\nOriginal: ${(err as Error).message}`,
    );
  }
}

/** The current settle pass's published state, or null if none has ever run. */
export async function readSettleState(page: Page): Promise<V2SettleState | null> {
  return page.evaluate((key) => {
    const pass = (window as unknown as Record<string, V2SettleState | undefined>)[key];
    if (!pass) return null;
    // Hand back only the serializable half — the pass also holds a live
    // MutationObserver, which cannot cross the boundary.
    return {
      epoch: pass.epoch,
      frame: pass.frame,
      startFrame: pass.startFrame,
      quiet: pass.quiet,
      mutations: pass.mutations,
      samples: [...pass.samples],
      inFlight: pass.inFlight,
      layout: pass.layout,
      running: pass.running,
      resolvedFrame: pass.resolvedFrame,
    };
  }, SETTLE_STATE_KEY);
}

/**
 * Tear down a pass that timed out. Its observer would otherwise stay attached,
 * and the next pass would resume the abandoned one instead of starting clean.
 */
async function abandonSettlePass(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const pass = (window as unknown as Record<string, SettlePass | undefined>)[key];
    if (!pass) return;
    pass.observer?.disconnect();
    pass.observer = null;
    pass.running = false;
  }, SETTLE_STATE_KEY);
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
