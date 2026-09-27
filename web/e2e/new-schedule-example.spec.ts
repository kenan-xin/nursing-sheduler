import { expect, test, type Page } from "@playwright/test";

// F07 coverage — the Start-over card offers TWO new-schedule choices.
//
// `New schedule` keeps the verified `resetToNewSchedule` cut exactly as it was
// (its own browser-level proof lives in `e2e/new-schedule-reset.spec.ts`); this
// spec covers the second choice, the realistic 87-person ward, and the fact that
// it is an ORDINARY import rather than a second reset protocol. The example is
// fetched from the static `/examples/...` path the app ships and handed to the
// same `useScenarioImport` pipeline the Upload modal and Edit-YAML use, so the
// assertions below read the shipped bytes back through the real store rather
// than through a fixture (mirroring `e2e/save-load-import.spec.ts`).

type NsWindow = {
  __nsStore: {
    /** The repository command bus — the product's only durable write path. */
    commands: {
      mutate(patch: Record<string, unknown>): Promise<{ ok: boolean }>;
    };
    drain(): Promise<void>;
    scenario(): Record<string, unknown>;
  };
};

const SAVE_AND_LOAD_URL = "/save-and-load";
const EXAMPLE_PATH = "/examples/large-ward-with-87-people-2025-11.yaml";
/** Glob form: Playwright matches routes against the absolute request URL. */
const EXAMPLE_URL_GLOB = `**${EXAMPLE_PATH}`;

const SEED_PATCH = { rangeStart: "2026-05-14", rangeEnd: "2026-05-20" };

async function gotoReadyStartOver(page: Page) {
  await page.goto(SAVE_AND_LOAD_URL);
  await expect(page.getByTestId("start-over-card")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __nsStore?: unknown }).__nsStore),
  );
}

/** A COMMITTED read — drained, so an assertion never outruns the command that wrote. */
function scenario(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const store = (window as unknown as NsWindow).__nsStore;
    await store.drain();
    return store.scenario();
  });
}

async function mutate(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (p) => {
    const store = (window as unknown as NsWindow).__nsStore;
    const outcome = await store.commands.mutate(p);
    if (!outcome.ok) throw new Error("seed mutate was refused");
    await store.drain();
  }, patch);
}

/** How many staff the committed projection holds — the readable "is it empty?" probe. */
async function staffCount(page: Page): Promise<number> {
  const committed = await scenario(page);
  return (committed.staff as unknown[]).length;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
});

test.describe("F07 — the Start-over card's two new-schedule choices", () => {
  test("offers both an empty schedule and the bundled 87-person example", async ({ page }) => {
    await gotoReadyStartOver(page);

    await expect(page.getByTestId("new-schedule-button")).toBeVisible();
    await expect(page.getByTestId("new-schedule-button")).toContainText("New schedule");
    await expect(page.getByTestId("new-schedule-example")).toBeVisible();
    await expect(page.getByTestId("new-schedule-example")).toContainText("87-person example");
    // The card says what each choice does before either is clicked.
    await expect(page.getByTestId("start-over-card")).toContainText("begin empty");
    await expect(page.getByTestId("start-over-card")).toContainText("87-person");
  });

  test("the Empty choice keeps today's verified reset behaviour", async ({ page }) => {
    await gotoReadyStartOver(page);
    await mutate(page, SEED_PATCH);
    expect((await scenario(page)).rangeStart).toBe("2026-05-14");

    await page.getByTestId("new-schedule-button").click();
    // The confirmation still NAMES the roster consequence, unchanged.
    await expect(page.getByTestId("confirm-dialog-consequences")).toContainText(
      "The saved roster and the last run's result",
    );
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page.getByText("New schedule created")).toBeVisible();

    await expect.poll(async () => (await scenario(page)).rangeStart).toBe("");
    expect(await staffCount(page)).toBe(0);
  });

  test("the Example choice loads the shipped ward through the ordinary import path", async ({
    page,
  }) => {
    await gotoReadyStartOver(page);

    await page.getByTestId("new-schedule-example").click();

    // The REAL bundled file, read back through the committed projection: 87 staff
    // over the November 2025 range the shipped YAML declares.
    await expect.poll(() => staffCount(page)).toBe(87);
    const loaded = await scenario(page);
    expect(loaded.rangeStart).toBe("2025-11-01");
    expect(loaded.rangeEnd).toBe("2025-11-30");
    expect((loaded.shifts as unknown[]).length).toBeGreaterThan(0);

    // An ordinary Load: the shared success toast, and NO V-issue list — the example
    // is accepted unchanged rather than through a repair path.
    await expect(
      page.getByText("Scenario loaded — this replaces your current setup."),
    ).toBeVisible();
    await expect(page.getByTestId("scenario-export-issues")).toHaveCount(0);
    await expect(page.getByTestId("new-schedule-example-error")).toHaveCount(0);
  });

  test("a failed example fetch keeps the current schedule and reports plainly", async ({
    page,
  }) => {
    await gotoReadyStartOver(page);
    await mutate(page, SEED_PATCH);

    // Scoped to the example path only, so the shell itself stays real.
    await page.route(EXAMPLE_URL_GLOB, (route) => route.fulfill({ status: 404, body: "" }));
    await page.getByTestId("new-schedule-example").click();

    const error = page.getByTestId("new-schedule-example-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("could not be loaded");
    // Nothing was announced as loaded, and the schedule is exactly as it was.
    await expect(page.getByText("Scenario loaded — this replaces your current setup.")).toHaveCount(
      0,
    );
    const after = await scenario(page);
    expect(after.rangeStart).toBe("2026-05-14");
    expect((after.staff as unknown[]).length).toBe(0);
    // The button stays armed, so clicking it again is a real retry.
    await expect(page.getByTestId("new-schedule-example")).toBeEnabled();
  });
});
