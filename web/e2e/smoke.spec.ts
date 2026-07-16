import { expect, test } from "@playwright/test";

// E2E smoke: the app boots and renders the style-reference home page.
test("home page renders the style reference", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Design system", level: 1 })).toBeVisible();
});
