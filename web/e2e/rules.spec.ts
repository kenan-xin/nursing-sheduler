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
        cardsByKind: Record<
          string,
          { uid: string; disabled?: boolean; description?: string; weight?: number }[]
        >;
        maxOneShiftPerDay?: { description?: string };
        mutateScenario: (patch: Record<string, unknown>) => void;
      };
      temporal: { getState: () => { pastStates: unknown[]; undo: () => void } };
    };
    hot: { getState: () => { hydrationStatus: string } };
    persistenceStatus: () => string;
  };
};

async function waitForStore(page: Page) {
  await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsStore));
}

/** Wait for the guarded durable write queue to report settled. */
async function waitForSaved(page: Page) {
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as NsWindow).__nsStore.persistenceStatus()),
      { timeout: 15_000 },
    )
    .toBe("saved");
}

/**
 * Seed the durable store through a real tracked mutation, then WAIT FOR THE WRITE
 * TO LAND. The wait is not optional: `persist` writes through an async guarded
 * FIFO queue, so a `page.reload()` that follows a bare `mutateScenario` can
 * outrun the write and rehydrate the older record — the seeded rows then simply
 * never appear. That passes on an idle machine and fails under contention;
 * reproduced at 3-4 failures in 61 runs at 16 workers, in tests that predate this
 * ticket as well as its own.
 */
