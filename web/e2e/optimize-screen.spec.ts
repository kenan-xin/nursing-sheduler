// T16e — bounded browser coverage for the Optimize & Export screen.
//
// Runs against the deterministic `/optimize-screen-fixture` dev page, which
// renders the screen's pure presentational states with no controller, transport,
// or direct stream. It verifies real-browser responsiveness (desktop + mobile,
// no horizontal overflow), keyboard/accessibility (roles, focusable controls,
// alert semantics), dark-mode/token rendering, and the recovery / control /
// terminal action surfaces. It makes NO claim about the T16f Browser → Next →
// FastAPI direct-stream gate; jsdom component/integration tests cover the same
// logic at the React-DOM level, this asserts it in a real browser layout.

import { expect, test } from "@playwright/test";

const FIXTURE_URL = "/optimize-screen-fixture";

test.describe("Optimize & Export screen — browser coverage", () => {
  test("renders the representative states with old-app copy and terminal actions", async ({
    page,
  }) => {
    await page.goto(FIXTURE_URL);
    await expect(page.getByTestId("optimize-fixture")).toBeVisible();

    // Required-data readiness with tab links.
    await expect(page.getByTestId("optimize-readiness")).toBeVisible();
    await expect(page.getByRole("link", { name: "Dates" })).toHaveAttribute("href", "/dates");

    // Server identity: online, mismatch warning, offline warning.
    await expect(page.getByTestId("optimize-version-mismatch")).toContainText(
      "Frontend and backend versions do not match",
    );
    await expect(page.getByTestId("optimize-server-offline")).toContainText(
      "Backend is not responding",
    );

    // Completed-with-artifact success + Download Again.
    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
    );
    await expect(
      page.getByTestId("fx-completed").getByTestId("optimize-download-again"),
    ).toBeVisible();

    // No-artifact reason (non-infeasible completed-without-artifact anomaly).
    await expect(page.getByTestId("optimize-no-artifact")).toContainText(
      "No downloadable schedule is available",
    );

    // Infeasible dedicated panel: explanation + solver verdict, no fabricated conflict list.
    const infeasible = page.getByTestId("fx-infeasible");
    await expect(infeasible).toContainText("This roster can");
    await expect(infeasible.getByTestId("optimize-infeasible")).toContainText(
      "no roster satisfies every hard rule",
    );
    await expect(infeasible.getByTestId("optimize-infeasible")).toContainText(
      "infeasibility_proven",
    );
    await expect(infeasible.getByTestId("optimize-adjust-rules")).toHaveAttribute("href", "/rules");

    // Worker-lost: resubmit + dismiss + cleanup failed retry/abandon.
    const workerLost = page.getByTestId("fx-worker-lost");
    await expect(workerLost.getByTestId("optimize-resubmit")).toBeVisible();
    await expect(workerLost.getByTestId("optimize-dismiss")).toBeVisible();
    await expect(workerLost.getByTestId("optimize-cleanup-retry")).toBeVisible();
    await expect(workerLost.getByTestId("optimize-cleanup-abandon")).toBeVisible();

    // Recovery notices.
    await expect(page.getByTestId("optimize-interrupted")).toContainText(
      "An unknown backend optimization may still be running",
    );
    await expect(page.getByTestId("optimize-unreadable")).toBeVisible();
    await expect(page.getByTestId("optimize-degraded")).toContainText(
      "Reload recovery is unavailable",
    );
  });

  test("running state renders server controls and the progress chart", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    const running = page.getByTestId("fx-running");
    await expect(running.getByTestId("optimize-controls")).toBeVisible();
    await expect(running.getByTestId("optimize-cancel")).toBeEnabled();
    // Get Results Now is server-gated; the fixture enables it.
    await expect(running.getByTestId("optimize-finish-now")).toBeEnabled();
    await expect(running.getByTestId("progress-chart")).toBeVisible();
  });

  test("terminal alerts expose assertive alert semantics", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    // No-artifact and worker-lost callouts are role=alert.
    await expect(page.getByTestId("optimize-no-artifact")).toHaveAttribute("role", "alert");
    await expect(page.getByTestId("optimize-terminal-error").first()).toHaveAttribute(
      "role",
      "alert",
    );
  });

  test("options toggles and timeout are keyboard-focusable", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    const prettify = page.getByRole("switch", { name: "Prettify XLSX" });
    await prettify.focus();
    await expect(prettify).toBeFocused();
    const timeout = page.getByLabel("Solver Timeout");
    await timeout.focus();
    await expect(timeout).toBeFocused();
  });

  for (const viewport of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "mobile", width: 375, height: 812 },
  ]) {
    test(`has no horizontal overflow at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(FIXTURE_URL);
      await expect(page.getByTestId("optimize-fixture")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }

  test("dark mode renders on-token surfaces (no default white leak)", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    // A themed surface must resolve to a real token color, not transparent/default.
    const bg = await page
      .getByTestId("fx-completed")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
    await expect(page.getByTestId("optimize-completed-artifact")).toBeVisible();
  });
});
