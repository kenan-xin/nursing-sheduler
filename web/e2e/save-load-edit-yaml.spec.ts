import { expect, test, type Page } from "@playwright/test";

// T17b-3 coverage — the right-panel Edit-YAML mode (`ScenarioYamlPreview`):
// Edit toggles the read-only `<pre>` into a textarea seeded from the same
// `prepareExport` YAML, Apply drives the SAME `useScenarioImport` pipeline as
// the Upload entry point (e2e/save-load-import.spec.ts) — block on V-issues,
// gate on `classifyImportVersion`, full-state replace via `loadScenario` — and
// Cancel discards the draft with no state change. Kept in its own spec file
// per e2e/save-load-import.spec.ts's convention, to avoid colliding with the
// concurrently growing e2e/save-load.spec.ts. Drives the real T04 store
// through the `window.__nsStore` seam (test-bridge.tsx).

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

async function mutate(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
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

// Mirrors e2e/save-load.spec.ts's VALID_SCENARIO_PATCH / lib/scenario/test-fixtures.ts's
// makeValidUiState (kept in sync manually — that fixture isn't exported for
// browser-context use).
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
  },
};

// A backend-valid YAML fixture whose roster range differs from
// VALID_SCENARIO_PATCH above, so a successful Apply is observable as a
// distinct full-state replace rather than a no-op re-application of the same
// dates. appVersion deliberately absent (drives the "missing" version-confirm
// gate case, same as e2e/save-load-import.spec.ts's VALID_YAML_NO_VERSION).
const EDITED_VALID_YAML = `apiVersion: alpha
dates:
  range:
    startDate: 2026-06-01
    endDate: 2026-06-07
people:
  items:
    - id: Chloe
    - id: Dan
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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
});

test.describe("T17b-3 — Edit-YAML mode", () => {
  test("Edit seeds a textarea with the current YAML; Cancel restores the read-only preview with no state change", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    await mutate(page, VALID_SCENARIO_PATCH);
    const before = await rangeStart(page);

    const preview = page.getByTestId("scenario-yaml-preview");
    const previewText = await preview.getByTestId("scenario-yaml-content").textContent();

    await preview.getByTestId("yaml-edit-toggle").click();
    const textarea = preview.getByTestId("scenario-yaml-textarea");
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue(previewText ?? "");
    await expect(preview.getByTestId("scenario-yaml-content")).toBeHidden();

    await textarea.fill("::bad::");
    await preview.getByTestId("yaml-cancel-button").click();

    await expect(preview.getByTestId("scenario-yaml-textarea")).toBeHidden();
    await expect(preview.getByTestId("scenario-yaml-content")).toContainText(
      previewText?.slice(0, 40) ?? "",
    );
    expect(await rangeStart(page)).toBe(before);
  });

  test("Apply on `::bad::` surfaces an inline parse error and leaves state untouched", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    await mutate(page, VALID_SCENARIO_PATCH);
    const before = await rangeStart(page);

    const preview = page.getByTestId("scenario-yaml-preview");
    await preview.getByTestId("yaml-edit-toggle").click();
    await preview.getByTestId("scenario-yaml-textarea").fill("::bad::");
    await preview.getByTestId("yaml-apply-button").click();

    await expect(preview.getByTestId("scenario-export-issues")).toBeVisible();
    expect(await rangeStart(page)).toBe(before);
    // Still editing -- Apply failed, the draft is not discarded.
    await expect(preview.getByTestId("scenario-yaml-textarea")).toBeVisible();
  });

  test("Apply on valid edited YAML runs the same block/gate/replace pipeline as Upload: full-state replace, history cleared", async ({
    page,
  }) => {
    await gotoReadySaveAndLoad(page);
    await mutate(page, VALID_SCENARIO_PATCH);

    const preview = page.getByTestId("scenario-yaml-preview");
    await preview.getByTestId("yaml-edit-toggle").click();
    await preview.getByTestId("scenario-yaml-textarea").fill(EDITED_VALID_YAML);
    await preview.getByTestId("yaml-apply-button").click();

    // No app version in the edited YAML -- the same version-confirm gate as Upload.
    await expect(page.getByTestId("confirm-dialog-confirm")).toBeVisible();
    await page.getByTestId("confirm-dialog-confirm").click();

    await expect.poll(() => rangeStart(page)).toBe("2026-06-01");
    expect(await pastStatesLength(page)).toBe(0);
    expect(await isDirty(page)).toBe(false);

    // Editing mode closes back to the read-only preview once the replace commits.
    await expect(preview.getByTestId("scenario-yaml-textarea")).toBeHidden();
    await expect(preview.getByTestId("scenario-yaml-content")).toContainText("Chloe");
  });
});
