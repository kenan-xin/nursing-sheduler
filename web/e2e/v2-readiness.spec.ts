import { expect, test, type Page } from "@playwright/test";
import { rowForRoute, V2_SURFACE_MATRIX, type V2Row } from "./support/v2-surface-matrix";
import {
  buildSeedPatch,
  prepareRow,
  seedRecordsBackup,
  seedRow,
  SEED_STAFF_IDS,
} from "./support/v2-seed";
import {
  awaitRowReady,
  awaitStableFrames,
  readSettleState,
  SETTLE_STATE_KEY,
  STABLE_QUIET_FRAMES,
} from "./support/v2-readiness";

// F4 — the all-row readiness smoke.
//
// This suite runs ALL SEVENTEEN rows, at F4, before any route has been
// re-skinned. It is deliberately readiness-ONLY: it proves that every row can
// reset, seed, navigate and settle against the shipped app, and asserts nothing
// about v2 styling. Demanding v2 conformance from an unmigrated route here would
// produce a suite that is red for months, and a suite that is expected to be red
// stops being read.
//
// What it therefore does prove, before the parallel wave opens:
//   • every seed descriptor targets a store that actually accepts it;
//   • every readiness descriptor settles on the route it names (an Advanced-only
//     route that forgot its mode lands on Home instead, and is caught here);
//   • every marker exists in the shipped source;
//   • the reset is real — each row starts from an empty durable store;
//   • nothing throws while getting there.
//
// Unlike the other two F4 suites this one ignores `V2_MATRIX_OWNER`: the point
// of a foundation checkpoint is that the WHOLE matrix was proven navigable
// before nine tickets started depending on it.

/** Read the durable scenario slice through the e2e store seam. */
async function readScenario(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const store = (
      window as unknown as {
        __nsStore?: { scenario: { getState(): Record<string, unknown> } };
      }
    ).__nsStore;
    if (!store) return null;
    const state = store.scenario.getState();
    return {
      staff: (state.staff as unknown[] | undefined)?.length ?? 0,
      shifts: (state.shifts as unknown[] | undefined)?.length ?? 0,
      reqData: (state.reqData as unknown[] | undefined)?.length ?? 0,
      rangeStart: (state.rangeStart as string | undefined) ?? "",
      cards: Object.fromEntries(
        Object.entries((state.cardsByKind as Record<string, unknown[]>) ?? {}).map(([k, v]) => [
          k,
          v.length,
        ]),
      ),
    };
  });
}

function backupStatus(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __nsStore?: { backupStatus(): string } }).__nsStore?.backupStatus() ??
      null,
  );
}

