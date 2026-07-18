import { expect, test, type Page } from "@playwright/test";

// T12 M1 clone acceptance (Playwright rows): the Shift Affinities editor driven
// against a production build through the real T04 store (`window.__nsStore`).
// Every named outcome asserts the DURABLE STORE shape AND the store.temporal
// entry count — so a green test cannot mask a data-integrity gap or a
// spurious/absent undo entry (mirrors counts.spec.ts / coverings.spec.ts rigor).
// Coverage spans:
//  • create via the People 1/People 2/Shift Types transfer selectors + the
//    date-scope WEEKEND chip + WeightField, one tracked mutation — asserting
//    the nested `people1`/`people2`/`shiftTypes` shape (canonical.ts parity
//    with Coverings) and the FLAT `date` list;
//  • full edit (description + weight) is one tracked mutation;
//  • Enable/Disable toggles the UI-only `disabled` marker — one entry each;
//  • delete returns the centred empty state, one entry;
//  • duplicate uses the unique-copy algorithm (FR-PR-13) and is one mutation;
//  • move up/down and pointer-half drag reorder (FR-PR-12) both reorder durably;
//  • all four selectors (People 1, People 2, Shift Types, Dates) are REQUIRED —
//    each blocks Save with its own verbatim message when empty;
//  • the ALL date-scope chip round-trips as the explicit `["ALL"]` keyword
//    (Dates is required here, unlike Coverings' optional date);
//  • weight has NO sign restriction (a negative or infinite weight is valid);
//  • numeric person `1` and string group `"1"` both survive with distinct
//    identity through the nested `people1` wrap;
//  • an open draft arms the navigation guard.

type AffinityCard = {
  uid: string;
  description?: string;
  disabled?: boolean;
  people1: unknown[];
  people2: unknown[];
  shiftTypes: unknown[];
  date: unknown[];
  weight: number;
};

type NsWindow = {
  __nsStore: {
    scenario: {
      getState: () => Record<string, unknown> & {
        cardsByKind: { affinities: AffinityCard[] };
        mutateScenario: (patch: Record<string, unknown>) => void;
        markSaved: () => void;
      };
      temporal: {
        getState: () => { pastStates: unknown[]; futureStates: unknown[] };
      };
    };
    isDirty: () => boolean;
  };
};

/** Wait for the test bridge to expose the live store on `window`. */
async function waitForStore(page: Page) {
  await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsStore));
}

/** Seed the durable store directly (the editor's store is the same singleton). */
async function seed(page: Page, patch: Record<string, unknown>) {
  await waitForStore(page);
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}

/** Navigate to the affinities screen and wait for the store seam + the editor.
 *  Shift Affinities is Advanced-only since T08d (DL12 §2); adopt the stored
 *  Advanced preference first so the route-validity gate doesn't redirect this
 *  direct visit to Home under the Guided default. */
async function gotoReady(page: Page) {
  await page.addInitScript(() => localStorage.setItem("ns-app-mode", "advanced"));
  await page.goto("/shift-affinities");
  await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsStore));
  await expect(page.getByTestId("add-card-toggle")).toBeVisible();
}

function readAffinities(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.getState().cardsByKind.affinities,
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
    { id: "Chloe", history: [] },
    { id: "Aisha", history: [] },
    { id: "Daniel", history: [] },
  ],
  shifts: [{ id: "Day" }, { id: "Night" }],
};

