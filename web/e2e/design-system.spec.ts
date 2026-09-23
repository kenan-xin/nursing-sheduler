import { expect, test, type Locator, type Page } from "@playwright/test";
import { rowForRoute } from "./support/v2-surface-matrix";
import { prepareRow } from "./support/v2-seed";
import { awaitRowReady, enterScreenshotMode, SCREENSHOT_ATTRIBUTE } from "./support/v2-readiness";

// Render / viewport / accent / reduced-motion / hydration rows of the T03
// acceptance matrix. Static rows (token snapshot, accent/shell derivation,
// radius decls, no-raw-color guard) live in app/design-system.test.ts.
//
// The theme/accent lifecycle rows below are the browser half of the F1 contract:
// the supported color-mix() computed path (which the source tests cannot reach,
// because Chromium cannot be made to fail a supported @supports query), the four
// accents across both themes, and every way the pre-paint script can be denied
// its storage.

// The canonical accent contract as the browser must compute it. --brandink and
// --brandtint here are the color-mix() results, not the static fallbacks; the
// two agree by construction (the fallbacks are the nearest 8-bit rendering of
// these formulas), which is what makes the pair testable from both sides.
const ACCENT_MATRIX = {
  teal: {
    light: { brand: "#0b7d68", brandink: "#096755", brandtint: "#e4f1ee" },
    dark: { brand: "#12a389", brandink: "#71c8b8", brandtint: "#18443b" },
  },
  sage: {
    light: { brand: "#3f7f6b", brandink: "#346858", brandtint: "#e9f1ee" },
    dark: { brand: "#72aa94", brandink: "#aaccbf", brandtint: "#31453e" },
  },
  rose: {
    light: { brand: "#af605a", brandink: "#904f4a", brandtint: "#f4eeed" },
    dark: { brand: "#d1847e", brandink: "#e3b5b2", brandtint: "#4a3b38" },
  },
  plum: {
    light: { brand: "#6b5f8c", brandink: "#584e73", brandtint: "#eeeef2" },
    dark: { brand: "#9e91c2", brandink: "#c5bdda", brandtint: "#3c3f4a" },
  },
} as const;

const ACCENTS = ["teal", "sage", "rose", "plum"] as const;

const ONBRAND = { light: "#ffffff", dark: "#111816" } as const;

// The two color-mix() inputs the derived tokens are built from, per theme.
const SURFACE = { light: "#fcfefd", dark: "#1a2220" } as const;

const MIX = {
  light: { ink: [82, "#000000"], tint: [10, SURFACE.light] },
  dark: { ink: [60, "#ffffff"], tint: [26, SURFACE.dark] },
} as const satisfies Record<"light" | "dark", Record<"ink" | "tint", readonly [number, string]>>;

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** The exact sRGB result of `color-mix(in srgb, a pct%, b)`, in 0..1 channels. */
function mixChannels(a: string, pct: number, b: string): [number, number, number] {
  const from = channels(a);
  const to = channels(b);
  const t = pct / 100;
  return [0, 1, 2].map((i) => from[i] * t + to[i] * (1 - t)) as [number, number, number];
}

// Denies every localStorage read the way a hardened profile or a partitioned
// third-party context does. Two shapes, because they fail at different points:
// the accessor itself throwing, and the read throwing.
function denyStorage(mode: "read-throws" | "property-throws"): string {
  return `(function () {
    if (${JSON.stringify(mode)} === "property-throws") {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get: function () { throw new DOMException("denied", "SecurityError"); },
      });
      return;
    }
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: function () { throw new DOMException("denied", "SecurityError"); },
        setItem: function () {},
        removeItem: function () {},
      },
    });
  })();`;
}

