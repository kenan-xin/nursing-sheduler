import { expect, test, type Page } from "@playwright/test";

// plq5 P1 — Recent schedules: a schedule left by New stays in the list, and Open
// switches this tab between two schedules through the real repository switch.

type NsWindow = {
  __nsStore: {
    commands: { mutate(patch: Record<string, unknown>): Promise<{ ok: boolean }> };
    drain(): Promise<void>;
    scenario(): Record<string, unknown>;
  };
};

async function mutate(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (p) => {
    const store = (window as unknown as NsWindow).__nsStore;
    const outcome = await store.commands.mutate(p);
    if (!outcome.ok) throw new Error("seed mutate was refused");
    await store.drain();
  }, patch);
}

function rangeStart(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const store = (window as unknown as NsWindow).__nsStore;
    await store.drain();
    return store.scenario().rangeStart;
  });
}

function ward(description: string, month: "09" | "10") {
  const end = month === "09" ? "30" : "31";
  return {
    meta: { apiVersion: "alpha", description },
    rangeStart: `2025-${month}-01`,
    rangeEnd: `2025-${month}-${end}`,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
});

test("opens and switches between two schedules from Recent schedules", async ({ page }) => {
  await page.goto("/save-and-load");
  // The card renders behind the hydration gate, so the authority is up once it shows.
  await expect(page.getByTestId("start-over-card")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __nsStore?: unknown }).__nsStore),
  );
  await mutate(page, ward("Ward A", "09"));

  // New keeps Ward A: the Start over copy says so, and the list shows it.
  await expect(page.getByTestId("start-over-card")).toContainText(
    "Your current schedule stays in Recent schedules",
  );
  await page.getByTestId("new-schedule-button").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(page.getByText("New schedule created")).toBeVisible();
  await mutate(page, ward("Ward B", "10"));

  const card = page.getByTestId("recent-schedules-card");
  const rows = card.getByTestId("recent-schedule-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Ward B · October 2025");
  await expect(rows.nth(0)).toContainText("Open here");
  await expect(rows.nth(1)).toContainText("Ward A · September 2025");

  await card.getByRole("button", { name: "Open Ward A · September 2025" }).click();
  await expect(page.getByTestId("scenario-context")).toContainText("Ward A");
  await expect.poll(() => rangeStart(page)).toBe("2025-09-01");
  await expect(rows.filter({ hasText: "Ward A" })).toContainText("Open here");

  await card.getByRole("button", { name: "Open Ward B · October 2025" }).click();
  await expect(page.getByTestId("scenario-context")).toContainText("Ward B");
  await expect.poll(() => rangeStart(page)).toBe("2025-10-01");

  // The tab's choice is durable: a reload comes back on Ward B, both still listed.
  await page.reload();
  await expect(page.getByTestId("scenario-context")).toContainText("Ward B");
  await expect(rows).toHaveCount(2);
});
