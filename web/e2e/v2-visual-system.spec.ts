import { expect, test, type Page } from "@playwright/test";
import { activeSelector, MATRIX_OWNER_ENV, selectRowsFromEnv } from "./support/v2-owner-selection";
import { rowForRoute, V2_ROLE_CONTRACT, type V2Row } from "./support/v2-surface-matrix";
import { prepareRow, seedRow } from "./support/v2-seed";
import { awaitRowReady } from "./support/v2-readiness";
import {
  buildPaintDiagnosticReport,
  collectCanvasSamples,
  collectResolvedPaint,
  diagnosticSlug,
  filterAxeViolations,
  formatAxeViolations,
  judgeCanvasSamples,
  judgePaintRecords,
  judgeSemanticChecks,
  measureHorizontalOverflow,
  measureTouchTargets,
  observeSemanticChecks,
  resolveCanonicalShadows,
  resolveTokenColors,
  runAxe,
  serializePaintDiagnosticReport,
  summarizePaintDiagnostics,
  type DiagnosticContext,
  type PaintVerdict,
} from "./support/v2-visual-audit";

// F4 — the owner-selected semantic and runtime runner.
//
// `V2_MATRIX_OWNER` filters the frozen manifest BEFORE any `test()` is called,
// so an unset selector registers the foundation row and nothing else. There is
// no skip, no ledger and no flag: an unmigrated route is not a pending test, it
// is not a test.
//
// The same file runs in two Playwright projects. `chromium` is the desktop lane;
// `v2-touch` is a 390x844 context with `hasTouch`, which is what actually flips
// the pointer media query. Every test here begins by PROVING which of the two it
// is in, because a context that silently stayed fine-pointer would measure the
// 32/36px control sizes and report success for exactly the wrong reason.

const ROWS = selectRowsFromEnv();
const SELECTOR = activeSelector(MATRIX_OWNER_ENV);

const ACCENTS = ["teal", "sage", "rose", "plum"] as const;
const THEMES = ["light", "dark"] as const;

/** Every tone token any surface role can require, resolved once per page. */
const TONE_TOKENS = [...new Set(Object.values(V2_ROLE_CONTRACT).map((c) => c.tone))];

/** The coarse-pointer minimum, absolute and independent of the 0.9 baseline. */
const TOUCH_MIN_PX = 44;

/** Which pointer state each project is REQUIRED to produce. */
const POINTER_BY_PROJECT: Record<string, "fine" | "coarse"> = {
  chromium: "fine",
  "v2-touch": "coarse",
};

function expectedPointer(projectName: string): "fine" | "coarse" {
  const expected = POINTER_BY_PROJECT[projectName];
  if (!expected) {
    throw new Error(
      `project "${projectName}" has no declared pointer expectation. Add it to ` +
        `POINTER_BY_PROJECT rather than letting the measurement below run unanchored.`,
    );
  }
  return expected;
}

/**
 * Load a row in a given theme/accent, then PROVE the pointer context before any
 * measurement happens. Returns the proven pointer state so a caller can branch
 * on a fact rather than on the project name it hopes is in force.
 */
async function loadRow(
  page: Page,
  row: V2Row,
  theme: (typeof THEMES)[number],
  accent: (typeof ACCENTS)[number],
): Promise<"fine" | "coarse"> {
  await prepareRow(page, row);
  // Registered AFTER prepareRow, whose reset clears storage — init scripts run
  // in registration order, so these survive it.
  await page.addInitScript(
    ([t, a]) => {
      try {
        window.localStorage.setItem("ns-theme", t);
        window.localStorage.setItem("ns-accent", a);
      } catch {}
    },
    [theme, accent] as const,
  );

  await page.goto(row.route);
  await awaitRowReady(page, row);
  await seedRow(page, row);
  await awaitRowReady(page, row);

  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-accent", accent);
  if (theme === "dark") await expect(html).toHaveClass(/dark/);
  else await expect(html).not.toHaveClass(/dark/);

  const media = await page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    fine: matchMedia("(pointer: fine)").matches,
    touchPoints: navigator.maxTouchPoints,
  }));

  const expected = expectedPointer(test.info().project.name);
  expect(
    media.coarse,
    `project "${test.info().project.name}" must report (pointer: coarse) = ${expected === "coarse"}; ` +
      `every target measurement below is meaningless otherwise`,
  ).toBe(expected === "coarse");
  expect(media.fine).toBe(expected === "fine");
  if (expected === "coarse") {
    expect(
      media.touchPoints,
      "a coarse context must expose at least one touch point",
    ).toBeGreaterThanOrEqual(1);
  }

  return expected;
}

// ---------------------------------------------------------------------------
// The batteries
// ---------------------------------------------------------------------------

/**
 * The context a row is being exercised in. Passed as an object rather than a
 * pre-formatted string so the diagnostic attachment can carry the axes as
 * FIELDS — a reader filtering "every rose-accent diagnostic" should not have to
 * parse them back out of a label.
 */
interface RunContext extends DiagnosticContext {
  label: string;
}

function runContext(
  row: V2Row,
  theme: string,
  accent: string,
  pointer: "fine" | "coarse",
): RunContext {
  return {
    owner: row.owner,
    route: row.route,
    theme,
    accent,
    pointer,
    label: `${row.route} [${theme}/${accent}/${pointer}]`,
  };
}

