import { expect, test, type Page } from "@playwright/test";

// T12 seed acceptance (Playwright rows): the prototype-conformance Shift Counts
// editor driven against a production build through the real T04 store
// (`window.__nsStore`). Every named outcome asserts the DURABLE STORE shape AND
// the store.temporal entry count — so a green test cannot mask a data-integrity
// gap or a spurious/absent undo entry (mirrors coverings.spec.ts's rigor).
// Coverage spans:
//  • create via the People/Count-shift-types transfer selectors + DateScopeField +
//    ExpressionField + WeightField, one tracked mutation;
//  • edit adds a coefficient in one tracked mutation;
//  • Enable/Disable toggles the UI-only `disabled` marker — one entry each;
//  • delete returns the centred empty state, one entry;
//  • duplicate is one tracked mutation and preserves an UNMARKED generic-array
//    (FR-PR-55a) card's expression/target arrays exactly, byte for byte;
//  • the squared-weight rule (AC-PR-12) blocks Save with the verbatim message;
//  • OFF/LEAVE/ALL are selectable and coefficient-bearing in Count Shift Types;
//  • a contracted-hours (marked) card renders read-only with its badge and never
//    opens the scalar form.

type CountCard = {
  uid: string;
  description?: string;
  disabled?: boolean;
  person: unknown;
  countDates: unknown;
  countShiftTypes: unknown;
  countShiftTypeCoefficients?: [string, number][];
  expression: string | string[];
  target: number | number[];
  weight: number;
  tag?: "contracted_hours";
  policy?: "exact" | "range";
};

type NsWindow = {
  __nsStore: {
    scenario: {
      getState: () => Record<string, unknown> & {
        cardsByKind: { counts: CountCard[] };
        mutateScenario: (patch: Record<string, unknown>) => void;
        markSaved: () => void;
      };
      temporal: {
        getState: () => {
          pastStates: unknown[];
          futureStates: unknown[];
          undo: () => void;
          redo: () => void;
        };
      };
    };
    isDirty: () => boolean;
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

async function gotoReady(page: Page) {
  await page.goto("/shift-counts");
  await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsStore));
  await expect(page.getByTestId("add-card-toggle")).toBeVisible();
}

function readCounts(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.getState().cardsByKind.counts,
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
  shifts: [{ id: "D" }, { id: "N" }],
};

