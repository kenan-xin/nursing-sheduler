import { expect, test, type Page } from "@playwright/test";

// DR-3 acceptance for the bespoke Shifts card-grid (`/shift-types` → ShiftTypeGrid),
// carved from people-shift-types.spec.ts. Driven against a production build through
// the real T04 store (`window.__nsStore`); every outcome asserts the DURABLE store
// shape. Coverage (migrated, not dropped): reserved OFF/LEAVE locked, working-time
// persist + derivation, the #6-equal / #7-partial grid rejections, clear-working-
// time-on-edit, bare-duration preservation on an unrelated edit, keyboard reorder,
// and the shared Shift-groups duplicate. The Min/Preferred staffing tie-in is DR-4
// and is intentionally NOT covered here (a shift card without staffing is an intended
// intermediate). Pure-logic parity is pinned in components/shift-types/*.test.tsx and
// components/entity-editor/core/*.test.ts (vitest).

type ShiftRow = {
  id: unknown;
  description?: string;
  startTime?: string;
  endTime?: string;
  restMinutes?: number;
  durationMinutes?: number;
};
type StoreState = Record<string, unknown> & {
  shifts?: ShiftRow[];
  shiftGroups?: { id: string; members: unknown[] }[];
  cardsByKind?: {
    requirements: Array<{
      uid: string;
      shiftType: unknown;
      requiredNumPeople: number;
      preferredNumPeople?: number;
      qualifiedPeople?: unknown;
      date?: unknown;
      weight: number;
    }>;
  };
};

type NsWindow = {
  __nsStore: {
    scenario: {
      getState: () => StoreState & { mutateScenario: (patch: Record<string, unknown>) => void };
      temporal: {
        getState: () => { pastStates: unknown[]; futureStates: unknown[] };
      };
    };
  };
};

/** Type-tagged presentation key (mirror core `entityKey`) for building test ids. */
const sk = (id: string) => `string:${id}`;

function readState(page: Page) {
  return page.evaluate(() => (window as unknown as NsWindow).__nsStore.scenario.getState());
}
async function readShifts(page: Page) {
  return (await readState(page)).shifts ?? [];
}
async function readShiftGroups(page: Page) {
  return (await readState(page)).shiftGroups ?? [];
}
async function readRequirements(page: Page) {
  return (await readState(page)).cardsByKind?.requirements ?? [];
}
async function readHistoryLength(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().pastStates.length,
  );
}

/** Seed the durable store directly (the grid's store is the same singleton). */
async function seed(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}