/**
 * Evidence for the analytic scanner's blind spots, recorded in TWO phases.
 *
 * Gradients, images, masks and filters are outside an analytic composite check's
 * reach, and the honest response is a diagnostic rather than a guessed colour.
 * But a diagnostic that only exists inside a local variable is indistinguishable
 * from no diagnostic at all: the owner runner used to compute these and drop
 * them, so an entire class of unverified paint was invisible in the report.
 *
 * The phase split is not stylistic. `page.screenshot({ animations: "disabled" })`
 * MUTATES the page: Playwright fast-forwards finite animations and transitions to
 * their end state, which fires `transitionend` / `animationend`, which runs
 * whatever handlers the page has. Capturing before the semantic, target,
 * overflow, pairing and Axe observations would therefore let evidence-gathering
 * change the very inputs those assertions read. The JSON and the annotation touch
 * nothing and are recorded immediately; the screenshot is deferred until every
 * same-page observation is done.
 *
 * Diagnostics stay non-fatal. `findings`, the `judged` floor and the canvas rules
 * are all fail-closed, and nothing here can change that. A proven finding does
 * not need a screenshot to justify itself, so an aborted test losing its deferred
 * capture costs nothing. An empty set records nothing and adds no noise.
 */
interface PendingDiagnosticEvidence {
  slug: string;
  report: ReturnType<typeof buildPaintDiagnosticReport>;
}

/** Phase 1 — JSON + annotation. Reads nothing from the page and mutates nothing. */
async function recordPaintDiagnostics(
  context: RunContext,
  verdict: PaintVerdict,
): Promise<PendingDiagnosticEvidence | null> {
  if (verdict.diagnostics.length === 0) return null;

  const info = test.info();
  const report = buildPaintDiagnosticReport(context, verdict);
  const slug = diagnosticSlug(context);

  await info.attach(`paint-diagnostics-${slug}.json`, {
    body: serializePaintDiagnosticReport(report),
    contentType: "application/json",
  });

  info.annotations.push({
    type: "v2-paint-diagnostic",
    description: summarizePaintDiagnostics(report),
  });

  return { slug, report };
}

/**
 * Phase 2 — the deterministic screenshot. MUST be called only after every
 * same-page observation and assertion is complete, because it fast-forwards
 * animations and fires their end events.
 */
async function capturePaintDiagnosticEvidence(
  page: Page,
  pending: PendingDiagnosticEvidence | null,
): Promise<void> {
  if (!pending) return;
  await test.info().attach(`paint-diagnostics-${pending.slug}.png`, {
    body: await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" }),
    contentType: "image/png",
  });
}

/**
 * Returns the deferred screenshot evidence, if any. The caller is responsible for
 * passing it to `capturePaintDiagnosticEvidence` once every other same-page
 * assertion has run — see the phase-split note above for why that ordering is a
 * correctness requirement and not a preference.
 */
async function expectNoBlack(
  page: Page,
  row: V2Row,
  context: RunContext,
): Promise<PendingDiagnosticEvidence | null> {
  const label = context.label;
  const canonical = await resolveCanonicalShadows(page);
  expect(
    canonical.length,
    `${label}: the six canonical --sh-* tokens must resolve before paint can be judged against them`,
  ).toBe(6);

  const verdict = judgePaintRecords(await collectResolvedPaint(page), canonical);

  // Phase 1 only: JSON and the annotation are recorded now, so they survive an
  // assertion failure below. The screenshot is deferred — it would mutate the page.
  const pending = await recordPaintDiagnostics(context, verdict);

  // An empty findings list is also what a scan that matched nothing produces.
  expect(verdict.judged, `${label}: the paint scan judged nothing at all`).toBeGreaterThan(50);

  expect(
    verdict.findings,
    `${label} — ${verdict.findings.length} No-Black violation(s):\n` +
      verdict.findings
        .map((f) => `  ${f.path}${f.pseudo} → ${f.property}: ${f.value}\n    └─ ${f.reason}`)
        .join("\n"),
  ).toEqual([]);

  const scan = await collectCanvasSamples(page);
  const canvas = judgeCanvasSamples(scan);

  // Accounting before verdict: every canvas in the document must have reached a
  // definite outcome, or the empty findings list below means nothing.
  expect(
    canvas.accounted,
    `${label}: ${canvas.accounted} of ${scan.canvasCount} canvas element(s) reached an outcome`,
  ).toBe(scan.canvasCount);

  expect(
    canvas.findings,
    `${label} — canvas paint (${JSON.stringify(canvas.byOutcome)}, ${canvas.inspected} pixels ` +
      `inspected):\n` +
      canvas.findings.map((f) => `  ${f.path}: ${f.reason}`).join("\n"),
  ).toEqual([]);

  return pending;
}

async function expectSemanticRoles(page: Page, row: V2Row, label: string) {
  const tokens = await resolveTokenColors(page, TONE_TOKENS);
  const failures = judgeSemanticChecks(row, await observeSemanticChecks(page, row), tokens);
  expect(
    failures,
    `${label} — ${failures.length} semantic failure(s):\n` +
      failures.map((f) => `  ${f.label} (${f.selector})\n    └─ ${f.detail}`).join("\n"),
  ).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const report = await measureHorizontalOverflow(page);
  expect(
    report.offenders,
    `${label}: content escapes the viewport (scrollWidth ${report.documentScrollWidth} > ` +
      `clientWidth ${report.documentClientWidth}):\n` +
      report.offenders.map((o) => `  ${o.path} ends at ${o.right}px`).join("\n"),
  ).toEqual([]);
  expect(report.documentScrollWidth).toBeLessThanOrEqual(report.documentClientWidth + 1);
}

/**
 * Every data surface stays square (DESIGN.md §5). Reported with its count, so a
 * route with no table is visibly vacuous rather than silently passing.
 */