test.describe.serial("T12 shift counts editor (seed)", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("create via transfer panes + expression/target + weight; one undo entry", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();

    await page.getByTestId("count-desc").fill("Working shifts close to average");
    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    await page.getByRole("button", { name: "Add D to count shift types" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /weekdays/i })
      .click();
    await page.getByTestId("expression-field-op-le").click();
    await page.getByTestId("expression-field-target").fill("8");
    await page.getByTestId("weight-field-input").fill("-5");
    await page.getByTestId("card-editor-submit").click();

    await expect(page.getByTestId("count-card-0")).toBeVisible();
    await expect(page.getByTestId("card-editor-empty")).toHaveCount(0);
    await expect(page.getByTestId("card-list-count")).toContainText("1 RULE");

    const cards = await readCounts(page);
    expect(cards).toHaveLength(1);
    expect(cards[0].description).toBe("Working shifts close to average");
    expect(cards[0].person).toEqual(["Aisha"]);
    expect(cards[0].countShiftTypes).toEqual(["D"]);
    expect(cards[0].expression).toBe("x <= T");
    expect(cards[0].target).toBe(8);
    expect(cards[0].weight).toBe(-5);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("edit adds a coefficient in one tracked mutation", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        affinities: [],
        coverings: [],
        counts: [
          {
            uid: "count-edit",
            person: ["Aisha"],
            countDates: ["2026-01-01"],
            countShiftTypes: ["D"],
            expression: "x >= T",
            target: 5,
            weight: -1,
          },
        ],
      },
    });
    await expect(page.getByTestId("count-card-0")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("count-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await page.getByTestId("coefficient-fields-input-D").fill("3");
    await page.getByTestId("card-editor-submit").click();

    const cards = await readCounts(page);
    expect(cards[0].countShiftTypeCoefficients).toEqual([["D", 3]]);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("disable then enable toggles the marker and one undo entry each", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        affinities: [],
        coverings: [],
        counts: [
          {
            uid: "count-dis",
            person: ["Aisha"],
            countDates: ["2026-01-01"],
            countShiftTypes: ["D"],
            expression: "x >= T",
            target: 5,
            weight: -1,
          },
        ],
      },
    });
    await expect(page.getByTestId("count-card-0")).toBeVisible();

    const beforeOff = await pastCount(page);
    await page.getByTestId("count-disable-0").click();
    await expect(page.getByTestId("count-card-0")).toHaveAttribute("data-disabled", "true");
    expect((await readCounts(page))[0].disabled).toBe(true);
    expect((await pastCount(page)) - beforeOff).toBe(1);

    const beforeEnable = await pastCount(page);
    await page.getByTestId("count-disable-0").click();
    await expect(page.getByTestId("count-card-0")).not.toHaveAttribute("data-disabled", "true");
    expect((await readCounts(page))[0].disabled).toBeUndefined();
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
        affinities: [],
        coverings: [],
        counts: [
          {
            uid: "count-del",
            person: ["Aisha"],
            countDates: ["2026-01-01"],
            countShiftTypes: ["D"],
            expression: "x >= T",
            target: 5,
            weight: -1,
          },
        ],
      },
    });
    await expect(page.getByTestId("count-card-0")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("count-delete-0").click();
    await expect(page.getByTestId("count-card-0")).toHaveCount(0);
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();
    expect(await readCounts(page)).toEqual([]);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("move up/down reorders durably", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        affinities: [],
        coverings: [],
        counts: [
          {
            uid: "count-a",
            description: "A",
            person: ["Aisha"],
            countDates: ["2026-01-01"],
            countShiftTypes: ["D"],
            expression: "x >= T",
            target: 5,
            weight: -1,
          },
          {
            uid: "count-b",
            description: "B",
            person: ["Aisha"],
            countDates: ["2026-01-01"],
            countShiftTypes: ["D"],
            expression: "x >= T",
            target: 5,
            weight: -1,
          },
        ],
      },
    });

    await page.getByTestId("count-up-1").click();
    await expect(page.getByTestId("count-card-0")).toContainText("B");
    const order = (await readCounts(page)).map((c) => c.description);
    expect(order).toEqual(["B", "A"]);
  });
});

test.describe.serial("T12 squared-weight rule (AC-PR-12)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test('rejects a positive weight with "|x - T|^2" and blocks Save', async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();
    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    await page.getByRole("button", { name: "Add D to count shift types" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /weekdays/i })
      .click();
    await page.getByTestId("expression-field-op-sq").click();
    await page.getByTestId("expression-field-target").fill("5");
    await page.getByTestId("weight-field-input").fill("1");

    const before = await pastCount(page);
    await page.getByTestId("card-editor-submit").click();

    // Save is blocked: the form stays open with the verbatim error, no mutation.
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(
      page.getByText('Weight must be non-positive for shift count with "|x - T|^2"'),
    ).toBeVisible();
    expect(await pastCount(page)).toBe(before);

    // Fixing the weight to non-positive allows Save.
    await page.getByTestId("weight-field-input").fill("-1");
    await page.getByTestId("card-editor-submit").click();
    await expect(page.getByTestId("count-card-0")).toBeVisible();
    expect((await readCounts(page))[0].expression).toBe("|x - T|^2");
  });
});

test.describe.serial("T12 OFF/LEAVE/ALL selectable and coefficient-bearing (FR-PR-51/78)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("LEAVE is selectable and gets a coefficient row", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    await page
      .getByRole("button", { name: "Add LEAVE — Leave (reserved) to count shift types" })
      .click();
    await expect(page.getByTestId("transfer-count-shift-types-count-shift-types")).toContainText(
      "LEAVE",
    );
    await expect(page.getByTestId("coefficient-fields-input-LEAVE")).toBeVisible();
  });
});

