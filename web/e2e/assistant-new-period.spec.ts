import { expect, test, type Page } from "@playwright/test";

// plq5 P3 in a real browser: "based on my September schedule, create October".
//
// NO LIVE PROVIDER. The card is reached through the assistant test bridge, which runs
// the REAL `prepare_new_period_from_schedule` body; everything after that is the
// shipped UI: the card in the dock, the user's Create, the switch to the new schedule,
// the panel's link back, and Recent schedules. September's roster is written straight
// into the browser's IndexedDB, in the row shape the roster storage reads.

const SENTINEL_KEY = "sk-or-v1-E2E-SENTINEL-DO-NOT-LEAK-000000000000";
const SENTINEL_MODEL = "anthropic/claude-sonnet-4.5";

type NsWindow = {
  __nsStore: {
    authority(): { scenarioId: string | null; ownership: string };
    commands: { mutate(patch: Record<string, unknown>): Promise<{ ok: boolean }> };
    drain(): Promise<void>;
    scenario(): { rangeStart: string; staff: { id: string; history?: string[] }[] };
  };
  __nsAssistant: {
    prepareNewPeriod(input: {
      scenarioId: string;
      rangeStart: string;
      rangeEnd: string;
    }): Promise<unknown>;
  };
};

const SEPTEMBER = {
  meta: { apiVersion: "alpha", description: "Ward 3" },
  rangeStart: "2025-09-01",
  rangeEnd: "2025-09-30",
  staff: [{ id: "Ana" }, { id: "Bo" }],
  shifts: [{ id: "D" }, { id: "N" }],
};

async function stubSetupRoutes(page: Page) {
  await page.route("**/api/ai/openrouter/models", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: "catalog",
        models: [{ id: SENTINEL_MODEL, label: "Claude Sonnet 4.5", imageInput: true }],
      }),
    }),
  );
  await page.route("**/api/ai/openrouter/test", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
}

/** September's roster: everyone off, except Ana on nights for the last two days. */
async function saveSeptemberRoster(page: Page, scenarioId: string) {
  await page.evaluate(async (id) => {
    const calendar = Array.from({ length: 30 }, (_, i) => ({
      iso: `2025-09-${String(i + 1).padStart(2, "0")}`,
      weekday: "Mon",
      weekend: false,
      holiday: false,
    }));
    const row = (nights: boolean) =>
      calendar.map((_, d) =>
        nights && d >= 28 ? { kind: "shift", shiftId: "N" } : { kind: "off" },
      );
    const document = {
      context: {
        people: [{ id: "Ana" }, { id: "Bo" }],
        shiftTypes: [{ id: "D" }, { id: "N" }],
        calendar,
        baselineMinimums: [],
        leaveCreditMinutes: null,
      },
      solvedDays: [row(true), row(false)],
      edits: [],
    };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("nurse-scheduler");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("roster", "readwrite");
        tx.objectStore("roster").put({
          key: `working:${id}`,
          document,
          revision: 1,
          clearEpoch: 0,
        });
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, scenarioId);
}

test("based on September, create October: the user's Create makes it, with rest history", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
  await stubSetupRoutes(page);

  // Enable the assistant (the card lives in its dock).
  await page.goto("/settings");
  await page.waitForFunction(() => {
    const ns = (window as unknown as Partial<NsWindow>).__nsStore;
    return Boolean(ns) && ns!.authority().scenarioId !== null;
  });
  await page.getByTestId("ai-enabled-switch").click();
  await page.getByTestId("ai-key-input").fill(SENTINEL_KEY);
  await page.getByTestId("ai-model-select").selectOption(SENTINEL_MODEL);
  await page.getByTestId("ai-test").click();
  await expect(page.getByTestId("ai-readiness")).toHaveText("Ready");

  const september = await page.evaluate(async (seed) => {
    const store = (window as unknown as NsWindow).__nsStore;
    if (!(await store.commands.mutate(seed)).ok) throw new Error("seed refused");
    await store.drain();
    return store.authority().scenarioId!;
  }, SEPTEMBER);
  await saveSeptemberRoster(page, september);

  await page.getByTestId("assistant-launcher").click();
  await expect(page.getByTestId("assistant-dock")).toBeVisible();
  await page.evaluate(
    (id) =>
      (window as unknown as NsWindow).__nsAssistant.prepareNewPeriod({
        scenarioId: id,
        rangeStart: "2025-10-01",
        rangeEnd: "2025-10-31",
      }),
    september,
  );

  const card = page.getByTestId("assistant-new-period");
  await expect(card).toContainText("Create “Ward 3 · October 2025”?");
  await expect(page.getByTestId("new-period-history")).toHaveText(
    "Rest history: the last 7 days of September 2025's roster, for 2 people.",
  );
  // Nothing exists yet: the card is an offer.
  expect(
    await page.evaluate(() => (window as unknown as NsWindow).__nsStore.authority().scenarioId),
  ).toBe(september);

  await page.getByTestId("new-period-create").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("assistant-derived-note")).toContainText(
    "Made from “Ward 3 · September 2025”. Its conversation stays with it.",
  );
  const october = await page.evaluate(async () => {
    const store = (window as unknown as NsWindow).__nsStore;
    await store.drain();
    return { id: store.authority().scenarioId, scenario: store.scenario() };
  });
  expect(october.id).not.toBe(september);
  expect(october.scenario.rangeStart).toBe("2025-10-01");
  expect(october.scenario.staff[0]!.history).toEqual(["OFF", "OFF", "OFF", "OFF", "OFF", "N", "N"]);

  // The link back opens Save & Load, where September is kept and October says where from.
  await page.getByRole("button", { name: "Open it from Recent schedules" }).click();
  const rows = page.getByTestId("recent-schedule-row");
  await expect(rows.filter({ hasText: "Ward 3 · October 2025" })).toContainText(
    "Based on Ward 3 · September 2025",
  );
  // September is kept, with its roster; October has none of its own yet.
  await expect(rows.filter({ hasText: "Has roster" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Has roster" })).toContainText("Ward 3 · September 2025");
});