for (const row of V2_SURFACE_MATRIX satisfies readonly V2Row[]) {
  test(`${row.owner} · ${row.route} — resets, seeds, navigates and settles`, async ({ page }) => {
    // Only uncaught page exceptions are collected. Console errors are NOT a
    // signal here: `/optimize-and-export` and the durable harness talk to a
    // backend that is deliberately absent from this suite's webServer, so their
    // failed fetches are expected and would drown a real error in noise.
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(`${err.name}: ${err.message}`));

    await prepareRow(page, row);
    await page.goto(row.route);
    await awaitRowReady(page, row);

    // --- the reset is real, not assumed ------------------------------------
    const before = await readScenario(page);
    if (row.readiness.storeSeam) {
      expect(before, `${row.route}: the store seam should be mounted`).not.toBeNull();

      if (row.seed === "harness-self-seeded") {
        // The durable harness writes its own minimum required data into the REAL
        // store on mount, so "empty after reset" is the wrong claim here. The
        // claim that matters is the same one in substance: the state on screen
        // is the harness's own deterministic seed and not a leftover from a
        // previous row.
        expect(
          before!.staff + before!.shifts,
          `${row.route}: the harness should have seeded itself by the time it is ready`,
        ).toBeGreaterThan(0);
        expect(
          before!.reqData,
          `${row.route}: the harness seeds no request cells, so any here are leftovers`,
        ).toBe(0);
      } else {
        expect(
          { staff: before!.staff, shifts: before!.shifts, reqData: before!.reqData },
          `${row.route} started from a non-empty durable store — the reset did not take`,
        ).toEqual({ staff: 0, shifts: 0, reqData: 0 });
      }
    }

    // --- seed, then settle again -------------------------------------------
    await seedRow(page, row);
    await awaitRowReady(page, row);

    const patch = buildSeedPatch(row.seed);
    if (patch !== null) {
      const after = await readScenario(page);
      expect(after, `${row.route}: the store seam disappeared after seeding`).not.toBeNull();
      // The seed must have LANDED, not merely been dispatched: `mutateScenario`
      // no-ops before hydration reports ready, so a race here would look exactly
      // like a passing test with an empty screen.
      expect(after!.staff, `${row.route}: seeded staff`).toBe(SEED_STAFF_IDS.length);
      expect(after!.rangeStart, `${row.route}: seeded roster start`).toBe(patch.rangeStart);

      if (patch.reqData) {
        expect(after!.reqData, `${row.route}: seeded request cells`).toBe(
          (patch.reqData as unknown[]).length,
        );
      }
      if (patch.cardsByKind) {
        for (const [kind, cards] of Object.entries(
          patch.cardsByKind as Record<string, unknown[]>,
        )) {
          expect(after!.cards[kind], `${row.route}: seeded ${kind}`).toBe(cards.length);
        }
      }
    }

    if (seedRecordsBackup(row.seed)) {
      expect(await backupStatus(page), `${row.route}: Workspace backup after seeding`).toBe(
        "current",
      );
    }

    // --- still on the route we asked for, and nothing threw -----------------
    expect(new URL(page.url()).pathname, `${row.route}: settled route`).toBe(row.route);
    expect(pageErrors, `${row.route} raised: ${pageErrors.join(" | ")}`).toEqual([]);
  });
}

test("the smoke covers every manifest row", () => {
  // The loop above is what registers the rows, so this guards the loop itself:
  // a filter accidentally introduced there would shrink the smoke silently.
  expect(V2_SURFACE_MATRIX).toHaveLength(17);
});

// ---------------------------------------------------------------------------
// The late paint-only transition proof
// ---------------------------------------------------------------------------
//
// G1's scan-before-edit pass caught the audits reading interpolated paint: two
// `mode-toggle` tabs mid-crossfade, their shadow alphas summing to exactly the
// canonical `--sh-1`. Diagnosed against the pinned Chromium, the mechanism was
// worse than a missing condition. `awaitStableFrames` returned a Promise from
// its `page.waitForFunction` predicate, and Playwright decides whether to keep
// polling by comparing the RETURNED value against `false` — a Promise never is,
// so the predicate ran once and its verdict was thrown away. The helper had
// never waited for anything.
//
// So the repair has to be proven by OUTCOME, not by reading the new code. The
// probe below starts readiness first, then makes a real class change that
// creates a Chromium-reported `CSSTransition` on `color` / `background-color` /
// `box-shadow` while the document's box never moves — and it fires that change
// at the last moment the pass could still be beaten, recording as it goes that
// the OLD contract's entire condition set was satisfied in that instant.

const PROBE_ID = "f4-paint-transition-probe";
const PROBE_LIT_CLASS = "f4-paint-transition-probe-lit";
const PROBE_DURATION_MS = 400;
const PROBE_START = { color: "rgb(20, 40, 30)", backgroundColor: "rgb(200, 230, 220)" } as const;
const PROBE_END = { color: "rgb(240, 250, 245)", backgroundColor: "rgb(11, 125, 104)" } as const;

/** What the in-page probe records about its own run. */
interface PaintProbeReport {
  armed: boolean;
  armedAtQuiet: number | null;
  armedAtFrame: number | null;
  legacyLayoutStable: boolean | null;
  legacyRunning: number | null;
  preludeTick: number | null;
  lit: boolean;
  live: boolean;
  liveProperties: string[];
  endEvents: number;
  endedProperties: string[];
  endFrame: number | null;
  ticks: number;
}

/**
 * Install a fixed, out-of-flow 24px square whose only transitions are paint.
 *
 * `position: fixed` is load-bearing: it keeps the square out of the document's
 * scroll box, so nothing it does can be caught by a layout comparison. The
 * `!important` durations are too — an ambient reduced-motion preference zeroes
 * every duration in `globals.css`, which would quietly turn this proof vacuous
 * instead of failing it.
 */