test.describe.serial("T12 generic-array lossless fallback (FR-PR-55a)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("an unmarked array count renders read-only and survives duplicate byte-for-byte", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        affinities: [],
        coverings: [],
        counts: [
          {
            uid: "count-adv",
            description: "Advanced range",
            person: ["Aisha"],
            countDates: ["2026-01-01"],
            countShiftTypes: ["D"],
            expression: ["x >= T", "x <= T"],
            target: [300, 340],
            weight: Infinity,
          },
        ],
      },
    });

    await expect(page.getByTestId("count-advanced-badge-0")).toBeVisible();
    await expect(page.getByTestId("count-readonly-note-0")).toBeVisible();
    await expect(page.getByTestId("count-edit-0")).toHaveCount(0);

    // Edit is blocked, not opened as a form.
    await page.getByTestId("count-readonly-note-0").click();
    await expect(page.getByTestId("card-editor-form")).toHaveCount(0);

    const before = await pastCount(page);
    await page.getByTestId("count-dup-0").click();
    expect((await pastCount(page)) - before).toBe(1);

    const cards = await readCounts(page);
    expect(cards).toHaveLength(2);
    expect(cards[1].expression).toEqual(["x >= T", "x <= T"]);
    expect(cards[1].target).toEqual([300, 340]);
    expect(cards[1].description).toBe("Advanced range copy");
  });
});

test.describe.serial("T12 M2a-2 contracted-hours guided editing", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("a marked card shows Edit (no read-only note) and reopens in the guided editor", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        affinities: [],
        coverings: [],
        counts: [
          {
            uid: "count-ch",
            description: "Monthly contract",
            tag: "contracted_hours",
            policy: "exact",
            unit: "half-hour",
            person: ["Aisha"],
            countDates: ["2026-01-01"],
            countShiftTypes: ["D"],
            expression: "x = T",
            target: 320,
            weight: Infinity,
          },
        ],
      },
    });

    // The badge stays; the marked card is now EDITABLE — Edit button, no read-only note.
    await expect(page.getByTestId("count-contracted-badge-0")).toBeVisible();
    await expect(page.getByTestId("count-readonly-note-0")).toHaveCount(0);
    await expect(page.getByTestId("count-edit-0")).toBeVisible();

    // Edit dispatches to the GUIDED contracted editor (policy toggle + hours target),
    // NOT the ordinary scalar form (which has no policy toggle).
    await page.getByTestId("count-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(page.getByTestId("contracted-policy-exact")).toBeVisible();
    await expect(page.getByTestId("contracted-target-exact")).toHaveValue("160h");
    await expect(page.getByTestId("count-desc")).toHaveCount(0);
  });

  test("Add Contracted Hours creates a marked card that reopens in the guided editor", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("add-contracted-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(page.getByTestId("contracted-policy-exact")).toBeVisible();

    await page.getByTestId("contracted-desc").fill("Full-time contract");
    await page.getByTestId("contracted-target-exact").fill("160h");
    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    await page.getByRole("button", { name: "Add D to count shift types" }).click();
    // Coverage is a hard commit gate (M2a-3): the selected D needs a coefficient.
    await page.getByTestId("contracted-coefficient-fields-input-D").fill("16");
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /all dates/i })
      .click();
    await page.getByTestId("card-editor-submit").click();

    // One tracked mutation; the durable card carries the full marked encoding.
    await expect(page.getByTestId("count-card-0")).toBeVisible();
    await expect(page.getByTestId("count-contracted-badge-0")).toBeVisible();
    expect((await pastCount(page)) - before).toBe(1);

    const cards = await readCounts(page);
    expect(cards).toHaveLength(1);
    expect(cards[0].tag).toBe("contracted_hours");
    expect(cards[0].policy).toBe("exact");
    expect(cards[0].expression).toBe("x = T");
    expect(cards[0].target).toBe(320);
    expect(cards[0].weight).toBe(Infinity);
    expect(cards[0].person).toEqual(["Aisha"]);
    expect(cards[0].countShiftTypes).toEqual(["D"]);

    // Reopening dispatches to the guided editor, not the ordinary form.
    await page.getByTestId("count-edit-0").click();
    await expect(page.getByTestId("contracted-target-exact")).toHaveValue("160h");
    await expect(page.getByTestId("count-desc")).toHaveCount(0);
  });

  test("Add Contracted Hours (Range) encodes the two-bound target", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);

    await page.getByTestId("add-contracted-toggle").click();
    await page.getByTestId("contracted-policy-range").click();
    await page.getByTestId("contracted-target-min").fill("150h");
    await page.getByTestId("contracted-target-max").fill("170h");
    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    await page.getByRole("button", { name: "Add D to count shift types" }).click();
    // Coverage is a hard commit gate (M2a-3): the selected D needs a coefficient.
    await page.getByTestId("contracted-coefficient-fields-input-D").fill("16");
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /all dates/i })
      .click();
    await page.getByTestId("card-editor-submit").click();

    await expect(page.getByTestId("count-card-0")).toBeVisible();
    const cards = await readCounts(page);
    expect(cards[0].policy).toBe("range");
    expect(cards[0].expression).toEqual(["x >= T", "x <= T"]);
    expect(cards[0].target).toEqual([300, 340]);
  });

  test("an ordinary card still edits in the scalar form; an advanced-array card stays read-only", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        affinities: [],
        coverings: [],
        counts: [
          {
            uid: "count-ord",
            description: "Ordinary",
            person: ["Aisha"],
            countDates: ["2026-01-01"],
            countShiftTypes: ["D"],
            expression: "x >= T",
            target: 5,
            weight: -1,
          },
          {
            uid: "count-adv",
            description: "Advanced range",
            person: ["Aisha"],
            countDates: ["2026-01-01"],
            countShiftTypes: ["D"],
            expression: ["x >= T", "x <= T"],
            target: [300, 340],
            weight: Infinity,
          },
        ],
      },
    });

    // Ordinary card → scalar form (has count-desc + expression field, no policy toggle).
    await page.getByTestId("count-edit-0").click();
    await expect(page.getByTestId("count-desc")).toBeVisible();
    await expect(page.getByTestId("contracted-policy-exact")).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel" }).click();

    // Advanced-array card → still read-only, no Edit button.
    await expect(page.getByTestId("count-advanced-badge-1")).toBeVisible();
    await expect(page.getByTestId("count-edit-1")).toHaveCount(0);
    await expect(page.getByTestId("count-readonly-note-1")).toBeVisible();
  });
});