test.describe.serial("T12 shift affinities editor (M1 clone)", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("create via transfer panes + WEEKEND date chip + weight; nested shape; one undo entry", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    // The centred empty state shows with no rules (m1).
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();

    await page.getByTestId("affinity-desc").fill("Keep Chloe and Aisha together");
    await page.getByRole("button", { name: "Add Chloe to people 1" }).click();
    await page.getByRole("button", { name: "Add Aisha to people 2" }).click();
    await page.getByRole("button", { name: "Add Day to shift types" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /weekends/i })
      .click();
    await page.getByTestId("weight-field-input").fill("30");
    await page.getByTestId("card-editor-submit").click();

    // The numbered card renders and the empty state is gone.
    await expect(page.getByTestId("affinity-card-0")).toBeVisible();
    await expect(page.getByTestId("card-editor-empty")).toHaveCount(0);
    await expect(page.getByTestId("card-list-count")).toContainText("1 RULE");

    const cards = await readAffinities(page);
    expect(cards).toHaveLength(1);
    expect(cards[0].description).toBe("Keep Chloe and Aisha together");
    // Nested one-element-wrap shape — parity with Coverings' preceptors/preceptees.
    expect(cards[0].people1).toEqual([["Chloe"]]);
    expect(cards[0].people2).toEqual([["Aisha"]]);
    expect(cards[0].shiftTypes).toEqual([["Day"]]);
    // `date` is FLAT (never nested) — Dates is required here.
    expect(cards[0].date).toEqual(["WEEKEND"]);
    expect(cards[0].weight).toBe(30);
    expect(cards[0].disabled).toBeUndefined();
    // The compound add is exactly ONE tracked mutation (one zundo entry).
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("edit updates description + weight in one tracked mutation", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        coverings: [],
        affinities: [
          {
            uid: "aff-edit",
            description: "Chloe and Aisha",
            people1: [["Chloe"]],
            people2: [["Aisha"]],
            shiftTypes: [["Day"]],
            date: ["ALL"],
            weight: 1,
          },
        ],
      },
    });
    await expect(page.getByTestId("affinity-card-0")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("affinity-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    // The current selection populates the SELECTED pane.
    await expect(page.getByTestId("transfer-people1-people1")).toContainText("Chloe");

    await page.getByTestId("affinity-desc").fill("Chloe and Aisha (updated)");
    await page.getByTestId("weight-field-input").fill("15");
    await page.getByTestId("card-editor-submit").click();

    const cards = await readAffinities(page);
    expect(cards[0].description).toBe("Chloe and Aisha (updated)");
    expect(cards[0].weight).toBe(15);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("disable then enable toggles the marker and one undo entry each", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        coverings: [],
        affinities: [
          {
            uid: "aff-dis",
            people1: [["Chloe"]],
            people2: [["Aisha"]],
            shiftTypes: [["Day"]],
            date: ["ALL"],
            weight: 1,
          },
        ],
      },
    });
    await expect(page.getByTestId("affinity-card-0")).toBeVisible();

    const beforeOff = await pastCount(page);
    await page.getByTestId("affinity-disable-0").click();
    await expect(page.getByTestId("affinity-card-0")).toHaveAttribute("data-disabled", "true");
    await expect(page.getByTestId("affinity-card-0").getByText("Disabled")).toBeVisible();
    expect((await readAffinities(page))[0].disabled).toBe(true);
    expect((await pastCount(page)) - beforeOff).toBe(1);

    const beforeEnable = await pastCount(page);
    await page.getByTestId("affinity-disable-0").click();
    await expect(page.getByTestId("affinity-card-0")).not.toHaveAttribute("data-disabled", "true");
    expect((await readAffinities(page))[0].disabled).toBeUndefined();
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
        coverings: [],
        affinities: [
          {
            uid: "aff-del",
            people1: [["Chloe"]],
            people2: [["Aisha"]],
            shiftTypes: [["Day"]],
            date: ["ALL"],
            weight: 1,
          },
        ],
      },
    });
    await expect(page.getByTestId("affinity-card-0")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("affinity-delete-0").click();
    await expect(page.getByTestId("affinity-card-0")).toHaveCount(0);
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();
    expect(await readAffinities(page)).toEqual([]);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("duplicate uses the unique-copy algorithm (FR-PR-13) in one tracked mutation", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        coverings: [],
        affinities: [
          {
            uid: "aff-dup",
            description: "Rule",
            people1: [["Chloe"]],
            people2: [["Aisha"]],
            shiftTypes: [["Day"]],
            date: ["ALL"],
            weight: 1,
          },
        ],
      },
    });

    const before = await pastCount(page);
    await page.getByTestId("affinity-dup-0").click();
    expect((await pastCount(page)) - before).toBe(1);
    await page.getByTestId("affinity-dup-0").click();

    const descriptions = (await readAffinities(page)).map((rule) => rule.description);
    expect(descriptions).toEqual(["Rule", "Rule copy 2", "Rule copy"]);
  });

  test("move up/down reorders durably", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        coverings: [],
        affinities: [
          {
            uid: "aff-a",
            description: "A",
            people1: [["Chloe"]],
            people2: [["Aisha"]],
            shiftTypes: [["Day"]],
            date: ["ALL"],
            weight: 1,
          },
          {
            uid: "aff-b",
            description: "B",
            people1: [["Chloe"]],
            people2: [["Daniel"]],
            shiftTypes: [["Day"]],
            date: ["ALL"],
            weight: 1,
          },
        ],
      },
    });

    // Card 1 is "B"; move it up → it becomes card 0.
    await page.getByTestId("affinity-up-1").click();
    await expect(page.getByTestId("affinity-card-0")).toContainText("B");
    const order = (await readAffinities(page)).map((c) => c.description);
    expect(order).toEqual(["B", "A"]);
  });

  test("dragging onto a card's upper half inserts BEFORE it (FR-PR-12)", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        coverings: [],
        affinities: ["A", "B", "C"].map((d) => ({
          uid: `aff-${d}`,
          description: d,
          people1: [["Chloe"]],
          people2: [["Aisha"]],
          shiftTypes: [["Day"]],
          date: ["ALL"],
          weight: 1,
        })),
      },
    });
    await expect(page.getByTestId("affinity-card-0")).toContainText("A");

    // Drop A onto the UPPER half of C: before-C ⇒ [B, A, C]; the naive
    // insert-at-index behavior would instead produce [B, C, A].
    await page.evaluate(() => {
      const source = document.querySelector('[data-testid="affinity-card-0"]')!;
      const dt = new DataTransfer();
      (window as unknown as { __dt?: DataTransfer }).__dt = dt;
      source.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      const source = document.querySelector('[data-testid="affinity-card-0"]')!;
      const target = document.querySelector('[data-testid="affinity-card-2"]')!;
      const dt = (window as unknown as { __dt?: DataTransfer }).__dt!;
      const rect = target.getBoundingClientRect();
      const upperY = rect.top + rect.height * 0.15; // C's upper half ⇒ drop BEFORE C
      const fire = (el: Element, type: string) =>
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientY: upperY,
          }),
        );
      fire(target, "dragover");
      fire(target, "drop");
      fire(source, "dragend");
    });

    await expect
      .poll(async () => (await readAffinities(page)).map((rule) => rule.description))
      .toEqual(["B", "A", "C"]);
  });
});

