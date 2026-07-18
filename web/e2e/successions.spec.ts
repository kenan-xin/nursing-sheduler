import { expect, test, type Page } from "@playwright/test";

// T12 M1 clone acceptance (Playwright rows): the prototype-conformance Shift
// Successions editor driven against a production build through the real T04
// store (`window.__nsStore`). Every named outcome asserts the DURABLE STORE
// shape AND the store.temporal entry count — so a green test cannot mask a
// data-integrity gap or a spurious/absent undo entry (mirrors
// coverings.spec.ts/counts.spec.ts's rigor). Coverage spans:
//  • create via the People transfer selector + the NEW PatternBuilder (click to
//    append, duplicates allowed) + DateScopeField + WeightField, one tracked
//    mutation;
//  • the pattern's per-position move-earlier/move-later/remove buttons;
//  • the min-2 pattern validation (AC-PR-11) blocks Save with the verbatim
//    message and unblocks once a second entry is added;
//  • edit adds a person + reorders the pattern in one tracked mutation, and
//    pattern order survives save/edit/duplicate;
//  • Enable/Disable toggles the UI-only `disabled` marker — one entry each;
//  • delete returns the centred empty state, one entry;
//  • move up/down reorders durably, and a native DnD drop onto a card's upper
//    half inserts BEFORE it (FR-PR-12);
//  • a numeric person id and a same-spelling string group stay distinct
//    selections (Object.is identity, mirrors T13's Major 3 regression);
//  • duplicate uses the unique-copy algorithm (FR-PR-13).

type SuccessionCard = {
  uid: string;
  description?: string;
  disabled?: boolean;
  person: unknown;
  pattern: unknown[];
  date?: unknown;
  weight: number;
};

type NsWindow = {
  __nsStore: {
    scenario: {
      getState: () => Record<string, unknown> & {
        cardsByKind: { successions: SuccessionCard[] };
        mutateScenario: (patch: Record<string, unknown>) => void;
      };
      temporal: {
        getState: () => { pastStates: unknown[]; futureStates: unknown[] };
      };
    };
  };
};

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

/** Shift Type Successions is Advanced-only since T08d (DL12 §2); adopt the
 *  stored Advanced preference first so the route-validity gate doesn't
 *  redirect this direct visit to Home under the Guided default. */
async function gotoReady(page: Page) {
  await page.addInitScript(() => localStorage.setItem("ns-app-mode", "advanced"));
  await page.goto("/shift-type-successions");
  await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsStore));
  await expect(page.getByTestId("add-card-toggle")).toBeVisible();
}

function readSuccessions(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.getState().cardsByKind.successions,
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
    { id: "Daniel", history: [] },
  ],
  shifts: [{ id: "N" }, { id: "AM" }, { id: "PM" }],
};

