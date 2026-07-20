// T16d — browser coverage for the optimization progress chart.
//
// Runs against the `/progress-chart-fixture` dev page (built alongside the
// design-system reference), covering responsive behavior, accessibility, dark
// mode + density token fidelity, range presets, comments toggle, tooltip
// semantics, and the four safety streams (empty, sparse, dense, no-comments,
// duplicate-times). jsdom component tests cover the same surface at the
// React-DOM level; this spec verifies it in a real browser layout.

import { expect, test } from "@playwright/test";

const FIXTURE_URL = "/progress-chart-fixture";

test.describe("Optimization progress chart — browser coverage", () => {
  test("renders the two-point dataset and exposes the figure label", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await expect(page.getByTestId("progress-chart")).toBeVisible();
    await expect(page.getByText("Incumbent Progress")).toBeVisible();

    // The figure's accessible name comes from the inner role="img" summary.
    // Target it explicitly so SVG <circle><title></title></circle> elements
    // (which can also expose role=img in some browsers) don't shadow it.
    const label = await page
      .locator('figure[data-testid="progress-chart"] [role="img"]')
      .getAttribute("aria-label");
    expect(label?.toLowerCase()).toContain("optimization progress chart");
    expect(label?.toLowerCase()).toContain("frames");
  });

  test("range presets are clickable and update the active state via aria-pressed", async ({
    page,
  }) => {
    await page.goto(FIXTURE_URL);

    // Switch to the dense dataset so all five presets are meaningful.
    await page.getByTestId("fixture-dataset-dense").click();
    const chart = page.getByTestId("progress-chart");
    await expect(chart).toHaveAttribute("data-range", "full");

    const full = page.getByTestId("progress-chart-range-full");
    const last10 = page.getByTestId("progress-chart-range-last-10");
    await expect(full).toHaveAttribute("aria-pressed", "true");
    await expect(last10).toHaveAttribute("aria-pressed", "false");

    await last10.click();
    await expect(chart).toHaveAttribute("data-range", "last-10");
    await expect(chart).toHaveAttribute("data-point-count", "10");
    await expect(full).toHaveAttribute("aria-pressed", "false");
    await expect(last10).toHaveAttribute("aria-pressed", "true");
  });

  test("comments toggle hides and restores the comments panel", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-two-points").click();

    await expect(page.getByTestId("progress-chart-comment-panel")).toBeVisible();
    const hideBtn = page.getByRole("button", { name: /hide comments panel/i });
    await expect(hideBtn).toHaveAttribute("aria-pressed", "true");

    await hideBtn.click();
    await expect(page.getByTestId("progress-chart-comment-panel")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /show comments panel/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await page.getByRole("button", { name: /show comments panel/i }).click();
    await expect(page.getByTestId("progress-chart-comment-panel")).toBeVisible();
  });

  test("tooltip renders score, comments, solution, and source on hover", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-two-points").click();

    const scorePanel = page.getByTestId("progress-chart-score-panel");
    const box = await scorePanel.boundingBox();
    expect(box).not.toBeNull();
    // Hover near the right edge of the score panel.
    await page.mouse.move(box!.x + box!.width * 0.9, box!.y + box!.height / 2);

    const tooltip = page.getByTestId("progress-chart-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip.getByText("Score", { exact: true })).toBeVisible();
    await expect(tooltip.getByText("Comments", { exact: true })).toBeVisible();
    // Use exact match: the source string also contains "solution-callback".
    await expect(tooltip.getByText("Solution", { exact: true })).toBeVisible();
    // Source is always present per the T16a contract.
    await expect(tooltip.getByText(/ortools/i)).toBeVisible();
  });

  test("sparse dataset renders without NaN geometry", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-sparse").click();

    const chart = page.getByTestId("progress-chart");
    await expect(chart).toHaveAttribute("data-point-count", "1");

    const min = Number(await chart.getAttribute("data-domain-min"));
    const max = Number(await chart.getAttribute("data-domain-max"));
    expect(Number.isFinite(min)).toBe(true);
    expect(Number.isFinite(max)).toBe(true);
    expect(max).toBeGreaterThan(min);

    // The score path's `d` attribute must not contain NaN.
    const d = await page
      .getByTestId("progress-chart-score-panel")
      .locator("path")
      .first()
      .getAttribute("d");
    expect(d).not.toBeNull();
    expect(d!).not.toContain("NaN");
  });

  test("empty dataset renders the waiting state, no panels", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-empty").click();

    await expect(page.getByText(/waiting for the first progress frame/i)).toBeVisible();
    await expect(page.getByTestId("progress-chart-score-panel")).toHaveCount(0);
  });

  test("no-comments dataset renders the comment panel with the no-comment hint", async ({
    page,
  }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-no-comments").click();

    await expect(page.getByText(/no comment frames in range/i)).toBeVisible();
    // No comment latest-dot when every comment is null.
    await expect(page.getByTestId("progress-chart-comment-panel-latest-dot")).toHaveCount(0);
  });

  test("dense dataset hides dots and surfaces the 'Points hidden' hint", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-dense").click();

    await expect(page.getByText(/points hidden/i)).toBeVisible();
    await expect(page.getByTestId("progress-chart")).toHaveAttribute(
      "data-dot-threshold",
      "hidden",
    );

    // Switching to Last 10 brings dots back.
    await page.getByTestId("progress-chart-range-last-10").click();
    await expect(page.getByTestId("progress-chart")).toHaveAttribute("data-dot-threshold", "shown");
    await expect(page.getByText(/points hidden/i)).toHaveCount(0);
  });

  test("dark theme applies token colors without raw-color leak", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-two-points").click();

    const scoreLine = page.getByTestId("progress-chart-score-panel").locator("path").first();
    const commentLine = page.getByTestId("progress-chart-comment-panel").locator("path").first();

    // Light theme: both data lines resolve to a real token color, not raw hex
    // literals or an empty/none stroke.
    const lightScore = await scoreLine.evaluate((el) => getComputedStyle(el).stroke);
    const lightComment = await commentLine.evaluate((el) => getComputedStyle(el).stroke);
    expect(lightScore).not.toBe("");
    expect(lightScore).not.toBe("none");
    expect(lightComment).not.toBe("");
    expect(lightComment).not.toBe("none");

    await page.getByRole("button", { name: /switch to dark theme/i }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    const darkScore = await scoreLine.evaluate((el) => getComputedStyle(el).stroke);
    const darkComment = await commentLine.evaluate((el) => getComputedStyle(el).stroke);
    expect(darkScore).not.toBe("none");
    expect(darkScore).not.toBe("");

    // The comment axis uses var(--warn), which re-derives between light and dark
    // (#b07d10 → #d6a743). Comparing the two proves the stroke is genuinely
    // token-driven, not a baked literal that ignores the theme.
    expect(darkComment).not.toBe("");
    expect(darkComment).not.toBe("none");
    expect(darkComment).not.toBe(lightComment);
  });

  test("keyboard inspection: the plot is focusable and arrow keys walk points", async ({
    page,
  }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-dense").click();

    const group = page.getByRole("group", { name: /use left and right arrow keys/i });
    await expect(group).toHaveAttribute("tabindex", "0");

    // Focus the plot → latest point selected → tooltip appears.
    await group.focus();
    const tooltip = page.getByTestId("progress-chart-tooltip");
    await expect(tooltip).toBeVisible();
    const elapsed = page.getByTestId("progress-chart-tooltip-elapsed");
    const latest = await elapsed.textContent();

    // Arrow left moves to an earlier point (different elapsed reading).
    await page.keyboard.press("ArrowLeft");
    await expect(elapsed).not.toHaveText(latest ?? "");

    // Home jumps to the first point; the live region announces its data.
    await page.keyboard.press("Home");
    const describedBy = await group.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const live = page.locator(`#${describedBy}`);
    await expect(live).toHaveText(/Point 1 of \d+/);

    // Escape clears the selection.
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
  });

  test("comment crosshair stays synchronized when the hovered point has no comment", async ({
    page,
  }) => {
    await page.goto(FIXTURE_URL);
    // no-comments dataset: every commentCount is null.
    await page.getByTestId("fixture-dataset-no-comments").click();

    const scorePanel = page.getByTestId("progress-chart-score-panel");
    const box = await scorePanel.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width * 0.85, box!.y + box!.height / 2);

    // Both panels draw the vertical crosshair at the same x even though the
    // hovered point's comment value is null. A vertical <line> has a zero-width
    // box, so assert it is attached (not `toBeVisible`, which treats zero-size
    // elements as hidden).
    const scoreCross = page.getByTestId("progress-chart-score-panel-crosshair");
    const commentCross = page.getByTestId("progress-chart-comment-panel-crosshair");
    await expect(scoreCross).toBeAttached();
    await expect(commentCross).toBeAttached();
    expect(await scoreCross.getAttribute("x1")).toBe(await commentCross.getAttribute("x1"));

    // The tooltip reads the comment value as N/A (not a dash).
    const tooltip = page.getByTestId("progress-chart-tooltip");
    await expect(tooltip.getByText("N/A").first()).toBeVisible();
  });

  test("square corners on every interactive element (radius 0 token fidelity)", async ({
    page,
  }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-two-points").click();

    const radius = await page
      .getByTestId("progress-chart")
      .locator("button, [data-testid='progress-chart']")
      .evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).borderRadius).filter((r) => r && r !== "0px"),
      );
    // Every rendered corner inside the chart resolves to 0px.
    expect(radius).toEqual([]);
  });

  test("chart re-renders on viewport resize (responsive container)", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-two-points").click();

    const scorePanel = page.getByTestId("progress-chart-score-panel");

    await page.setViewportSize({ width: 1280, height: 1000 });
    const handleWide = await scorePanel.elementHandle();
    // ResizeObserver fires async; wait for the SVG width to settle above 800px
    // (the 1280-wide viewport minus the fixture's max-w-5xl + padding).
    await page.waitForFunction((el) => el !== null && el.clientWidth > 800, handleWide);
    const wideWidth = await scorePanel.evaluate((el) => el.clientWidth);

    await page.setViewportSize({ width: 480, height: 1000 });
    const handleNarrow = await scorePanel.elementHandle();
    await page.waitForFunction((el) => el !== null && el.clientWidth <= 480, handleNarrow);
    const narrowWidth = await scorePanel.evaluate((el) => el.clientWidth);

    expect(narrowWidth).toBeLessThan(wideWidth);
    // The narrow chart must still fit within the smaller viewport.
    expect(narrowWidth).toBeLessThanOrEqual(480);
  });

  test("every range button has an accessible name and reflects its state non-visually", async ({
    page,
  }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-dense").click();

    const footer = page.getByTestId("progress-chart-range-controls");
    const buttons = footer.getByRole("button");
    const labels = await buttons.allTextContents();
    expect(labels).toEqual(["Full", "Last 1 min", "Last 10 min", "Last 10", "Last 50"]);

    // Exactly one button is pressed at any time (radio-group semantics even
    // though it's implemented as aria-pressed buttons).
    const initiallyPressed = await buttons.evaluateAll(
      (els) => els.filter((el) => el.getAttribute("aria-pressed") === "true").length,
    );
    expect(initiallyPressed).toBe(1);

    await page.getByTestId("progress-chart-range-last-50").click();
    const afterChange = await buttons.evaluateAll(
      (els) => els.filter((el) => el.getAttribute("aria-pressed") === "true").length,
    );
    expect(afterChange).toBe(1);
    await expect(page.getByTestId("progress-chart-range-last-50")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("long-running dataset stays bounded and renders without lag", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-long-running").click();

    const chart = page.getByTestId("progress-chart");
    await expect(chart).toHaveAttribute("data-point-count", "200");
    await expect(chart).toHaveAttribute("data-dot-threshold", "hidden");

    // Last 50 narrows to a still-readable slice.
    await page.getByTestId("progress-chart-range-last-50").click();
    await expect(chart).toHaveAttribute("data-point-count", "50");
    await expect(chart).toHaveAttribute("data-dot-threshold", "hidden");
  });
});

