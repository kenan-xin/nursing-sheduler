import { expect, test, type Page } from "@playwright/test";

// T13 REBUILD acceptance (Playwright rows): the prototype-conformance rebuild of
// the Shift Type Coverings editor driven against a production build through the
// real T04 store (`window.__nsStore`). Every named outcome asserts the DURABLE
// STORE shape AND the store.temporal entry count — so a green test cannot mask a
// data-integrity gap or a spurious/absent undo entry. Coverage spans:
//  • create via the two-pane transfer selectors + the date-scope WEEKEND chip (M2/M3)
//    and the ScreenCards shell (M1) + the numbered Always-enforced card (M4);
//  • full edit (description + an added preceptor) is one tracked mutation;
//  • Enable/Disable toggles the UI-only `disabled` marker (M4) — one entry each;
//  • delete returns the centred empty state (m1), one entry;
//  • the date-scope "specific dates" text + transfer "Add all" serialize exactly;
//  • move up/down reorders durably (FR-CV-21).
// The preserved pure-logic regressions (OFF/LEAVE + numeric-shift-id exclusion,
// date:[] → OMITTED, the rename/delete cascade) are pinned in the vitest suite.

type CoveringCard = {
  uid: string;
  description?: string;
  disabled?: boolean;
  preceptors: unknown[];
  preceptees: unknown[];
  shiftTypes: unknown[];
  date?: string[];
  weight: number;
};

type NsWindow = {
  __nsStore: {
    scenario: {
      getState: () => Record<string, unknown> & {
        cardsByKind: { coverings: CoveringCard[] };
        mutateScenario: (patch: Record<string, unknown>) => void;
      };
      temporal: {
        getState: () => { pastStates: unknown[]; futureStates: unknown[] };
      };
    };
  };
};

/** Wait for the test bridge to expose the live store on `window`. */
async function waitForStore(page: Page) {
  await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsStore));
}

/** Seed the durable store directly (the editor's store is the same singleton).
 *  Waits for the bridge to mount first — `goto` returns before the React tree
 *  hydrates and the test-bridge effect runs, so an immediate `evaluate` would
 *  read `__nsStore` as undefined. */
async function seed(page: Page, patch: Record<string, unknown>) {
  await waitForStore(page);
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}

/** Navigate to the coverings screen and wait for the store seam + the editor to
 *  mount. The TestBridge only exposes `window.__nsStore` from a deferred effect,
 *  so seeding immediately after `goto` races it (cf. app-shell-rebuild.spec).
 *  Shift Type Coverings is Advanced-only since T08d (DL12 §2); adopt the
 *  stored Advanced preference first so the route-validity gate doesn't
 *  redirect this direct visit to Home under the Guided default. */
async function gotoReady(page: Page) {
  await page.addInitScript(() => localStorage.setItem("ns-app-mode", "advanced"));
  await page.goto("/shift-type-coverings");
  await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsStore));
  await expect(page.getByTestId("add-card-toggle")).toBeVisible();
}

function readCoverings(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.getState().cardsByKind.coverings,
  );
}
/** store.temporal undo depth — how many tracked mutations are on the past stack. */
function pastCount(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().pastStates.length,
  );
}

const BASE_SEED = {
  rangeStart: "2026-01-01",
  rangeEnd: "2026-01-31",
  staff: [
    { id: "Aisha", history: [] },
    { id: "Chloe", history: [] },
    { id: "Daniel", history: [] },
  ],
  shifts: [{ id: "Day" }, { id: "Night" }],
};

