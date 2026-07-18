import { expect, test, type Page } from "@playwright/test";

// T17a-4/T17a-5 coverage — the Save screen shell's Scenario-file card
// (Download/Copy), read-only YAML preview, and Anonymise card (3 toggles +
// Download-anonymised). Drives the real T04 store through the
// `window.__nsStore` seam (test-bridge.tsx), mirroring e2e/app-shell-rebuild.spec.ts.
//
// Dirty-machinery decision under test: Download clears dirty (`markSaved`) on a
// SUCCESSFUL write only; Copy and Download-anonymised never clear dirty; an
// invalid draft blocks all three and leaves dirty untouched.

type NsWindow = {
  __nsStore: {
    scenario: { getState(): Record<string, unknown> & { mutateScenario(x: unknown): void } };
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

async function mutate(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}

function isDirty(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as NsWindow).__nsStore.isDirty());
}

// A minimal but backend-valid scenario patch (mirrors
// lib/scenario/test-fixtures.ts' makeValidUiState — kept in sync manually since
// that fixture isn't exported for browser-context use).
const VALID_SCENARIO_PATCH = {
  rangeStart: "2026-05-14",
  rangeEnd: "2026-05-20",
  staff: [{ id: "Alice", history: ["D"] }, { id: "Bob" }],
  staffGroups: [{ id: "Seniors", members: ["Alice", "Bob"] }],
  shifts: [
    {
      id: "D",
      description: "Day",
      startTime: "09:00",
      endTime: "17:00",
      restMinutes: 60,
      durationMinutes: 420,
    },
    { id: "E", description: "Evening" },
    { id: "N", description: "Night" },
  ],
  shiftGroups: [{ id: "DayOrEvening", members: ["D", "E"] }],
  dateGroups: [{ id: "FirstTwo", members: ["2026-05-14", "2026-05-15"] }],
  maxOneShiftPerDay: { description: "one per day" },
  cardsByKind: {
    requirements: [
      {
        uid: "r1",
        shiftType: "D",
        requiredNumPeople: 1,
        qualifiedPeople: "ALL",
        date: "ALL",
        weight: -1,
      },
    ],
    successions: [],
    counts: [],
    affinities: [],
    coverings: [],
  },
  reqData: [
    { uid: "c1", kind: "leave", person: "Alice", date: "2026-05-14" },
    { uid: "c2", kind: "request", person: "Bob", date: "2026-05-15", shiftType: "D", weight: 2 },
    { uid: "c3", kind: "off", person: "Bob", date: "2026-05-16", weight: 1 },
  ],
  exportLayout: {
    formatting: [{ uid: "f1", type: "row", people: ["Alice"], backgroundColor: "#ff0000" }],
    // mutateScenario shallow-merges exportLayout, and computeScenarioSummary (rendered
    // on every page via the sidebar) reads .length on all three arrays — so a partial
    // exportLayout leaves these undefined and crashes the tree, wiping __nsStore.
    extraColumns: [],
    extraRows: [],
  },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
});