async function expectSquareDataSurfaces(page: Page, label: string) {
  const report = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("table, thead, tbody, tfoot, tr, th, td"));
    const rounded = nodes
      .filter((el) => {
        const s = getComputedStyle(el);
        return [
          s.borderTopLeftRadius,
          s.borderTopRightRadius,
          s.borderBottomLeftRadius,
          s.borderBottomRightRadius,
        ].some((r) => r !== "0px");
      })
      .slice(0, 10)
      .map((el) => `${el.tagName.toLowerCase()} → ${getComputedStyle(el).borderRadius}`);
    return { measured: nodes.length, rounded };
  });
  expect(
    report.rounded,
    `${label}: ${report.measured} data-surface element(s) measured; these are rounded:\n  ` +
      report.rounded.join("\n  "),
  ).toEqual([]);
}

/** Every mounted overlay backdrop paints the theme scrim, never a raw alpha. */
async function expectScrimProvenance(page: Page, label: string) {
  const report = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--scrim)";
    document.body.appendChild(probe);
    const scrim = getComputedStyle(probe).backgroundColor;
    probe.remove();

    const backdrops = Array.from(
      document.querySelectorAll("[data-slot$='-overlay'], [data-slot='backdrop'], [data-scrim]"),
    );
    return {
      scrim,
      measured: backdrops.length,
      offenders: backdrops
        .map((el) => ({
          slot: el.getAttribute("data-slot") ?? el.tagName.toLowerCase(),
          bg: getComputedStyle(el).backgroundColor,
        }))
        .filter((b) => b.bg !== scrim && b.bg !== "rgba(0, 0, 0, 0)"),
    };
  });
  expect(
    report.offenders,
    `${label}: ${report.measured} backdrop(s) measured against var(--scrim) = ${report.scrim}; ` +
      `these differ:\n  ${report.offenders.map((o) => `${o.slot}: ${o.bg}`).join("\n  ")}`,
  ).toEqual([]);
}

/**
 * The Redundant Signal Rule (DESIGN.md §2): a status tint always appears with
 * its paired semantic ink, so status is never carried by colour alone. The ink
 * may sit on the tinted element itself or on a descendant of it — a badge that
 * wraps its text in a span is still pairing them.
 *
 * Scoped to elements that actually SAY something. The rule is about a status
 * SIGNAL, and a signal with no text is precisely the failure it names; an empty
 * tinted box is not a signal at all. That distinction is what keeps a palette
 * swatch — whose entire job is to render a token with nothing else in it — from
 * reading as a status badge that forgot its label.
 */
async function expectStatusPairing(page: Page, label: string) {
  const offenders = await page.evaluate(() => {
    const resolve = (token: string) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = `var(${token})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };
    const resolveInk = (token: string) => {
      const probe = document.createElement("div");
      probe.style.color = `var(${token})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };

    const pairs = [
      ["--successtint", "--successink"],
      ["--warntint", "--warnink"],
      ["--errortint", "--errorink"],
    ] as const;

    const out: { tint: string; html: string }[] = [];
    for (const [tintToken, inkToken] of pairs) {
      const tint = resolve(tintToken);
      const ink = resolveInk(inkToken);
      for (const el of Array.from(document.querySelectorAll("*"))) {
        if (getComputedStyle(el).backgroundColor !== tint) continue;
        if ((el.textContent ?? "").trim() === "") continue;
        const paired =
          getComputedStyle(el).color === ink ||
          Array.from(el.querySelectorAll("*")).some((c) => getComputedStyle(c).color === ink);
        if (!paired) out.push({ tint: tintToken, html: el.outerHTML.slice(0, 120) });
      }
    }
    return out;
  });

  expect(
    offenders,
    `${label}: a status tint appears without its paired semantic ink — status would be ` +
      `carried by colour alone:\n  ${offenders.map((o) => `${o.tint}: ${o.html}`).join("\n  ")}`,
  ).toEqual([]);
}

/**
 * A solid semantic fill always carries its paired `--on-*` foreground, on the
 * filled element AND on every text it contains (DESIGN.md §6: "Don't hardcode
 * white on a semantic fill; use the paired --on-* token").
 *
 * Unlike the status-tint rule above, this one is universal over DESCENDANTS
 * rather than satisfied by any one of them. The failure it exists to catch is a
 * child that opts out — a label inside a `bg-brand` control forcing `text-ink3`
 * — which leaves the fill correct, the parent's own colour correct, and the
 * words on it unreadable. A subtree that establishes its own opaque background
 * is no longer painted on the fill, so it is not held to the fill's pairing.
 */
async function expectSolidFillPairing(page: Page, label: string) {
  const offenders = await page.evaluate(() => {
    const probe = (property: "color" | "backgroundColor", token: string) => {
      const el = document.createElement("div");
      el.style[property === "color" ? "color" : "backgroundColor"] = `var(${token})`;
      document.body.appendChild(el);
      const value = getComputedStyle(el)[property];
      el.remove();
      return value;
    };

    const PAIRS = [
      ["--brand", "--onbrand"],
      ["--fill-error", "--on-error"],
      ["--fill-warn", "--on-warn"],
      ["--ink", "--on-ink"],
    ] as const;

    /** Text this element renders itself, ignoring what its children render. */
    const ownText = (el: Element) =>
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("")
        .trim();

    const out: { fill: string; expected: string; got: string; html: string }[] = [];

    for (const [fillToken, onToken] of PAIRS) {
      const fill = probe("backgroundColor", fillToken);
      const on = probe("color", onToken);

      for (const filled of Array.from(document.querySelectorAll("*"))) {
        if (getComputedStyle(filled).backgroundColor !== fill) continue;

        const stack: Element[] = [filled];
        while (stack.length) {
          const el = stack.pop()!;
          // A descendant that paints its own opaque plane is no longer sitting
          // on the fill, so the fill's pairing does not govern its text.
          if (el !== filled) {
            const bg = getComputedStyle(el).backgroundColor;
            if (bg !== "rgba(0, 0, 0, 0)" && bg !== fill) continue;
          }
          const text = ownText(el);
          const color = getComputedStyle(el).color;
          if (text !== "" && color !== on) {
            out.push({
              fill: fillToken,
              expected: `${onToken} (${on})`,
              got: color,
              html: `${el.tagName.toLowerCase()}: ${JSON.stringify(text.slice(0, 40))}`,
            });
          }
          stack.push(...Array.from(el.children));
        }
      }
    }
    return out;
  });

  expect(
    offenders,
    `${label}: text on a solid semantic fill does not use its paired --on-* token, ` +
      `so the fill is legible only by accident:\n  ` +
      offenders
        .map((o) => `${o.fill} → expected ${o.expected}, got ${o.got} on ${o.html}`)
        .join("\n  "),
  ).toEqual([]);
}