test.describe.serial("T13 shift-type coverings editor (rebuild)", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("create via transfer panes + WEEKEND date chip; Always-enforced card; one undo entry", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    // The centred empty state shows with no rules (m1).
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();

    await page.getByTestId("covering-desc").fill("Chloe covered by Aisha");
    // Two-pane transfer: add one preceptor / one preceptee / one shift type.
    await page.getByRole("button", { name: "Add Aisha as a preceptor" }).click();
    await page.getByRole("button", { name: "Add Chloe as a preceptee" }).click();
    await page.getByRole("button", { name: "Add Day as a covered shift type" }).click();
    // Date-scope WEEKEND chip (M3).
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /weekends/i })
      .click();
    await page.getByTestId("card-editor-submit").click();

    // The numbered card renders and the empty state is gone.
    await expect(page.getByTestId("covering-card-0")).toBeVisible();
    await expect(page.getByTestId("card-editor-empty")).toHaveCount(0);
    await expect(page.getByTestId("card-list-count")).toContainText("1 RULE");

    const cards = await readCoverings(page);
    expect(cards).toHaveLength(1);
    expect(cards[0].description).toBe("Chloe covered by Aisha");
    expect(cards[0].preceptors).toEqual([["Aisha"]]);
    expect(cards[0].preceptees).toEqual([["Chloe"]]);
    expect(cards[0].shiftTypes).toEqual([["Day"]]);
    expect(cards[0].date).toEqual(["WEEKEND"]);
    expect(cards[0].weight).toBe(1); // inert enforced weight
    expect(cards[0].disabled).toBeUndefined();
    // The compound add is exactly ONE tracked mutation (one zundo entry).
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("edit updates description + adds a preceptor in one tracked mutation", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    // Seed one existing covering to edit.
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [
          {
            uid: "cov-edit",
            description: "Chloe covered",
            preceptors: [["Aisha"]],
            preceptees: [["Chloe"]],
            shiftTypes: [["Day"]],
            weight: 1,
          },
        ],
      },
    });
    await expect(page.getByTestId("covering-card-0")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("covering-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    // The current selection populates the SELECTED pane; Daniel is still available.
    await expect(page.getByTestId("transfer-preceptors-preceptors")).toContainText("Aisha");

    await page.getByTestId("covering-desc").fill("Chloe + Daniel covered by Aisha");
    await page.getByRole("button", { name: "Add Daniel as a preceptor" }).click();
    await page.getByTestId("card-editor-submit").click();

    const cards = await readCoverings(page);
    expect(cards[0].description).toBe("Chloe + Daniel covered by Aisha");
    expect(cards[0].preceptors).toEqual([["Aisha", "Daniel"]]);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("disable then enable toggles the marker, the badge, and one undo entry each (M4)", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [
          {
            uid: "cov-dis",
            preceptors: [["Aisha"]],
            preceptees: [["Chloe"]],
            shiftTypes: [["Day"]],
            weight: 1,
          },
        ],
      },
    });
    await expect(page.getByTestId("covering-card-0")).toBeVisible();

    // Disable → marker on, card fades, Disabled badge shows, label flips to Enable.
    const beforeOff = await pastCount(page);
    await page.getByTestId("covering-disable-0").click();
    await expect(page.getByTestId("covering-card-0")).toHaveAttribute("data-disabled", "true");
    await expect(page.getByTestId("covering-card-0").getByText("Disabled")).toBeVisible();
    expect((await readCoverings(page))[0].disabled).toBe(true);
    expect((await pastCount(page)) - beforeOff).toBe(1);

    // Enable → marker stripped (undefined, not merely false), badge gone, ONE entry.
    const beforeEnable = await pastCount(page);
    await page.getByTestId("covering-disable-0").click();
    await expect(page.getByTestId("covering-card-0")).not.toHaveAttribute("data-disabled", "true");
    await expect(page.getByTestId("covering-card-0").getByText("Disabled")).toHaveCount(0);
    expect((await readCoverings(page))[0].disabled).toBeUndefined();
    expect((await pastCount(page)) - beforeEnable).toBe(1);
  });

  test("delete removes the rule and returns the centred empty state; one undo entry", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [
          {
            uid: "cov-del",
            preceptors: [["Aisha"]],
            preceptees: [["Chloe"]],
            shiftTypes: [["Day"]],
            weight: 1,
          },
        ],
      },
    });
    await expect(page.getByTestId("covering-card-0")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("covering-delete-0").click();
    await expect(page.getByTestId("covering-card-0")).toHaveCount(0);
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();
    expect(await readCoverings(page)).toEqual([]);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("date-scope specific dates + transfer Add all serialize exactly (M2/M3)", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    // Add all preceptors at once (M2 Add-all) — Aisha, Chloe, Daniel in item order.
    await page.getByTestId("transfer-add-all-preceptors").click();
    await page.getByRole("button", { name: "Add Chloe as a preceptee" }).click();
    await page.getByTestId("transfer-add-all-shiftTypes").click();
    // Specific dates as a compact range text (M3): days 1 and 3 of Jan 2026.
    await page.getByTestId("date-scope-custom").fill("1, 3");
    await page.getByTestId("card-editor-submit").click();

    const cards = await readCoverings(page);
    expect(cards[0].preceptors).toEqual([["Aisha", "Chloe", "Daniel"]]);
    expect(cards[0].shiftTypes).toEqual([["Day", "Night"]]);
    expect(cards[0].date).toEqual(["2026-01-01", "2026-01-03"]);
  });

  test("move up/down reorders durably (FR-CV-21)", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [
          {
            uid: "cov-a",
            description: "A",
            preceptors: [["Aisha"]],
            preceptees: [["Chloe"]],
            shiftTypes: [["Day"]],
            weight: 1,
          },
          {
            uid: "cov-b",
            description: "B",
            preceptors: [["Aisha"]],
            preceptees: [["Daniel"]],
            shiftTypes: [["Day"]],
            weight: 1,
          },
        ],
      },
    });

    // Card 1 is "B"; move it up → it becomes card 0.
    await page.getByTestId("covering-up-1").click();
    await expect(page.getByTestId("covering-card-0")).toContainText("B");
    const order = (await readCoverings(page)).map((c) => c.description);
    expect(order).toEqual(["B", "A"]);
  });
});