// WCAG 2.2 SC 1.4.3 relative-luminance contrast, computed from rendered colors.
// https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum
function parseRgb(value: string): [number, number, number] {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`unparseable color: ${value}`);
  const parts = m[1].split(/[,\s/]+/).map(parseFloat);
  return [parts[0], parts[1], parts[2]];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(parseRgb(fg));
  const b = relativeLuminance(parseRgb(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The 8-bit `rgb(...)` form Chromium reports for a plain hex token. */
function toRgb(hex: string): string {
  return `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
}

function swatchColor(page: Page, token: string) {
  return page
    .getByTestId(`swatch-${token}`)
    .locator("div")
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
}

// Plain hex tokens and derived color-mix() tokens are DIFFERENT contracts and
// get separate assertion paths. Collapsing them into one helper is what let a
// derived row pass on a static fallback: `--brandink`'s published fallback is by
// construction the nearest-8-bit rendering of its own formula, so an `rgb(...)`
// paint that equals it proves nothing about whether the guarded branch ran.
//
// Chromium serializes a resolved `color-mix(in srgb, …)` as `color(srgb r g b)`
// and a plain hex token as `rgb(r, g, b)`. For a derived row the `color(srgb …)`
// form IS the evidence that the @supports branch is live, so it is required, not
// merely preferred — see the adversarial regression at the end of this file.
const MIX_CHANNEL_TOLERANCE = 1e-5;

// The oracle is deliberately narrow: exactly the opaque three-channel form the
// pinned Chromium project was observed to emit for a resolved color-mix(). There
// is no optional-alpha branch. An explicit `/ 1` is numerically equivalent but is
// a DIFFERENT, unobserved serialization, and an oracle whose job is to prove the
// guarded branch ran must fail closed on anything it has not actually seen —
// tolerating unobserved forms is how a proof quietly becomes an assumption.
const MIX_CHANNEL = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const SUPPORTED_MIX_PATTERN = new RegExp(
  `^color\\(srgb\\s+(${MIX_CHANNEL})\\s+(${MIX_CHANNEL})\\s+(${MIX_CHANNEL})\\)$`,
);

/**
 * Parses a Chromium-resolved supported-branch `color-mix()` paint into 0..1
 * channels. Returns null for ANY other serialization — `rgb(...)` (what a later
 * rule resetting the token to its static fallback produces), any alpha suffix,
 * another colour space, a different channel count, or a non-finite channel.
 */
function parseSupportedMix(value: string): [number, number, number] | null {
  const srgb = value.trim().match(SUPPORTED_MIX_PATTERN);
  if (!srgb) return null;
  const [r, g, b] = srgb.slice(1, 4).map(Number);
  if (![r, g, b].every(Number.isFinite)) return null;
  return [r, g, b];
}

/**
 * The derived-token predicate, pure and directly testable: true only when the
 * paint is a supported-branch mix AND every channel matches the full-precision
 * formula. A rounded 8-bit fallback can never satisfy it.
 *
 * The tolerance targets serialization, not colour drift. Chromium's six-decimal
 * error on light rose's 143.5 tie is ~9.8e-8 in normalized channel space, while
 * one 8-bit step is 1/255 ≈ 3.9e-3 — about 392× the tolerance — so real drift
 * still fails. The nearest-8-bit correspondence between these formulas and the
 * published fallback table is pinned exactly in app/design-system.test.ts.
 */
function matchesSupportedMix(value: string, expected: [number, number, number]): boolean {
  const parsed = parseSupportedMix(value);
  return (
    parsed !== null &&
    [0, 1, 2].every((i) => Math.abs(parsed[i] - expected[i]) < MIX_CHANNEL_TOLERANCE)
  );
}

/** Asserts a swatch that renders a plain hex token, at exact 8-bit rgb(). */
async function expectPlainSwatch(page: Page, token: string, hex: string) {
  const eightBit = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ");
  expect(await swatchColor(page, token), `--${token}`).toBe(`rgb(${eightBit})`);
}

/**
 * Asserts a swatch that renders a color-mix() derived token. Requires the
 * supported-branch serialization first, then the full-precision formula.
 */
async function expectMixedSwatch(
  page: Page,
  token: string,
  expected: [number, number, number],
  label: string,
) {
  const actual = await swatchColor(page, token);
  const parsed = parseSupportedMix(actual);
  expect(
    parsed,
    `${label}: expected the guarded color-mix() branch to paint a color(srgb …) value, got ${actual}. ` +
      `An rgb(...) value here means a later rule reset --${token} to its static fallback.`,
  ).not.toBeNull();
  if (parsed === null) throw new Error(`${label}: unreachable — assertion above throws`);

  for (const i of [0, 1, 2]) {
    expect(
      Math.abs(parsed[i] - expected[i]),
      `${label} channel ${i}: got ${actual}, expected ${expected.join(" ")}`,
    ).toBeLessThan(MIX_CHANNEL_TOLERANCE);
  }
}

// F4's foundation row. This spec is the one place the manifest's descriptors
// meet the surface they describe, so it uses them rather than restating them.
const FOUNDATION_ROW = rowForRoute("/design-system")!;

// ---------------------------------------------------------------------------
// F4 — the shared harness, proven against the foundation surface.
//
// The manifest's foundation descriptors are used by three other suites that
// cannot see this page's markup. These tests are what keep the two honest: if
// the marker moves, or the reset stops resetting, or screenshot mode stops
// suppressing motion, it fails HERE rather than as a puzzling flake in a
// route ticket's baseline six weeks from now.
// ---------------------------------------------------------------------------
test.describe("F4 shared harness", () => {
  test("the manifest's foundation descriptor matches this page", async ({ page }) => {
    expect(FOUNDATION_ROW.readiness.strategy).toBe("bare");
    expect(FOUNDATION_ROW.readiness.mode).toBeNull();

    await prepareRow(page, FOUNDATION_ROW);
    await page.goto(FOUNDATION_ROW.route);
    await awaitRowReady(page, FOUNDATION_ROW);

    // The marker the manifest names is a real element on this page — not a
    // selector that happens to resolve to nothing and settle instantly.
    await expect(page.locator(FOUNDATION_ROW.readiness.marker)).toHaveCount(1);

    // This route renders outside the (app) group, so it has no shell, no
    // hydration gate and no store seam. `storeSeam: false` in the manifest is
    // that fact, and this is the assertion that it stays true.
    expect(FOUNDATION_ROW.readiness.storeSeam).toBe(false);
    expect(await page.evaluate(() => "__nsStore" in window)).toBe(false);
  });

  test("every semantic check in the frozen row resolves on this page", async ({ page }) => {
    // The runner reports a check that matched nothing as a failure, but only
    // when it runs. This proves each selector is live before nine tickets start
    // trusting the same shape of declaration for their own rows.
    await page.goto("/design-system");
    await awaitRowReady(page, FOUNDATION_ROW);

    const missing: string[] = [];
    for (const check of FOUNDATION_ROW.semanticChecks) {
      const count = await page.locator(check.selector).count();
      const required = check.minCount ?? 1;
      if (count < required)
        missing.push(`${check.label} (${check.selector}): ${count}/${required}`);
    }
    expect(missing, `unresolved semantic checks:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  test("screenshot mode marks the root and stops the running animations", async ({ page }) => {
    await page.goto("/design-system");
    await awaitRowReady(page, FOUNDATION_ROW);

    // The skeleton shimmer runs forever by design, which is exactly why the
    // readiness contract cannot wait it out and why screenshot mode has to
    // remove it instead.
    const before = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === "running").length,
    );
    expect(
      before,
      "the reference page should have a live infinite animation to suppress",
    ).toBeGreaterThan(0);

    await enterScreenshotMode(page);

    expect(await page.locator("html").getAttribute(SCREENSHOT_ATTRIBUTE)).toBe("");
    const after = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === "running").length,
    );
    expect(after, "screenshot mode must leave no animation running").toBe(0);
  });
});

