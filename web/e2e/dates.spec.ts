import { expect, test, type Page } from "@playwright/test";

// T10 Dates & Calendar — Playwright acceptance for the prototype-conformant rebuild.
// The lib layer proves the pure halves of the acceptance rows in vitest
// (lib/dates/*.test.ts); this spec drives the REAL Dates UI through the real T04
// store (the `window.__nsStore` seam from components/shell/test-bridge.tsx) for the
// UI-only behaviours:
//   • two-column work area (roster-period card | calendar card) at desktop
//   • calendar state language — Monday-first, month heading, legend, in-range band,
//     solid labelled START/END endpoints, holiday marker, muted out-of-range days
//   • holiday import surface is English-only (no bilingual column)
//   • import switch creates WORKDAY/NON-WORKDAY/PH, then editable + deletable
//   • custom group create + inline name edit + Save/Cancel/Delete via the shared
//     entity-editor core (fs7) and the shared DateScopePicker
//   • read-only derived groups are multi-select PREVIEW chips (never mutating)
//   • row 6 — day-scope picker toggles + quick-picks, out-of-range members preserved
//   • row 4 regression — reserved auto-derived ids are never editable/mutable

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
});

/** Navigate to Dates and wait for the hydrated screen + store seam. */
async function gotoDates(page: Page) {
  await page.goto("/dates");
  await expect(page.getByTestId("screen")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __nsStore?: unknown }).__nsStore),
  );
}

/** Set the roster range through the real inputs (commit-on-complete, no button). */
async function setRange(page: Page, start: string, end: string) {
  await page.getByTestId("range-start").fill(start);
  await page.getByTestId("range-end").fill(end);
  // The completing edit commits the range cascade; wait for it to land in the store.
  await page.waitForFunction(
    ([s, e]) => {
      const st = (
        window as unknown as {
          __nsStore: { scenario: { getState(): { rangeStart: string; rangeEnd: string } } };
        }
      ).__nsStore.scenario.getState();
      return st.rangeStart === s && st.rangeEnd === e;
    },
    [start, end] as const,
  );
}

/** Read a scenario field from the live store via the e2e seam. */
async function readField<T = unknown>(page: Page, key: string): Promise<T> {
  return page.evaluate(
    (k) =>
      (
        window as unknown as {
          __nsStore: { scenario: { getState(): Record<string, unknown> } };
        }
      ).__nsStore.scenario.getState()[k] as T,
    key,
  );
}

/** Directly patch the store (seed groups, inject reserved ids). */
async function patchStore(page: Page, groups: { id: string; members: (string | number)[] }[]) {
  await page.evaluate((g) => {
    const store = (
      window as unknown as {
        __nsStore: {
          scenario: {
            getState(): {
              dateGroups: { id: string; members: (string | number)[] }[];
              mutateScenario(patch: Record<string, unknown>): void;
            };
          };
        };
      }
    ).__nsStore.scenario;
    store.getState().mutateScenario({ dateGroups: [...store.getState().dateGroups, ...g] });
  }, groups);
}

/** A display-calendar day cell by its UTC ISO key. */
function displayCell(page: Page, iso: string) {
  return page.locator(`.ns-month-calendar--display .fc-day[data-ns-date="${iso}"]`);
}

/** A day cell scoped to the shared date-scope picker. */
function pickerCell(page: Page, iso: string) {
  return page.locator(`[data-testid="date-scope-picker"] .fc-day[data-ns-date="${iso}"]`);
}

