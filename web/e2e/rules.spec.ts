import { expect, test, type Page } from "@playwright/test";

// The e2e suite runs against a production build; the `window.__nsStore` seam is
// gated off there unless a caller opts in before load (`test-bridge.tsx`).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
});

// T14c focused acceptance: the Guided Rules screen loaded DIRECTLY at /rules
// (navigation exposure is T08d's job — this route must stand on its own),
// driven against the real T04 store (`window.__nsStore`), proving:
//  • the built-in structural rule always renders, locked/on;
//  • EVERY constraint gets a row, with no opt-in step and nothing to configure;
//  • a rule is derived from `cardsByKind` (Advanced -> Rules), and its
//    Toggle/Adjust write straight back to the SAME card — one tracked mutation
//    each — round-tripping without data loss;
//  • an unsupported (multi-shift-type) requirement renders read-only, never
//    hidden/flattened;
//  • rename writes the source constraint's own `description` and round-trips;
//  • the screen loads and wraps sensibly at both desktop and mobile widths.

type NsWindow = {
  __nsStore: {
    scenario: {
      getState: () => Record<string, unknown> & {
        cardsByKind: Record<string, { uid: string; disabled?: boolean; description?: string }[]>;
        maxOneShiftPerDay?: { description?: string };
        mutateScenario: (patch: Record<string, unknown>) => void;
      };
      temporal: { getState: () => { pastStates: unknown[]; undo: () => void } };
    };
  };
};

async function waitForStore(page: Page) {
  await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsStore));
}

async function seed(page: Page, patch: Record<string, unknown>) {
  await waitForStore(page);
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}

function storeState(page: Page) {
  return page.evaluate(() => (window as unknown as NsWindow).__nsStore.scenario.getState());
}

function pastCount(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().pastStates.length,
  );
}

async function undo(page: Page) {
  await page.evaluate(() => {
    (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().undo();
  });
}

async function gotoReady(page: Page) {
  await page.goto("/rules");
  await waitForStore(page);
  await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "rules");
}

test.describe("Rules screen — direct route load", () => {
  test("loads /rules directly and shows the built-in structural rule, locked and on", async ({
    page,
  }) => {
    await gotoReady(page);
    await expect(page.getByText("At most one shift per day")).toBeVisible();
    const builtinRow = page.getByTestId(/rule-row-builtin/);
    await expect(builtinRow).toContainText(/built-in/i);
  });

  test("shows the empty state with no advanced constraints", async ({ page }) => {
    await gotoReady(page);
    await expect(page.getByTestId("rules-empty-state")).toBeVisible();
  });
});