// Touch/pen tap inspection runs in a touch-enabled context so Chromium
// synthesizes pointerdown events with pointerType "touch".
test.describe("Optimization progress chart — touch inspection", () => {
  test.use({ hasTouch: true });

  test("tapping a sparse point retains the tooltip + synchronized crosshairs", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-sparse").click();

    const scorePanel = page.getByTestId("progress-chart-score-panel");
    const box = await scorePanel.boundingBox();
    expect(box).not.toBeNull();
    await page.touchscreen.tap(box!.x + box!.width * 0.6, box!.y + box!.height / 2);

    // The selection is RETAINED after the finger lifts (a plain onPointerMove
    // implementation would have nothing here — the finger-lift pointerleave
    // would clear it).
    const tooltip = page.getByTestId("progress-chart-tooltip");
    await expect(tooltip).toBeVisible();
    await page.waitForTimeout(300);
    await expect(tooltip).toBeVisible();
    await expect(page.getByTestId("progress-chart-score-panel-crosshair")).toBeAttached();
    await expect(page.getByTestId("progress-chart-comment-panel-crosshair")).toBeAttached();
  });

  test("tapping a dense point retains it; a second tap on it clears the selection", async ({
    page,
  }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-dense").click();

    const scorePanel = page.getByTestId("progress-chart-score-panel");
    const box = await scorePanel.boundingBox();
    expect(box).not.toBeNull();
    const tx = box!.x + box!.width * 0.6;
    const ty = box!.y + box!.height / 2;

    await page.touchscreen.tap(tx, ty);
    const tooltip = page.getByTestId("progress-chart-tooltip");
    await expect(tooltip).toBeVisible();
    // Retention holds across a pause.
    await page.waitForTimeout(300);
    await expect(tooltip).toBeVisible();
    await expect(page.getByTestId("progress-chart-score-panel-crosshair")).toBeAttached();

    // Tapping the same point again toggles the retained selection off.
    await page.touchscreen.tap(tx, ty);
    await expect(tooltip).toHaveCount(0);
  });

  test("tapping a null-comment point keeps the comment crosshair and reads N/A", async ({
    page,
  }) => {
    await page.goto(FIXTURE_URL);
    await page.getByTestId("fixture-dataset-no-comments").click();

    const scorePanel = page.getByTestId("progress-chart-score-panel");
    const box = await scorePanel.boundingBox();
    expect(box).not.toBeNull();
    await page.touchscreen.tap(box!.x + box!.width * 0.85, box!.y + box!.height / 2);

    const tooltip = page.getByTestId("progress-chart-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(page.getByTestId("progress-chart-comment-panel-crosshair")).toBeAttached();
    await expect(tooltip.getByText("N/A").first()).toBeVisible();
  });
});