test.describe.serial("DR-3 Shifts card-grid", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("OFF/LEAVE reserved cards render locked; adding a clock shift persists working time", async ({
    page,
  }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
    await expect(page.getByTestId("synthetic-OFF")).toBeVisible();
    await expect(page.getByTestId("synthetic-LEAVE")).toBeVisible();
    // Reserved cards show a lock + reason, never a raw editable/disabled control.
    await expect(page.getByTestId("synthetic-OFF-reason")).toBeVisible();
    await expect(page.getByTestId("shift-edit-OFF")).toHaveCount(0);

    await page.getByTestId("add-shift-toggle").click();
    await page.getByTestId("shift-add-code").fill("Day");
    await page.getByTestId("shift-add-start").selectOption("08:00");
    await page.getByTestId("shift-add-end").selectOption("16:00");
    // Working(auto) derivation is visible whenever start+end are set.
    await expect(page.getByTestId("shift-add-duration")).toContainText("8h");
    await page.getByTestId("shift-add-save").click();

    await expect(page.getByTestId(`shift-card-${sk("Day")}`)).toBeVisible();
    expect((await readShifts(page)).find((s) => s.id === "Day")).toMatchObject({
      id: "Day",
      startTime: "08:00",
      endTime: "16:00",
      durationMinutes: 480,
    });
  });

  test("grid rejections — #6 equal start/end and #7 partial clock block save", async ({ page }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();

    await page.getByTestId("add-shift-toggle").click();
    await page.getByTestId("shift-add-code").fill("Bad");
    await page.getByTestId("shift-add-start").selectOption("09:00");
    await page.getByTestId("shift-add-end").selectOption("09:00");
    await expect(page.getByText(/must differ/i)).toBeVisible();
    await expect(page.getByTestId("shift-add-save")).toBeDisabled();

    await page.getByTestId("shift-add-end").selectOption("");
    await expect(page.getByText(/provided together/i)).toBeVisible();
    await expect(page.getByTestId("shift-add-save")).toBeDisabled();
  });

  test("clearing working time on edit persists as removal", async ({ page }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
    await seed(page, {
      shifts: [{ id: "Day", startTime: "08:00", endTime: "16:00", durationMinutes: 480 }],
      shiftGroups: [],
    });

    await page.getByTestId(`shift-edit-${sk("Day")}`).click();
    await page.getByTestId(`shift-edit-${sk("Day")}-start`).selectOption("");
    await page.getByTestId(`shift-edit-${sk("Day")}-end`).selectOption("");
    await page.getByTestId(`shift-edit-${sk("Day")}-save`).click();

    const day = (await readShifts(page)).find((s) => s.id === "Day");
    expect(day?.startTime ?? null).toBeNull();
    expect(day?.endTime ?? null).toBeNull();
    expect(day?.durationMinutes ?? null).toBeNull();
    expect(day?.restMinutes ?? null).toBeNull();
  });

  test("a loaded bare-duration shift survives an unrelated edit (DL10-D4 guardrail)", async ({
    page,
  }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
    // A valid producer shape: bare durationMinutes, NO clocks (spec 01 accepts it).
    await seed(page, { shifts: [{ id: "Flex", durationMinutes: 480 }], shiftGroups: [] });

    await page.getByTestId(`shift-edit-${sk("Flex")}`).click();
    await page.getByTestId(`shift-edit-${sk("Flex")}-name`).fill("Flexible shift");
    await page.getByTestId(`shift-edit-${sk("Flex")}-save`).click();

    const flex = (await readShifts(page)).find((s) => s.id === "Flex");
    expect(flex?.durationMinutes).toBe(480); // preserved, not force-cleared
    expect(flex?.startTime ?? null).toBeNull(); // no clocks injected
    expect(flex?.endTime ?? null).toBeNull();
    expect(flex?.description).toBe("Flexible shift");
  });

  test("keyboard reorder (Up/Down) moves the durable order", async ({ page }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
    await seed(page, {
      shifts: [{ id: "A" }, { id: "B" }, { id: "C" }],
      shiftGroups: [],
    });

    await expect(page.getByTestId(`shift-move-up-${sk("A")}`)).toBeDisabled();
    await page.getByTestId(`shift-move-down-${sk("A")}`).click();
    await expect
      .poll(async () => (await readShifts(page)).map((s) => s.id))
      .toEqual(["B", "A", "C"]);
  });

  test("shift group duplicate keeps members", async ({ page }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
    await seed(page, {
      shifts: [{ id: "Day" }, { id: "Night" }],
      shiftGroups: [{ id: "Working", members: ["Day", "Night"] }],
    });

    await page.getByTestId("group-dup-Working").click();
    await expect(page.getByTestId("group-row-Working copy")).toBeVisible();
    expect((await readShiftGroups(page)).find((g) => g.id === "Working copy")?.members).toEqual([
      "Day",
      "Night",
    ]);
  });

  test("staffing flow creates one shared rule, then rename + collapse stays atomic", async ({
    page,
  }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();

    await page.getByTestId("add-shift-toggle").click();
    await page.getByTestId("shift-add-code").fill("Day");
    await page.getByTestId("shift-add-required").fill("2");
    await page.getByTestId("shift-add-preferred").fill("3");
    await page.getByTestId("shift-add-save").click();

    await expect(page.getByTestId(`staffing-min-${sk("Day")}`)).toHaveText("2");
    expect((await readRequirements(page))[0]).toMatchObject({
      shiftType: ["Day"],
      qualifiedPeople: ["ALL"],
      date: ["ALL"],
      requiredNumPeople: 2,
      preferredNumPeople: 3,
      weight: -50,
    });

    const before = await readHistoryLength(page);
    await page.getByTestId(`shift-edit-${sk("Day")}`).click();
    await page.getByTestId(`shift-edit-${sk("Day")}-code`).fill("AM");
    await page.getByTestId(`shift-edit-${sk("Day")}-required`).fill("4");
    await page.getByTestId(`shift-edit-${sk("Day")}-preferred`).fill("4");
    await expect(page.getByTestId(`shift-edit-${sk("Day")}-preferred-collapse`)).toContainText(
      "weight reset from -50 to -1",
    );
    await page.getByTestId(`shift-edit-${sk("Day")}-save`).click();

    expect(await readHistoryLength(page)).toBe(before + 1);
    expect((await readShifts(page)).map((shift) => shift.id)).toEqual(["AM"]);
    expect((await readRequirements(page))[0]).toMatchObject({
      shiftType: ["AM"],
      requiredNumPeople: 4,
      weight: -1,
    });
    expect((await readRequirements(page))[0].preferredNumPeople).toBeUndefined();
  });
});