test.describe("T17a-4 — Scenario-file card + read-only preview", () => {
  test("the ● SAVED badge (browser auto-save status) is present", async ({ page }) => {
    await gotoReadySaveAndLoad(page);
    const badge = page.getByTestId("auto-save-status").getByTestId("persistence-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(/saved/i);
  });

  test("Download on a valid scenario writes a scenario.yaml file and clears dirty", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    await mutate(page, VALID_SCENARIO_PATCH);
    expect(await isDirty(page)).toBe(true);

    await expect(page.getByTestId("scenario-yaml-content")).toContainText("apiVersion: alpha");
    await expect(page.getByTestId("scenario-yaml-preview")).not.toContainText(
      "issue",
      // No V-issues panel on a valid draft.
    );

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("scenario-download-button").click(),
    ]);
    expect(download.suggestedFilename()).toBe("scenario.yaml");

    // Download is the ONLY path that clears dirty (unblocks qq0.22).
    expect(await isDirty(page)).toBe(false);
  });

  test("Copy on a valid scenario writes the clipboard, toggles the label, and leaves dirty set", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await gotoReadySaveAndLoad(page);
    await mutate(page, VALID_SCENARIO_PATCH);
    expect(await isDirty(page)).toBe(true);

    await page.getByTestId("scenario-copy-button").click();
    await expect(page.getByTestId("scenario-copy-button")).toContainText("Copied!");

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain("apiVersion: alpha");

    // Copy produces no durable artifact and must NOT clear dirty.
    expect(await isDirty(page)).toBe(true);
  });

  test("an invalid draft shows V-issues in both the card and the preview; Download/Copy write nothing and dirty is not cleared", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    // Leaving the date range blank/default fails producer validation (zIsoDate),
    // and diverges from the clean baseline so dirty is observably true.
    await mutate(page, { staff: [{ id: "Nurse A" }] });
    expect(await isDirty(page)).toBe(true);

    await expect(
      page.getByTestId("scenario-yaml-preview").getByTestId("scenario-export-issues"),
    ).toBeVisible();

    const downloadAttempt = page.waitForEvent("download", { timeout: 800 }).catch(() => null);
    await page.getByTestId("scenario-download-button").click();
    expect(await downloadAttempt).toBeNull();
    await expect(
      page.getByTestId("scenario-file-card").getByTestId("scenario-export-issues"),
    ).toBeVisible();
    expect(await isDirty(page)).toBe(true); // Download did not clear dirty.

    await page.getByTestId("scenario-copy-button").click();
    await expect(page.getByTestId("scenario-copy-button")).not.toContainText("Copied!");
    await expect(
      page.getByTestId("scenario-file-card").getByTestId("scenario-export-issues"),
    ).toBeVisible();
    expect(await isDirty(page)).toBe(true); // Copy did not clear dirty either.
  });
});

test.describe("T17a-5 -- Anonymise card", () => {
  test("exactly 3 toggles render, with the DL10 D2 defaults (people ON, groups/scatter OFF)", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    const card = page.getByTestId("anonymise-card");
    await expect(card).toBeVisible();

    await expect(card.getByTestId("anonymise-toggle-people")).toBeVisible();
    await expect(card.getByTestId("anonymise-toggle-groups")).toBeVisible();
    await expect(card.getByTestId("anonymise-toggle-scatter")).toBeVisible();

    // DL10 D2: no 4th "Remove free-text descriptions" toggle.
    await expect(card.getByText(/remove free-text descriptions/i)).toHaveCount(0);
    await expect(card.getByText(/free-text descriptions are not changed/i)).toBeVisible();

    await expect(card.getByTestId("anonymise-toggle-people")).toHaveAttribute("data-checked", "");
    await expect(card.getByTestId("anonymise-toggle-groups")).toHaveAttribute("data-unchecked", "");
    await expect(card.getByTestId("anonymise-toggle-scatter")).toHaveAttribute(
      "data-unchecked",
      "",
    );
  });

  test("Download anonymised is disabled with all toggles off, re-enabled with >=1 on", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    const card = page.getByTestId("anonymise-card");
    const downloadButton = card.getByTestId("anonymise-download-button");

    // Default: people ON -> enabled.
    await expect(downloadButton).toBeEnabled();

    await card.getByTestId("anonymise-toggle-people").click();
    await expect(downloadButton).toBeDisabled();

    await card.getByTestId("anonymise-toggle-groups").click();
    await expect(downloadButton).toBeEnabled();
  });

  test("Download anonymised on a valid scenario writes scenario-anonymised.yaml and does NOT clear dirty", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    await mutate(page, VALID_SCENARIO_PATCH);
    expect(await isDirty(page)).toBe(true);

    const card = page.getByTestId("anonymise-card");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      card.getByTestId("anonymise-download-button").click(),
    ]);
    expect(download.suggestedFilename()).toBe("scenario-anonymised.yaml");

    // An anonymised copy is a redacted export, not a save of the working
    // scenario (mirrors why Copy doesn't clear dirty) -- dirty stays set.
    expect(await isDirty(page)).toBe(true);
  });

  test("an invalid draft shows V-issues in the Anonymise card and writes nothing", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    await mutate(page, { staff: [{ id: "Nurse A" }] });
    expect(await isDirty(page)).toBe(true);

    const card = page.getByTestId("anonymise-card");
    const downloadAttempt = page.waitForEvent("download", { timeout: 800 }).catch(() => null);
    await card.getByTestId("anonymise-download-button").click();
    expect(await downloadAttempt).toBeNull();
    await expect(card.getByTestId("scenario-export-issues")).toBeVisible();
    expect(await isDirty(page)).toBe(true);
  });
});
