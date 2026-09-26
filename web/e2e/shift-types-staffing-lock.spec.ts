import { expect, test, type Page } from "@playwright/test";

// Bead 5mr (DR-4 follow-up): the read-only staffing lock's BROWSER contract. The
// group/qualified/date-scoped read-only path and its deep-link were pinned only
// at the jsdom component level (components/shift-types/shift-type-grid.test.tsx),
// so a regression in the shipped mounting path could slip through. This drives
// the same invariants through a production build and the real durable store
// (`window.__nsStore`):
//   (a) a group / qualified / date-scoped requirement renders the shift card
//       read-only — value + reason + deep-link, and NO editable staffing inputs;
//   (b) that deep-link navigates to the Staffing Requirements route
//       (`/shift-type-requirements`).
// The Min/Preferred EDITABLE tie-in is covered separately in
// components/shift-types/save-shift-card.test.ts (vitest) and is not restated here.

type NsWindow = {
  __nsStore: {
    /** The repository command bus — the product's only durable write path. */
    commands: { mutate(patch: Record<string, unknown>): Promise<{ ok: boolean }> };
    drain(): Promise<void>;
    authority(): { scenarioId: string | null };
    scenario(): { cardsByKind: { requirements: unknown[] } };
  };
};

/** Type-tagged presentation key (mirror core `entityKey`) for building test ids. */
const sk = (id: string) => `string:${id}`;

/** The five card collections, always written together: a partial `cardsByKind`
 *  patch leaves the projection reading `undefined` where it expects an array, and
 *  the commit is refused. */
function cards(requirements: Record<string, unknown>[]) {
  return { requirements, successions: [], counts: [], affinities: [], coverings: [] };
}

/** Seed the durable store directly (the grid's store is the same singleton).
 *  Waits for the writer lease first — a command issued while the tab is still
 *  acquiring authority is refused, so an early seed would silently write nothing. */
async function seed(page: Page, patch: Record<string, unknown>) {
  await page.waitForFunction(() => {
    const store = (window as unknown as NsWindow).__nsStore;
    return Boolean(store) && store.authority().scenarioId !== null;
  });
  await page.evaluate(async (p) => {
    await (window as unknown as NsWindow).__nsStore.commands.mutate(p);
  }, patch);
}

/**
 * An all-nurse, every-date baseline for one shift, plus the scope override under
 * test — the same fixture shape the jsdom suite builds (shift-type-grid.test.tsx).
 * Only the override decides the card's state: a non-`ALL` qualified/date scope, or
 * a group hop, removes the editable baseline and forces the read-only render.
 */
function requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: "req-scoped",
    shiftType: ["Day"],
    requiredNumPeople: 2,
    qualifiedPeople: ["ALL"],
    date: ["ALL"],
    weight: -50,
    ...overrides,
  };
}

const SCOPES = [
  {
    name: "group",
    patch: { shiftGroups: [{ id: "WORKING", members: ["Day"] }] },
    card: requirement({ shiftType: ["WORKING"] }),
    rule: "Set by the WORKING group — it staffs every shift in the group together (2 nurses).",
  },
  {
    name: "qualified",
    patch: {},
    card: requirement({ qualifiedPeople: ["Seniors"] }),
    rule: "Set by a skill rule (Seniors: 2 nurses).",
  },
  {
    name: "date",
    patch: { rangeStart: "2026-07-01", rangeEnd: "2026-07-07" },
    card: requirement({ date: ["2026-07-01"] }),
    rule: "Set by a date rule (2026-07-01: 2 nurses).",
  },
] as const;

test.describe.serial("DR-4 staffing lock — read-only render + deep-link", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
      // Staffing Requirements is Advanced-only (DL12 §2). Stored up front so the
      // route-validity gate resolves the deep-link's destination instead of
      // bouncing it Home.
      try {
        window.localStorage.setItem("ns-app-mode", "advanced");
      } catch {}
    });
  });

  for (const { name, patch, card, rule } of SCOPES) {
    test(`a ${name}-scoped shift renders read-only staffing with no editable inputs`, async ({
      page,
    }) => {
      await page.goto("/shift-types");
      await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
      await seed(page, {
        shifts: [{ id: "Day" }],
        shiftGroups: [],
        cardsByKind: cards([card]),
        ...patch,
      });

      const cardKey = sk("Day");
      const region = page.getByTestId(`staffing-readonly-${cardKey}`);
      await expect(region).toBeVisible();
      // Value, reason and deep-link — the honest read-only surface.
      await expect(page.getByTestId(`staffing-min-${cardKey}`)).toHaveText("2");
      await expect(region).toContainText(rule);
      await expect(region).toContainText(/make the roster impossible to build/i);
      await expect(page.getByTestId(`staffing-link-${cardKey}`)).toHaveAttribute(
        "href",
        "/shift-type-requirements",
      );
      // NO editable inputs anywhere on the card.
      await expect(page.getByTestId(`shift-card-${cardKey}`).locator("input")).toHaveCount(0);

      // …and the in-place editor agrees: a read-only well, never editable Min/Preferred inputs.
      await page.getByTestId(`shift-edit-${cardKey}`).click();
      await expect(page.getByTestId(`shift-edit-${cardKey}-staffing-readonly`)).toBeVisible();
      await expect(page.getByTestId(`shift-edit-${cardKey}-required`)).toHaveCount(0);
      await expect(page.getByTestId(`shift-edit-${cardKey}-preferred`)).toHaveCount(0);
      // Saving from the read-only state must not fabricate a requirement.
      await page.getByTestId(`shift-edit-${cardKey}-save`).click();
      const requirementCount = await page.evaluate(async () => {
        const store = (window as unknown as NsWindow).__nsStore;
        await store.drain();
        return store.scenario().cardsByKind.requirements.length;
      });
      expect(requirementCount).toBe(1);
    });
  }

  test("the staffing deep-link navigates to /shift-type-requirements", async ({ page }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
    await seed(page, {
      shifts: [{ id: "Day" }],
      shiftGroups: [{ id: "WORKING", members: ["Day"] }],
      cardsByKind: cards([requirement({ shiftType: ["WORKING"] })]),
    });

    const link = page.getByTestId(`staffing-link-${sk("Day")}`);
    await expect(link).toHaveAttribute("href", "/shift-type-requirements");
    // No editor open ⇒ no losable draft ⇒ the guarded push commits immediately.
    await link.click();
    await expect(page).toHaveURL(/\/shift-type-requirements\/?$/);
    await expect(page.getByTestId("add-card-toggle")).toBeVisible();
  });
});