// Layout guard for the Time-on-floor clock row, which only over-subscribes in its
// COMPOSED state: an overnight shift adds the "+1 day" badge beside the two clock
// selects, and each select carries the shared Select's caret gutter. At the widths
// where the card grid is 3-up the children then want more than one line.
//
// This lives in e2e and not vitest because the assertion IS layout — wrapping,
// overflow and text clipping are all resolved by the engine against the real
// stylesheet, and jsdom computes none of it. The failure mode is silent and visual
// (a select pushed past the card edge, or digits chopped off a time with no ellipsis
// to warn you), so nothing else in the suite goes red when it breaks.
//
// The row overflowed for overnight shifts even before the caret gutter existed; the
// gutter only made it unmissable. Assertions are on the invariant — nothing escapes
// the row, no glyphs are clipped — rather than on `flex-wrap` specifically, so a
// future fix that stacks the row differently still passes.
test.describe("DR-5 shift card — the overnight clock row wraps instead of overflowing", () => {
  // 1100 is where the card grid turns 3-up (the prototype's ns-grid3 ladder), so
  // 1100–1280 is the narrowest a card gets. Density used to inflate this row at
  // the larger end of its range; the knob is gone (bmw.8) and the 0.9 baseline
  // is baked as literals in globals.css, so the guard now runs once per width at
  // that single scale.
  const WIDTHS = [1100, 1150, 1280];

  for (const width of WIDTHS) {
    test(`${width}px`, async ({ page }, testInfo) => {
      testInfo.setTimeout(30_000);
      await page.setViewportSize({ width, height: 1300 });
      await page.goto("/shift-types");
      await expect(page.getByTestId("add-shift-toggle")).toBeVisible();

      await page.getByTestId("add-shift-toggle").click();
      await page.getByTestId("shift-add-code").fill("Night");
      // end <= start is the overnight case, which is what summons the badge.
      await page.getByTestId("shift-add-start").selectOption("19:00");
      await page.getByTestId("shift-add-end").selectOption("07:00");

      const row = page.getByTestId("shift-add-clocks");
      // Guard the premise: without the badge this row is not the composed state
      // the test exists for, and every assertion below would pass trivially.
      await expect(row.getByText("+1 day")).toBeVisible();

      const geometry = await row.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const children = [...el.children];
        const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
        return {
          rowWidth: box.width,
          // What the children would need laid out on ONE line.
          oneLineNeed:
            children.reduce((sum, c) => sum + c.getBoundingClientRect().width, 0) +
            gap * (children.length - 1),
          lineCount: new Set(children.map((c) => Math.round(c.getBoundingClientRect().top))).size,
          escapes: children
            .filter((c) => c.getBoundingClientRect().right > box.right + 1)
            .map((c) => c.getAttribute("data-testid") ?? c.textContent?.trim() ?? "?"),
          overflows: el.scrollWidth > el.clientWidth + 1,
          // A select whose text is wider than its content box chops glyphs with no
          // ellipsis — the failure mode of "shrink instead of wrap".
          clipped: [...el.querySelectorAll("select")]
            .filter((s) => s.scrollWidth > s.clientWidth + 1)
            .map((s) => s.getAttribute("data-testid") ?? "?"),
        };
      });

      expect(geometry.escapes, "no child may extend past the row").toEqual([]);
      expect(geometry.overflows, "the row must not overflow").toBe(false);
      expect(geometry.clipped, "no clock select may clip its time").toEqual([]);

      // Prove the test is in the regime it was written for: where one line is not
      // enough, the row must actually have taken a second one. Asserted only when
      // the arithmetic demands it, since the widest band still fits on one line.
      if (geometry.oneLineNeed > geometry.rowWidth + 1) {
        expect(
          geometry.lineCount,
          `children need ${Math.round(geometry.oneLineNeed)}px in a ${Math.round(
            geometry.rowWidth,
          )}px row, so the row must wrap`,
        ).toBeGreaterThan(1);
      }
    });
  }
});