test.describe.serial("T12 M2a-3 contracted coverage-gated commit", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("incomplete coverage blocks Save; completing it saves and round-trips through the shared validator", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);

    await page.getByTestId("add-contracted-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await page.getByTestId("contracted-desc").fill("Full-time contract");
    await page.getByTestId("contracted-target-exact").fill("160h");
    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    // Select TWO worked shift types so the coverage bijection needs both.
    await page.getByRole("button", { name: "Add D to count shift types" }).click();
    await page.getByRole("button", { name: "Add N to count shift types" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /all dates/i })
      .click();

    // Only D gets a coefficient — N is left uncovered.
    await page.getByTestId("contracted-coefficient-fields-input-D").fill("16");

    const before = await pastCount(page);
    await page.getByTestId("card-editor-submit").click();

    // Save is BLOCKED: the form stays open with the coverage aggregate error and no
    // mutation is committed (the draft stays recoverable).
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(page.getByTestId("contracted-coefficient-fields-aggregate-error")).toContainText(
      "coverage is incomplete",
    );
    expect(await pastCount(page)).toBe(before);

    // Completing the coverage lets it save in exactly one tracked mutation.
    await page.getByTestId("contracted-coefficient-fields-input-N").fill("16");
    await page.getByTestId("card-editor-submit").click();
    await expect(page.getByTestId("count-card-0")).toBeVisible();
    expect((await pastCount(page)) - before).toBe(1);

    const cards = await readCounts(page);
    expect(cards[0].tag).toBe("contracted_hours");
    expect(cards[0].target).toBe(320);
    expect(cards[0].countShiftTypeCoefficients).toEqual([
      ["D", 16],
      ["N", 16],
    ]);

    // Round-trip: reopening and re-submitting passes the SAME shared validator the
    // producer boundary uses — the commit gate calls validateContractedHoursContract.
    await page.getByTestId("count-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await page.getByTestId("card-editor-submit").click();
    await expect(page.getByTestId("count-card-0")).toBeVisible();
    expect((await readCounts(page))[0].countShiftTypeCoefficients).toEqual([
      ["D", 16],
      ["N", 16],
    ]);
  });
});

