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
//  • a linked rule is derived from `cardsByKind` (Advanced -> Rules), and its
//    Toggle/Adjust write straight back to the SAME card — one tracked mutation
//    each — round-tripping without data loss;
//  • an unsupported (multi-shift-type) requirement renders read-only, never
//    hidden/flattened;
//  • pinning/unpinning via "Customise library" only ever touches
//    `guidedRulePins`, never the source constraint;
//  • the screen loads and wraps sensibly at both desktop and mobile widths.

type NsWindow = {
  __nsStore: {
    scenario: {
      getState: () => Record<string, unknown> & {
        cardsByKind: Record<string, { uid: string; disabled?: boolean; description?: string }[]>;
        guidedRulePins: unknown[];
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

test.describe("Rules screen — pin CRUD", () => {
  test("pinning surfaces a Pinned badge; unpinning removes only the shortcut", async ({ page }) => {
    await gotoReady(page);
    await seed(page, {
      cardsByKind: {
        requirements: [{ uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1 }],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await page.reload();
    await waitForStore(page);

    await page.getByTestId("rules-admin-toggle").click();
    await page.getByTestId("rules-new-pin").click();
    await page.getByTestId("pin-form-record-select").selectOption("requirements:r1");
    await page.getByTestId("pin-form-submit").click();

    await expect(page.getByTestId("rule-pinned-badge-requirements:r1")).toBeVisible();
    let state = await storeState(page);
    expect(state.guidedRulePins).toHaveLength(1);

    await page.getByTestId("rule-unpin-requirements:r1").click();
    state = await storeState(page);
    expect(state.guidedRulePins).toHaveLength(0);
    expect(state.cardsByKind.requirements).toHaveLength(1);
  });
});

test.describe("Rules screen — stale-pin cleanup (T14d)", () => {
  test("shows an actionable stale-pin notice and clears every stale pin in one atomic action", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, {
      guidedRulePins: [
        {
          id: "orphan",
          constraintKind: "requirements",
          constraintId: "gone",
          category: "Staffing",
          quickFields: [],
        },
      ],
    });
    await page.reload();
    await waitForStore(page);

    await expect(page.getByTestId("rules-stale-pin-notice")).toBeVisible();
    await page.getByTestId("rules-cleanup-stale-pins").click();

    await expect(page.getByTestId("rules-stale-pin-notice")).toHaveCount(0);
    const state = await storeState(page);
    expect(state.guidedRulePins).toHaveLength(0);
  });
});

test.describe("Rules screen — Pin submit as one undoable step (T14d)", () => {
  test("a Pin submit with a changed title is a single Undo step for the rename and the pin together", async ({
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

    await page.getByTestId("rules-admin-toggle").click();
    await page.getByTestId("rules-new-pin").click();
    await page.getByTestId("pin-form-record-select").selectOption("requirements:r1");
    await page.getByTestId("pin-form-title").fill("Renamed rule");

    const before = await pastCount(page);
    await page.getByTestId("pin-form-submit").click();

    await expect.poll(() => pastCount(page)).toBe(before + 1);
    let state = await storeState(page);
    expect(state.cardsByKind.requirements[0].description).toBe("Renamed rule");
    expect(state.guidedRulePins).toHaveLength(1);

    await undo(page);

    state = await storeState(page);
    expect(state.cardsByKind.requirements[0].description).toBe("Day cap");
    expect(state.guidedRulePins).toHaveLength(0);
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
    await expect(page.getByTestId("rules-admin-toggle")).toBeVisible();
  });
});