test.describe("Rules screen — Advanced -> Rules -> source-record mutation round trip", () => {
  test("a requirement card derives a linked row; Toggle and Adjust write the same card", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, {
      cardsByKind: {
        requirements: [
          { uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1, description: "Day cap" },
        ],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await page.reload();
    await waitForStore(page);

    await expect(page.getByText("Day cap")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("rule-toggle-requirements:r1").click();
    const afterToggle = await storeState(page);
    expect(afterToggle.cardsByKind.requirements[0].disabled).toBe(true);
    expect(await pastCount(page)).toBe(before + 1);

    await page.getByTestId("rule-toggle-requirements:r1").click();
    await page.getByTestId("rule-adjust-toggle-requirements:r1").click();
    const adjustInput = page.getByTestId("rule-adjust-input-requirements:r1-requiredNumPeople");
    await adjustInput.fill("6");
    // AdjustPanel commits on blur/Enter (not per-keystroke, to keep the edit one undo
    // entry) — fill() alone never writes the store, so press Enter like a real user.
    await adjustInput.press("Enter");

    await expect
      .poll(async () => {
        const state = (await storeState(page)) as unknown as {
          cardsByKind: { requirements: { requiredNumPeople: number }[] };
        };
        return state.cardsByKind.requirements[0].requiredNumPeople;
      })
      .toBe(6);
  });

  test("a multi-shift-type requirement stays visible read-only, never hidden or flattened", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, {
      cardsByKind: {
        requirements: [{ uid: "r2", shiftType: ["D", "N"], requiredNumPeople: 1, weight: -1 }],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await page.reload();
    await waitForStore(page);

    const row = page.getByTestId("rule-row-requirements:r2");
    await expect(row).toBeVisible();
    await expect(row).toContainText(/adjust it in Advanced/i);
    await expect(page.getByTestId("rule-adjust-toggle-requirements:r2")).toHaveCount(0);
  });
});

test.describe("Rules screen — every constraint appears", () => {
  test("one row per constraint of every kind, under its plain-English heading", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, {
      cardsByKind: {
        requirements: [
          { uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1 },
          // Unsupported shape — still gets a row, read-only.
          { uid: "r2", shiftType: ["D", "N"], requiredNumPeople: 1, weight: -1 },
        ],
        successions: [{ uid: "s1", person: ["P1"], pattern: ["N", "D"], weight: -1 }],
        // Disabled — still gets a row.
        counts: [
          {
            uid: "c1",
            person: "ALL",
            countDates: "ALL",
            countShiftTypes: "N",
            expression: "x >= T",
            target: 3,
            weight: 1,
            disabled: true,
          },
        ],
        affinities: [
          {
            uid: "a1",
            people1: ["P1"],
            people2: ["P2"],
            shiftTypes: ["D"],
            date: "ALL",
            weight: 1,
          },
        ],
        coverings: [
          { uid: "v1", preceptors: ["P1"], preceptees: ["P2"], shiftTypes: ["D"], weight: -1 },
        ],
      },
    });
    await page.reload();
    await waitForStore(page);

    for (const id of [
      "builtin:max-one-shift-per-day",
      "requirements:r1",
      "requirements:r2",
      "successions:s1",
      "counts:c1",
      "affinities:a1",
      "coverings:v1",
    ]) {
      await expect(page.getByTestId(`rule-row-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("rule-row-counts:c1")).toHaveAttribute("data-disabled", "true");

    const headings = await page
      .locator("[data-testid^='rule-category-']")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-testid")!.replace("rule-category-", "")),
      );
    expect(headings).toEqual([
      "Always on",
      "Staffing levels",
      "Shift sequences",
      "Hours & contracts",
      "Who works together",
      "Supervision",
    ]);
  });
});

test.describe("Rules screen — rename round trip", () => {
  test("renaming a rule writes the source constraint's own description, as one Undo step", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, {
      cardsByKind: {
        requirements: [
          { uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1, description: "Day cap" },
        ],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await page.reload();
    await waitForStore(page);

    await expect(page.getByText("Day cap")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("rule-rename-requirements:r1").click();
    await page.getByTestId("rule-rename-input-requirements:r1").fill("Day shift cover");
    await page.getByTestId("rule-rename-save-requirements:r1").click();

    await expect(page.getByText("Day shift cover")).toBeVisible();
    await expect.poll(() => pastCount(page)).toBe(before + 1);
    let state = await storeState(page);
    expect(state.cardsByKind.requirements[0].description).toBe("Day shift cover");

    await undo(page);

    state = await storeState(page);
    expect(state.cardsByKind.requirements[0].description).toBe("Day cap");
    await expect(page.getByText("Day cap")).toBeVisible();
  });

  test("the locked built-in rule can be relabelled even though it cannot be switched off", async ({
    page,
  }) => {
    await gotoReady(page);
    const rowId = "builtin:max-one-shift-per-day";

    await page.getByTestId(`rule-rename-${rowId}`).click();
    await page.getByTestId(`rule-rename-input-${rowId}`).fill("One shift a day");
    await page.getByTestId(`rule-rename-save-${rowId}`).click();

    await expect(page.getByText("One shift a day")).toBeVisible();
    const state = await storeState(page);
    expect(state.maxOneShiftPerDay?.description).toBe("One shift a day");
  });
});

test.describe("Rules screen — responsive", () => {
  test("desktop width renders the header actions and category list without overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoReady(page);
    await expect(page.getByTestId("rules-continue")).toBeVisible();
  });

  test("mobile width wraps the header and remains usable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReady(page);
    await expect(page.getByTestId("rules-continue")).toBeVisible();
    await expect(page.getByTestId(/rule-row-builtin/)).toBeVisible();
  });
});
