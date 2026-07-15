import { expect, test } from "@playwright/test";

// E2E smoke: the empty app boots and renders its shell heading.
test("home page renders the app shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Nurse Scheduler" })).toBeVisible();
});
