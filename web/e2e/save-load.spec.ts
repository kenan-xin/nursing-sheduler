import { expect, test, type Page } from "@playwright/test";

// T17 coverage — the Save screen shell's Scenario-file card (Download / Upload /
// Copy / Edit YAML, per the prototype's action group), read-only YAML preview,
// and Anonymise card (3 toggles + Download-anonymised). Drives the real T04
// store through the `window.__nsStore` seam (test-bridge.tsx), mirroring
// e2e/app-shell-rebuild.spec.ts.
//
// Backup-freshness decision under test: Download records the Workspace backup
// (`recordBackup`) on a SUCCESSFUL write only, marking it current; Copy and
// Download-anonymised never record a backup; an invalid draft blocks all three and
// leaves backup currentness untouched.

type NsWindow = {
  __nsStore: {
    scenario: {
      getState(): Record<string, unknown> & {
        mutateScenario(x: unknown): void;
        recordBackup(): void;
      };
    };
    backupStatus(): "none" | "current" | "stale";
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

// Record a current Workspace backup (as a successful plain Download would). The
// app no longer invents a backup on load (T17r review P0), so a scenario is only
// "stale" against a real prior backup — tests that need a stale precondition call
// this before editing.
async function recordBackup(page: Page) {
  await page.evaluate(() => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().recordBackup();
  });
}

function backupStatus(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as NsWindow).__nsStore.backupStatus());
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
  test("all four prototype file actions are co-located in the Scenario file card in canonical order; no separate Load card remains", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    const card = page.getByTestId("scenario-file-card");

    const testids = await card
      .locator("button[data-testid]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    expect(testids).toEqual([
      "scenario-download-button",
      "scenario-upload-button",
      "scenario-copy-button",
      "scenario-edit-yaml-button",
    ]);

    await expect(page.getByTestId("load-controls")).toHaveCount(0);
  });

  test("the ● SAVED badge (browser auto-save status) is present", async ({ page }) => {
    await gotoReadySaveAndLoad(page);
    const badge = page.getByTestId("auto-save-status").getByTestId("persistence-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(/saved/i);
  });

  test("Download on a valid scenario writes a scenario.yaml file and marks the backup current", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    await recordBackup(page);
    await mutate(page, VALID_SCENARIO_PATCH);
    expect(await backupStatus(page)).toBe("stale");

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

    // Download is the ONLY path that records a backup / marks it current (unblocks qq0.22).
    expect(await backupStatus(page)).toBe("current");
  });

  test("Copy on a valid scenario writes the clipboard, toggles the label, and leaves the backup stale", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await gotoReadySaveAndLoad(page);
    await recordBackup(page);
    await mutate(page, VALID_SCENARIO_PATCH);
    expect(await backupStatus(page)).toBe("stale");

    await page.getByTestId("scenario-copy-button").click();
    await expect(page.getByTestId("scenario-copy-button")).toContainText("Copied!");

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain("apiVersion: alpha");

    // Copy produces no durable artifact and must NOT record a backup.
    expect(await backupStatus(page)).toBe("stale");
  });

  test("an incomplete draft still backs up (DL12 §2): Download writes scenario.yaml and marks the backup current", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    // Leaving the date range blank is INCOMPLETE, not corrupt. A Workspace backup
    // preserves incomplete work (DL12 §2) — readiness gates Optimize, not backup —
    // so it must download, not block.
    await recordBackup(page);
    await mutate(page, { staff: [{ id: "Nurse A" }] });
    expect(await backupStatus(page)).toBe("stale");

    // No blocking export-issues panel: the backup is permissive.
    await expect(
      page.getByTestId("scenario-yaml-preview").getByTestId("scenario-export-issues"),
    ).toHaveCount(0);
    // The preview shows the flat Workspace document, incomplete dates and all.
    await expect(page.getByTestId("scenario-yaml-content")).toContainText("workspaceVersion: 1");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("scenario-download-button").click(),
    ]);
    expect(download.suggestedFilename()).toBe("scenario.yaml");
    // A successful plain Workspace Download is the one path that records a backup.
    expect(await backupStatus(page)).toBe("current");
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

  test("Download anonymised on a valid scenario writes scenario-anonymised.yaml and does NOT record a backup", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    await recordBackup(page);
    await mutate(page, VALID_SCENARIO_PATCH);
    expect(await backupStatus(page)).toBe("stale");

    const card = page.getByTestId("anonymise-card");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      card.getByTestId("anonymise-download-button").click(),
    ]);
    expect(download.suggestedFilename()).toBe("scenario-anonymised.yaml");

    // An anonymised copy is a redacted export, not a save of the working
    // scenario (mirrors why Copy doesn't record a backup) -- the backup stays stale.
    expect(await backupStatus(page)).toBe("stale");
  });

  test("an incomplete draft still anonymises (DL12 §2 backup), leaving the backup stale", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    // Incomplete (blank dates), not corrupt: the anonymised Workspace backup
    // preserves it and writes, rather than blocking.
    await recordBackup(page);
    await mutate(page, { staff: [{ id: "Nurse A" }] });
    expect(await backupStatus(page)).toBe("stale");

    const card = page.getByTestId("anonymise-card");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      card.getByTestId("anonymise-download-button").click(),
    ]);
    expect(download.suggestedFilename()).toBe("scenario-anonymised.yaml");
    // An anonymised copy is a redacted export, never a backup — the backup stays stale.
    expect(await backupStatus(page)).toBe("stale");
  });

  // Scatter needs a complete, valid calendar. A null, partial, or reversed range
  // must surface a structured blocking issue BEFORE any transform, write no file,
  // and leave the source state untouched (T17r review P2).
  for (const [label, range] of [
    ["a null (unset) range", { rangeStart: "", rangeEnd: "" }],
    ["a partial range (start only)", { rangeStart: "2026-05-14", rangeEnd: "" }],
    ["a reversed range (end before start)", { rangeStart: "2026-05-20", rangeEnd: "2026-05-14" }],
  ] as const) {
    test(`Scatter on ${label} blocks with a structured issue and downloads nothing`, async ({
      page,
    }) => {
      await gotoReadySaveAndLoad(page);
      await mutate(page, { ...VALID_SCENARIO_PATCH, ...range });

      const card = page.getByTestId("anonymise-card");
      await card.getByTestId("anonymise-toggle-scatter").click();

      let downloaded = false;
      page.on("download", () => {
        downloaded = true;
      });
      await card.getByTestId("anonymise-download-button").click();

      // The range guard surfaces a blocking issue in the card and writes no file.
      await expect(card.getByTestId("scenario-export-issues")).toBeVisible();
      expect(downloaded).toBe(false);
      // Source state is untouched — the guard runs before the clone/transform.
      const rangeStart = await page.evaluate(
        () => (window as unknown as NsWindow).__nsStore.scenario.getState().rangeStart,
      );
      expect(rangeStart).toBe(range.rangeStart);
    });
  }
});

