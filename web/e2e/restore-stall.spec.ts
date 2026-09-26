import { expect, test } from "@playwright/test";

// u2o: the first load after a deploy sat at RESTORING with no console error and the
// 10s stalled-restore Reload never appeared. The JS stall timer is armed by the
// hydration gate's mount effect, so a page whose client chunks never arrive can
// never arm it. The server markup must carry a Reload that time alone reveals.
// This drives the real production build with every client chunk held pending, which
// is the no-error hang the user saw.
test("a page whose client chunks never load still offers Reload after the stall deadline", async ({
  page,
}) => {
  await page.route("**/_next/static/chunks/**/*.js", () => {
    // Never fulfilled: the request stays pending, exactly like a hung chunk fetch.
    // Scripts only -- the stylesheet did arrive live (the RESTORING chip was painted).
  });
  await page.goto("/", { waitUntil: "commit" });

  await expect(page.getByTestId("persistence-status")).toHaveAttribute("data-status", "restoring");
  const slow = page.getByTestId("hydration-slow");
  await expect(slow).toBeAttached();
  await expect(slow).toBeHidden();

  await expect(slow).toBeVisible({ timeout: 15_000 });
  await expect(slow.getByRole("link", { name: "Reload" })).toBeVisible();
});