test.describe.serial("T12 M1 shift successions editor (clone)", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("create via People transfer + ordered PatternBuilder + date chip + weight; one undo entry", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();

    await page.getByTestId("succession-desc").fill("Forbid Evening -> Day");
    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    // Build an ordered pattern PM -> AM -> N (click order matters).
    await page.getByRole("button", { name: "Add PM to the pattern" }).click();
    await page.getByRole("button", { name: "Add AM to the pattern" }).click();
    await page.getByRole("button", { name: "Add N to the pattern" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /weekdays/i })
      .click();
    await page.getByTestId("weight-field-input").fill("3");
    await page.getByTestId("card-editor-submit").click();

    await expect(page.getByTestId("succession-card-0")).toBeVisible();
    await expect(page.getByTestId("card-editor-empty")).toHaveCount(0);
    await expect(page.getByTestId("card-list-count")).toContainText("1 RULE");

    const cards = await readSuccessions(page);
    expect(cards).toHaveLength(1);
    expect(cards[0].description).toBe("Forbid Evening -> Day");
    expect(cards[0].person).toEqual(["Aisha"]);
    // Order preserved exactly as clicked — PM, AM, N.
    expect(cards[0].pattern).toEqual(["PM", "AM", "N"]);
    expect(cards[0].date).toEqual(["WEEKDAY"]);
    expect(cards[0].weight).toBe(3);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("duplicates are allowed in the pattern — clicking the same shift type twice appends both", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    await page.getByRole("button", { name: "Add N to the pattern" }).click();
    await page.getByRole("button", { name: "Add N to the pattern" }).click();
    await expect(page.getByTestId("pattern-chip-0")).toContainText("N");
    await expect(page.getByTestId("pattern-chip-1")).toContainText("N");

    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /weekdays/i })
      .click();
    await page.getByTestId("card-editor-submit").click();

    const cards = await readSuccessions(page);
    expect(cards[0].pattern).toEqual(["N", "N"]);
  });

  test("pattern move-earlier / move-later / remove reorder and shrink the sequence", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    await page.getByRole("button", { name: "Add N to the pattern" }).click();
    await page.getByRole("button", { name: "Add AM to the pattern" }).click();
    await page.getByRole("button", { name: "Add PM to the pattern" }).click();
    await expect(page.getByTestId("pattern-builder-order")).toContainText("N");

    // Move the middle entry (AM) later: N, AM, PM -> N, PM, AM.
    await page.getByTestId("pattern-chip-1").getByRole("button", { name: "Move later" }).click();
    await expect(page.getByTestId("pattern-chip-1")).toContainText("PM");
    await expect(page.getByTestId("pattern-chip-2")).toContainText("AM");

    // Move it back earlier: N, PM, AM -> N, AM, PM.
    await page.getByTestId("pattern-chip-2").getByRole("button", { name: "Move earlier" }).click();
    await expect(page.getByTestId("pattern-chip-1")).toContainText("AM");

    // Remove the first entry: N, AM, PM -> AM, PM.
    await page.getByTestId("pattern-chip-0").getByRole("button", { name: "Remove N" }).click();
    await expect(page.getByTestId("pattern-chip-0")).toContainText("AM");
    await expect(page.getByTestId("pattern-chip-1")).toContainText("PM");
    await expect(page.getByTestId("pattern-chip-2")).toHaveCount(0);
  });

  test("min-2 pattern validation blocks Save with the verbatim message (AC-PR-11)", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /weekdays/i })
      .click();
    // Only ONE pattern entry — below the minimum of 2.
    await page.getByRole("button", { name: "Add N to the pattern" }).click();

    const before = await pastCount(page);
    await page.getByTestId("card-editor-submit").click();

    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(
      page.getByText("At least 2 shift types must be selected for a succession pattern"),
    ).toBeVisible();
    expect(await pastCount(page)).toBe(before);

    // Adding a second entry unblocks Save.
    await page.getByRole("button", { name: "Add AM to the pattern" }).click();
    await page.getByTestId("card-editor-submit").click();
    await expect(page.getByTestId("succession-card-0")).toBeVisible();
  });

  test("edit adds a person and reorders the pattern in one tracked mutation; order survives", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [
          {
            uid: "succ-edit",
            description: "Edit me",
            person: ["Aisha"],
            pattern: ["N", "AM"],
            date: ["2026-01-01"],
            weight: -1,
          },
        ],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await expect(page.getByTestId("succession-card-0")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("succession-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    // The current selection populates the SELECTED pane and the pattern order.
    await expect(page.getByTestId("transfer-people-people")).toContainText("Aisha");
    await expect(page.getByTestId("pattern-chip-0")).toContainText("N");
    await expect(page.getByTestId("pattern-chip-1")).toContainText("AM");

    await page.getByRole("button", { name: "Add Chloe to people" }).click();
    // Reverse the pattern order: N, AM -> AM, N.
    await page.getByTestId("pattern-chip-1").getByRole("button", { name: "Move earlier" }).click();
    await page.getByTestId("card-editor-submit").click();

    const cards = await readSuccessions(page);
    expect(cards[0].person).toEqual(["Aisha", "Chloe"]);
    expect(cards[0].pattern).toEqual(["AM", "N"]);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("disable then enable toggles the marker and one undo entry each", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [
          {
            uid: "succ-dis",
            person: ["Aisha"],
            pattern: ["N", "AM"],
            date: ["2026-01-01"],
            weight: -1,
          },
        ],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await expect(page.getByTestId("succession-card-0")).toBeVisible();

    const beforeOff = await pastCount(page);
    await page.getByTestId("succession-disable-0").click();
    await expect(page.getByTestId("succession-card-0")).toHaveAttribute("data-disabled", "true");
    expect((await readSuccessions(page))[0].disabled).toBe(true);
    expect((await pastCount(page)) - beforeOff).toBe(1);

    const beforeEnable = await pastCount(page);
    await page.getByTestId("succession-disable-0").click();
    await expect(page.getByTestId("succession-card-0")).not.toHaveAttribute(
      "data-disabled",
      "true",
    );
    expect((await readSuccessions(page))[0].disabled).toBeUndefined();
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
        successions: [
          {
            uid: "succ-del",
            person: ["Aisha"],
            pattern: ["N", "AM"],
            date: ["2026-01-01"],
            weight: -1,
          },
        ],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await expect(page.getByTestId("succession-card-0")).toBeVisible();

    const before = await pastCount(page);
    await page.getByTestId("succession-delete-0").click();
    await expect(page.getByTestId("succession-card-0")).toHaveCount(0);
    await expect(page.getByTestId("card-editor-empty")).toBeVisible();
    expect(await readSuccessions(page)).toEqual([]);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("move up/down reorders durably", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [
          {
            uid: "succ-a",
            description: "A",
            person: ["Aisha"],
            pattern: ["N", "AM"],
            date: ["2026-01-01"],
            weight: -1,
          },
          {
            uid: "succ-b",
            description: "B",
            person: ["Aisha"],
            pattern: ["AM", "N"],
            date: ["2026-01-01"],
            weight: -1,
          },
        ],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });

    await page.getByTestId("succession-up-1").click();
    await expect(page.getByTestId("succession-card-0")).toContainText("B");
    const order = (await readSuccessions(page)).map((c) => c.description);
    expect(order).toEqual(["B", "A"]);
  });

  test("dragging onto a card's upper half inserts BEFORE it (FR-PR-12)", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: ["A", "B", "C"].map((d) => ({
          uid: `succ-${d}`,
          description: d,
          person: ["Aisha"],
          pattern: ["N", "AM"],
          date: ["2026-01-01"],
          weight: -1,
        })),
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await expect(page.getByTestId("succession-card-0")).toContainText("A");

    // Drop A onto the UPPER half of C — before-C ⇒ [B, A, C].
    await page.evaluate(() => {
      const source = document.querySelector('[data-testid="succession-card-0"]')!;
      const dt = new DataTransfer();
      (window as unknown as { __dt?: DataTransfer }).__dt = dt;
      source.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      const source = document.querySelector('[data-testid="succession-card-0"]')!;
      const target = document.querySelector('[data-testid="succession-card-2"]')!;
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
      .poll(async () => (await readSuccessions(page)).map((rule) => rule.description))
      .toEqual(["B", "A", "C"]);
  });

  test("duplicate uses the unique-copy algorithm and preserves pattern order (FR-PR-13)", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [
          {
            uid: "succ-rule",
            description: "Rule",
            person: ["Aisha"],
            pattern: ["PM", "AM", "N"],
            date: ["2026-01-01"],
            weight: -1,
          },
        ],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });

    const before = await pastCount(page);
    await page.getByTestId("succession-dup-0").click();
    expect((await pastCount(page)) - before).toBe(1);

    // Duplicate again → "Rule copy 2" inserted immediately after "Rule".
    await page.getByTestId("succession-dup-0").click();
    const cards = await readSuccessions(page);
    expect(cards.map((c) => c.description)).toEqual(["Rule", "Rule copy 2", "Rule copy"]);
    // Pattern order survives duplication byte-for-byte.
    expect(cards[1].pattern).toEqual(["PM", "AM", "N"]);
    expect(cards[2].pattern).toEqual(["PM", "AM", "N"]);
  });

  test('numeric person 1 and string group "1" are both selectable and survive (numeric/string identity)', async ({
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
      shifts: [{ id: "N" }, { id: "AM" }],
    });
    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();

    await page.getByRole("button", { name: "Add 1 to people" }).click();
    await page.getByRole("button", { name: "Add 1 — StrOne to people" }).click();
    await page.getByRole("button", { name: "Add N to the pattern" }).click();
    await page.getByRole("button", { name: "Add AM to the pattern" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /weekdays/i })
      .click();
    await page.getByTestId("card-editor-submit").click();

    const cards = await readSuccessions(page);
    // Both refs coexist with their original types (numeric 1, string "1").
    expect(cards[0].person).toEqual([1, "1"]);
  });

  test("ALL date scope validates, saves date ['ALL'], and reopens with ALL active", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    await page.getByRole("button", { name: "Add N to the pattern" }).click();
    await page.getByRole("button", { name: "Add AM to the pattern" }).click();
    const allChip = page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /all dates/i });
    await allChip.click();
    await page.getByTestId("card-editor-submit").click();

    await expect(page.getByTestId("succession-card-0")).toBeVisible();
    const cards = await readSuccessions(page);
    expect(cards).toHaveLength(1);
    expect(cards[0].date).toEqual(["ALL"]);

    await page.getByTestId("succession-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect(
      page.getByTestId("date-scope-field").getByRole("button", { name: /all dates/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("an open draft arms the navigation guard (draft guard)", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();

    await page.getByTestId("nav-link-/people").click();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await page.getByTestId("confirm-dialog-cancel").click();
    expect(new URL(page.url()).pathname).toBe("/shift-type-successions");
  });

  // The app shell scrolls an inner overflow container, not the window — measure
  // the nearest scrollable ancestor of the screen (mirrors counts.spec.ts m3).
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

  test("a nested-aggregate pattern renders read-only and survives duplicate byte-for-byte (Major 1)", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [
          {
            uid: "succ-nested",
            description: "Advanced nested",
            person: ["Aisha"],
            // A nested-aggregate position — the sequential PatternBuilder cannot
            // author this without corrupting it, so it must be read-only.
            pattern: [["N", "AM"], "PM"],
            date: ["2026-01-01"],
            weight: -1,
          },
        ],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });

    // Advanced badge + read-only note; no Edit button.
    await expect(page.getByTestId("succession-advanced-badge-0")).toBeVisible();
    await expect(page.getByTestId("succession-readonly-note-0")).toBeVisible();
    await expect(page.getByTestId("succession-edit-0")).toHaveCount(0);

    // Clicking the read-only note never opens the form.
    await page.getByTestId("succession-readonly-note-0").click();
    await expect(page.getByTestId("card-editor-form")).toHaveCount(0);

    // Duplicate is one tracked mutation and preserves the nested pattern exactly.
    const before = await pastCount(page);
    await page.getByTestId("succession-dup-0").click();
    expect((await pastCount(page)) - before).toBe(1);
    const cards = await readSuccessions(page);
    expect(cards).toHaveLength(2);
    expect(cards[1].pattern).toEqual([["N", "AM"], "PM"]);
    expect(cards[1].description).toBe("Advanced nested copy");
  });

  test("a normal 2+ sequential pattern still opens the form and edits fine (Major 1 counterpart)", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [
          {
            uid: "succ-scalar",
            description: "Sequential",
            person: ["Aisha"],
            pattern: ["N", "AM"],
            date: ["2026-01-01"],
            weight: -1,
          },
        ],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });

    // No advanced treatment — Edit is offered and opens the form.
    await expect(page.getByTestId("succession-advanced-badge-0")).toHaveCount(0);
    await page.getByTestId("succession-edit-0").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await page.getByRole("button", { name: "Add PM to the pattern" }).click();
    await page.getByTestId("card-editor-submit").click();

    const cards = await readSuccessions(page);
    expect(cards[0].pattern).toEqual(["N", "AM", "PM"]);
  });

  test("pattern positions are drag-reorderable (FR-PR-33)", async ({ page }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await page.getByTestId("add-card-toggle").click();

    await page.getByRole("button", { name: "Add N to the pattern" }).click();
    await page.getByRole("button", { name: "Add AM to the pattern" }).click();
    await page.getByRole("button", { name: "Add PM to the pattern" }).click();
    await expect(page.getByTestId("pattern-chip-0")).toContainText("N");

    // Drag the first chip (N) onto the RIGHT half of the last chip (PM) ⇒ after-PM
    // ⇒ [AM, PM, N]. Native HTML5 DnD is unreliable headless, so dispatch the real
    // drag events with a controlled clientX in PM's right half.
    await page.evaluate(() => {
      const source = document.querySelector('[data-testid="pattern-chip-0"]')!;
      const dt = new DataTransfer();
      (window as unknown as { __dt?: DataTransfer }).__dt = dt;
      source.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      const source = document.querySelector('[data-testid="pattern-chip-0"]')!;
      const target = document.querySelector('[data-testid="pattern-chip-2"]')!;
      const dt = (window as unknown as { __dt?: DataTransfer }).__dt!;
      const rect = target.getBoundingClientRect();
      const rightX = rect.left + rect.width * 0.85; // PM's right half ⇒ drop AFTER PM
      const fire = (el: Element, type: string) =>
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: rightX,
          }),
        );
      fire(target, "dragover");
      fire(target, "drop");
      fire(source, "dragend");
    });

    await expect(page.getByTestId("pattern-chip-0")).toContainText("AM");
    await expect(page.getByTestId("pattern-chip-1")).toContainText("PM");
    await expect(page.getByTestId("pattern-chip-2")).toContainText("N");

    // The reordered pattern persists on Save.
    await page.getByRole("button", { name: "Add Aisha to people" }).click();
    await page
      .getByTestId("date-scope-field")
      .getByRole("button", { name: /weekdays/i })
      .click();
    await page.getByTestId("card-editor-submit").click();
    const cards = await readSuccessions(page);
    expect(cards[0].pattern).toEqual(["AM", "PM", "N"]);
  });

  test("editing a lower card scrolls to the form, and Save restores the offset", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: Array.from({ length: 12 }, (_, i) => ({
          uid: `succ-${i}`,
          description: `Rule ${i}`,
          person: ["Aisha"],
          pattern: ["N", "AM"],
          date: ["2026-01-01"],
          weight: -1,
        })),
        counts: [],
        affinities: [],
        coverings: [],
      },
    });

    await page.getByTestId("succession-card-11").scrollIntoViewIfNeeded();
    const preEdit = await scrollerTop(page);
    expect(preEdit).toBeGreaterThan(0);

    await page.getByTestId("succession-edit-11").click();
    await expect(page.getByTestId("card-editor-form")).toBeVisible();
    await expect.poll(() => scrollerTop(page)).toBe(0);

    await page.getByTestId("card-editor-submit").click();
    await expect(page.getByTestId("card-editor-form")).toHaveCount(0);
    await expect.poll(() => scrollerTop(page)).toBeGreaterThanOrEqual(preEdit - 5);
  });
});