test.describe.serial("T12 Affinities — all four selectors required (FR-PR-61)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("Save is blocked and shows all four verbatim empty-selection messages", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    const before = await pastCount(page);
    await page.getByTestId("card-editor-submit").click();

    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(page.getByText("At least one person must be selected for People 1")).toBeVisible();
    await expect(page.getByText("At least one person must be selected for People 2")).toBeVisible();
    await expect(page.getByText("At least one shift type must be selected")).toBeVisible();
    await expect(page.getByText("At least one date must be selected")).toBeVisible();
    expect(await pastCount(page)).toBe(before);
  });
});

test.describe.serial("T12 Affinities — ALL date scope (allValue=['ALL']) round-trip", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("selecting ALL validates, saves date ['ALL'], and reopens with ALL active", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    await page.getByRole("button", { name: "Add Chloe to people 1" }).click();
    await page.getByRole("button", { name: "Add Aisha to people 2" }).click();
    await page.getByRole("button", { name: "Add Day to shift types" }).click();
    // Choose the ALL date scope — Affinities wires allValue={["ALL"]} (Dates is
    // required, unlike Coverings), so this must emit the explicit all-dates
    // keyword (non-empty ⇒ passes the required check), NOT clear to [].
    const allChip = page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /all dates/i });
    await allChip.click();
    await page.getByTestId("card-editor-submit").click();

    await expect(page.getByTestId("affinity-card-0")).toBeVisible();
    const cards = await readAffinities(page);
    expect(cards).toHaveLength(1);
    expect(cards[0].date).toEqual(["ALL"]);

    // Reopening the card shows the ALL chip active.
    await page.getByTestId("affinity-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(
      page.getByTestId("date-scope-field").getByRole("button", { name: /all dates/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe.serial("T12 Affinities — weight has no sign restriction", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("a negative weight and -infinity are both accepted (unlike the squared-count rule)", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    await page.getByRole("button", { name: "Add Chloe to people 1" }).click();
    await page.getByRole("button", { name: "Add Aisha to people 2" }).click();
    await page.getByRole("button", { name: "Add Day to shift types" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /all dates/i })
      .click();
    // The default is +1 (encourage); explicitly discourage instead.
    await page.getByTestId("weight-field-minus-inf").click();
    await page.getByTestId("card-editor-submit").click();

    await expect(page.getByTestId("affinity-card-0")).toBeVisible();
    const cards = await readAffinities(page);
    expect(cards[0].weight).toBe(-Infinity);
  });
});

test.describe.serial("T12 Affinities — numeric/string identity (mirrors Coverings Major 3)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test('numeric person 1 and string group "1" are both selectable and survive in People 1', async ({
    page,
  }) => {
    await gotoReady(page);
    // Backend-valid people-domain identities that share a surface spelling but
    // differ in type: a numeric staff item `1` and a people-group named `"1"`.
    await seed(page, {
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-31",
      staff: [
        { id: 1, history: [] },
        { id: "Aisha", history: [] },
      ],
      staffGroups: [{ id: "1", description: "StrOne", members: [] }],
      shifts: [{ id: "Day" }],
    });
    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();

    // Both rows are present and addable in People 1 (distinct via their labels).
    await page.getByRole("button", { name: "Add 1 to people 1" }).click();
    await page.getByRole("button", { name: "Add 1 — StrOne to people 1" }).click();
    // People 2 + shift type + dates make the draft valid.
    await page.getByRole("button", { name: "Add Aisha to people 2" }).click();
    await page.getByRole("button", { name: "Add Day to shift types" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /all dates/i })
      .click();
    await page.getByTestId("card-editor-submit").click();

    const cards = await readAffinities(page);
    // Both refs coexist with their original types (numeric 1, string "1").
    expect(cards[0].people1).toEqual([[1, "1"]]);
  });
});