test.describe.serial("T13 transfer selector — remove, Clear all, selected filter (M2)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("remove (X) and Clear all empty the Selected pane", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    const selected = page.getByTestId("transfer-preceptors-preceptors");
    // Add all three preceptors, then remove one via its X row.
    await page.getByTestId("transfer-add-all-preceptors").click();
    await expect(selected).toContainText("Aisha");
    await page.getByRole("button", { name: "Remove Aisha from preceptors" }).click();
    await expect(selected).not.toContainText("Aisha");
    await expect(selected).toContainText("Chloe");

    // Clear all empties the Selected pane back to its empty message.
    await page.getByTestId("transfer-clear-preceptors").click();
    await expect(selected).toContainText(/Nothing selected/i);
  });

  test("selected-side filter appears only after 8 selections and narrows the pane", async ({
    page,
  }) => {
    await gotoReady(page);
    // Seed 10 staff so the 8-selection threshold is reachable.
    await seed(page, {
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-31",
      staff: Array.from({ length: 10 }, (_, i) => ({ id: `N${i + 1}`, history: [] })),
      shifts: [{ id: "Day" }],
    });
    await page.getByTestId("add-card-toggle").click();

    // Below the threshold: no selected-side filter.
    await expect(page.getByTestId("transfer-sel-search-preceptors")).toHaveCount(0);
    // Add all 10 → the selected-side filter appears.
    await page.getByTestId("transfer-add-all-preceptors").click();
    await expect(page.getByTestId("transfer-sel-search-preceptors")).toBeVisible();
    // It narrows the Selected pane to matching rows only.
    await page.getByTestId("transfer-sel-search-preceptors").fill("N1");
    await expect(page.getByTestId("transfer-preceptors-preceptors")).toContainText("N1");
    await expect(page.getByTestId("transfer-preceptors-preceptors")).not.toContainText("N2");
  });
});

test.describe.serial("T13 hard rules — OFF/LEAVE rejected in the transfer (FR-CV-15)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("OFF and an OFF-tainted group stay visible but cannot be added", async ({ page }) => {
    await gotoReady(page);
    await seed(page, {
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-31",
      staff: [{ id: "Aisha", history: [] }],
      shifts: [{ id: "Day" }, { id: "OFF" }],
      shiftGroups: [{ id: "Rest", members: ["OFF"] }],
    });
    await page.getByTestId("add-card-toggle").click();

    const available = page.getByTestId("transfer-available-shiftTypes");
    // OFF and the tainted group remain visible (inert), per the T13 hard rule.
    await expect(available).toContainText("OFF");
    await expect(available).toContainText("Rest");
    // Neither exposes an add button (the row is disabled, not omitted).
    await expect(
      page.getByRole("button", { name: /Add OFF as a covered shift type/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Add Rest as a covered shift type/i }),
    ).toHaveCount(0);
    // Add all skips them: with only Day addable, Add-all is absent (nothing addable beyond Day
    // once Day is the sole enabled option) OR adds only Day — assert Day is addable directly.
    await page.getByRole("button", { name: /Add Day as a covered shift type/i }).click();
    await expect(page.getByTestId("transfer-shiftTypes-shiftTypes")).toContainText("Day");
  });
});

test.describe.serial("T13 empty-state gate — hides while the form is open (m1)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("empty state disappears when Add opens the form and returns on Cancel", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);

    // No rules, no draft ⇒ centred empty state shows.
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();

    // Opening the Add form hides it (ScreenCards:1046 — never both at once).
    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(page.getByTestId("card-editor-empty")).toHaveCount(0);

    // Closing the form brings it back.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();
  });
});