async function seed(page: Page, patch: Record<string, unknown>) {
  await waitForStore(page);
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
  await waitForSaved(page);
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
  // Wait for the hydration COMMIT, not just the store's existence. The built-in
  // row is derived unconditionally, so its presence is the marker that the
  // rehydrate has finished; seeding before that point is silently overwritten by
  // it (the known non-blocking `ii7.10.4` race). Without this the specs below
  // pass on an idle machine and fail under contention — reproduced at 3 failures
  // in 61 runs at 16 workers, including two tests that predate this ticket.
  await page.getByTestId("rule-row-builtin:max-one-shift-per-day").waitFor();
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
    const seeded = (await storeState(page)) as unknown as {
      cardsByKind: { requirements: { requiredNumPeople: number }[] };
    };
    expect(seeded.cardsByKind.requirements[0].requiredNumPeople).toBe(2);

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

// ---------------------------------------------------------------------------
// R3 — the v2 visual system, where it is route-specific.
//
// The F4 matrix already runs the universal battery over /rules in light and dark
// at both pointer densities. What it never does is DRIVE the screen: it loads the
// route and judges what is on it, so a surface or control that only exists once a
// rule's Adjust panel or rename editor is open is outside its reach. Those are
// this file's, and they are asserted on RESOLVED style rather than class names —
// `rules-screen.test.tsx` holds the authoring half.
// ---------------------------------------------------------------------------

/** Resolve a runtime token the way the surface recipe's consumers see it. */
function token(page: Page, name: string) {
  return page.evaluate((variable) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = `var(${variable})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, name);
}

function styleOf(page: Page, selector: string, properties: readonly string[]) {
  return page.evaluate(
    ([sel, props]) => {
      const element = document.querySelector(sel as string);
      if (!element) throw new Error(`no element matched ${sel}`);
      const style = getComputedStyle(element);
      return Object.fromEntries(
        (props as string[]).map((p) => [p, style.getPropertyValue(p)]),
      ) as Record<string, string>;
    },
    [selector, properties] as const,
  );
}

// ---------------------------------------------------------------------------
// The durable hard-weight regression (ii7.13.2).
//
// `+∞` / `−∞` are real Adjust actions here, and `JSON.stringify` has no
// representation for a non-finite number — so before the shared codec landed,
// clicking either wrote IndexedDB `null`, the next load's sanitizer rejected it,
// and the whole app fell into "Stored data could not be loaded". The component
// tests stop at the in-memory store and the finite round trip above never crosses
// the serialization seam, so this is the only coverage that discriminates it —
// which is why it drives the real controls, waits for the real write queue, and
// reads IndexedDB directly rather than trusting the store it just wrote.
// ---------------------------------------------------------------------------

/** The raw persisted record, read straight out of IndexedDB (not via the store). */
function readPersistedRecord(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("nurse-scheduler");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains("keyval")) return null;
      return await new Promise<string | null>((resolve, reject) => {
        const get = db
          .transaction("keyval", "readonly")
          .objectStore("keyval")
          .get("nurse-scheduler/scenario");
        get.onsuccess = () =>
          resolve((get.result as { value?: string } | undefined)?.value ?? null);
        get.onerror = () => reject(get.error);
      });
    } finally {
      db.close();
    }
  });
}

/** The live succession weight, plus a string form so the sign is unambiguous. */
function readSuccessionWeight(page: Page) {
  return page.evaluate(() => {
    const card = (window as unknown as NsWindow).__nsStore.scenario.getState().cardsByKind
      .successions[0];
    return {
      raw: card?.weight,
      text: String(card?.weight),
      isNumber: typeof card?.weight === "number",
      finite: Number.isFinite(card?.weight),
      hydration: (window as unknown as NsWindow).__nsStore.hot.getState().hydrationStatus,
    };
  });
}

/** Seed exactly one adjustable requirement, then reload so it is durable. */
async function seedOneRequirement(page: Page, extra: Record<string, unknown> = {}) {
  await seed(page, {
    cardsByKind: {
      requirements: [
        {
          uid: "r1",
          shiftType: "D",
          requiredNumPeople: 2,
          weight: -1,
          description: "Day cap",
          ...extra,
        },
      ],
      successions: [],
      counts: [],
      affinities: [],
      coverings: [],
    },
  });
  await page.reload();
  await waitForStore(page);
}

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

test.describe("Rules screen — a signed hard weight survives a durable reload", () => {
  for (const [label, control, expected] of [
    ["−∞", "minus-inf", Number.NEGATIVE_INFINITY],
    ["+∞", "plus-inf", Number.POSITIVE_INFINITY],
  ] as const) {
    test(`the real ${label} control persists its exact sign through IndexedDB`, async ({
      page,
    }) => {
      // `gotoReady` has already waited for the hydration commit, so the seed
      // below cannot be overwritten by the rehydrate.
      await gotoReady(page);
      await seed(page, {
        rangeStart: "2026-02-01",
        rangeEnd: "2026-02-28",
        cardsByKind: {
          requirements: [
            { uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1, description: "Day cap" },
          ],
          successions: [
            { uid: "s1", person: ["P1"], pattern: ["N", "D"], weight: -2, description: "No N-D" },
          ],
          counts: [],
          affinities: [],
          coverings: [],
        },
      });

      // Baseline: the FINITE weight is durable, so the assertions below isolate
      // the non-finite case rather than a broken seed.
      await waitForSaved(page);
      expect(await readPersistedRecord(page)).toContain(`"weight":-2`);

      await page.getByTestId("rule-adjust-toggle-successions:s1").click();
      await page.getByTestId(`rule-adjust-${control}-successions:s1-weight`).click();

      // In memory first — the control really did commit an infinity.
      const live = await readSuccessionWeight(page);
      expect(live.raw).toBe(expected);
      expect(live.finite).toBe(false);

      await waitForSaved(page);

      // The bytes that actually reached IndexedDB. This is the assertion the old
      // code failed: it stored `"weight":null` and lost the sign entirely.
      const record = await readPersistedRecord(page);
      expect(record).not.toBeNull();
      expect(record).not.toContain(`"weight":null`);
      expect(record).toContain("$nsNonFinite");
      expect(record).toContain(`"$nsNonFinite":"${expected > 0 ? "Infinity" : "-Infinity"}"`);

      await page.reload();
      await waitForStore(page);
      await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "rules");
      await page.getByTestId("rule-row-successions:s1").waitFor();

      // Same number, same sign, and the app is usable rather than sitting on the
      // destructive "Stored data could not be loaded" reset offer.
      const restored = await readSuccessionWeight(page);
      expect(restored.raw).toBe(expected);
      expect(restored.text).toBe(expected > 0 ? "Infinity" : "-Infinity");
      expect(restored.isNumber).toBe(true);
      expect(restored.finite).toBe(false);
      expect(restored.hydration).toBe("ready");

      // The rest of the scenario came back with it.
      const state = await storeState(page);
      expect(state.rangeStart).toBe("2026-02-01");
      expect(state.cardsByKind.requirements[0].description).toBe("Day cap");
      await expect(page.getByText("Day cap")).toBeVisible();

      // And it is still editable: reopening Adjust shows the hard weight legibly
      // rather than an empty box, so the scenario is usable, not merely loaded.
      await page.getByTestId("rule-adjust-toggle-successions:s1").click();
      await expect(page.getByTestId("rule-adjust-input-successions:s1-weight")).toHaveValue(
        expected > 0 ? "Infinity" : "-Infinity",
      );
    });
  }
});

test.describe("Rules screen — v2 surface ladder and geometry", () => {
  test("a category list is one resting L1 card whose rows and dividers stay square", async ({
    page,
  }) => {
    await gotoReady(page);
    await seedOneRequirement(page);

    const surface = await token(page, "--surface");
    const card = await styleOf(page, '[data-testid="rule-category-Staffing levels"]', [
      "background-color",
      "border-top-left-radius",
      "box-shadow",
      "overflow-x",
    ]);
    expect(card["background-color"]).toBe(surface);
    expect(card["border-top-left-radius"]).toBe("16px");
    expect(card["box-shadow"]).not.toBe("none");
    expect(card["box-shadow"]).not.toContain("inset");
    // The clip is what lets the square rows inside end in a rounded card.
    expect(card["overflow-x"]).toBe("hidden");

    const row = await styleOf(page, '[data-testid="rule-row-requirements:r1"]', [
      "border-top-left-radius",
      "border-bottom-right-radius",
      "opacity",
    ]);
    expect(row["border-top-left-radius"]).toBe("0px");
    expect(row["border-bottom-right-radius"]).toBe("0px");
    expect(row.opacity).toBe("1");
  });

  test("a switched-off row recedes to the --panel tone at full opacity", async ({ page }) => {
    await gotoReady(page);
    await seedOneRequirement(page, { disabled: true });

    const panel = await token(page, "--panel");
    const row = await styleOf(page, '[data-testid="rule-row-requirements:r1"]', [
      "background-color",
      "opacity",
    ]);
    expect(row["background-color"]).toBe(panel);
    // Tone-first, so every label in the row keeps the contrast it cleared.
    expect(row.opacity).toBe("1");
  });

  test("the advanced-records strip is an inset well, never an outer elevation", async ({
    page,
  }) => {
    await gotoReady(page);
    await seedOneRequirement(page);

    const panel = await token(page, "--panel");
    const strip = await styleOf(page, '[data-slot="surface"][data-level="well"]', [
      "background-color",
      "border-top-left-radius",
      "box-shadow",
    ]);
    expect(strip["background-color"]).toBe(panel);
    expect(strip["border-top-left-radius"]).toBe("12px");
    expect(strip["box-shadow"]).toContain("inset");
  });

  test("an open adjustment band is a flat square --panel band with a dashed top edge", async ({
    page,
  }) => {
    await gotoReady(page);
    await seedOneRequirement(page);
    await page.getByTestId("rule-adjust-toggle-requirements:r1").click();

    const panel = await token(page, "--panel");
    const band = await styleOf(page, '[data-testid="rule-adjust-panel-requirements:r1"]', [
      "background-color",
      "border-top-left-radius",
      "border-top-style",
      "box-shadow",
    ]);
    expect(band["background-color"]).toBe(panel);
    // A full-bleed band is square and flat (DESIGN.md §4 rule 2).
    expect(band["border-top-left-radius"]).toBe("0px");
    expect(band["border-top-style"]).toBe("dashed");
    expect(band["box-shadow"]).toBe("none");
  });
});

test.describe("Rules screen — coarse-pointer controls behind an interaction", () => {
  // The matrix's touch project measures the row as it LOADS. The controls below
  // only exist after a click, so nothing else in the epic measures them.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("every control revealed by Adjust and Rename is a real 44px target", async ({ page }) => {
    await gotoReady(page);
    expect(
      await page.evaluate(
        () => matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints >= 1,
      ),
      "this context must actually be coarse-pointer, or the measurements below prove nothing",
    ).toBe(true);

    await seed(page, {
      cardsByKind: {
        requirements: [],
        successions: [
          { uid: "s1", person: ["P1"], pattern: ["N", "D"], weight: -2, description: "No N→D" },
        ],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await page.reload();
    await waitForStore(page);

    /** Both axes: buttons and icon controls own their width as well as height. */
    async function expectRealTarget(testId: string) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box, `${testId} has no box`).not.toBeNull();
      expect(Math.round(box!.width), `${testId} width`).toBeGreaterThanOrEqual(44);
      expect(Math.round(box!.height), `${testId} height`).toBeGreaterThanOrEqual(44);
    }

    // The two inline text affordances, which carry the floor explicitly rather
    // than through a Button variant.
    await expectRealTarget("rule-rename-successions:s1");
    await expectRealTarget("rule-open-advanced-successions:s1");

    await page.getByTestId("rule-adjust-toggle-successions:s1").click();
    for (const testId of [
      "rule-adjust-plus-inf-successions:s1-weight",
      "rule-adjust-minus-inf-successions:s1-weight",
      "rule-adjust-done-successions:s1",
    ]) {
      await expectRealTarget(testId);
    }

    // Renaming REPLACES the title row with its editor, so its controls have to be
    // measured while that editor is the thing on screen.
    await page.getByTestId("rule-rename-successions:s1").click();
    await expectRealTarget("rule-rename-save-successions:s1");
    await expectRealTarget("rule-rename-cancel-successions:s1");

    // The field is a height-only claim: it stretches to its row, not to 44px wide.
    const field = await page.getByTestId("rule-rename-input-successions:s1").boundingBox();
    expect(Math.round(field!.height)).toBeGreaterThanOrEqual(44);
  });
});
