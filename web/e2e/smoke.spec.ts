import { expect, test } from "@playwright/test";

// E2E smoke: the app boots and renders the style-reference page (relocated to
// /design-system in T08 so the shell owns Home at /).
test("design-system reference renders", async ({ page }) => {
  await page.goto("/design-system");
  await expect(page.getByRole("heading", { name: "Design system", level: 1 })).toBeVisible();
});
