import { expect, test, type Page } from "@playwright/test";

// T17b-2 coverage — the Load flow UI: the Scenario-file card's Upload button
// opens the upload modal, then the shared import pipeline (version-mismatch
// confirm, import warnings banner, full-state replace). Kept in its own spec
// file (rather than extending e2e/save-load.spec.ts) to avoid colliding with
// that file's growth; both drive the real T04 store through the same
// `window.__nsStore` seam (test-bridge.tsx), mirroring
// e2e/app-shell-rebuild.spec.ts.

type NsWindow = {
  __nsStore: {
    scenario: {
      getState(): Record<string, unknown> & { mutateScenario(x: unknown): void };
      temporal: { getState(): { pastStates: unknown[] } };
    };
    isDirty(): boolean;
  };
};

async function gotoReadySaveAndLoad(page: Page) {
  await page.goto("/save-and-load");
  await expect(page.getByTestId("screen")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __nsStore?: unknown }).__nsStore),
  );
}

function rangeStart(page: Page): Promise<unknown> {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.getState().rangeStart,
  );
}

function pastStatesLength(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().pastStates.length,
  );
}

function isDirty(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as NsWindow).__nsStore.isDirty());
}

// A minimal backend-valid YAML fixture (mirrors lib/scenario/test-fixtures.ts'
// makeValidUiState — kept in sync manually, same convention as
// e2e/save-load.spec.ts's VALID_SCENARIO_PATCH). appVersion deliberately absent
// (drives the "missing" version-confirm gate case).
const VALID_YAML_NO_VERSION = `apiVersion: alpha
dates:
  range:
    startDate: 2026-06-01
    endDate: 2026-06-07
people:
  items:
    - id: Alice
    - id: Bob
shiftTypes:
  items:
    - id: D
      description: Day
      startTime: "09:00"
      endTime: "17:00"
      durationMinutes: 480
preferences:
  - type: shift type requirement
    shiftType: D
    requiredNumPeople: 1
    qualifiedPeople: ALL
    date: ALL
`;

const VALID_YAML_MISMATCHED_VERSION = `${VALID_YAML_NO_VERSION}appVersion: v0.0.1-e2e-fixture\n`;

const INVALID_YAML = "preferences: [unterminated, flow";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
});

test.describe("T17b-2 — Load flow UI", () => {
  test("Upload opens the modal with a dropzone and a load-sample affordance", async ({ page }) => {
    await gotoReadySaveAndLoad(page);
    await page.getByTestId("scenario-upload-button").click();
    await expect(page.getByTestId("upload-modal")).toBeVisible();
    await expect(page.getByTestId("upload-dropzone")).toBeVisible();
    await expect(page.getByTestId("upload-load-sample-button")).toBeVisible();
  });

  test("Load a sample scenario replaces state and clears undo history", async ({ page }) => {
    await gotoReadySaveAndLoad(page);
    await page.getByTestId("scenario-upload-button").click();
    await page.getByTestId("upload-load-sample-button").click();

    await expect.poll(() => rangeStart(page)).not.toBe(null);
    expect(await pastStatesLength(page)).toBe(0);
    expect(await isDirty(page)).toBe(false);
  });

  test("invalid YAML blocks the load: V-issues shown, store untouched", async ({ page }) => {
    await gotoReadySaveAndLoad(page);
    const before = await rangeStart(page);

    await page.getByTestId("scenario-upload-button").click();
    await page.getByTestId("upload-file-input").setInputFiles({
      name: "bad.yaml",
      mimeType: "text/yaml",
      buffer: Buffer.from(INVALID_YAML),
    });

    await expect(
      page.getByTestId("scenario-file-card").getByTestId("scenario-export-issues"),
    ).toBeVisible();
    expect(await rangeStart(page)).toBe(before);
  });

  test("a missing app version shows the confirm modal; Cancel is a no-op", async ({ page }) => {
    await gotoReadySaveAndLoad(page);
    const before = await rangeStart(page);

    await page.getByTestId("scenario-upload-button").click();
    await page.getByTestId("upload-file-input").setInputFiles({
      name: "no-version.yaml",
      mimeType: "text/yaml",
      buffer: Buffer.from(VALID_YAML_NO_VERSION),
    });

    await expect(page.getByTestId("confirm-dialog-confirm")).toBeVisible();
    await expect(page.getByText(/does not contain app version information/i)).toBeVisible();

    await page.getByTestId("confirm-dialog-cancel").click();
    await expect(page.getByTestId("confirm-dialog-confirm")).toBeHidden();
    expect(await rangeStart(page)).toBe(before);
  });

  test("a version mismatch's Continue commits the load", async ({ page }) => {
    await gotoReadySaveAndLoad(page);

    await page.getByTestId("scenario-upload-button").click();
    await page.getByTestId("upload-file-input").setInputFiles({
      name: "mismatch.yaml",
      mimeType: "text/yaml",
      buffer: Buffer.from(VALID_YAML_MISMATCHED_VERSION),
    });

    await expect(page.getByTestId("confirm-dialog-confirm")).toBeVisible();
    await page.getByTestId("confirm-dialog-confirm").click();

    await expect.poll(() => rangeStart(page)).toBe("2026-06-01");
    expect(await pastStatesLength(page)).toBe(0);
  });
});