// T08e — the visible, accessible tri-state backup-freshness indicator on the
// Save & Load surface. It is display-only (never gates nav/unload/operations —
// that decoupling is proven in app-shell.spec.ts) and DISTINCT from the browser
// auto-save persistence badge: the persistence badge answers "saved in this
// browser?", this one answers "does my downloaded backup still match my work?".
test.describe("T08e — Workspace-backup freshness indicator", () => {
  test("reads No backup → Backup current after a plain Download → Backup out of date after an edit", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    const badge = page.getByTestId("backup-status");

    // A fresh workspace has no downloaded backup.
    await expect(badge).toHaveAttribute("data-status", "none");
    await expect(badge).toContainText(/no backup/i);

    // A successful plain Download records the backup → current.
    await mutate(page, VALID_SCENARIO_PATCH);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("scenario-download-button").click(),
    ]);
    expect(download.suggestedFilename()).toBe("scenario.yaml");
    await expect(badge).toHaveAttribute("data-status", "current");
    await expect(badge).toContainText(/backup current/i);

    // Any edit diverges from the downloaded file → out of date.
    await mutate(page, { rangeStart: "2027-01-01" });
    await expect(badge).toHaveAttribute("data-status", "stale");
    await expect(badge).toContainText(/backup out of date/i);
  });

  test("Copy and Download-anonymised never falsely mark the backup current", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await gotoReadySaveAndLoad(page);
    const badge = page.getByTestId("backup-status");

    // Reach 'current' via a real Download, then edit to 'stale'.
    await mutate(page, VALID_SCENARIO_PATCH);
    await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("scenario-download-button").click(),
    ]);
    await expect(badge).toHaveAttribute("data-status", "current");
    await mutate(page, { rangeStart: "2027-01-01" });
    await expect(badge).toHaveAttribute("data-status", "stale");

    // Copy produces no durable backup → stays stale, never flips to current.
    await page.getByTestId("scenario-copy-button").click();
    await expect(page.getByTestId("scenario-copy-button")).toContainText("Copied!");
    await expect(badge).toHaveAttribute("data-status", "stale");

    // Download-anonymised is a redacted export, not a backup → stays stale.
    await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("anonymise-download-button").click(),
    ]);
    await expect(badge).toHaveAttribute("data-status", "stale");
  });

  test("importing a scenario clears freshness to No backup, never current", async ({ page }) => {
    await gotoReadySaveAndLoad(page);
    const badge = page.getByTestId("backup-status");

    // Reach 'current' first, so the import is proven to CLEAR an existing backup.
    await mutate(page, VALID_SCENARIO_PATCH);
    await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("scenario-download-button").click(),
    ]);
    await expect(badge).toHaveAttribute("data-status", "current");

    // Import a sample into the non-empty workspace (stages the replace confirm).
    await page.getByTestId("scenario-upload-button").click();
    await page.getByTestId("upload-load-sample-button").click();
    await page.getByTestId("confirm-dialog-confirm").click();

    // An imported file is not a fresh local backup → freshness clears to none.
    await expect(badge).toHaveAttribute("data-status", "none");
    await expect(badge).toContainText(/no backup/i);
  });

  test("the backup badge is a distinct surface from the auto-save persistence badge", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    const backup = page.getByTestId("backup-status");
    const persistence = page.getByTestId("auto-save-status").getByTestId("persistence-badge");

    await expect(backup).toBeVisible();
    await expect(persistence).toBeVisible();
    // Two different axes: local autosave says Saved; the backup is not yet taken.
    await expect(persistence).toContainText(/saved/i);
    await expect(backup).toContainText(/no backup/i);
  });
});