async function installPaintProbe(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      #${PROBE_ID} {
        position: fixed;
        top: 0;
        left: 0;
        width: 24px;
        height: 24px;
        pointer-events: none;
        color: ${PROBE_START.color};
        background-color: ${PROBE_START.backgroundColor};
        box-shadow: 0 1px 2px rgba(20, 60, 50, 0.2);
        transition-property: color, background-color, box-shadow !important;
        transition-duration: ${PROBE_DURATION_MS}ms !important;
        transition-timing-function: linear !important;
      }
      #${PROBE_ID}.${PROBE_LIT_CLASS} {
        color: ${PROBE_END.color};
        background-color: ${PROBE_END.backgroundColor};
        box-shadow: 0 1px 2px rgba(11, 125, 104, 0.6);
      }
    `,
  });
  await page.evaluate((id) => {
    const el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
  }, PROBE_ID);
}

/**
 * Arm the probe to light itself once a settle pass is `atQuiet` frames into its
 * quiet run — i.e. deliberately inside the window, with the pass already on its
 * way to resolving.
 *
 * The trigger is the pass's own published state, not a timer, so the ordering
 * this proof depends on ("readiness started FIRST") is established from
 * observable browser state rather than hoped for.
 *
 * `preludeFrames` splits the change in two: an attribute mutation that starts no
 * transition at all, then the class change `preludeFrames` frames later. That is
 * the shape of a React update that commits twice — and the only thing that can
 * hold the window across the gap is the mutation epoch, because in those frames
 * the layout box has not moved and there is no animation to see.
 */
async function armLateTransition(
  page: Page,
  { atQuiet, preludeFrames = 0 }: { atQuiet: number; preludeFrames?: number },
): Promise<void> {
  await page.evaluate(
    ({ id, lit, settleKey, quiet, prelude, tickCap }) => {
      const store = window as unknown as Record<string, unknown>;
      const target = document.getElementById(id);
      if (!target) throw new Error(`the paint probe #${id} is not installed`);

      const report = {
        armed: false,
        armedAtQuiet: null as number | null,
        armedAtFrame: null as number | null,
        legacyLayoutStable: null as boolean | null,
        legacyRunning: null as number | null,
        preludeTick: null as number | null,
        lit: false,
        live: false,
        liveProperties: [] as string[],
        endEvents: 0,
        endedProperties: [] as string[],
        endFrame: null as number | null,
        ticks: 0,
      };
      store.__f4PaintProbe = report;

      const settle = () =>
        store[settleKey] as
          | { epoch: number; frame: number; quiet: number; running: boolean }
          | undefined;
      const baseEpoch = settle()?.epoch ?? 0;

      const layout = () => {
        const el = document.documentElement;
        return `${el.scrollWidth}x${el.scrollHeight}x${document.body.scrollHeight}`;
      };
      const layoutBefore = layout();

      target.addEventListener("transitionend", (event) => {
        report.endEvents += 1;
        const property = (event as TransitionEvent).propertyName;
        if (!report.endedProperties.includes(property)) report.endedProperties.push(property);
        report.endFrame = settle()?.frame ?? null;
      });

      const light = () => {
        // Flush the settled starting style so the class change below is a
        // genuine change between two settled styles, and therefore starts a
        // transition rather than painting straight to the endpoint.
        void getComputedStyle(target).backgroundColor;
        target.classList.add(lit);
        report.lit = true;
      };

      const tick = () => {
        report.ticks += 1;
        const pass = settle();

        if (!report.armed) {
          if (pass && pass.running && pass.epoch > baseEpoch && pass.quiet >= quiet) {
            report.armed = true;
            report.armedAtQuiet = pass.quiet;
            report.armedAtFrame = pass.frame;
            // Everything the OLD contract asked, recorded in the instant before
            // the transition exists: the layout box has not moved and no finite
            // animation is running. Both hold — which is precisely why a
            // layout-plus-animation check would call this page settled here.
            report.legacyLayoutStable = layout() === layoutBefore;
            report.legacyRunning = document
              .getAnimations()
              .filter(
                (a) =>
                  a.playState === "running" &&
                  a.effect?.getComputedTiming().iterations !== Infinity,
              ).length;
            if (prelude > 0) {
              // A real attribute mutation that changes no declared property, so
              // it starts nothing. Only the mutation epoch can see it.
              report.preludeTick = report.ticks;
              target.setAttribute("data-probe-prelude", "1");
            } else {
              light();
            }
          }
        } else if (!report.lit) {
          if (report.preludeTick !== null && report.ticks >= report.preludeTick + prelude) light();
        } else if (!report.live) {
          const live = target
            .getAnimations()
            .filter(
              (a) =>
                a.constructor.name === "CSSTransition" && (a.playState === "running" || a.pending),
            );
          if (live.length > 0) {
            report.live = true;
            report.liveProperties = live
              .map((a) => (a as unknown as { transitionProperty: string }).transitionProperty)
              .sort();
          }
        }

        const done = report.armed && report.lit && report.live && report.endEvents > 0;
        if (!done && report.ticks < tickCap) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    {
      id: PROBE_ID,
      lit: PROBE_LIT_CLASS,
      settleKey: SETTLE_STATE_KEY,
      quiet: atQuiet,
      prelude: preludeFrames,
      tickCap: 900,
    },
  );
}