test.describe.serial("T12 Affinities — open-draft navigation guard", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("an open draft arms the navigation guard on a clean scenario", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    // Reset the baseline so the scenario is CLEAN — isolates draftOpen as the only
    // reason the guard can fire.
    await page.evaluate(() =>
      (window as unknown as NsWindow).__nsStore.scenario.getState().markSaved(),
    );
    expect(await page.evaluate(() => (window as unknown as NsWindow).__nsStore.isDirty())).toBe(
      false,
    );

    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();

    // Sidebar navigation is intercepted by the guard even though nothing is dirty.
    await page.getByTestId("nav-link-/people").click();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await page.getByTestId("confirm-dialog-cancel").click();
    expect(new URL(page.url()).pathname).toBe("/shift-affinities");
  });
});

test.describe.serial("T12 Affinities — edit scroll save/restore (FR-PR-07)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  // The app shell scrolls an inner overflow container, not the window — measure the
  // nearest scrollable ancestor of the screen (the same node the editor uses).
  const scrollerTop = (page: Page) =>
    page.evaluate(() => {
      let el = document.querySelector('[data-testid="screen"]')?.parentElement ?? null;
      while (el) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === "auto" || oy === "scroll") return el.scrollTop;
        el = el.parentElement;
      }
      return window.scrollY;
    });

  async function seedLongAffinityList(page: Page) {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    // Enough cards to push a lower card well below the fold.
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        coverings: [],
        affinities: Array.from({ length: 12 }, (_, i) => ({
          uid: `aff-${i}`,
          description: `Rule ${i}`,
          people1: [["Chloe"]],
          people2: [["Aisha"]],
          shiftTypes: [["Day"]],
          date: ["ALL"],
          weight: 1,
        })),
      },
    });
  }

  test("editing a lower card scrolls to the form, and Save restores the offset", async ({
    page,
  }) => {
    await seedLongAffinityList(page);

    // Scroll the container down to the last card and record the pre-edit offset.
    await page.getByTestId("affinity-card-11").scrollIntoViewIfNeeded();
    const preEdit = await scrollerTop(page);
    expect(preEdit).toBeGreaterThan(0);

    await page.getByTestId("affinity-edit-11").click();
    // The edit form is open and the container scrolled toward the top (FR-PR-07).
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect.poll(() => scrollerTop(page)).toBe(0);

    // Save (a no-op edit is fine — Update still closes the form). The FINAL offset
    // must return to the recorded pre-edit value once the form has unmounted and
    // the list layout collapsed back.
    await page.getByTestId("card-editor-submit").click();
    await expect(page.getByTestId("card-editor-form")).toHaveCount(0);
    await expect.poll(() => scrollerTop(page)).toBeGreaterThanOrEqual(preEdit - 5);
  });

  test("Cancel from an edit also restores the pre-edit scroll offset", async ({ page }) => {
    await seedLongAffinityList(page);

    await page.getByTestId("affinity-card-11").scrollIntoViewIfNeeded();
    const preEdit = await scrollerTop(page);
    expect(preEdit).toBeGreaterThan(0);

    await page.getByTestId("affinity-edit-11").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect.poll(() => scrollerTop(page)).toBe(0);

    // Cancel closes the form; the offset returns to the recorded pre-edit value.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("card-editor-form")).toHaveCount(0);
    await expect.poll(() => scrollerTop(page)).toBeGreaterThanOrEqual(preEdit - 5);
  });
});