async function expectAxeClean(page: Page, row: V2Row, label: string) {
  const results = await runAxe(page);

  // An empty violations list is also what a failed axe injection produces, so
  // the run has to prove it actually evaluated the page before its silence
  // counts as evidence.
  expect(
    results.passes.length + results.violations.length + results.incomplete.length,
    `${label}: axe evaluated no rule at all — the scan did not run`,
  ).toBeGreaterThan(10);

  const verdict = filterAxeViolations(results, row.axeExceptions);

  expect(
    verdict.violations,
    `${label} — ${verdict.violations.length} WCAG AA violation(s):\n${formatAxeViolations(verdict.violations)}`,
  ).toEqual([]);

  // A stale exception is a documented waiver for something that no longer
  // exists. Left in place it silently widens the next real violation's blast
  // radius, so it fails here rather than waiting for G1 to notice.
  expect(
    verdict.unusedExceptions,
    `${label}: axe exception(s) that matched nothing and should be retired:\n  ` +
      verdict.unusedExceptions.map((e) => `${e.rule} on ${e.selector} — ${e.reason}`).join("\n  "),
  ).toEqual([]);
}

async function expectTouchTargets(page: Page, label: string) {
  const report = await measureTouchTargets(page, TOUCH_MIN_PX);
  expect(
    report.measured,
    `${label}: no interactive control was measured, so the target assertion is vacuous`,
  ).toBeGreaterThan(0);
  expect(
    report.offenders,
    `${label}: ${report.offenders.length} control(s) under the ${TOUCH_MIN_PX}px coarse minimum ` +
      `(of ${report.measured} measured):\n` +
      report.offenders.map((o) => `  ${o.path} "${o.text}" — ${o.width}x${o.height}`).join("\n"),
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test.describe(`v2 visual system — ${MATRIX_OWNER_ENV}=${SELECTOR}`, () => {
  for (const row of ROWS) {
    test.describe(`${row.owner} · ${row.route}`, () => {
      for (const theme of THEMES) {
        test(`${theme} theme — full contract`, async ({ page }) => {
          const pointer = await loadRow(page, row, theme, "teal");
          const context = runContext(row, theme, "teal", pointer);
          const label = context.label;

          const pending = await expectNoBlack(page, row, context);
          await expectSemanticRoles(page, row, label);
          await expectSquareDataSurfaces(page, label);
          await expectScrimProvenance(page, label);
          await expectStatusPairing(page, label);
          await expectSolidFillPairing(page, label);
          await expectNoHorizontalOverflow(page, label);
          await expectAxeClean(page, row, label);
          if (pointer === "coarse") await expectTouchTargets(page, label);

          // LAST. The capture fast-forwards animations and fires their end
          // events, so it must not run before anything above reads the page.
          await capturePaintDiagnosticEvidence(page, pending);
        });
      }

      // The accent axis changes `--brand` and its two derived tokens, so it can
      // reach contrast, tint and border paint on any surface that uses them. It
      // gets the paint and role batteries rather than the full one: axe and the
      // layout measurements do not vary with the accent, and running them four
      // more times would buy nothing but wall-clock.
      for (const accent of ACCENTS) {
        test(`${accent} accent — paint and roles hold`, async ({ page }) => {
          const pointer = await loadRow(page, row, "light", accent);
          const context = runContext(row, "light", accent, pointer);
          const label = context.label;

          const pending = await expectNoBlack(page, row, context);
          await expectSemanticRoles(page, row, label);
          await expectStatusPairing(page, label);
          // The accent axis is exactly where a solid-brand pairing breaks: the
          // fill moves per accent while an opted-out child colour does not.
          await expectSolidFillPairing(page, label);

          await capturePaintDiagnosticEvidence(page, pending);
        });
      }

      test("controls meet the pointer contract for this project", async ({ page }) => {
        const pointer = await loadRow(page, row, "light", "teal");
        const label = `${row.route} [pointer:${pointer}]`;

        if (pointer === "coarse") {
          await expectTouchTargets(page, label);
        } else {
          // The precise-pointer lane's own claim: real controls exist and are
          // measurable. Without it this branch would assert nothing at all, and
          // a desktop run would "cover" the pointer contract by doing nothing.
          const report = await measureTouchTargets(page, 1);
          expect(report.measured, `${label}: no interactive control was measured`).toBeGreaterThan(
            0,
          );
          expect(report.offenders, `${label}: a control has a zero-sized box`).toEqual([]);
        }
        await expectNoHorizontalOverflow(page, label);
      });
    });
  }
});

// Always the foundation surface, whatever `V2_MATRIX_OWNER` selects: these
// fixtures are about the scanner, not about a route.
const FIXTURE_ROW = rowForRoute("/design-system")!;

/**
 * The pointer axis of the project currently running, derived the same way the
 * owner rows derive it. The fixtures used to hard-code `"fine"`, which made
 * every piece of v2-touch evidence describe a context it was not captured in.
 */
function projectPointer(): "fine" | "coarse" {
  return expectedPointer(test.info().project.name);
}

// ---------------------------------------------------------------------------
// Runtime scanner fixtures
//
// The pure judging half is exercised directly in `v2-visual-audit.test.ts`.
// These prove the COLLECTORS: that the browser-side traversal actually reaches
// each kind of paint. A scanner that silently cannot see pseudo-elements, or
// portalled overlays, or SVG paint, reports the same empty findings list as a
// clean page — and would go on doing so for the rest of the epic.
//
// Each fixture injects its own synthetic DOM and asserts on the collector's
// output, so nothing here depends on (or perturbs) the real page's cleanliness.
// ---------------------------------------------------------------------------
test.describe("runtime scanner fixtures", () => {
  /** Inject a probe tree onto the foundation surface and collect what it paints. */
  async function collectWithProbe(page: Page, html: string, style = "") {
    await page.goto(FIXTURE_ROW.route);
    await awaitRowReady(page, FIXTURE_ROW);
    if (style) await page.addStyleTag({ content: style });
    await page.evaluate((markup) => {
      const host = document.createElement("div");
      host.id = "v2-probe";
      host.innerHTML = markup;
      document.body.appendChild(host);
    }, html);
    const canonical = await resolveCanonicalShadows(page);
    const records = await collectResolvedPaint(page);
    return { canonical, records, verdict: judgePaintRecords(records, canonical) };
  }

  const findingsFor = (verdict: ReturnType<typeof judgePaintRecords>, property: string) =>
    verdict.findings.filter((f) => f.property === property);

  test("sees a normal element's foreground and background", async ({ page }) => {
    const { verdict } = await collectWithProbe(
      page,
      `<p id="probe-normal" style="color: rgb(0,0,0); background: rgb(0,0,0)">x</p>`,
    );
    expect(findingsFor(verdict, "color").length).toBeGreaterThan(0);
    expect(findingsFor(verdict, "backgroundColor").length).toBeGreaterThan(0);
  });

  test("sees ::before and ::after", async ({ page }) => {
    const { verdict } = await collectWithProbe(
      page,
      `<p class="probe-pseudo">x</p>`,
      `.probe-pseudo::before { content: "a"; color: rgb(0,0,0); }
       .probe-pseudo::after  { content: "b"; background: rgb(0,0,0); }`,
    );
    expect(verdict.findings.filter((f) => f.pseudo === "::before").length).toBeGreaterThan(0);
    expect(verdict.findings.filter((f) => f.pseudo === "::after").length).toBeGreaterThan(0);
  });

  test("sees SVG fill and stroke — and does NOT read them off plain HTML", async ({ page }) => {
    const { verdict } = await collectWithProbe(
      page,
      `<svg width="8" height="8"><rect id="probe-svg" width="8" height="8" fill="rgb(0,0,0)" stroke="rgb(0,0,0)"/></svg>
       <div id="probe-html">plain</div>`,
    );
    expect(findingsFor(verdict, "fill").length).toBeGreaterThan(0);
    expect(findingsFor(verdict, "stroke").length).toBeGreaterThan(0);
    // `fill` inherits with an initial value of black, so an unfiltered scan
    // reports every <div> in the document. That was a real defect in this
    // scanner, and this is the regression that keeps it fixed.
    expect(verdict.findings.filter((f) => f.path.includes("probe-html"))).toEqual([]);
  });

  test("sees borders and outlines only when the edge is actually drawn", async ({ page }) => {
    const { verdict } = await collectWithProbe(
      page,
      `<div id="probe-border" style="border: 2px solid rgb(0,0,0)">x</div>
       <div id="probe-zero" style="border: 0 solid rgb(0,0,0)">x</div>`,
    );
    expect(findingsFor(verdict, "borderTopColor").length).toBeGreaterThan(0);
    // Chromium reports a used border colour regardless of width; reading it
    // unconditionally would invent a violation on every zero-width edge.
    expect(verdict.findings.filter((f) => f.path.includes("probe-zero"))).toEqual([]);
  });

  test("sees a portalled overlay in document.body", async ({ page }) => {
    await page.goto(FIXTURE_ROW.route);
    await awaitRowReady(page, FIXTURE_ROW);
    await page.getByTestId("open-dialog").click();
    await expect(page.locator("[data-slot='dialog-content']")).toBeVisible();
    await awaitRowReady(page, FIXTURE_ROW);

    const records = await collectResolvedPaint(page);
    expect(
      records.some((r) => r.path.includes("dialog-content")),
      "the scanner must reach a Base UI popup, which is portalled outside the page tree",
    ).toBe(true);

    const canonical = await resolveCanonicalShadows(page);
    expect(judgePaintRecords(records, canonical).findings).toEqual([]);
  });

  test("accepts a canonical shadow and rejects a hand-authored one", async ({ page }) => {
    const { verdict, canonical } = await collectWithProbe(
      page,
      `<div id="probe-ok" style="box-shadow: var(--sh-3)">x</div>
       <div id="probe-raw" style="box-shadow: 0 2px 4px rgba(0,0,0,0.9)">x</div>`,
    );
    expect(canonical).toHaveLength(6);
    expect(verdict.findings.filter((f) => f.path.includes("probe-ok"))).toEqual([]);
    expect(verdict.findings.filter((f) => f.path.includes("probe-raw")).length).toBeGreaterThan(0);
  });

  test("resolves a translucent composite through its ancestors", async ({ page }) => {
    const { verdict } = await collectWithProbe(
      page,
      `<div style="background: rgb(0,0,0)"><div id="probe-composite" style="background: rgba(0,0,0,0.5)">x</div></div>`,
    );
    const composite = verdict.findings.filter(
      (f) => f.path.includes("probe-composite") && f.reason.includes("composites"),
    );
    expect(
      composite.length,
      "a translucent layer over a black ancestor composites to black and must be reported as such",
    ).toBeGreaterThan(0);
  });

  test("catches a child that opts out of a solid fill's paired foreground", async ({ page }) => {
    // The exact shape reported on /shift-counts: a `bg-brand` control whose
    // formula child forces `text-ink3`, leaving the fill right, the parent's own
    // colour right, and the words on it unreadable. R4 owns that file; this is
    // the check that will catch it when R4's rows are selected.
    await page.goto(FIXTURE_ROW.route);
    await awaitRowReady(page, FIXTURE_ROW);
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.innerHTML = `<button id="probe-fill" style="background: var(--brand); color: var(--onbrand)">
        Exact <span id="probe-optout" style="color: var(--ink3)">= sum(hours)</span>
      </button>`;
      document.body.appendChild(host);
    });

    await expect(expectSolidFillPairing(page, "fixture")).rejects.toThrow(/paired --on-\* token/);

    // And the same control without the opt-out passes, so the check is not
    // simply rejecting every solid fill it sees.
    await page.evaluate(() => {
      document.getElementById("probe-optout")!.setAttribute("style", "color: var(--onbrand)");
    });
    await expectSolidFillPairing(page, "fixture");
  });

  test("reports a gradient as a diagnostic rather than guessing at it", async ({ page }) => {
    const { verdict } = await collectWithProbe(
      page,
      `<div id="probe-gradient" style="background-image: linear-gradient(rgb(0,0,0), rgb(255,255,255))">x</div>`,
    );
    const diagnostics = verdict.diagnostics.filter((d) => d.path.includes("probe-gradient"));
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(verdict.findings.filter((f) => f.path.includes("probe-gradient"))).toEqual([]);
  });

  // The judge-level test above proves the DIAGNOSTIC is produced. It cannot prove
  // the production runner does anything with it — and for two commits it did not:
  // `expectNoBlack` computed the set and dropped it, so non-solid paint was
  // unverified AND invisible. This drives the real `expectNoBlack` and asserts
  // against `test.info().attachments`, so the evidence path itself is covered.
  test("the production expectNoBlack attaches diagnostic JSON and a screenshot", async ({
    page,
  }) => {
    await page.goto(FIXTURE_ROW.route);
    await awaitRowReady(page, FIXTURE_ROW);

    // A gradient and a filter: non-solid, so each is a diagnostic, and neither
    // paints a black background colour, so neither is a No-Black finding. That
    // distinction is the point — `expectNoBlack` must still PASS here.
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.innerHTML = `
        <div id="probe-attach-gradient" style="background-image: linear-gradient(rgb(0,0,0), rgb(255,255,255)); height: 20px">g</div>
        <div id="probe-attach-filter" style="filter: blur(2px); height: 20px">f</div>`;
      document.body.appendChild(host);
    });

    const before = test.info().attachments.length;
    // The pointer axis is DERIVED from the active project, exactly as the owner
    // rows derive it. Hard-coding "fine" made the v2-touch evidence lie about the
    // context it was captured in.
    const context = runContext(FIXTURE_ROW, "light", "teal", projectPointer());

    // The SAME production helper the owner rows call.
    const pending = await expectNoBlack(page, FIXTURE_ROW, context);
    await capturePaintDiagnosticEvidence(page, pending);

    const added = test.info().attachments.slice(before);
    const slug = diagnosticSlug(context);

    const json = added.find((a) => a.name === `paint-diagnostics-${slug}.json`);
    expect(json, `attachments: ${added.map((a) => a.name).join(", ")}`).toBeDefined();
    expect(json!.contentType).toBe("application/json");

    const png = added.find((a) => a.name === `paint-diagnostics-${slug}.png`);
    expect(png, `attachments: ${added.map((a) => a.name).join(", ")}`).toBeDefined();
    expect(png!.contentType).toBe("image/png");

    // The JSON carries the owner axes AND the injected paint, not just a count.
    const report = JSON.parse(json!.body!.toString("utf8"));
    expect(report.owner).toBe(FIXTURE_ROW.owner);
    expect(report.route).toBe(FIXTURE_ROW.route);
    expect({ theme: report.theme, accent: report.accent, pointer: report.pointer }).toEqual({
      theme: "light",
      accent: "teal",
      pointer: projectPointer(),
    });
    expect(report.judged).toBeGreaterThan(50);
    expect(report.diagnosticCount).toBe(report.diagnostics.length);

    const paths = report.diagnostics.map((d: { path: string }) => d.path).join(" ");
    expect(paths).toContain("probe-attach-gradient");
    expect(paths).toContain("probe-attach-filter");

    // Every entry carries the full descriptor a reader needs to locate it.
    for (const d of report.diagnostics) {
      expect(Object.keys(d).sort()).toEqual(["note", "path", "property", "pseudo", "value"]);
    }

    // And the annotation names the owner so the report is readable without
    // opening the JSON.
    const annotation = test.info().annotations.find((a) => a.type === "v2-paint-diagnostic");
    expect(annotation?.description).toContain(FIXTURE_ROW.owner);
    expect(annotation?.description).toContain(FIXTURE_ROW.route);
  });

  test("a clean page attaches nothing at all", async ({ page }) => {
    // Empty diagnostics must add no noise: no JSON, no screenshot, no annotation.
    // Without this, the cheapest way to satisfy the requirement above would be to
    // attach unconditionally and bury the real signal.
    await page.goto(FIXTURE_ROW.route);
    await awaitRowReady(page, FIXTURE_ROW);

    const canonical = await resolveCanonicalShadows(page);
    const verdict = judgePaintRecords(await collectResolvedPaint(page), canonical);
    expect(
      verdict.diagnostics,
      "the reference page is expected to be free of non-solid paint; if this ever changes, " +
        "this test needs a different clean fixture rather than a relaxed assertion",
    ).toEqual([]);

    const before = test.info().attachments.length;
    const pending = await expectNoBlack(
      page,
      FIXTURE_ROW,
      runContext(FIXTURE_ROW, "light", "teal", projectPointer()),
    );
    expect(pending, "a clean page yields no deferred screenshot evidence").toBeNull();
    await capturePaintDiagnosticEvidence(page, pending);
    expect(test.info().attachments.length - before).toBe(0);
    expect(test.info().annotations.filter((a) => a.type === "v2-paint-diagnostic")).toEqual([]);
  });

  // The ordering requirement, made executable.
  //
  // `page.screenshot({ animations: "disabled" })` fast-forwards finite
  // transitions to their end state and fires `transitionend`. If evidence were
  // captured before the semantic/Axe observations, any handler on that event
  // would rewrite the page underneath them. This probe installs exactly such a
  // handler and proves two things at once: the mutation has NOT happened while
  // the production path evaluates its inputs, and it HAS happened after the
  // deferred capture — which is what makes the probe discriminating rather than
  // merely green.
  test("diagnostic capture cannot mutate the page before its assertions read it", async ({
    page,
  }) => {
    await page.goto(FIXTURE_ROW.route);
    await awaitRowReady(page, FIXTURE_ROW);

    await page.evaluate(() => {
      const w = window as unknown as { __probeEndEvents: number };
      w.__probeEndEvents = 0;

      const host = document.createElement("div");
      // A gradient so the run produces diagnostics at all, and a long finite
      // transition whose end event mutates the DOM.
      host.innerHTML = `
        <div id="probe-order-gradient" style="background-image: linear-gradient(rgb(0,0,0), rgb(255,255,255)); height: 20px">g</div>
        <div id="probe-order-transition" style="height: 20px; background-color: rgb(252,254,253); transition: background-color 30s linear">t</div>`;
      document.body.appendChild(host);

      const target = document.getElementById("probe-order-transition")!;
      target.addEventListener("transitionend", () => {
        w.__probeEndEvents++;
        // The mutation a premature capture would inflict on later assertions.
        target.setAttribute("data-probe-mutated", "true");
      });

      // Start the transition on the next frame so it is genuinely running.
      requestAnimationFrame(() => {
        target.style.backgroundColor = "rgb(17, 24, 22)";
      });
    });

    const settled = () =>
      page.evaluate(() => ({
        endEvents: (window as unknown as { __probeEndEvents: number }).__probeEndEvents,
        mutated: document
          .getElementById("probe-order-transition")!
          .hasAttribute("data-probe-mutated"),
      }));

    const context = runContext(FIXTURE_ROW, "light", "teal", projectPointer());
    const pending = await expectNoBlack(page, FIXTURE_ROW, context);

    // The production path produced evidence...
    expect(pending, "the gradient probe should have produced diagnostics").not.toBeNull();

    // ...and did NOT fast-forward the transition while doing so. This is the
    // assertion that fails if the screenshot moves back before the observations.
    expect(
      await settled(),
      "expectNoBlack must not fire transition end events before its own assertions read the page",
    ).toEqual({ endEvents: 0, mutated: false });

    // A same-page observation of the kind the owner rows make, still reading the
    // unmutated page.
    await expectSemanticRoles(page, FIXTURE_ROW, context.label);
    expect((await settled()).mutated, "semantic inputs were read on a mutated page").toBe(false);

    // Now the deferred capture, which is allowed to fast-forward.
    await capturePaintDiagnosticEvidence(page, pending);

    // The probe is live: the capture really does fire the end event. Without
    // this, the assertions above could pass simply because the transition never
    // ran, and the test would prove nothing.
    const after = await settled();
    expect(
      after.endEvents,
      "the deferred capture should have fast-forwarded the transition, proving the probe was live",
    ).toBeGreaterThan(0);
    expect(after.mutated).toBe(true);

    // And the evidence survived.
    const names = test.info().attachments.map((a) => a.name);
    const slug = diagnosticSlug(context);
    expect(names).toContain(`paint-diagnostics-${slug}.json`);
    expect(names).toContain(`paint-diagnostics-${slug}.png`);
  });

  test("reads a same-origin canvas, and judges its pixels", async ({ page }) => {
    await page.goto(FIXTURE_ROW.route);
    await awaitRowReady(page, FIXTURE_ROW);

    // Two canvases painted from script: one the warm ink, one pure black. The
    // first proves pixel inspection actually works; the second proves it is not
    // merely returning nothing.
    await page.evaluate(() => {
      for (const [id, fill] of [
        ["probe-canvas-ok", "rgb(51, 46, 43)"],
        ["probe-canvas-black", "rgb(0, 0, 0)"],
      ] as const) {
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        canvas.setAttribute("data-testid", id);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, 16, 16);
        document.body.appendChild(canvas);
      }
    });

    const scan = await collectCanvasSamples(page);
    const ok = scan.samples.find((s) => s.path.includes("probe-canvas-ok"))!;
    const black = scan.samples.find((s) => s.path.includes("probe-canvas-black"))!;

    expect(ok.error, "a same-origin canvas must be readable").toBeUndefined();
    expect(ok.outcome).toBe("readable-2d");
    expect(ok.pixels.length, "pixel inspection returned nothing").toBeGreaterThan(0);
    expect(judgeCanvasSamples({ canvasCount: 1, samples: [ok] }).findings).toEqual([]);

    const blackVerdict = judgeCanvasSamples({ canvasCount: 1, samples: [black] });
    expect(blackVerdict.findings.length).toBe(1);
    expect(blackVerdict.inspected).toBeGreaterThan(0);

    // Accounting: every canvas in the document reached an outcome, so an empty
    // findings list is a real result rather than a short scan.
    expect(scan.samples.length).toBe(scan.canvasCount);
  });

  test("a zero-sized canvas is recorded explicitly, never as empty success", async ({ page }) => {
    await page.goto(FIXTURE_ROW.route);
    await awaitRowReady(page, FIXTURE_ROW);
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 0;
      canvas.height = 0;
      canvas.setAttribute("data-testid", "probe-canvas-zero");
      document.body.appendChild(canvas);
    });

    const scan = await collectCanvasSamples(page);
    const zero = scan.samples.find((s) => s.path.includes("probe-canvas-zero"))!;
    expect(zero, "a zero-sized canvas must still be sampled").toBeDefined();
    expect(zero.outcome).toBe("zero-size");
    expect(scan.samples.length).toBe(scan.canvasCount);

    // It paints nothing, so it is not a failure — but it IS accounted for, which
    // is the difference between "nothing to see" and "nobody looked".
    const verdict = judgeCanvasSamples({ canvasCount: 1, samples: [zero] });
    expect(verdict.findings).toEqual([]);
    expect(verdict.byOutcome["zero-size"]).toBe(1);
    expect(verdict.accounted).toBe(1);
  });

  test("a real WebGL canvas is read back or fails explicitly — never silently", async ({
    page,
  }) => {
    await page.goto(FIXTURE_ROW.route);
    await awaitRowReady(page, FIXTURE_ROW);

    // A genuine WebGL context, not a stub. `getContext("2d")` returns null once
    // this renderer owns the canvas, which is exactly how the old collector
    // recorded it as an error-free sample with no pixels and passed No-Black
    // without inspecting one pixel of it.
    const created = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      canvas.setAttribute("data-testid", "probe-canvas-webgl");
      document.body.appendChild(canvas);
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) return { ok: false as const, twoD: canvas.getContext("2d") !== null };
      // Opaque black, so a successful readback must ALSO be judged a finding.
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { ok: true as const, twoD: canvas.getContext("2d") !== null };
    });

    expect(created.ok, "the pinned Chromium should provide a WebGL context").toBe(true);
    expect(
      created.twoD,
      "getContext('2d') must return null here — that null is the hole this closes",
    ).toBe(false);

    const scan = await collectCanvasSamples(page);
    const webgl = scan.samples.find((s) => s.path.includes("probe-canvas-webgl"))!;

    expect(webgl, "the WebGL canvas must be sampled, not dropped").toBeDefined();
    expect(scan.samples.length).toBe(scan.canvasCount);
    expect(webgl.contextType, "the owning renderer must be identified").toMatch(/webgl/);

    // Either it was genuinely read back, or it failed loudly with the reason.
    // Both are acceptable; "empty and fine" is not, and neither is silence.
    const verdict = judgeCanvasSamples({ canvasCount: 1, samples: [webgl] });
    if (webgl.outcome === "readable-webgl") {
      expect(webgl.pixels.length).toBeGreaterThan(0);
      // The buffer was cleared to opaque black, so reading it must FAIL No-Black.
      expect(verdict.findings.length, "an opaque black WebGL frame must be a finding").toBe(1);
      expect(verdict.inspected).toBeGreaterThan(0);
    } else {
      expect(webgl.outcome).toBe("unreadable");
      expect(webgl.error, "an unreadable canvas must say why").toBeTruthy();
      expect(verdict.findings.length).toBe(1);
      expect(verdict.findings[0].reason).toMatch(/hard failure, not a skip/);
    }
  });

  test("a dropped canvas cannot pass on an empty findings list", async ({ page }) => {
    // The accounting rule itself. A collector that returns fewer samples than
    // there are canvases produces the same empty findings list as a clean page,
    // so the count is judged separately.
    await page.goto(FIXTURE_ROW.route);
    await awaitRowReady(page, FIXTURE_ROW);

    const verdict = judgeCanvasSamples({ canvasCount: 3, samples: [] });
    expect(verdict.findings.length).toBe(1);
    expect(verdict.findings[0].property).toBe("canvas accounting");
    expect(verdict.findings[0].reason).toMatch(/dropped a canvas/);
    expect(verdict.accounted).toBe(0);
  });

  test("fails a genuinely tainted canvas, and never skips it", async ({ page }) => {
    // A real cross-origin image with no CORS headers, served through Playwright's
    // router. This taints the canvas in the browser for real, rather than
    // stubbing `getImageData` to throw and calling that a proof.
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await page.route("http://cross-origin.test/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
    );

    await page.goto(FIXTURE_ROW.route);
    await awaitRowReady(page, FIXTURE_ROW);

    const drew = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      canvas.setAttribute("data-testid", "probe-canvas-tainted");
      document.body.appendChild(canvas);
      const ctx = canvas.getContext("2d")!;
      const img = new Image();
      img.src = "http://cross-origin.test/pixel.png";
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
      ctx.drawImage(img, 0, 0, 16, 16);
      return true;
    });
    expect(drew).toBe(true);

    const scan = await collectCanvasSamples(page);
    const tainted = scan.samples.find((s) => s.path.includes("probe-canvas-tainted"))!;
    expect(tainted.error, "drawing a cross-origin image must taint the canvas").toMatch(
      /SecurityError/i,
    );
    expect(tainted.outcome).toBe("tainted");
    expect(scan.samples.length).toBe(scan.canvasCount);

    const verdict = judgeCanvasSamples({ canvasCount: 1, samples: [tainted] });
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].reason).toMatch(/hard failure, not a skip/);
    expect(verdict.byOutcome.tainted).toBe(1);
  });
});

test(`the ${MATRIX_OWNER_ENV} selection registered at least one row`, () => {
  // Registration-time filtering means a mis-selection produces an EMPTY suite,
  // which a reporter renders as a pass. This is the guard against that.
  expect(ROWS.length, `${MATRIX_OWNER_ENV}=${SELECTOR} registered no rows`).toBeGreaterThan(0);
});