test.describe("design system — style reference", () => {
  test("all sections + controls render", async ({ page }) => {
    await page.goto("/design-system");
    // The shared readiness contract, exercised on the surface it was written
    // for: hydration is not applicable here (this route renders outside the
    // (app) group), but the marker, fonts, portals and stable-frame conditions
    // all are. F1's theme/accent lifecycle rows below are NOT re-run through it
    // — they own that coverage and several of them deliberately break storage.
    await awaitRowReady(page, FOUNDATION_ROW);
    for (const id of [
      "palette",
      "accent",
      "typography",
      "spacing",
      "surfaces",
      "radius",
      "shadows",
      "motion",
      "breakpoints",
      "components",
      "targets",
      "skeletons",
      "conventions",
      "controls",
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(page.getByRole("group", { name: "Accent" })).toBeVisible();
    // react-icons render as inline SVGs (no Lucide).
    await expect(page.getByRole("main").locator("svg").first()).toBeVisible();
  });

  test("theme toggle flips light ↔ dark and tokens resolve in both", async ({ page }) => {
    await page.goto("/design-system");
    const html = page.locator("html");
    await expect(html).not.toHaveClass(/dark/);

    const surfaceLight = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
    );
    expect(surfaceLight).toBe("#fcfefd");

    const tintLight = await swatchColor(page, "brandtint");

    await page.getByRole("button", { name: /switch to dark theme/i }).click();
    await expect(html).toHaveClass(/dark/);

    const surfaceDark = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
    );
    expect(surfaceDark).toBe("#1a2220");

    // brandtint is color-mix-derived and must differ between light and dark.
    const tintDark = await swatchColor(page, "brandtint");
    expect(tintDark).not.toBe(tintLight);
    expect(tintDark).not.toBe("rgba(0, 0, 0, 0)");

    // No hard-coded color leak: every rendered swatch resolves to a real color.
    const emptyBgs = await page
      .getByTestId("palette")
      .locator("[data-testid^='swatch-'] > div")
      .evaluateAll(
        (els) =>
          els.filter((el) => {
            const bg = getComputedStyle(el).backgroundColor;
            return !bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent";
          }).length,
      );
    expect(emptyBgs).toBe(0);
  });

  test("accent axis re-resolves --brand from data-accent alone", async ({ page }) => {
    await page.goto("/design-system");
    // Teal is the default a first-time visitor lands on.
    await expectPlainSwatch(page, "brand", ACCENT_MATRIX.teal.light.brand);

    for (const accent of ACCENTS) {
      await page.getByRole("button", { name: `${accent} accent` }).click();
      await expect(page.locator("html")).toHaveAttribute("data-accent", accent);
      await expectPlainSwatch(page, "brand", ACCENT_MATRIX[accent].light.brand);
    }

    // data-accent carries the CHOICE; nothing writes an inline colour.
    expect(await page.locator("html").getAttribute("style")).toBeNull();
  });

  // The supported branch of the @supports guard. The source tests pin the static
  // fallback pairs; only a real engine can prove the color-mix() formulas land on
  // the same values, in every accent and both themes.
  for (const accent of ACCENTS) {
    for (const theme of ["light", "dark"] as const) {
      test(`computed ${theme} ${accent} pair matches the color-mix contract`, async ({ page }) => {
        await page.addInitScript(
          ([t, a]) => {
            localStorage.setItem("ns-theme", t);
            localStorage.setItem("ns-accent", a);
          },
          [theme, accent] as const,
        );
        await page.goto("/design-system");

        const html = page.locator("html");
        await expect(html).toHaveAttribute("data-accent", accent);
        if (theme === "dark") await expect(html).toHaveClass(/dark/);
        else await expect(html).not.toHaveClass(/dark/);

        const expected = ACCENT_MATRIX[accent][theme];
        await expectPlainSwatch(page, "brand", expected.brand);

        // The derived pair, checked against the formulas rather than restated
        // literals — this is the supported color-mix() branch of the @supports
        // guard, which the source tests cannot reach.
        const [inkPct, inkEnd] = MIX[theme].ink;
        const [tintPct, tintEnd] = MIX[theme].tint;
        await expectMixedSwatch(
          page,
          "brandink",
          mixChannels(expected.brand, inkPct, inkEnd),
          `--brandink ${theme} ${accent}`,
        );
        await expectMixedSwatch(
          page,
          "brandtint",
          mixChannels(expected.brand, tintPct, tintEnd),
          `--brandtint ${theme} ${accent}`,
        );

        // --onbrand is theme-paired, and --chrome aliases the live accent.
        await expectPlainSwatch(page, "onbrand", ONBRAND[theme]);
        await expectPlainSwatch(page, "chrome", expected.brand);
      });
    }
  }

  // The guard on the guard. The published static fallbacks are BY CONSTRUCTION
  // the nearest-8-bit rendering of the formulas they stand in for, so a derived
  // row that accepts an 8-bit `rgb(...)` proves nothing: a later cascade rule
  // could reset the token to its fallback and every assertion would still pass.
  // This exercises the pure predicate directly — no catching of a Playwright
  // failure — against a real overridden paint taken from the live page.
  test("a later static-fallback override does not satisfy the supported-mix check", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("ns-accent", "rose"));
    await page.goto("/design-system");

    const [pct, endpoint] = MIX.light.ink;
    const expected = mixChannels(ACCENT_MATRIX.rose.light.brand, pct, endpoint);

    // Production cascade: the @supports branch is live, so the predicate accepts.
    // Asserted positively first, so a predicate that rejected everything could
    // not pass this test vacuously.
    const guarded = await swatchColor(page, "brandink");
    expect(parseSupportedMix(guarded), `expected color(srgb …), got ${guarded}`).not.toBeNull();
    expect(matchesSupportedMix(guarded, expected)).toBe(true);

    // Now inject the drift this exists to catch: a later rule of equal
    // specificity resetting --brandink to its own published static fallback.
    await page.addStyleTag({ content: 'html[data-accent="rose"] { --brandink: #904f4a; }' });

    // The paint is now an 8-bit rgb() indistinguishable from the fallback — and
    // equal to what the formula rounds to, which is exactly why the old shared
    // comparator accepted it.
    const overridden = await swatchColor(page, "brandink");
    expect(overridden).toBe("rgb(144, 79, 74)");
    expect(overridden.startsWith("rgb(")).toBe(true);
    expect(expected.map((c) => Math.round(c * 255))).toEqual([144, 79, 74]);

    // The predicate must reject it on serialization alone, before any numeric
    // comparison can be fooled by that equality.
    expect(parseSupportedMix(overridden)).toBeNull();
    expect(matchesSupportedMix(overridden, expected)).toBe(false);
  });

  // Direct regressions on the oracle itself. The tests above prove the predicate
  // behaves correctly on the two paints the live page actually produces; these
  // pin its BOUNDARY, so it cannot be widened later into accepting a
  // serialization that was never observed from the pinned Chromium project.
  test.describe("supported-mix oracle fails closed", () => {
    // The exact live light-rose --brandink paint, as emitted by pinned Chromium
    // and independently reproduced in review. This is the one form that counts
    // as evidence the guarded branch ran.
    const OBSERVED = "color(srgb 0.562745 0.308706 0.289412)";

    test("accepts the observed pinned-Chromium no-alpha serialization", () => {
      expect(parseSupportedMix(OBSERVED)).toEqual([0.562745, 0.308706, 0.289412]);

      const [pct, endpoint] = MIX.light.ink;
      const expected = mixChannels(ACCENT_MATRIX.rose.light.brand, pct, endpoint);
      expect(matchesSupportedMix(OBSERVED, expected)).toBe(true);
    });

    // Every rejected case below parses (or would parse) to 0.1/0.2/0.3, which is
    // exactly the `expected` passed to the predicate. So if the parser ever
    // regressed into accepting one of these, the numeric comparison would
    // succeed and matchesSupportedMix() would wrongly return true — these
    // assertions are about the serialization gate, not about the arithmetic.
    const REJECTED: readonly (readonly [string, string])[] = [
      ["explicit opaque alpha", "color(srgb 0.1 0.2 0.3 / 1)"],
      ["explicit alpha as percentage", "color(srgb 0.1 0.2 0.3 / 100%)"],
      ["fractional alpha", "color(srgb 0.1 0.2 0.3 / 0.999)"],
      ["zero alpha", "color(srgb 0.1 0.2 0.3 / 0)"],
      ["bare alpha separator", "color(srgb 0.1 0.2 0.3 /)"],
      ["legacy rgb", "rgb(0.1, 0.2, 0.3)"],
      ["legacy rgba", "rgba(26, 51, 77, 1)"],
      ["fully transparent", "rgba(0, 0, 0, 0)"],
      ["another colour space — display-p3", "color(display-p3 0.1 0.2 0.3)"],
      ["another colour space — srgb-linear", "color(srgb-linear 0.1 0.2 0.3)"],
      ["another colour space — oklch", "oklch(0.5 0.1 20)"],
      ["missing colour space", "color(0.1 0.2 0.3)"],
      ["too few channels", "color(srgb 0.1 0.2)"],
      ["too many channels", "color(srgb 0.1 0.2 0.3 0.4)"],
      ["trailing token", "color(srgb 0.1 0.2 0.3) extra"],
      ["leading token", "paint color(srgb 0.1 0.2 0.3)"],
      ["unclosed function", "color(srgb 0.1 0.2 0.3"],
      ["comma-separated channels", "color(srgb 0.1, 0.2, 0.3)"],
      ["uppercase serialization", "COLOR(SRGB 0.1 0.2 0.3)"],
      ["non-finite channel", "color(srgb 0.1 0.2 1e999)"],
      ["malformed channel", "color(srgb 0.1 0.2 .)"],
      ["css-wide keyword", "none"],
      ["empty string", ""],
    ];

    for (const [label, value] of REJECTED) {
      test(`rejects ${label}`, () => {
        expect(parseSupportedMix(value), `parsed ${JSON.stringify(value)}`).toBeNull();
        expect(matchesSupportedMix(value, [0.1, 0.2, 0.3])).toBe(false);
      });
    }

    // The case that actually matters in production: the static fallback paint is
    // numerically the formula's nearest-8-bit rendering, so it must be rejected
    // on serialization, never waved through on equality.
    test("rejects the static-fallback rgb() paint against its own formula", () => {
      const [pct, endpoint] = MIX.light.ink;
      const expected = mixChannels(ACCENT_MATRIX.rose.light.brand, pct, endpoint);
      expect(expected.map((c) => Math.round(c * 255))).toEqual([144, 79, 74]);
      expect(parseSupportedMix("rgb(144, 79, 74)")).toBeNull();
      expect(matchesSupportedMix("rgb(144, 79, 74)", expected)).toBe(false);
    });

    // The tolerance is unchanged and still discriminates: one 8-bit step is
    // ~392x its width, so a real one-step drift in a correctly serialized mix
    // fails on the numbers rather than the grammar.
    test("still rejects a correctly serialized mix that drifts by one 8-bit step", () => {
      const [pct, endpoint] = MIX.light.ink;
      const expected = mixChannels(ACCENT_MATRIX.rose.light.brand, pct, endpoint);
      const drifted = `color(srgb ${expected[0] + 1 / 255} ${expected[1]} ${expected[2]})`;
      expect(parseSupportedMix(drifted)).not.toBeNull();
      expect(matchesSupportedMix(drifted, expected)).toBe(false);
    });
  });

  test("the accent choice survives a theme change and re-resolves per theme", async ({ page }) => {
    await page.goto("/design-system");
    await page.getByRole("button", { name: "plum accent" }).click();
    await expectPlainSwatch(page, "brand", ACCENT_MATRIX.plum.light.brand);

    await page.getByRole("button", { name: /switch to dark theme/i }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    // Same choice, different resolved value — with no JavaScript write of a hex.
    await expect(page.locator("html")).toHaveAttribute("data-accent", "plum");
    await expectPlainSwatch(page, "brand", ACCENT_MATRIX.plum.dark.brand);
    const [pct, endpoint] = MIX.dark.ink;
    await expectMixedSwatch(
      page,
      "brandink",
      mixChannels(ACCENT_MATRIX.plum.dark.brand, pct, endpoint),
      "--brandink dark plum",
    );
    expect(await page.evaluate(() => localStorage.getItem("ns-accent"))).toBe("plum");
  });

  test("toggling the theme does not pin the accent", async ({ page }) => {
    await page.goto("/design-system");
    await page.getByRole("button", { name: /switch to dark theme/i }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    // The touched axis persists; the untouched one must stay unwritten. When
    // these were coupled, a single dark-mode toggle froze the accent, so a later
    // change to the default accent never reached anyone who had used the toggle.
    const stored = await page.evaluate(() => ({
      theme: localStorage.getItem("ns-theme"),
      accent: localStorage.getItem("ns-accent"),
    }));
    expect(stored).toEqual({ theme: "dark", accent: null });
  });

  // A stored value outside the allowlist is ignored, NOT rewritten: there is no
  // mapping for the retired v1 hues, no version key, and no one-time reset
  // (adoption record D4b). Leaving storage alone is the point — a rewrite would
  // destroy evidence of what the browser actually held.
  for (const stored of ["blue", "magenta", "slate", "", "TEAL", "not-an-accent"]) {
    test(`an unsupported stored accent ${JSON.stringify(stored)} renders teal untouched`, async ({
      page,
    }) => {
      await page.addInitScript((value) => {
        localStorage.setItem("ns-accent", value);
      }, stored);
      await page.goto("/design-system");

      await expect(page.locator("html")).toHaveAttribute("data-accent", "teal");
      await expectPlainSwatch(page, "brand", ACCENT_MATRIX.teal.light.brand);
      expect(await page.evaluate(() => localStorage.getItem("ns-accent"))).toBe(stored);
    });
  }

  test("an absent stored accent renders teal and writes nothing", async ({ page }) => {
    await page.goto("/design-system");
    await expect(page.locator("html")).toHaveAttribute("data-accent", "teal");
    expect(await page.evaluate(() => localStorage.getItem("ns-accent"))).toBeNull();
  });

  test("a genuine accent pick survives a reload", async ({ page }) => {
    await page.goto("/design-system");
    await page.getByRole("button", { name: "rose accent" }).click();
    await page.reload();

    await expect(page.locator("html")).toHaveAttribute("data-accent", "rose");
    await expectPlainSwatch(page, "brand", ACCENT_MATRIX.rose.light.brand);
    expect(await page.evaluate(() => localStorage.getItem("ns-accent"))).toBe("rose");
  });

  test("an unset theme follows the system preference before paint", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/design-system");
    await expect(page.locator("html")).toHaveClass(/dark/);
    // The system preference is not a user pick, so it is not persisted.
    expect(await page.evaluate(() => localStorage.getItem("ns-theme"))).toBeNull();

    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/design-system");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });

  test("a stored theme beats the system preference", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => localStorage.setItem("ns-theme", "light"));
    await page.goto("/design-system");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });

  // The two axes are read in independently guarded operations, so a denied
  // storage still paints system theme plus teal instead of aborting both.
  for (const mode of ["read-throws", "property-throws"] as const) {
    test(`a denied localStorage (${mode}) still paints system theme plus teal`, async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));

      await page.emulateMedia({ colorScheme: "dark" });
      await page.addInitScript(denyStorage(mode));
      await page.goto("/design-system");

      const html = page.locator("html");
      await expect(html).toHaveClass(/dark/);
      await expect(html).toHaveAttribute("data-accent", "teal");
      await expectPlainSwatch(page, "brand", ACCENT_MATRIX.teal.dark.brand);
      expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
    });
  }

  // v2 rounds by semantic ROLE, so the old blanket "everything is 0px" assertion is
  // gone. What replaces it is stricter, not looser: each role must compute ITS OWN
  // value, and every data surface must still compute an explicit 0px.
  test("the accent control is four real ToggleGroup items previewing their own accent", async ({
    page,
  }) => {
    await page.goto("/design-system");
    const group = page.getByRole("group", { name: "Accent" });
    const items = group.locator("[data-slot='toggle-group-item']");
    await expect(items).toHaveCount(ACCENTS.length);

    // No raw swatch survives the migration: every pressable element in the group
    // is a Base UI toggle item, so the touch measurement below cannot miss one.
    expect(await group.locator("button:not([data-slot='toggle-group-item'])").count()).toBe(0);

    for (const accent of ACCENTS) {
      const swatch = group.locator(`[data-accent-swatch="${accent}"]`);
      await expect(swatch).toHaveCount(1);
      const paint = await swatch.evaluate((el) => ({
        bg: getComputedStyle(el).backgroundColor,
        inline: el.getAttribute("style"),
      }));
      // Painted by the single CSS authority, and equal to that accent's own light
      // --brand. An inline style here would be a second source of truth.
      expect(paint.bg, accent).toBe(toRgb(ACCENT_MATRIX[accent].light.brand));
      expect(paint.inline, accent).toBeNull();
    }

    // Selection is Base UI's own state, and exactly one item holds it.
    await group.getByRole("button", { name: "plum accent" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-accent", "plum");
    await expect(items.locator("[data-pressed]")).toHaveCount(0);
    expect(await group.locator("[data-slot='toggle-group-item'][data-pressed]").count()).toBe(1);
  });

  test("secondary and ghost both resolve to a real L1 control", async ({ page }) => {
    await page.goto("/design-system");
    const components = page.getByTestId("components");
    const surface = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--surface)";
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    });

    for (const name of ["Secondary", "Ghost"]) {
      const style = await components
        .locator("button", { hasText: name })
        .first()
        .evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, border: s.borderTopWidth, shadow: s.boxShadow };
        });
      // DESIGN.md names secondary AND ghost as L1: a real fill, a hairline and
      // resting elevation. A chromeless ghost fails all three.
      expect(style.bg, name).toBe(surface);
      expect(parseFloat(style.border), name).toBeGreaterThan(0);
      expect(style.shadow, name).not.toBe("none");
    }
  });

  test("radius follows the semantic role, and every data surface stays square", async ({
    page,
  }) => {
    await page.goto("/design-system");
    const main = page.getByRole("main");
    const radiusOf = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).borderRadius);

    // The role specimens are the declared contract, one box per token.
    for (const [utility, px] of [
      ["rounded-card", "16px"],
      ["rounded-control", "12px"],
      ["rounded-chip", "9px"],
      ["rounded-pill", "999px"],
      ["rounded-none", "0px"],
    ] as const) {
      expect(await radiusOf(page.getByTestId(`radius-${utility}`)), utility).toBe(px);
    }

    // And the primitives resolve to the role their owner chose.
    for (const [label, locator, px] of [
      ["card", main.locator("[data-slot='card']").first(), "16px"],
      ["button", main.locator("[data-slot='button']").first(), "999px"],
      ["input", main.locator("[data-slot='input']").first(), "12px"],
      ["select", main.locator("select").first(), "12px"],
      ["badge", main.locator("[data-slot='badge']").first(), "9px"],
      ["switch track", main.locator("[data-slot='switch-track']").first(), "999px"],
    ] as const) {
      expect(await radiusOf(locator), label).toBe(px);
    }

    // Legend swatches and hairlines stay square — DESIGN.md §5 keeps every data
    // surface and every full-bleed edge unrounded.
    const swatchRadii = await page
      .getByTestId("palette")
      .locator("[data-testid^='swatch-'] > div")
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderRadius));
    expect(swatchRadii.length).toBeGreaterThan(20);
    for (const r of swatchRadii) expect(r).toBe("0px");

    const separatorRadii = await main
      .locator("[data-slot='separator']")
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderRadius));
    expect(separatorRadii.length).toBeGreaterThan(0);
    for (const r of separatorRadii) expect(r).toBe("0px");

    // The generic shadcn scale remains the square compatibility fallback, so an
    // unmigrated component fails square rather than inventing a radius.
    const generic = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--radius-lg").trim(),
    );
    expect(generic).toBe("0px");
  });

  test("the raised overlay shells resolve the L2 role behind the semantic scrim", async ({
    page,
  }) => {
    await page.goto("/design-system");
    await page.getByTestId("open-dialog").click();

    const popup = page.locator("[data-slot='dialog-content']");
    await expect(popup).toBeVisible();

    // The token's own paint is resolved through a probe element rather than parsed
    // out of its declaration text: the production CSS minifier is free to rewrite
    // `#ffffff` as `#fff` or an `rgb(… / …)` as a hex-with-alpha, so comparing
    // against the raw custom-property STRING would be comparing serialisations.
    // Both sides of this comparison are computed values.
    const resolveToken = (token: string, property: "color" | "backgroundColor") =>
      page.evaluate(
        ([name, prop]) => {
          const probe = document.createElement("div");
          probe.style.setProperty(prop === "color" ? "color" : "background-color", `var(${name})`);
          document.body.appendChild(probe);
          const value = getComputedStyle(probe)[prop as "color" | "backgroundColor"];
          probe.remove();
          return value;
        },
        [token, property] as const,
      );

    const paint = await popup.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, radius: s.borderRadius, shadow: s.boxShadow };
    });
    expect(paint.bg).toBe(await resolveToken("--surface2", "backgroundColor"));
    expect(paint.radius).toBe("16px");
    expect(paint.shadow).not.toBe("none");

    // The backdrop is the theme scrim token, never a raw translucent black.
    const backdrop = await page
      .locator("[data-slot='dialog-overlay']")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(backdrop).toBe(await resolveToken("--scrim", "backgroundColor"));

    // Base UI behaviour survives the re-skin.
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
  });

  // T8: the coarse-pointer minimum is on the REAL control, so it has to be measured
  // in a context where `(pointer: coarse)` actually matches. This test builds that
  // context itself — it does not depend on F4's later `v2-touch` Playwright project
  // — and asserts the media state BEFORE measuring, because a context that silently
  // stayed fine-pointer would measure the 32/36px sizes and "pass" for the wrong
  // reason.
  test("real controls reach 44x44 under (pointer: coarse)", async ({ browser }) => {
    // `hasTouch` alone is what flips the pointer media: measured in the pinned
    // Chromium, this context reports maxTouchPoints 1 with (pointer: coarse) true
    // and (pointer: fine) false, while the same viewport WITHOUT `hasTouch`
    // reports the opposite. `isMobile` is deliberately not set — it would add
    // device-metrics emulation this measurement does not need.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await page.goto("/design-system");

      const media = await page.evaluate(() => ({
        coarse: matchMedia("(pointer: coarse)").matches,
        fine: matchMedia("(pointer: fine)").matches,
      }));
      expect(
        media.coarse,
        "the context must report (pointer: coarse) or the 44px assertions below prove nothing",
      ).toBe(true);
      expect(media.fine).toBe(false);

      const main = page.getByRole("main");
      const undersized = await main
        .locator(
          "[data-slot='button'], [data-slot='input'], select, [data-slot='switch'], [data-slot='toggle-group-item']",
        )
        .evaluateAll((els) =>
          els
            .map((el) => {
              const rect = el.getBoundingClientRect();
              return {
                tag: el.tagName.toLowerCase(),
                slot: el.getAttribute("data-slot") ?? "",
                text: (el.textContent ?? "").trim().slice(0, 24),
                w: Math.round(rect.width * 100) / 100,
                h: Math.round(rect.height * 100) / 100,
              };
            })
            // A field stretches to its row, so only HEIGHT is a target claim for it;
            // buttons and icon controls own both axes.
            .filter((m) =>
              m.slot === "input" || m.tag === "select" ? m.h < 44 : m.h < 44 || m.w < 44,
            ),
        );
      expect(
        undersized,
        `controls under the 44px coarse minimum: ${JSON.stringify(undersized)}`,
      ).toEqual([]);

      // The count matters: an empty selector would also produce an empty offender
      // list, which is the shape a silently-passing test takes.
      const measured = await main
        .locator(
          "[data-slot='button'], [data-slot='input'], select, [data-slot='switch'], [data-slot='toggle-group-item']",
        )
        .count();
      expect(measured).toBeGreaterThan(15);

      // The accent items are measured by name, not just swept up by the selector
      // above: the previous raw swatches carried no data-slot at all, so the
      // sweep silently skipped them while they sat at 24px.
      const accentItems = page
        .getByRole("group", { name: "Accent" })
        .locator("[data-slot='toggle-group-item']");
      expect(
        await accentItems.count(),
        "the accent control must expose four measurable items",
      ).toBe(4);
      const accentBoxes = await accentItems.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
        }),
      );
      expect(accentBoxes).toHaveLength(4);
      for (const box of accentBoxes) {
        expect(box.w, `accent item width ${JSON.stringify(box)}`).toBeGreaterThanOrEqual(44);
        expect(box.h, `accent item height ${JSON.stringify(box)}`).toBeGreaterThanOrEqual(44);
      }

      // No pseudo-element hitbox: the target must be the element that paints, so
      // its own box — not an overlay — has to carry the size.
      const switchBox = await main.locator("[data-slot='switch']").first().boundingBox();
      expect(switchBox?.width).toBeGreaterThanOrEqual(44);
      expect(switchBox?.height).toBeGreaterThanOrEqual(44);

      // No horizontal page overflow at the narrow width.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  test("functional text meets WCAG AA (4.5:1) in light and dark", async ({ page }) => {
    await page.goto("/design-system");
    const components = page.getByTestId("components");
    const targets = [
      { name: "destructive button", loc: components.locator("button", { hasText: "Delete" }) },
      {
        name: "success badge",
        loc: components.locator("[data-slot='badge']", { hasText: "Saved" }),
      },
      {
        name: "warn badge",
        loc: components.locator("[data-slot='badge']", { hasText: "Caution" }),
      },
      {
        name: "error badge",
        loc: components.locator("[data-slot='badge']", { hasText: "Infeasible" }),
      },
    ];

    // Both the fill and its paired foreground are theme tokens now, so a theme
    // flip animates BOTH through `transition-colors duration-fast`. Wait for the
    // pair to stop changing, then assert the RESTING colours — the threshold and
    // diagnostic below are unchanged; only the mid-transition sample is gone.
    const readPair = (loc: Locator) =>
      loc.evaluate((el) => {
        const s = getComputedStyle(el);
        return { fg: s.color, bg: s.backgroundColor };
      });

    const assertAA = async (theme: string) => {
      for (const { name, loc } of targets) {
        let previous = "";
        await expect
          .poll(
            async () => {
              const { fg, bg } = await readPair(loc);
              const key = `${fg}|${bg}`;
              const settled = key === previous;
              previous = key;
              return settled;
            },
            { message: `${theme} ${name}: colours never settled` },
          )
          .toBe(true);

        const { fg, bg } = await readPair(loc);
        const ratio = contrastRatio(fg, bg);
        expect(
          ratio,
          `${theme} ${name}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    };

    await assertAA("light");
    await page.getByRole("button", { name: /switch to dark theme/i }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await assertAA("dark");
  });

  test("prefers-reduced-motion suppresses motion tokens", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/design-system");
    const duration = await page
      .getByTestId("skeletons")
      .locator("[data-slot='skeleton']")
      .first()
      .evaluate((el) => getComputedStyle(el).animationDuration);
    expect(parseFloat(duration)).toBeLessThan(0.05);
  });

  test("fluid type scale steps up across the exact breakpoint ladder", async ({ page }) => {
    await page.goto("/design-system");
    const display = page.getByRole("heading", { name: "Design system", level: 1 });
    const ladder = [480, 768, 1024, 1280, 1440, 1920];
    let previous = 0;
    for (const width of ladder) {
      await page.setViewportSize({ width, height: 1000 });
      const size = await display.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(size, `font-size must increase at ${width}px (was ${previous})`).toBeGreaterThan(
        previous,
      );
      previous = size;
    }
  });

  test("skeleton mirrors the structure of the box it stands in for", async ({ page }) => {
    await page.goto("/design-system");
    const skeletons = page.getByTestId("skeletons");
    const skeletonCard = skeletons.locator("[data-slot='skeleton-card']");

    // Structure oracle: the skeleton card is built from multiple shape blocks.
    const partCount = await skeletonCard.locator("[data-slot='skeleton']").count();
    expect(partCount).toBeGreaterThanOrEqual(5);

    const skeletonBox = await skeletonCard.boundingBox();
    expect(skeletonBox?.width).toBeGreaterThan(0);
    expect(skeletonBox?.height).toBeGreaterThan(0);

    // Geometry oracle: swap to the resolved card in the same grid slot; the
    // skeleton must have reproduced its box in BOTH dimensions (width and
    // height), not just width — otherwise it isn't standing in for the structure.
    await skeletons.getByRole("button", { name: "Toggle loading" }).click();
    const card = skeletons.locator("[data-slot='card']");
    await expect(card).toBeVisible();
    const cardBox = await card.boundingBox();
    expect(Math.abs((cardBox?.width ?? 0) - (skeletonBox?.width ?? 0))).toBeLessThanOrEqual(2);
    expect(Math.abs((cardBox?.height ?? 0) - (skeletonBox?.height ?? 0))).toBeLessThanOrEqual(2);
  });

  test("persisted dark + non-default accent hydrate with no mismatch", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    await page.addInitScript(() => {
      localStorage.setItem("ns-theme", "dark");
      localStorage.setItem("ns-accent", "sage");
    });
    await page.goto("/design-system");

    const html = page.locator("html");
    await expect(html).toHaveClass(/dark/);
    await expect(html).toHaveAttribute("data-accent", "sage");

    // Controls must reconcile to the adopted state (finding #1): a persisted dark
    // page announces "switch to light", sage is selected. Sage is deliberately the
    // non-default accent here — the whole point is that adoption overrides the
    // server snapshot, which a persisted value equal to the default cannot prove.
    await expect(page.getByRole("button", { name: /switch to light theme/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "sage accent" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Any unexpected console error / pageerror fails the test. Do NOT pre-filter
    // to hydration-like substrings — that lets real errors through (a
    // `console.error("boom")` would be collected but filtered out before the
    // assertion). Only a narrow allowlist of known-benign lines is permitted.
    const ALLOWED: RegExp[] = [/Failed to load resource.*favicon/i];
    const unexpected = consoleErrors.filter((t) => !ALLOWED.some((re) => re.test(t)));
    expect(unexpected, `console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
  });
});