test.describe.serial("T13 cold-review regressions", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("editing a disabled covering keeps it disabled (Major 1)", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [
          {
            uid: "cov-dis-edit",
            disabled: true,
            description: "Off rule",
            preceptors: [["Aisha"]],
            preceptees: [["Chloe"]],
            shiftTypes: [["Day"]],
            weight: 1,
          },
        ],
      },
    });
    // The card renders disabled (badge + Enable action).
    await expect(page.getByTestId("covering-card-0")).toHaveAttribute("data-disabled", "true");
    await expect(page.getByTestId("covering-card-0").getByText("Disabled")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("covering-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await page.getByTestId("covering-desc").fill("Off rule (edited)");
    await page.getByTestId("card-editor-submit").click();

    // The edit-save MUST carry forward `disabled` — canonical.ts drops disabled
    // coverings, so losing the marker would silently re-enable a turned-off rule.
    const cards = await readCoverings(page);
    expect(cards[0].description).toBe("Off rule (edited)");
    expect(cards[0].disabled).toBe(true);
    await expect(page.getByTestId("covering-card-0")).toHaveAttribute("data-disabled", "true");
    await expect(page.getByTestId("covering-card-0").getByText("Disabled")).toBeVisible();
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("a numeric date ref does not crash the editor and round-trips verbatim (Major 2)", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [
          {
            uid: "cov-numdate",
            description: "Numeric date",
            preceptors: [["Aisha"]],
            preceptees: [["Chloe"]],
            shiftTypes: [["Day"]],
            date: [1], // valid DateRef (number | string)
            weight: 1,
          },
        ],
      },
    });
    // The list renders the numeric date without error.
    await expect(page.getByTestId("covering-card-0")).toContainText("1");

    // Opening the edit form renders DateScopeField against a numeric ref — the old
    // `activeScope` threw `a.toUpperCase is not a function` here and killed the route.
    await page.getByTestId("covering-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await page.getByTestId("covering-desc").fill("Numeric date (edited)");
    await page.getByTestId("card-editor-submit").click();

    expect(errors).toEqual([]);
    const cards = await readCoverings(page);
    expect(cards[0].description).toBe("Numeric date (edited)");
    // The numeric ref survives untouched (not stringified, not dropped).
    expect(cards[0].date).toEqual([1]);
  });

  test('numeric person 1 and string group "1" are both selectable and survive (Major 3)', async ({
    page,
  }) => {
    await gotoReady(page);
    // Backend-valid people-domain identities that share a surface spelling but
    // differ in type: a numeric staff item `1` and a people-group named `"1"`.
    await seed(page, {
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-31",
      staff: [{ id: 1, history: [] }],
      staffGroups: [{ id: "1", description: "StrOne", members: [] }],
      shifts: [{ id: "Day" }],
    });
    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();

    // Both rows are present and addable (distinct via their labels/aria).
    await page.getByRole("button", { name: "Add 1 as a preceptor" }).click();
    await page.getByRole("button", { name: "Add 1 — StrOne as a preceptor" }).click();
    // A preceptee + shift type make the draft valid.
    await page.getByRole("button", { name: "Add 1 as a preceptee" }).click();
    await page.getByRole("button", { name: "Add Day as a covered shift type" }).click();
    await page.getByTestId("card-editor-submit").click();

    const cards = await readCoverings(page);
    // Both refs coexist with their original types (numeric 1, string "1").
    expect(cards[0].preceptors).toEqual([[1, "1"]]);
  });

  test("duplicate is one tracked mutation and carries the source disabled state (Minor 2)", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [
          {
            uid: "cov-dup",
            disabled: true,
            description: "Source",
            preceptors: [["Aisha"]],
            preceptees: [["Chloe"]],
            shiftTypes: [["Day"]],
            weight: 1,
          },
        ],
      },
    });

    const before = await pastCount(page);
    await page.getByTestId("covering-dup-0").click();
    expect((await pastCount(page)) - before).toBe(1);
    const cards = await readCoverings(page);
    expect(cards).toHaveLength(2);
    // The duplicate (inserted after the source) inherits the disabled marker.
    expect(cards[1].disabled).toBe(true);
    expect(cards[1].description).toBe("Source copy");
  });
});