test.describe.serial("T12 Affinities — empty-state gate hides while the form is open", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("empty state disappears when Add opens the form and returns on Cancel", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);

    await expect(page.getByTestId("card-editor-empty")).toBeVisible();

    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(page.getByTestId("card-editor-empty")).toHaveCount(0);

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();
  });
});

test.describe
  .serial("T12 Affinities — advanced multi-term card read-only + lossless (FR-PR-55a-style)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("a multi-term affinity renders read-only and survives edit-attempt/duplicate/move/disable byte-for-byte", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    // `people1: [["Chloe"], ["Aisha"]]` is TWO separate C3 affinity terms — a
    // shape the single-term form cannot author. It must be preserved verbatim;
    // routing it through flatten+build would collapse it to `[["Chloe","Aisha"]]`.
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        coverings: [],
        affinities: [
          {
            uid: "aff-adv",
            description: "Multi-term rule",
            people1: [["Chloe"], ["Aisha"]],
            people2: [["Daniel"]],
            shiftTypes: [["Day"]],
            date: ["ALL"],
            weight: 30,
          },
          {
            uid: "aff-plain",
            description: "Plain rule",
            people1: [["Chloe"]],
            people2: [["Aisha"]],
            shiftTypes: [["Day"]],
            date: ["ALL"],
            weight: 1,
          },
        ],
      },
    });

    // The advanced card shows its badge + read-only note and OMITS Edit.
    await expect(page.getByTestId("affinity-advanced-badge-0")).toBeVisible();
    await expect(page.getByTestId("affinity-readonly-note-0")).toBeVisible();
    await expect(page.getByTestId("affinity-edit-0")).toHaveCount(0);
    // The plain card is still editable.
    await expect(page.getByTestId("affinity-edit-1")).toBeVisible();
    await expect(page.getByTestId("affinity-advanced-badge-1")).toHaveCount(0);

    // Clicking the read-only note never opens the form (edit is blocked).
    await page.getByTestId("affinity-readonly-note-0").click();
    await expect(page.getByTestId("card-editor-form")).toHaveCount(0);

    // Duplicate the advanced card → one tracked mutation; the clone preserves the
    // two-term shape EXACTLY (the assertion that catches a silent collapse).
    const before = await pastCount(page);
    await page.getByTestId("affinity-dup-0").click();
    expect((await pastCount(page)) - before).toBe(1);
    let cards = await readAffinities(page);
    expect(cards).toHaveLength(3);
    // Source (index 0) unchanged; clone inserted after it (index 1).
    expect(cards[0].people1).toEqual([["Chloe"], ["Aisha"]]);
    expect(cards[1].people1).toEqual([["Chloe"], ["Aisha"]]);
    expect(cards[1].description).toBe("Multi-term rule copy");

    // Disable the advanced source → marker on, selectors untouched.
    await page.getByTestId("affinity-disable-0").click();
    cards = await readAffinities(page);
    expect(cards[0].disabled).toBe(true);
    expect(cards[0].people1).toEqual([["Chloe"], ["Aisha"]]);

    // Move the advanced source down → order changes, shape still byte-for-byte.
    await page.getByTestId("affinity-down-0").click();
    cards = await readAffinities(page);
    const moved = cards.find((c) => c.uid === "aff-adv")!;
    expect(moved.people1).toEqual([["Chloe"], ["Aisha"]]);
    expect(moved.people2).toEqual([["Daniel"]]);
    expect(moved.shiftTypes).toEqual([["Day"]]);
  });
});