test.describe.serial("T12 ALL date scope (allValue=['ALL']) round-trip", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("selecting ALL validates, saves countDates ['ALL'], and reopens with ALL active", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    await page.getByRole("button", { name: "Add D to count shift types" }).click();
    // Choose the ALL date scope — Counts wires allValue={["ALL"]}, so this must
    // emit the explicit all-dates keyword (non-empty ⇒ passes the required check),
    // NOT clear to [] (which for Counts would mean "count over zero dates").
    const allChip = page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /all dates/i });
    await allChip.click();
    await page.getByTestId("expression-field-target").fill("5");
    await page.getByTestId("card-editor-submit").click();

    // Saved with the explicit ALL keyword and no "date required" error.
    await expect(page.getByTestId("count-card-0")).toBeVisible();
    const cards = await readCounts(page);
    expect(cards).toHaveLength(1);
    expect(cards[0].countDates).toEqual(["ALL"]);

    // Reopening the card shows the ALL chip active (activeScope treats ["ALL"] as ALL).
    await page.getByTestId("count-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(
      page.getByTestId("date-scope-field").getByRole("button", { name: /all dates/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe.serial("T12 Coverings regression — default allValue keeps ALL emitting []", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("Coverings passes no allValue: the ALL date chip clears date to omitted (all dates)", async ({
    page,
  }) => {
    // Guards the shared DateScopeField default: Coverings relies on ALL emitting []
    // so an OMITTED `date` serializes as "all dates" (DL08). This must be unchanged
    // by the Counts allValue addition.
    await page.goto("/shift-type-coverings");
    await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsStore));
    await expect(page.getByTestId("add-card-toggle")).toBeVisible();
    await seed(page, BASE_SEED);

    await page.getByTestId("add-card-toggle").click();
    await page.getByRole("button", { name: "Add Aisha as a preceptor" }).click();
    await page.getByRole("button", { name: "Add Chloe as a preceptee" }).click();
    await page.getByRole("button", { name: "Add D as a covered shift type" }).click();
    // Pick the ALL date chip, then Save.
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /all dates/i })
      .click();
    await page.getByTestId("card-editor-submit").click();

    await expect(page.getByTestId("covering-card-0")).toBeVisible();
    const coverings = await page.evaluate(
      () =>
        (
          window as unknown as {
            __nsStore: {
              scenario: {
                getState: () => { cardsByKind: { coverings: { date?: unknown }[] } };
              };
            };
          }
        ).__nsStore.scenario.getState().cardsByKind.coverings,
    );
    // Coverings' ALL chip clears to [] ⇒ buildCoveringCard OMITS date entirely.
    expect(coverings[0].date).toBeUndefined();
  });
});