function readPaintProbe(page: Page): Promise<PaintProbeReport> {
  return page.evaluate(
    () => (window as unknown as { __f4PaintProbe: PaintProbeReport }).__f4PaintProbe,
  );
}

function documentLayout(page: Page) {
  return page.evaluate(() => {
    const el = document.documentElement;
    return { width: el.scrollWidth, height: el.scrollHeight, body: document.body.scrollHeight };
  });
}

function probePaint(page: Page) {
  return page.evaluate((id) => {
    const style = getComputedStyle(document.getElementById(id)!);
    return { color: style.color, backgroundColor: style.backgroundColor };
  }, PROBE_ID);
}

test.describe("stable frames — a late, layout-neutral paint transition", () => {
  const row = rowForRoute("/design-system")!;

  test("readiness cannot resolve until the transition reaches its endpoint", async ({ page }) => {
    await page.goto(row.route);
    await awaitRowReady(page, row);
    await installPaintProbe(page);

    const layoutBefore = await documentLayout(page);
    // Two frames short of the run the pass needs: as late as the mutation can
    // land and still be inside the window. The slack is because the probe's rAF
    // callback and the pass's poll are ordered by registration within a frame,
    // and firing on the very last frame would be a coin toss rather than a test.
    await armLateTransition(page, { atQuiet: STABLE_QUIET_FRAMES - 2 });

    await awaitStableFrames(page);

    const probe = await readPaintProbe(page);
    const settle = await readSettleState(page);

    // --- premises: without these the rest proves nothing -------------------
    expect(
      probe.armed,
      `the probe never fired (${probe.ticks} frames): readiness resolved before the mutation ` +
        `could be made, so no late transition was ever created`,
    ).toBe(true);
    expect(
      { layoutStable: probe.legacyLayoutStable, runningAnimations: probe.legacyRunning },
      "in the instant before the transition existed, the layout-plus-animation contract was " +
        "fully satisfied — if it was not, this run does not exercise the gap at all",
    ).toEqual({ layoutStable: true, runningAnimations: 0 });
    expect(
      probe.live,
      "Chromium never reported a running CSSTransition after the class change, so there was " +
        "nothing for readiness to wait out",
    ).toBe(true);
    expect(probe.liveProperties, "the transition must cover all three paint properties").toEqual([
      "background-color",
      "box-shadow",
      "color",
    ]);
    expect(
      await documentLayout(page),
      "the probe's transition must be PAINT-only: a layout change would be caught by the " +
        "box comparison and would not exercise the defect",
    ).toEqual(layoutBefore);

    // --- the claim ---------------------------------------------------------
    expect(
      probe.endedProperties.slice().sort(),
      "every property must have reached its end",
    ).toEqual(["background-color", "box-shadow", "color"]);
    expect(probe.endFrame, "the transition never ended").not.toBeNull();
    expect(settle?.resolvedFrame, "the settle pass never recorded a resolution").not.toBeNull();
    expect(
      settle!.resolvedFrame! - probe.endFrame!,
      `readiness resolved at frame ${settle!.resolvedFrame} but the transition only ended at ` +
        `frame ${probe.endFrame} (armed at quiet=${probe.armedAtQuiet}, frame ` +
        `${probe.armedAtFrame}) — it must resolve at least a full frame after the endpoint, so ` +
        `the endpoint paint is what an audit reads`,
    ).toBeGreaterThanOrEqual(2);

    // ...and the paint on offer really is the endpoint, not an interpolant.
    expect(await probePaint(page), "an audit running now would sample the endpoint").toEqual({
      color: PROBE_END.color,
      backgroundColor: PROBE_END.backgroundColor,
    });
  });

  test("a mutation that only promises a transition still holds readiness", async ({ page }) => {
    // The single-step case above is caught by animation state alone, because the
    // transition exists in the same style pass as the class change. This is the
    // case animation state CANNOT catch: a DOM change that starts nothing, with
    // the transition arriving two frames later — the shape of a React update that
    // commits twice. In the frames between, the layout box has not moved and
    // `getAnimations()` is empty, so only the mutation epoch holds the window.
    await page.goto(row.route);
    await awaitRowReady(page, row);
    await installPaintProbe(page);

    await armLateTransition(page, { atQuiet: STABLE_QUIET_FRAMES - 2, preludeFrames: 2 });

    await awaitStableFrames(page);

    const probe = await readPaintProbe(page);
    const settle = await readSettleState(page);

    expect(probe.armed, `the probe never fired (${probe.ticks} frames)`).toBe(true);
    expect(
      { layoutStable: probe.legacyLayoutStable, runningAnimations: probe.legacyRunning },
      "the prelude mutation must land on a page that layout and animation state both call " +
        "settled — that is the whole point of this case",
    ).toEqual({ layoutStable: true, runningAnimations: 0 });
    expect(probe.preludeTick, "the prelude mutation was never made").not.toBeNull();
    expect(probe.lit, "the transition was never started").toBe(true);
    expect(probe.live, "Chromium never reported a running CSSTransition").toBe(true);
    expect(probe.endFrame, "the transition never ended").not.toBeNull();
    expect(
      settle!.resolvedFrame! - probe.endFrame!,
      `readiness resolved at frame ${settle!.resolvedFrame}, the transition ended at frame ` +
        `${probe.endFrame}. Without the mutation epoch the pass would have completed its quiet ` +
        `run during the prelude, before the transition existed at all.`,
    ).toBeGreaterThanOrEqual(2);
    expect(await probePaint(page)).toEqual({
      color: PROBE_END.color,
      backgroundColor: PROBE_END.backgroundColor,
    });
  });

  test("a page with no late transition still settles promptly", async ({ page }) => {
    await page.goto(row.route);
    await awaitRowReady(page, row);
    // Installed but never lit: same fixture, no transition.
    await installPaintProbe(page);

    // The reference page's skeleton shimmer runs forever by design. It must not
    // block — that contract predates this repair and has to survive it.
    expect(
      await page.evaluate(
        () => document.getAnimations().filter((a) => a.playState === "running").length,
      ),
      "the reference page should still be running its infinite shimmer",
    ).toBeGreaterThan(0);

    await awaitStableFrames(page);
    const settle = await readSettleState(page);

    expect(settle?.resolvedFrame, "the control never resolved").not.toBeNull();
    expect(
      settle!.resolvedFrame! - settle!.startFrame,
      `a quiet page must cost the quiet window and little more, but this pass took ` +
        `${settle!.resolvedFrame! - settle!.startFrame} frames over ${settle!.mutations} ` +
        `mutation(s): ${settle!.samples.join("; ") || "(none)"}`,
    ).toBeLessThanOrEqual(STABLE_QUIET_FRAMES + 3);
    expect(await probePaint(page), "nothing should have moved the probe off its start").toEqual({
      color: PROBE_START.color,
      backgroundColor: PROBE_START.backgroundColor,
    });
  });
});
