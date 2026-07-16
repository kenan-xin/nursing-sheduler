import { expect, test, type Page } from "@playwright/test";

// Render / viewport / density / accent / reduced-motion / hydration rows of the
// T03 acceptance matrix. Static rows (token snapshot, accent/shell derivation,
// radius decls, no-raw-color guard) live in app/design-system.test.ts.

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

function swatchColor(page: Page, token: string) {
  return page
    .getByTestId(`swatch-${token}`)
    .locator("div")
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
}

test.describe("design system — style reference", () => {
  test("all sections + controls render", async ({ page }) => {
    await page.goto("/");
    for (const id of ["palette", "typography", "spacing", "components", "skeletons", "controls"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(page.getByRole("group", { name: "Accent" })).toBeVisible();
    // react-icons render as inline SVGs (no Lucide).
    await expect(page.getByRole("main").locator("svg").first()).toBeVisible();
  });

  test("theme toggle flips light ↔ dark and tokens resolve in both", async ({ page }) => {
    await page.goto("/");
    const html = page.locator("html");
    await expect(html).not.toHaveClass(/dark/);

    const surfaceLight = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
    );
    expect(["#fff", "#ffffff"]).toContain(surfaceLight);

    const tintLight = await swatchColor(page, "brandtint");

    await page.getByRole("button", { name: /switch to dark theme/i }).click();
    await expect(html).toHaveClass(/dark/);

    const surfaceDark = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
    );
    expect(surfaceDark).toBe("#181d25");

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

  test("accent axis re-derives brand via color-mix", async ({ page }) => {
    await page.goto("/");
    const brandDefault = await swatchColor(page, "brand");
    expect(brandDefault).toBe("rgb(35, 96, 196)"); // #2360c4

    await page.getByRole("button", { name: "teal accent" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-accent", "teal");
    expect(await swatchColor(page, "brand")).toBe("rgb(14, 116, 144)"); // #0e7490

    await page.getByRole("button", { name: "magenta accent" }).click();
    expect(await swatchColor(page, "brand")).toBe("rgb(176, 53, 122)"); // #b0357a
  });

  test("every component + nested part renders border-radius 0", async ({ page }) => {
    await page.goto("/");
    const radii = await page
      .getByRole("main")
      .locator(
        "button, input, [data-slot='badge'], [data-slot='card'], [data-slot='switch'], [data-slot='switch-thumb'], [data-slot='skeleton'], [data-slot='skeleton-card']",
      )
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderRadius));
    expect(radii.length).toBeGreaterThan(8);
    for (const r of radii) {
      expect(r).toBe("0px");
    }
  });

  test("functional text meets WCAG AA (4.5:1) in light and dark", async ({ page }) => {
    await page.goto("/");
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

    const assertAA = async (theme: string) => {
      for (const { name, loc } of targets) {
        const { fg, bg } = await loc.evaluate((el) => {
          const s = getComputedStyle(el);
          return { fg: s.color, bg: s.backgroundColor };
        });
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
    await page.goto("/");
    const duration = await page
      .getByTestId("skeletons")
      .locator("[data-slot='skeleton']")
      .first()
      .evaluate((el) => getComputedStyle(el).animationDuration);
    expect(parseFloat(duration)).toBeLessThan(0.05);
  });

  test("fluid type scale steps up across the exact breakpoint ladder", async ({ page }) => {
    await page.goto("/");
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

  test("density multiplier scales type and spacing", async ({ page }) => {
    await page.goto("/");
    await page.setViewportSize({ width: 1280, height: 1000 });
    const display = page.getByRole("heading", { name: "Design system", level: 1 });
    const spaceBox = page.getByTestId("space-4").locator("div");

    const measure = async (density: string) => {
      await page.evaluate((d) => document.documentElement.setAttribute("data-density", d), density);
      return {
        font: await display.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
        space: await spaceBox.evaluate((el) => parseFloat(getComputedStyle(el).width)),
      };
    };

    const compact = await measure("compact");
    const comfortable = await measure("comfortable");
    const spacious = await measure("spacious");

    expect(comfortable.font).toBeGreaterThan(compact.font);
    expect(spacious.font).toBeGreaterThan(comfortable.font);
    expect(comfortable.space).toBeGreaterThan(compact.space);
    expect(spacious.space).toBeGreaterThan(comfortable.space);
  });

  test("skeleton mirrors the structure of the box it stands in for", async ({ page }) => {
    await page.goto("/");
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

  test("persisted dark + non-default density/accent hydrate with no mismatch", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    await page.addInitScript(() => {
      localStorage.setItem("ns-theme", "dark");
      localStorage.setItem("ns-density", "spacious");
      localStorage.setItem("ns-accent", "teal");
    });
    await page.goto("/");

    const html = page.locator("html");
    await expect(html).toHaveClass(/dark/);
    await expect(html).toHaveAttribute("data-density", "spacious");
    await expect(html).toHaveAttribute("data-accent", "teal");

    // Controls must reconcile to the adopted state (finding #1): a persisted dark
    // page announces "switch to light", Spacious is pressed, teal is selected.
    await expect(page.getByRole("button", { name: /switch to light theme/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "spacious" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "teal accent" })).toHaveAttribute(
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