test.describe.serial("T12 cold-review fixes (Major)", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("M2 — a valid-values coefficient overlap shows its aggregate error and blocks Save", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, {
      ...BASE_SEED,
      shiftGroups: [{ id: "Both", members: ["D", "N"] }],
    });
    await page.getByTestId("add-card-toggle").click();

    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /weekdays/i })
      .click();
    // Select the group AND its two members, then give every eligible id a VALID value.
    await page.getByRole("button", { name: "Add Both to count shift types" }).click();
    await page.getByRole("button", { name: "Add D to count shift types" }).click();
    await page.getByRole("button", { name: "Add N to count shift types" }).click();
    await page.getByTestId("coefficient-fields-input-D").fill("2");
    await page.getByTestId("coefficient-fields-input-N").fill("3");
    await page.getByTestId("coefficient-fields-input-Both").fill("4");
    await page.getByTestId("expression-field-target").fill("5");

    const before = await pastCount(page);
    await page.getByTestId("card-editor-submit").click();

    // Save blocked, aggregate overlap error visible (M2 — previously silent).
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(page.getByTestId("coefficient-fields-aggregate-error")).toContainText(
      "Shift type coefficients overlap",
    );
    expect(await pastCount(page)).toBe(before);
  });

  test("M3 — deselecting then reselecting a coefficient source yields a fresh blank row", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    await page.getByRole("button", { name: "Add D to count shift types" }).click();
    await page.getByTestId("coefficient-fields-input-D").fill("3");
    // Remove D, then add it back.
    await page.getByRole("button", { name: "Remove D from count shift types" }).click();
    await expect(page.getByTestId("coefficient-fields-input-D")).toHaveCount(0);
    await page.getByRole("button", { name: "Add D to count shift types" }).click();

    // The re-added source is blank, not its stale 3 (FR-PR-73).
    await expect(page.getByTestId("coefficient-fields-input-D")).toHaveValue("");
  });

  test("M4 — an open draft arms the navigation guard on a clean scenario", async ({ page }) => {
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
    expect(new URL(page.url()).pathname).toBe("/shift-counts");
  });

  test("M5 — dragging onto a card's upper half inserts BEFORE it (FR-PR-12)", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        affinities: [],
        coverings: [],
        counts: ["A", "B", "C"].map((d) => ({
          uid: `count-${d}`,
          description: d,
          person: ["Aisha"],
          countDates: ["2026-01-01"],
          countShiftTypes: ["D"],
          expression: "x >= T",
          target: 5,
          weight: -1,
        })),
      },
    });
    await expect(page.getByTestId("count-card-0")).toContainText("A");

    // Drop A onto the UPPER half of C. Native HTML5 DnD is unreliable headless, so
    // dispatch the real drag events with a controlled clientY in C's upper half —
    // this exercises the genuine CardListItem onDrop → pointer-half → reorder wiring.
    // before-C ⇒ [B, A, C]; the old insert-at-index behavior produced [B, C, A].
    // dragstart first (React commits `dragUid` on the next tick — a real drag spans
    // task ticks, so split the dispatch and flush between the two evaluates).
    await page.evaluate(() => {
      const source = document.querySelector('[data-testid="count-card-0"]')!;
      const dt = new DataTransfer();
      (window as unknown as { __dt?: DataTransfer }).__dt = dt;
      source.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      const source = document.querySelector('[data-testid="count-card-0"]')!;
      const target = document.querySelector('[data-testid="count-card-2"]')!;
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
      .poll(async () => (await readCounts(page)).map((rule) => rule.description))
      .toEqual(["B", "A", "C"]);
  });

  test("M6 — Enter saves even with Shift held (FR-PR-05)", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    await page.getByRole("button", { name: "Add D to count shift types" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /weekdays/i })
      .click();
    await page.getByTestId("expression-field-target").fill("5");

    // Focus a field, then Shift+Enter — the Coverings contract would ignore this,
    // but Counts saves on Enter regardless of modifiers.
    await page.getByTestId("count-desc").click();
    await page.keyboard.press("Shift+Enter");

    await expect(page.getByTestId("count-card-0")).toBeVisible();
    const cards = await readCounts(page);
    expect(cards).toHaveLength(1);
    expect(cards[0].countShiftTypes).toEqual(["D"]);
  });
});

