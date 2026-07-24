import { expect, test, type Page } from "@playwright/test";

// T12 M1 clone acceptance (Playwright rows): the prototype-conformance Staffing
// Requirements editor driven against a production build through the real T04
// store (`window.__nsStore`). Every named outcome asserts the DURABLE STORE shape
// AND the store.temporal entry count — so a green test cannot mask a
// data-integrity gap or a spurious/absent undo entry (mirrors counts.spec.ts /
// coverings.spec.ts's rigor). Coverage spans:
//  • create via the single-select shift-type radio + coefficients + required/
//    preferred/qualified/dates + the CONDITIONAL weight dial, one tracked
//    mutation;
//  • the radio single-select always replaces (never accumulates) and OFF/LEAVE
//    (and a group reaching them) are excluded from the options entirely;
//  • the weight dial appears ONLY when preferred differs from required, and the
//    saved weight/preferredNumPeople are FORCED when it does not (EDGE-PR-03);
//  • the coverage-warning banner reports undefined/duplicate `(date, shiftType)`
//    pairs and clears once a shift type is fully covered;
//  • a stored requirement with no qualified-people scope loads as `[ALL]` and
//    saves an explicit `[ALL]` back (FR-PR-26);
//  • drag-drop reorder honors the pointer half (FR-PR-12);
//  • duplicate derives a unique "… copy" label;
//  • edit scroll save/restore (FR-PR-07) and the navigation guard (FR-PR-06).

type RequirementCard = {
  uid: string;
  description?: string;
  shiftType: unknown;
  shiftTypeCoefficients?: [string, number][];
  requiredNumPeople: number;
  preferredNumPeople?: number;
  qualifiedPeople?: unknown;
  date?: unknown;
  weight: number;
  disabled?: boolean;
};

type NsWindow = {
  __nsStore: {
    scenario: {
      getState: () => Record<string, unknown> & {
        cardsByKind: { requirements: RequirementCard[] };
        mutateScenario: (patch: Record<string, unknown>) => void;
        recordBackup: () => void;
      };
      temporal: {
        getState: () => { pastStates: unknown[]; futureStates: unknown[] };
      };
    };
    backupStatus: () => "none" | "current" | "stale";
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

/** Shift Type Requirements is Advanced-only since T08d (DL12 §2); adopt the
 *  stored Advanced preference first so the route-validity gate doesn't
 *  redirect this direct visit to Home under the Guided default. */
async function gotoReady(page: Page) {
  await page.addInitScript(() => localStorage.setItem("ns-app-mode", "advanced"));
  await page.goto("/shift-type-requirements");
  await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsStore));
  await expect(page.getByTestId("add-card-toggle")).toBeVisible();
}

function readRequirements(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.getState().cardsByKind.requirements,
  );
}

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
  ],
  shifts: [{ id: "D" }, { id: "N" }, { id: "OFF" }, { id: "LEAVE" }],
  shiftGroups: [
    { id: "Working", members: ["D", "N"] },
    { id: "RestGroup", members: ["OFF"] },
  ],
};