test.describe("T10 Dates & Calendar", () => {
  test("two-column work area — roster-period card sits beside the calendar card", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoDates(page);
    await setRange(page, "2026-07-01", "2026-07-31");

    const roster = page.getByTestId("roster-period-card");
    const calendar = page.getByTestId("calendar-view");
    await expect(roster).toBeVisible();
    await expect(calendar).toBeVisible();

    const r = await roster.boundingBox();
    const c = await calendar.boundingBox();
    // Side by side at desktop: calendar starts to the right of the roster card and
    // both share (roughly) the same top edge.
    expect(c!.x).toBeGreaterThan(r!.x + r!.width - 20);
    expect(Math.abs(c!.y - r!.y)).toBeLessThan(60);
  });

  test("page identity — STEP 1 hero + Continue to staff CTA", async ({ page }) => {
    await gotoDates(page);
    await expect(page.getByRole("heading", { name: "Schedule Dates" })).toBeVisible();
    await expect(page.getByText("Step 1 · Dates")).toBeVisible();
    const cta = page.getByTestId("dates-continue");
    await expect(cta).toHaveText(/Continue to staff/);
    await expect(cta).toHaveAttribute("href", "/people");
  });

  test("calendar state language — heading, legend, in-range band, labelled endpoints", async ({
    page,
  }) => {
    await gotoDates(page);
    await setRange(page, "2026-07-01", "2026-08-15"); // spans July + August

    // One month grid per spanned month (spec 02 FR-DC-17).
    await expect(page.locator(".ns-month-calendar--display")).toHaveCount(2);

    // Monday-first: the first day-of-week header column is MON.
    await expect(
      page.locator(".ns-month-calendar--display .fc-col-header-cell").first(),
    ).toHaveText(/MON/i);

    // Legend is the exact three-item prototype legend.
    const calendar = page.getByTestId("calendar-view");
    await expect(calendar).toContainText("In roster");
    await expect(calendar).toContainText("Start / end");
    await expect(calendar).toContainText("Holiday");

    // Endpoints are solid and labelled — exactly one START and one END.
    await expect(page.locator(".ns-month-calendar--display .fc-day.ns-cal-start")).toHaveCount(1);
    await expect(page.locator(".ns-month-calendar--display .fc-day.ns-cal-end")).toHaveCount(1);
    await expect(displayCell(page, "2026-07-01")).toContainText("START");
    await expect(displayCell(page, "2026-08-15")).toContainText("END");

    // Ordinary in-range days carry the brand band; out-of-range days render muted.
    await expect(
      page.locator(".ns-month-calendar--display .fc-day.ns-cal-in").first(),
    ).toBeVisible();
    await expect(
      page.locator(".ns-month-calendar--display .fc-day.ns-cal-outside").first(),
    ).toBeVisible();

    // National Day (Aug 9) + its observed substitute (Aug 10) both carry the holiday
    // marker class (spec 02 FR-DC-23) — no cell-filling event pill is rendered.
    await expect(page.locator(".ns-month-calendar--display .fc-day.ns-cal-holiday")).toHaveCount(2);
    await expect(page.locator(".ns-month-calendar .fc-daygrid-event")).toHaveCount(0);
  });

  test("holiday cells expose the holiday name via title (incl. a holiday endpoint)", async ({
    page,
  }) => {
    await gotoDates(page);
    // Range ENDS on the observed National Day (Aug 10) — a holiday-endpoint cell.
    await setRange(page, "2026-08-01", "2026-08-10");

    // Ordinary holiday cell (Aug 9, National Day, not an endpoint): name in the title.
    const holiday = displayCell(page, "2026-08-09");
    await expect(holiday).toHaveClass(/ns-cal-holiday/);
    await expect(holiday).toHaveAttribute("title", /National Day/);

    // Holiday ENDPOINT cell (Aug 10): solid END styling wins, but the holiday name is
    // STILL surfaced via the title/accessible label alongside the endpoint role.
    const end = displayCell(page, "2026-08-10");
    await expect(end).toHaveClass(/ns-cal-end/);
    await expect(end).toContainText("END");
    await expect(end).toHaveAttribute("title", /End of roster · National Day/);
    await expect(end).toHaveAttribute("aria-label", /National Day/);
  });

  test("cell title/aria update on an in-month range change (no stale mount-time attrs)", async ({
    page,
  }) => {
    await gotoDates(page);
    await setRange(page, "2026-08-01", "2026-08-10"); // Aug 10 = END + observed National Day
    await expect(displayCell(page, "2026-08-10")).toHaveAttribute(
      "title",
      "End of roster · National Day",
    );

    // Extend end to Aug 11 — SAME month, so the grid would not remount on its own.
    await page.getByTestId("range-end").fill("2026-08-11");
    await page.waitForFunction(() => {
      const st = (
        window as unknown as {
          __nsStore: { scenario: { getState(): { rangeEnd: string } } };
        }
      ).__nsStore.scenario.getState();
      return st.rangeEnd === "2026-08-11";
    });

    // Aug 10 drops the endpoint role but KEEPS the holiday name (title no longer stale).
    const aug10 = displayCell(page, "2026-08-10");
    await expect(aug10).not.toHaveClass(/ns-cal-end/);
    await expect(aug10).toHaveAttribute("title", "National Day");
    await expect(aug10).toHaveAttribute("aria-label", "National Day");
    // Aug 11 is the NEW end (not a holiday) → plain endpoint title.
    const aug11 = displayCell(page, "2026-08-11");
    await expect(aug11).toHaveClass(/ns-cal-end/);
    await expect(aug11).toHaveAttribute("title", "End of roster");

    // Reverse the transition — shrink back to Aug 10.
    await page.getByTestId("range-end").fill("2026-08-10");
    await page.waitForFunction(() => {
      const st = (
        window as unknown as {
          __nsStore: { scenario: { getState(): { rangeEnd: string } } };
        }
      ).__nsStore.scenario.getState();
      return st.rangeEnd === "2026-08-10";
    });

    // Aug 10 regains the endpoint role in its title; Aug 11 is now out of range → no title.
    await expect(displayCell(page, "2026-08-10")).toHaveAttribute(
      "title",
      "End of roster · National Day",
    );
    expect(await displayCell(page, "2026-08-11").getAttribute("title")).toBeNull();
  });

  test("holiday import surface is English-only", async ({ page }) => {
    await gotoDates(page);
    await setRange(page, "2026-05-01", "2026-05-31");

    const changes = page.getByTestId("import-changes");
    await expect(changes).toBeVisible();
    await expect(changes).toContainText("Labour Day");
    await expect(changes).toContainText("Hari Raya Haji");
    await expect(changes).toContainText("Vesak Day");

    const text = (await changes.innerText()) ?? "";
    const nonLatin = /[　-鿿가-힯]/u;
    expect(nonLatin.test(text), text).toBe(false);
    await expect(page.getByTestId("import-english-only")).toHaveText("english-only");

    // The switch reflects the import state and toggles.
    const toggle = page.getByTestId("import-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("import switch creates WORKDAY/NON-WORKDAY/PH, then editable + deletable", async ({
    page,
  }) => {
    await gotoDates(page);
    await setRange(page, "2026-05-01", "2026-05-31");

    await expect(page.getByTestId("editable-group-WORKDAY")).toBeVisible();
    await expect(page.getByTestId("editable-group-NON-WORKDAY")).toBeVisible();
    await expect(page.getByTestId("editable-group-PH")).toBeVisible();

    // Editable: the edit button opens the inline editor with the shared picker.
    await page.getByTestId("editable-group-edit-WORKDAY").click();
    await expect(page.getByTestId("date-group-editor-WORKDAY")).toBeVisible();
    await expect(page.getByTestId("date-scope-picker")).toBeVisible();
    await page.getByTestId("date-group-cancel").click();

    // Deletable: deleting PH runs the cascade; it disappears from panel + store.
    await page.getByTestId("editable-group-delete-PH").click();
    await expect(page.getByTestId("editable-group-PH")).toHaveCount(0);
    const ids = (await readField<{ id: string }[]>(page, "dateGroups")).map((g) => g.id);
    expect(ids).not.toContain("PH");
    expect(ids).toEqual(expect.arrayContaining(["WORKDAY", "NON-WORKDAY"]));
  });

  test("custom group — create with a name + picked days, then inline-rename", async ({ page }) => {
    await gotoDates(page);
    await setRange(page, "2026-07-01", "2026-07-31");

    // "+ Group" opens the inline draft card.
    await page.getByTestId("date-group-add").click();
    await expect(page.getByTestId("date-group-editor-new")).toBeVisible();

    // Name it and pick every weekend day, then Save.
    await page.getByTestId("date-group-name").fill("MyWeekends");
    await page.getByTestId("date-scope-picker-weekends").click();
    await page.getByTestId("date-group-save").click();

    // The new editable group card renders with its members.
    await expect(page.getByTestId("editable-group-MyWeekends")).toBeVisible();
    let groups = await readField<{ id: string; members: string[] }[]>(page, "dateGroups");
    const created = groups.find((g) => g.id === "MyWeekends")!;
    expect(created.members.length).toBeGreaterThan(0);

    // Inline-rename via the edit card.
    await page.getByTestId("editable-group-edit-MyWeekends").click();
    await page.getByTestId("date-group-name").fill("Rest days");
    await page.getByTestId("date-group-save").click();

    await expect(page.getByTestId("editable-group-Rest days")).toBeVisible();
    await expect(page.getByTestId("editable-group-MyWeekends")).toHaveCount(0);
    groups = await readField<{ id: string; members: string[] }[]>(page, "dateGroups");
    expect(groups.map((g) => g.id)).toContain("Rest days");
    expect(groups.map((g) => g.id)).not.toContain("MyWeekends");
  });

  test("creating a group with a reserved auto-derived name is rejected", async ({ page }) => {
    await gotoDates(page);
    await setRange(page, "2026-07-01", "2026-07-31");

    await page.getByTestId("date-group-add").click();
    await page.getByTestId("date-group-name").fill("weekend"); // reserved (case-insensitive)
    await page.getByTestId("date-group-save").click();

    await expect(page.getByTestId("date-group-name-error")).toBeVisible();
    const ids = (await readField<{ id: string }[]>(page, "dateGroups")).map((g) => g.id);
    expect(ids).not.toContain("weekend");
  });

  test("derived groups are multi-select PREVIEW chips (never mutating membership)", async ({
    page,
  }) => {
    await gotoDates(page);
    await setRange(page, "2026-07-01", "2026-07-31");
    const before = await readField<{ id: string }[]>(page, "dateGroups");

    // Select two derived groups → sticky preview shows their union.
    await page.getByTestId("derived-group-WEEKEND").click();
    await page.getByTestId("derived-group-SUNDAY").click();
    await expect(page.getByTestId("date-group-preview")).toBeVisible();
    await expect(page.getByTestId("date-group-preview-count")).toContainText("day");

    // WEEKEND (Sat+Sun) is a superset of SUNDAY, so the union equals WEEKEND's size.
    const weekendCount = Number(
      await page.getByTestId("derived-group-WEEKEND-count").textContent(),
    );
    await expect(page.getByTestId("date-group-preview-count")).toHaveText(`${weekendCount} days`);

    // Clear + hide controls work.
    await page.getByTestId("date-group-preview-clear").click();
    await expect(page.getByTestId("date-group-preview")).toHaveCount(0);

    // Preview NEVER mutated the store — dateGroups are byte-for-byte unchanged.
    const after = await readField<{ id: string }[]>(page, "dateGroups");
    expect(after).toEqual(before);
  });

  test("row 6 — day-scope picker + quick-picks, out-of-range members preserved", async ({
    page,
  }) => {
    await gotoDates(page);
    await setRange(page, "2026-07-01", "2026-07-31"); // same-month ⇒ DD ids

    // Custom group: one in-range member ("01") + one out-of-range ("2020-01-01").
    await patchStore(page, [{ id: "Custom", members: ["01", "2020-01-01"] }]);

    // Clear the in-range selection, Save → only the preserved out-of-range remains.
    await page.getByTestId("editable-group-edit-Custom").click();
    await expect(page.getByTestId("date-scope-picker")).toBeVisible();
    await page.getByTestId("date-scope-picker-clear").click();
    await page.getByTestId("date-group-save").click();
    let custom = (await readField<{ id: string; members: string[] }[]>(page, "dateGroups")).find(
      (g) => g.id === "Custom",
    )!;
    expect(custom.members).toEqual(["2020-01-01"]);

    // Weekdays quick-pick adds every weekday back, still preserving out-of-range.
    await page.getByTestId("editable-group-edit-Custom").click();
    await page.getByTestId("date-scope-picker-weekdays").click();
    // Toggle Jul 1 (a Wednesday, so a selected weekday) OFF via a cell click.
    await expect(pickerCell(page, "2026-07-01")).toHaveClass(/ns-pick-selected/);
    await pickerCell(page, "2026-07-01").click();
    await page.getByTestId("date-group-save").click();

    custom = (await readField<{ id: string; members: string[] }[]>(page, "dateGroups")).find(
      (g) => g.id === "Custom",
    )!;
    expect(custom.members).toContain("2020-01-01"); // out-of-range preserved
    expect(custom.members).not.toContain("01"); // Jul 1 toggled off
    expect(custom.members.length).toBeGreaterThan(1); // other weekdays present
  });

  test("inline Delete closes the editor and leaves the panel usable (MAJOR 1 regression)", async ({
    page,
  }) => {
    await gotoDates(page);
    await setRange(page, "2026-05-01", "2026-05-31"); // imports WORKDAY/NON-WORKDAY/PH

    // Open PH's inline editor and Delete from inside it.
    await page.getByTestId("editable-group-edit-PH").click();
    await expect(page.getByTestId("date-group-editor-PH")).toBeVisible();
    await page.getByTestId("date-group-delete").click();

    // The editor closed and PH is gone — no stale editing state.
    await expect(page.getByTestId("date-group-editor-PH")).toHaveCount(0);
    await expect(page.getByTestId("editable-group-PH")).toHaveCount(0);

    // The panel is fully usable again: + Group is enabled and a new group can be
    // created, then an existing group can still be edited (not permanently busy).
    await expect(page.getByTestId("date-group-add")).toBeEnabled();
    await page.getByTestId("date-group-add").click();
    await page.getByTestId("date-group-name").fill("AfterDelete");
    await page.getByTestId("date-scope-picker-weekdays").click();
    await page.getByTestId("date-group-save").click();
    await expect(page.getByTestId("editable-group-AfterDelete")).toBeVisible();

    await page.getByTestId("editable-group-edit-WORKDAY").click();
    await expect(page.getByTestId("date-group-editor-WORKDAY")).toBeVisible();
  });

  test("off-grid date-literal group names are rejected at create (MAJOR 2 regression)", async ({
    page,
  }) => {
    await gotoDates(page);
    await setRange(page, "2026-07-01", "2026-07-31");

    // These are producer/T07-invalid date-literal shapes (D / MM-DD / YYYY-MM-DD).
    // None is a currently-generated item, so ONLY the date-literal guard rejects them
    // — CREATE must agree with rename/export, not silently write an unexportable id.
    const invalid = ["99", "32", "07-32", "2020-01-01"];
    for (const bad of invalid) {
      await page.getByTestId("date-group-add").click();
      await page.getByTestId("date-group-name").fill(bad);
      await page.getByTestId("date-group-save").click();
      await expect(page.getByTestId("date-group-name-error")).toBeVisible();
      await page.getByTestId("date-group-cancel").click();
    }

    const ids = (await readField<{ id: string }[]>(page, "dateGroups")).map((g) => g.id);
    for (const bad of invalid) expect(ids).not.toContain(bad);
  });

  test("row 4 regression — reserved auto-derived ids are never editable/mutable", async ({
    page,
  }) => {
    await gotoDates(page);
    await setRange(page, "2026-07-01", "2026-07-31");

    // Inject reserved auto-derived ids (case-insensitively) + a Custom group DIRECTLY
    // via the test bridge — this is invalid LOADED state the producer itself rejects
    // (reserved date-group ids are refused case-insensitively, producer.ts:419-435).
    // The point is defensive: even if such state is loaded, the UI MUST treat reserved
    // ids as read-only — no edit/delete/mutation path (acceptance row 4).
    const reserved = ["ALL", "WEEKDAY", "WEEKEND", "MONDAY", "FRIDAY", "all", "Weekday"];
    await patchStore(page, [
      ...reserved.map((id) => ({ id, members: ["01"] })),
      { id: "Custom", members: ["02"] },
    ]);

    // No reserved id renders an editable card / edit / delete control.
    for (const id of reserved) {
      await expect(page.getByTestId(`editable-group-${id}`)).toHaveCount(0);
      await expect(page.getByTestId(`editable-group-edit-${id}`)).toHaveCount(0);
      await expect(page.getByTestId(`editable-group-delete-${id}`)).toHaveCount(0);
    }
    await expect(page.getByTestId("editable-group-Custom")).toBeVisible();

    // No mutation path: the reserved entries remain in the store, untouched.
    const ids = (await readField<{ id: string }[]>(page, "dateGroups")).map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(reserved));
  });
});