test.describe.serial("T12 cold-review fixes (Minor)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("m1 — duplicate uses the unique-copy algorithm (FR-PR-13)", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        affinities: [],
        coverings: [],
        counts: [
          {
            uid: "count-rule",
            description: "Rule",
            person: ["Aisha"],
            countDates: ["2026-01-01"],
            countShiftTypes: ["D"],
            expression: "x >= T",
            target: 5,
            weight: -1,
          },
        ],
      },
    });

    // Duplicate twice → "Rule copy", then "Rule copy 2".
    await page.getByTestId("count-dup-0").click();
    await page.getByTestId("count-dup-0").click();
    const descriptions = (await readCounts(page)).map((rule) => rule.description);
    expect(descriptions).toEqual(["Rule", "Rule copy 2", "Rule copy"]);
  });

  test("m2 — a contracted-hours card carries the brand border accent", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        affinities: [],
        coverings: [],
        counts: [
          {
            uid: "count-ch",
            description: "Monthly contract",
            tag: "contracted_hours",
            policy: "exact",
            person: ["Aisha"],
            countDates: ["2026-01-01"],
            countShiftTypes: ["D"],
            expression: "x = T",
            target: 320,
            weight: Infinity,
          },
        ],
      },
    });

    await expect(page.getByTestId("count-card-0")).toHaveClass(/border-brand/);
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

  async function seedLongCountList(page: Page) {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    // Enough cards to push a lower card well below the fold.
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        affinities: [],
        coverings: [],
        counts: Array.from({ length: 12 }, (_, i) => ({
          uid: `count-${i}`,
          description: `Rule ${i}`,
          person: ["Aisha"],
          countDates: ["2026-01-01"],
          countShiftTypes: ["D"],
          expression: "x >= T",
          target: 5,
          weight: -1,
        })),
      },
    });
  }

  test("m3 — editing a lower card scrolls to the form, and Save restores the offset", async ({
    page,
  }) => {
    await seedLongCountList(page);

    // Scroll the container down to the last card and record the pre-edit offset.
    await page.getByTestId("count-card-11").scrollIntoViewIfNeeded();
    const preEdit = await scrollerTop(page);
    expect(preEdit).toBeGreaterThan(0);

    await page.getByTestId("count-edit-11").click();
    // The edit form is open and the container scrolled toward the top (FR-PR-07).
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect.poll(() => scrollerTop(page)).toBe(0);

    // Save (a no-op edit is fine — Update still closes the form). The FINAL offset
    // must return to the recorded pre-edit value once the form has unmounted and
    // the list layout collapsed back. The old synchronous restore landed short.
    await page.getByTestId("card-editor-submit").click();
    await expect(page.getByTestId("card-editor-form")).toHaveCount(0);
    await expect.poll(() => scrollerTop(page)).toBeGreaterThanOrEqual(preEdit - 5);
  });

  test("m3 — Cancel from an edit also restores the pre-edit scroll offset", async ({ page }) => {
    await seedLongCountList(page);

    await page.getByTestId("count-card-11").scrollIntoViewIfNeeded();
    const preEdit = await scrollerTop(page);
    expect(preEdit).toBeGreaterThan(0);

    await page.getByTestId("count-edit-11").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect.poll(() => scrollerTop(page)).toBe(0);

    // Cancel closes the form; the offset returns to the recorded pre-edit value.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("card-editor-form")).toHaveCount(0);
    await expect.poll(() => scrollerTop(page)).toBeGreaterThanOrEqual(preEdit - 5);
  });

  test("temporal change closes an open edit and an immediate stale Save cannot overwrite Redo", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    const original = {
      uid: "temporal-count",
      description: "Original",
      person: ["Aisha"],
      countDates: ["2026-01-01"],
      countShiftTypes: ["D"],
      expression: "x >= T",
      target: 1,
      weight: -1,
    };
    const redone = { ...original, description: "Redone by temporal change" };
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        affinities: [],
        coverings: [],
        counts: [original],
      },
    });
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [],
        affinities: [],
        coverings: [],
        counts: [redone],
      },
    });
    await page.evaluate(() =>
      (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().undo(),
    );
    await expect(page.getByTestId("count-card-0")).toContainText("Original");

    const before = await pastCount(page);
    await page.getByTestId("count-edit-0").click();
    await page.getByTestId("count-desc").fill("Stale local edit");
    // Reproduce the render→effect race: Redo and submit occur synchronously in
    // one task, before React can passively close the stale draft. Require the
    // Submit control — an optional-chained `?.click()` would silently no-op if it
    // were missing, letting the passive stale-close alone satisfy the assertions
    // below and mask a broken synchronous guard (a false green).
    await page.evaluate(() => {
      const store = (window as unknown as NsWindow).__nsStore.scenario;
      store.temporal.getState().redo();
      const submit = document.querySelector<HTMLElement>('[data-testid="card-editor-submit"]');
      if (!submit)
        throw new Error("card-editor-submit not found — cannot exercise the stale Save race");
      submit.click();
    });

    await expect(page.getByTestId("card-editor-form")).toHaveCount(0);
    await expect(page.getByTestId("count-card-0")).toContainText("Redone by temporal change");
    expect((await readCounts(page))[0].description).toBe("Redone by temporal change");
    expect(await pastCount(page)).toBe(before + 1); // Redo only; stale Save adds no entry.
  });
});