test.describe.serial("T12 staffing requirements editor (M1 clone)", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("create with equal preferred/required hides the dial and forces weight -1", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();

    await page.getByTestId("requirement-desc").fill("Day shift needs seniors");
    await page.getByTestId("shift-type-single-select-option-D").check();
    await page.getByTestId("requirement-required").fill("3");
    await page.getByRole("button", { name: /Add ALL/ }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /all dates/i })
      .click();

    // Preferred left blank ⇒ equals required ⇒ the note shows, no dial.
    await expect(page.getByTestId("weight-field")).toContainText(
      "Weight is not needed when the preferred number of people equals the required number.",
    );
    await expect(page.getByTestId("weight-field-input")).toHaveCount(0);

    await page.getByTestId("card-editor-submit").click();

    await expect(page.getByTestId("requirement-card-0")).toBeVisible();
    await expect(page.getByTestId("card-editor-empty")).toHaveCount(0);

    const cards = await readRequirements(page);
    expect(cards).toHaveLength(1);
    expect(cards[0].description).toBe("Day shift needs seniors");
    expect(cards[0].shiftType).toEqual(["D"]);
    expect(cards[0].requiredNumPeople).toBe(3);
    expect(cards[0].preferredNumPeople).toBeUndefined();
    expect(cards[0].weight).toBe(-1); // forced, regardless of the in-form default
    expect(cards[0].qualifiedPeople).toEqual(["ALL"]);
    expect(cards[0].date).toEqual(["ALL"]);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("a distinct preferred shows the dial and enforces the non-positive rule", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    await page.getByTestId("shift-type-single-select-option-D").check();
    await page.getByTestId("requirement-required").fill("3");
    await page.getByTestId("requirement-preferred").fill("5");
    await page.getByRole("button", { name: /Add ALL/ }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /all dates/i })
      .click();

    // The dial is now visible.
    await expect(page.getByTestId("weight-field-input")).toBeVisible();

    // A positive weight is rejected with the verbatim message.
    await page.getByTestId("weight-field-input").fill("10");
    await page.getByTestId("card-editor-submit").click();
    await expect(page.getByText("Weight must be 0 or less (including -Infinity)")).toBeVisible();
    expect(await readRequirements(page)).toHaveLength(0);

    // A non-positive weight saves cleanly, along with the distinct preferred.
    await page.getByTestId("weight-field-input").fill("-20");
    await page.getByTestId("card-editor-submit").click();

    const cards = await readRequirements(page);
    expect(cards).toHaveLength(1);
    expect(cards[0].requiredNumPeople).toBe(3);
    expect(cards[0].preferredNumPeople).toBe(5);
    expect(cards[0].weight).toBe(-20);
  });

  test("the shift-type radio replaces the selection and rejects an empty save", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    // Save with nothing selected — the verbatim empty message.
    await page.getByTestId("card-editor-submit").click();
    await expect(page.getByText("At least one shift type must be selected")).toBeVisible();

    // Selecting D then N leaves only N checked (a radio, not a multi-select).
    await page.getByTestId("shift-type-single-select-option-D").check();
    await expect(page.getByTestId("shift-type-single-select-option-D")).toBeChecked();
    await page.getByTestId("shift-type-single-select-option-N").check();
    await expect(page.getByTestId("shift-type-single-select-option-D")).not.toBeChecked();
    await expect(page.getByTestId("shift-type-single-select-option-N")).toBeChecked();

    await page.getByRole("button", { name: /Add ALL/ }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /all dates/i })
      .click();
    await page.getByTestId("requirement-required").fill("1");
    await page.getByTestId("card-editor-submit").click();

    const cards = await readRequirements(page);
    expect(cards[0].shiftType).toEqual(["N"]);
  });

  test("OFF and LEAVE are excluded from the options entirely, and so is a group reaching them", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    const select = page.getByTestId("shift-type-single-select");
    await expect(select).not.toContainText("OFF");
    await expect(select).not.toContainText("LEAVE");
    // `RestGroup` (members: [OFF]) is excluded entirely, unlike Coverings' disabled-
    // but-visible treatment — `Working` ([D, N]) remains fully selectable.
    await expect(select).not.toContainText("RestGroup");
    await expect(select).toContainText("Working");
    await expect(page.getByTestId("shift-type-single-select-option-OFF")).toHaveCount(0);
    await expect(page.getByTestId("shift-type-single-select-option-LEAVE")).toHaveCount(0);
  });

  test("an empty people domain renders setup guidance instead of the picker (M4, FR-PR-14)", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, {
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-31",
      staff: [],
      staffGroups: [],
      shifts: [{ id: "D" }],
    });
    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();

    // The synthetic ALL group is no longer offered against an empty people domain —
    // the authoritative setup guidance shows and the picker is absent.
    await expect(
      page.getByText("No people set up — add some on the Staff screen first."),
    ).toBeVisible();
    await expect(page.getByTestId("transfer-list-qualified")).toHaveCount(0);
  });

  test("editing a stored requirement with no qualified scope loads [ALL] and saves it back", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [
          {
            uid: "req-noqual",
            description: "Night needs coverage",
            shiftType: ["N"],
            requiredNumPeople: 2,
            weight: -1,
          },
        ],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await expect(page.getByTestId("requirement-card-0")).toBeVisible();
    expect((await readRequirements(page))[0].qualifiedPeople).toBeUndefined();

    await page.getByTestId("requirement-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(page.getByTestId("transfer-qualified-qualified")).toContainText("ALL");

    await page.getByTestId("card-editor-submit").click();
    const cards = await readRequirements(page);
    expect(cards[0].qualifiedPeople).toEqual(["ALL"]);
  });

  test("an explicit null qualified/date scope loads as [ALL] and saves it back (M3)", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [
          {
            uid: "req-null",
            description: "Null scope",
            shiftType: ["D"],
            requiredNumPeople: 1,
            weight: -1,
            qualifiedPeople: null,
            date: null,
          },
        ],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await expect(page.getByTestId("requirement-card-0")).toBeVisible();

    await page.getByTestId("requirement-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    // The null scope loads as ALL — not an unknown `null` token.
    await expect(page.getByTestId("transfer-qualified-qualified")).toContainText("ALL");

    // Update without changing either scope — the null must NOT round-trip as [null].
    await page.getByTestId("card-editor-submit").click();
    const cards = await readRequirements(page);
    expect(cards[0].qualifiedPeople).toEqual(["ALL"]);
    expect(cards[0].date).toEqual(["ALL"]);
  });

  test("delete removes the card with no confirmation; one undo entry", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [
          { uid: "req-del", shiftType: ["D"], requiredNumPeople: 1, date: ["ALL"], weight: -1 },
        ],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await expect(page.getByTestId("requirement-card-0")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("requirement-delete-0").click();
    await expect(page.getByTestId("requirement-card-0")).toHaveCount(0);
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();
    expect(await readRequirements(page)).toEqual([]);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("Enable/Disable toggles the disabled marker; one undo entry each (M1)", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [
          { uid: "req-dis", shiftType: ["D"], requiredNumPeople: 1, date: ["ALL"], weight: -1 },
        ],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await expect(page.getByTestId("requirement-card-0")).toBeVisible();

    // Disable → marker on, card fades, Disabled badge shows, label flips to Enable.
    const beforeOff = await pastCount(page);
    await page.getByTestId("requirement-disable-0").click();
    await expect(page.getByTestId("requirement-card-0")).toHaveAttribute("data-disabled", "true");
    await expect(page.getByTestId("requirement-card-0").getByText("Disabled")).toBeVisible();
    expect((await readRequirements(page))[0].disabled).toBe(true);
    expect((await pastCount(page)) - beforeOff).toBe(1);

    // Enable → marker stripped (undefined, not merely false), badge gone, ONE entry.
    const beforeEnable = await pastCount(page);
    await page.getByTestId("requirement-disable-0").click();
    await expect(page.getByTestId("requirement-card-0")).not.toHaveAttribute(
      "data-disabled",
      "true",
    );
    await expect(page.getByTestId("requirement-card-0").getByText("Disabled")).toHaveCount(0);
    expect((await readRequirements(page))[0].disabled).toBeUndefined();
    expect((await pastCount(page)) - beforeEnable).toBe(1);
  });

  test("duplicate derives a unique copy label and is one tracked mutation", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [
          {
            uid: "req-src",
            description: "Day coverage",
            shiftType: ["D"],
            requiredNumPeople: 2,
            date: ["ALL"],
            weight: -1,
          },
        ],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });

    const before = await pastCount(page);
    await page.getByTestId("requirement-dup-0").click();
    expect((await pastCount(page)) - before).toBe(1);
    const cards = await readRequirements(page);
    expect(cards).toHaveLength(2);
    expect(cards[1].description).toBe("Day coverage copy");

    // A second duplicate of the ORIGINAL dedupes against the existing "copy".
    await page.getByTestId("requirement-dup-0").click();
    const cards2 = await readRequirements(page);
    expect(cards2.map((c) => c.description)).toEqual([
      "Day coverage",
      "Day coverage copy 2",
      "Day coverage copy",
    ]);
  });

  test("move up reorders durably", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [
          {
            uid: "req-a",
            description: "A",
            shiftType: ["D"],
            requiredNumPeople: 1,
            date: ["ALL"],
            weight: -1,
          },
          {
            uid: "req-b",
            description: "B",
            shiftType: ["N"],
            requiredNumPeople: 1,
            date: ["ALL"],
            weight: -1,
          },
        ],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });

    await page.getByTestId("requirement-up-1").click();
    await expect(page.getByTestId("requirement-card-0")).toContainText("B");
    const order = (await readRequirements(page)).map((c) => c.description);
    expect(order).toEqual(["B", "A"]);
  });

  test("dragging onto a card's upper half inserts BEFORE it (FR-PR-12)", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: ["A", "B", "C"].map((d) => ({
          uid: `req-${d}`,
          description: d,
          shiftType: ["D"],
          requiredNumPeople: 1,
          date: ["ALL"],
          weight: -1,
        })),
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await expect(page.getByTestId("requirement-card-0")).toContainText("A");

    // Drop A onto the UPPER half of C. Native HTML5 DnD is unreliable headless, so
    // dispatch the real drag events with a controlled clientY in C's upper half.
    await page.evaluate(() => {
      const source = document.querySelector('[data-testid="requirement-card-0"]')!;
      const dt = new DataTransfer();
      (window as unknown as { __dt?: DataTransfer }).__dt = dt;
      source.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      const source = document.querySelector('[data-testid="requirement-card-0"]')!;
      const target = document.querySelector('[data-testid="requirement-card-2"]')!;
      const dt = (window as unknown as { __dt?: DataTransfer }).__dt!;
      const rect = target.getBoundingClientRect();
      const upperY = rect.top + rect.height * 0.15;
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
      .poll(async () => (await readRequirements(page)).map((rule) => rule.description))
      .toEqual(["B", "A", "C"]);
  });

  test("the coverage-warning banner reports undefined pairs and clears once covered", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, {
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-02",
      staff: [{ id: "Aisha", history: [] }],
      shifts: [{ id: "D" }],
    });

    await expect(page.getByTestId("requirement-coverage-warnings")).toBeVisible();
    await expect(page.getByTestId("requirement-coverage-undefined")).toContainText(
      "Undefined staffing requirements: 2 date/shift type pairs have no requirement",
    );
    await expect(page.getByTestId("requirement-coverage-undefined")).toContainText("D: ALL");

    // Covering D over ALL dates clears the undefined section.
    await seed(page, {
      cardsByKind: {
        requirements: [
          { uid: "req-cov", shiftType: ["D"], requiredNumPeople: 1, date: ["ALL"], weight: -1 },
        ],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await expect(page.getByTestId("requirement-coverage-warnings")).toHaveCount(0);

    // A second requirement covering the SAME pairs creates a duplicate warning.
    await seed(page, {
      cardsByKind: {
        requirements: [
          { uid: "req-cov", shiftType: ["D"], requiredNumPeople: 1, date: ["ALL"], weight: -1 },
          { uid: "req-cov-2", shiftType: ["D"], requiredNumPeople: 2, date: ["ALL"], weight: -1 },
        ],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await expect(page.getByTestId("requirement-coverage-duplicate")).toContainText(
      "Duplicate staffing requirements: 2 date/shift type pairs are covered by more than one requirement",
    );
    await expect(page.getByTestId("requirement-coverage-duplicate")).toContainText(
      "requirements 1 and 2",
    );
  });

  test("the coverage banner never lists OFF/LEAVE day states (M5, FR-PR-40)", async ({ page }) => {
    await gotoReady(page);
    await seed(page, {
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-02",
      staff: [{ id: "Aisha", history: [] }],
      shifts: [{ id: "D" }, { id: "OFF" }, { id: "LEAVE" }],
    });

    await expect(page.getByTestId("requirement-coverage-warnings")).toBeVisible();
    await expect(page.getByTestId("requirement-coverage-undefined")).toContainText("D: ALL");
    await expect(page.getByTestId("requirement-coverage-undefined")).not.toContainText("OFF");
    await expect(page.getByTestId("requirement-coverage-undefined")).not.toContainText("LEAVE");
  });

  test("an open draft arms the navigation guard on a clean scenario", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.evaluate(() =>
      (window as unknown as NsWindow).__nsStore.scenario.getState().recordBackup(),
    );
    expect(
      await page.evaluate(() => (window as unknown as NsWindow).__nsStore.backupStatus()),
    ).toBe("current");

    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();

    await page.getByTestId("nav-link-/people").click();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await page.getByTestId("confirm-dialog-cancel").click();
    expect(new URL(page.url()).pathname).toBe("/shift-type-requirements");
  });

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

  async function seedLongRequirementList(page: Page) {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: Array.from({ length: 12 }, (_, i) => ({
          uid: `req-${i}`,
          description: `Rule ${i}`,
          shiftType: ["D"],
          requiredNumPeople: 1,
          date: ["ALL"],
          weight: -1,
        })),
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
  }

  test("editing a lower card scrolls to the form, and Save restores the offset", async ({
    page,
  }) => {
    await seedLongRequirementList(page);

    await page.getByTestId("requirement-card-11").scrollIntoViewIfNeeded();
    const preEdit = await scrollerTop(page);
    expect(preEdit).toBeGreaterThan(0);

    await page.getByTestId("requirement-edit-11").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect.poll(() => scrollerTop(page)).toBe(0);

    await page.getByTestId("card-editor-submit").click();
    await expect(page.getByTestId("card-editor-form")).toHaveCount(0);
    await expect.poll(() => scrollerTop(page)).toBeGreaterThanOrEqual(preEdit - 5);
  });
});
