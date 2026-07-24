import { expect, test, type Page } from "@playwright/test";

// DR-2 acceptance (Playwright) for the bespoke Staff table (`PeopleTable`), carved
// from the retired `people-shift-types.spec.ts`. Every named outcome asserts the
// DURABLE STORE shape AND, where relevant, the store.temporal entry count — so a green
// test cannot mask a data-integrity gap or a spurious/absent undo entry. Coverage:
// inline-row add / rename (name→id) with description PRESERVED / duplicate / immediate
// delete; native drag-reorder AND the Up/Down keyboard fallback (both gated off while
// searching or editing); the inline group toggle chips; typed-id identity (`1` vs `"1"`
// vs `"#1"`); membership-draft reconciliation across external delete/rename (no
// resurrection, no silent drop, stale Save aborted); the .txt/.csv bulk upload incl.
// reserved / group-id-collision rejection and identical-upload no-op; reserved `ALL`
// rejection; and the search "No matches" empty state. The shared `GroupsSection` (Staff
// copy) keeps its existing test-ids. DL10 (no person role/seniority) is asserted too.
//
// Pure-logic parity is pinned in components/entity-editor/core/*.test.ts and the
// component contract in components/people/people-table.test.tsx (vitest).

type StoreState = Record<string, unknown> & {
  staff?: { id: unknown; description?: string; history?: string[] }[];
  staffGroups?: { id: string; members: unknown[] }[];
};

type NsWindow = {
  __nsStore: {
    scenario: {
      getState: () => StoreState & { mutateScenario: (patch: Record<string, unknown>) => void };
      temporal: {
        getState: () => {
          pastStates: unknown[];
          futureStates: unknown[];
          undo: () => void;
          redo: () => void;
        };
      };
    };
  };
};

/** Type-tagged presentation keys (mirror core `entityKey`) for building test ids. */
const sk = (id: string) => `string:${id}`;
const nk = (n: number) => `number:${n}`;

function readState(page: Page) {
  return page.evaluate(() => (window as unknown as NsWindow).__nsStore.scenario.getState());
}
async function readStaff(page: Page) {
  return (await readState(page)).staff ?? [];
}
async function readStaffGroups(page: Page) {
  return (await readState(page)).staffGroups ?? [];
}
function pastCount(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().pastStates.length,
  );
}
function futureCount(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().futureStates.length,
  );
}
/**
 * Race a real Redo against an IMMEDIATE stale Save in ONE task, before React can flush
 * the close-on-external effect: redo(), then synchronously dispatch a click on the
 * still-mounted Save control. The submit handler's synchronous `isStale` guard — not
 * the passive effect — must make the Save a no-op (close-gate Major).
 */
function redoThenClick(page: Page, saveTestId: string) {
  return page.evaluate((testId) => {
    const w = window as unknown as NsWindow;
    w.__nsStore.scenario.temporal.getState().redo();
    document
      .querySelector(`[data-testid="${testId}"]`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, saveTestId);
}

async function seed(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}
function undo(page: Page) {
  return page.evaluate(() =>
    (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().undo(),
  );
}
function redo(page: Page) {
  return page.evaluate(() =>
    (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().redo(),
  );
}

/** Reorder via native HTML5 drag (rows are draggable `<tr>`, drag identity is index). */
async function drag(page: Page, sourceTestId: string, targetTestId: string) {
  const src = `[data-testid="${sourceTestId}"]`;
  const dst = `[data-testid="${targetTestId}"]`;
  await page.dispatchEvent(src, "dragstart");
  await page.dispatchEvent(dst, "dragover");
  await page.dispatchEvent(dst, "drop");
  await page.dispatchEvent(src, "dragend");
}

async function addPerson(page: Page, id: string) {
  await page.getByTestId("people-add").click();
  await page.getByTestId("people-name-input-__new__").fill(id);
  await page.getByTestId("people-save-__new__").click();
}

test.describe.serial("DR-2 Staff table", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("staff — add, duplicate, immediate delete; no role/seniority (DL10)", async ({ page }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();

    await addPerson(page, "Alice");
    await addPerson(page, "Bob");
    await expect(page.getByTestId(`people-row-${sk("Alice")}`)).toBeVisible();
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["Alice", "Bob"]);
    expect((await readStaff(page)).every((p) => Array.isArray(p.history))).toBe(true);

    await expect(page.getByTestId(`people-row-${sk("Alice")}`)).not.toContainText(
      /role|seniority|senior|junior/i,
    );

    // Duplicate → "Alice copy" inserted right after the source.
    await page.getByTestId(`people-dup-${sk("Alice")}`).click();
    await expect(page.getByTestId(`people-row-${sk("Alice copy")}`)).toBeVisible();
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["Alice", "Alice copy", "Bob"]);

    // Delete is immediate — NO confirmation dialog (FR-ED-14).
    await page.getByTestId(`people-delete-${sk("Alice copy")}`).click();
    await expect(page.getByTestId(`people-row-${sk("Alice copy")}`)).toHaveCount(0);
    await expect(page.getByTestId("confirm-dialog-confirm")).toHaveCount(0);
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["Alice", "Bob"]);
  });

  test("staff — inline rename maps name→id and PRESERVES the existing description", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", description: "Charge nurse", history: ["h1"] }],
      staffGroups: [{ id: "G", members: ["P1"] }],
    });

    await page.getByTestId(`people-edit-${sk("P1")}`).click();
    await page.getByTestId(`people-name-input-${sk("P1")}`).fill("Alice");
    await page.getByTestId(`people-save-${sk("P1")}`).click();

    const p = (await readStaff(page))[0];
    expect(p.id).toBe("Alice");
    expect(p.description).toBe("Charge nurse"); // never dropped by a name/group edit
    expect(p.history).toEqual(["h1"]);
    // Rename cascade rewrote the group member reference.
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["Alice"]);
  });

  test("staff — assigning a group inline + rename is one compound Save (one undo entry)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", description: "note", history: [] }],
      staffGroups: [{ id: "G", members: [] }],
    });

    await page.getByTestId(`people-edit-${sk("P1")}`).click();
    const before = await pastCount(page);
    await page.getByTestId(`people-name-input-${sk("P1")}`).fill("Alice");
    await page.getByTestId(`people-group-${sk("P1")}-G`).click();
    await page.getByTestId(`people-save-${sk("P1")}`).click();

    expect((await readStaff(page))[0].id).toBe("Alice");
    expect((await readStaff(page))[0].description).toBe("note");
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["Alice"]);
    expect((await pastCount(page)) - before).toBe(1);

    // One Undo reverses the whole compound edit; one Redo reapplies it.
    await undo(page);
    expect((await readStaff(page))[0].id).toBe("P1");
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual([]);
    await redo(page);
    expect((await readStaff(page))[0].id).toBe("Alice");
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["Alice"]);
  });

  test("staff — drag reorder moves durable order; drag + keyboard reorder gated off while editing", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
        { id: "P3", history: [] },
      ],
      staffGroups: [],
    });

    await drag(page, `people-row-${sk("P3")}`, `people-row-${sk("P1")}`);
    await expect
      .poll(async () => (await readStaff(page)).map((p) => p.id))
      .toEqual(["P3", "P1", "P2"]);

    // Enter edit mode → rows are no longer draggable and reorder buttons vanish.
    await page.getByTestId(`people-edit-${sk("P1")}`).click();
    await expect(page.getByTestId(`people-row-${sk("P3")}`)).toHaveAttribute("draggable", "false");
    await expect(page.getByTestId(`people-move-down-${sk("P3")}`)).toHaveCount(0);
    await drag(page, `people-row-${sk("P3")}`, `people-row-${sk("P2")}`);
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["P3", "P1", "P2"]);
  });

  test("staff — Up/Down keyboard reorder is the accessible alternative (one undo entry)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
        { id: "P3", history: [] },
      ],
      staffGroups: [],
    });

    await expect(page.getByTestId(`people-move-up-${sk("P1")}`)).toBeDisabled();
    await expect(page.getByTestId(`people-move-down-${sk("P3")}`)).toBeDisabled();

    const before = await pastCount(page);
    await page.getByTestId(`people-move-down-${sk("P1")}`).click();
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["P2", "P1", "P3"]);
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("staff — reserved ALL rejected (add + case-insensitive); synthetic ALL group read-only", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();

    await page.getByTestId("people-add").click();
    await page.getByTestId("people-name-input-__new__").fill("ALL");
    await expect(page.getByTestId("people-name-input-__new__")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByTestId("people-save-__new__")).toBeDisabled();
    await page.getByTestId("people-name-input-__new__").fill("all");
    await expect(page.getByTestId("people-save-__new__")).toBeDisabled();
    await page.getByTestId("people-cancel-__new__").click();

    await expect(page.getByTestId("synthetic-ALL")).toBeVisible();
    await expect(page.getByTestId("group-edit-ALL")).toHaveCount(0);
  });

  test("staff — search shows a No-matches empty state with a working Clear search", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, { staff: [{ id: "Alice", history: [] }], staffGroups: [] });

    await page.getByTestId("people-search").fill("zzz");
    await expect(page.getByTestId("people-empty")).toContainText("No matches");
    await expect(page.getByTestId("people-count")).toContainText("0 of 1");
    await page.getByTestId("people-empty-clear").click();
    await expect(page.getByTestId(`people-row-${sk("Alice")}`)).toBeVisible();
  });

  test('staff — numeric 1, string "1", string "#1" are distinct; editing one leaves the rest', async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [
        { id: 1, history: [] },
        { id: "1", history: [] },
        { id: "#1", history: [] },
      ],
      staffGroups: [],
    });

    await expect(page.getByTestId(`people-row-${nk(1)}`)).toBeVisible();
    await expect(page.getByTestId(`people-row-${sk("1")}`)).toBeVisible();
    await expect(page.getByTestId(`people-row-${sk("#1")}`)).toBeVisible();

    // Rename the NUMERIC 1 via the inline row; the two string rows stay untouched.
    await page.getByTestId(`people-edit-${nk(1)}`).click();
    await page.getByTestId(`people-name-input-${nk(1)}`).fill("one");
    await page.getByTestId(`people-save-${nk(1)}`).click();
    await expect
      .poll(async () => (await readStaff(page)).map((p) => p.id))
      .toEqual(["one", "1", "#1"]);
  });

  test('staff — numeric 1 is inline-editable beside string "1"; its type survives', async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [
        { id: 1, history: [] },
        { id: "1", history: [] },
      ],
      staffGroups: [{ id: "G", members: [] }],
    });

    await page.getByTestId(`people-edit-${nk(1)}`).click();
    // Unchanged id text preserves the numeric id → Save is NOT falsely blocked.
    await expect(page.getByTestId(`people-save-${nk(1)}`)).toBeEnabled();
    await page.getByTestId(`people-group-${nk(1)}-G`).click();
    await page.getByTestId(`people-save-${nk(1)}`).click();

    const staff = await readStaff(page);
    expect(staff[0].id).toBe(1); // still the NUMBER 1, not "1"
    expect(staff[1].id).toBe("1"); // string sibling untouched
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual([1]);
  });

  test("staff — an unrelated edit preserves a loaded WHITESPACE id verbatim", async ({ page }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [{ id: " P1 ", description: "keep", history: [] }],
      staffGroups: [{ id: "G", members: [] }],
    });

    // Change only the group membership; the whitespace id must NOT be trimmed/renamed.
    await page.getByTestId(`people-edit-${sk(" P1 ")}`).click();
    await page.getByTestId(`people-group-${sk(" P1 ")}-G`).click();
    await page.getByTestId(`people-save-${sk(" P1 ")}`).click();

    const staff = await readStaff(page);
    expect(staff[0].id).toBe(" P1 "); // verbatim — no silent trim/rename
    expect(staff[0].description).toBe("keep");
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual([" P1 "]);
  });

  test("staff — item rename → Undo → Redo round-trips durably", async ({ page }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [{ id: "G", members: ["P1"] }],
    });

    await page.getByTestId(`people-edit-${sk("P1")}`).click();
    await page.getByTestId(`people-name-input-${sk("P1")}`).fill("Alice");
    await page.getByTestId(`people-save-${sk("P1")}`).click();
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["Alice"]);
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["Alice"]);

    await undo(page);
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["P1"]);
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["P1"]);
    await redo(page);
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["Alice"]);
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["Alice"]);
  });

  // --- shared GroupsSection (Staff copy) — existing test-ids unchanged ---

  test("staff groups — add with members, reserved/dup rejection, duplicate keeps members", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
      ],
      staffGroups: [],
    });

    await page.getByTestId("add-group-toggle").click();
    await page.getByTestId("add-group-id").fill("Team");
    await page
      .getByTestId("transfer-list-__new__")
      .getByRole("button", { name: /Add P1 to group/i })
      .click();
    await page.getByTestId("group-save-__new__").click();
    await expect(page.getByTestId("group-row-Team")).toBeVisible();
    expect((await readStaffGroups(page)).find((g) => g.id === "Team")?.members).toEqual(["P1"]);

    await page.getByTestId("add-group-toggle").click();
    await page.getByTestId("add-group-id").fill("ALL");
    await expect(page.getByTestId("group-save-__new__")).toBeDisabled();
    await page.getByTestId("add-group-id").fill("Team");
    await expect(page.getByTestId("group-save-__new__")).toBeDisabled();
    await page.getByTestId("group-cancel-__new__").click();

    await page.getByTestId("group-dup-Team").click();
    await expect(page.getByTestId("group-row-Team copy")).toBeVisible();
    expect((await readStaffGroups(page)).find((g) => g.id === "Team copy")?.members).toEqual([
      "P1",
    ]);
  });

  test("staff groups — rename cascades, delete removes it; group membership is one Save (Add all = one undo)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
        { id: "P3", history: [] },
      ],
      staffGroups: [{ id: "Team", members: ["P1"] }],
    });

    // Rename Team → Seniors (id + members, one commit).
    await page.getByTestId("group-edit-Team").click();
    await page.getByTestId("group-edit-id-Team").fill("Seniors");
    await page.getByTestId("group-save-Team").click();
    await expect(page.getByTestId("group-row-Seniors")).toBeVisible();
    expect((await readStaffGroups(page)).find((g) => g.id === "Seniors")?.members).toEqual(["P1"]);

    // Add all + Save = exactly ONE undo entry, all three members in item order.
    await page.getByTestId("group-edit-Seniors").click();
    const beforeAddAll = await pastCount(page);
    await page.getByTestId("transfer-add-all-Seniors").click();
    await page.getByTestId("group-save-Seniors").click();
    expect((await readStaffGroups(page)).find((g) => g.id === "Seniors")?.members).toEqual([
      "P1",
      "P2",
      "P3",
    ]);
    expect((await pastCount(page)) - beforeAddAll).toBe(1);

    await page.getByTestId("group-delete-Seniors").click();
    await expect(page.getByTestId("group-row-Seniors")).toHaveCount(0);
  });

  // --- stale-draft / close-on-external ---

  test("staff — an external membership change VISIBLY closes the open group form; no resurrection", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
      ],
      staffGroups: [{ id: "G", members: ["P1", "P2"] }],
    });

    await page.getByTestId("group-edit-G").click();
    await expect(page.getByTestId("transfer-list-G")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P2", history: [] }],
      staffGroups: [{ id: "G", members: ["P2"] }],
    });
    await expect(page.getByTestId("transfer-list-G")).toHaveCount(0);
    await expect(page.getByTestId("group-row-G")).toBeVisible();
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["P2"]);
  });

  test("staff — an external rename VISIBLY closes the open inline row; membership preserved", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [{ id: "Team", members: ["P1"] }],
    });

    await page.getByTestId(`people-edit-${sk("P1")}`).click();
    // External rename Team → Seniors while the inline row is open → the row closes; the
    // cascade already moved P1, and nothing stale is written over it.
    await seed(page, { staffGroups: [{ id: "Seniors", members: ["P1"] }] });
    await expect(page.getByTestId(`people-save-${sk("P1")}`)).toHaveCount(0);
    expect((await readStaffGroups(page)).find((g) => g.id === "Seniors")?.members).toEqual(["P1"]);
  });

  test("staff — EDIT-ITEM local chip + concurrent Redo: row closes, no stale group write", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [
        { id: "G", members: [] },
        { id: "H", members: [] },
      ],
    });
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [
        { id: "G", members: [] },
        { id: "H", members: ["P1"] },
      ],
    });
    await undo(page); // H back to []
    const past = await pastCount(page);
    const future = await futureCount(page);

    await page.getByTestId(`people-edit-${sk("P1")}`).click();
    await page.getByTestId(`people-group-${sk("P1")}-G`).click();
    await expect(page.getByTestId(`people-group-${sk("P1")}-G`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await redo(page); // external H=[P1] → the open row VISIBLY closes
    await expect(page.getByTestId(`people-save-${sk("P1")}`)).toHaveCount(0);
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual([]);
    expect((await readStaffGroups(page)).find((g) => g.id === "H")?.members).toEqual(["P1"]);
    expect(await pastCount(page)).toBe(past + 1);
    expect(await futureCount(page)).toBe(future - 1);
  });

  test("staff — EDIT-ITEM immediate stale Save racing Redo is a no-op (close-gate)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [
        { id: "G", members: [] },
        { id: "H", members: [] },
      ],
    });
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [
        { id: "G", members: [] },
        { id: "H", members: ["P1"] },
      ],
    });
    await undo(page); // H back to []
    const past = await pastCount(page);

    await page.getByTestId(`people-edit-${sk("P1")}`).click();
    await page.getByTestId(`people-group-${sk("P1")}-G`).click(); // local draft G
    await redoThenClick(page, `people-save-${sk("P1")}`);
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual([]);
    expect((await readStaffGroups(page)).find((g) => g.id === "H")?.members).toEqual(["P1"]);
    expect(await pastCount(page)).toBe(past + 1);
    await expect(page.getByTestId(`people-save-${sk("P1")}`)).toHaveCount(0);
  });

  test("staff — unrelated durable meta churn leaves the open row and Save commits", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [{ id: "G", members: [] }],
    });

    await page.getByTestId(`people-edit-${sk("P1")}`).click();
    await page.getByTestId(`people-group-${sk("P1")}-G`).click();
    // Unrelated meta churn (not items/groups) must NOT close the row or block Save.
    await seed(page, { rangeStart: "2099-01-01" });
    await expect(page.getByTestId(`people-save-${sk("P1")}`)).toBeVisible();
    const past = await pastCount(page);
    await page.getByTestId(`people-save-${sk("P1")}`).click();
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["P1"]);
    expect(await pastCount(page)).toBe(past + 1);
  });

  // --- bulk upload ---

  test("staff — bulk upload reorders existing, adds new, moves unmentioned to the tail", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "A", history: [] },
        { id: "B", history: [] },
        { id: "C", history: [] },
      ],
      staffGroups: [],
    });

    await page.getByTestId("people-upload").click();
    await expect(page.getByTestId("upload-dialog")).toBeVisible();
    await page.getByTestId("upload-file-input").setInputFiles({
      name: "people.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("B\nD\nA\n# a comment\n\n"),
    });
    await expect
      .poll(async () => (await readStaff(page)).map((p) => p.id))
      .toEqual(["B", "D", "A", "C"]);
    expect((await readStaff(page)).find((p) => p.id === "D")?.history).toEqual([]);
  });

  test("staff — bulk upload rejects intra-file duplicate, reserved, and group-id collision", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [{ id: "A", history: [] }],
      staffGroups: [{ id: "Team", members: [] }],
    });

    await page.getByTestId("people-upload").click();
    await page.getByTestId("upload-file-input").setInputFiles({
      name: "dup.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("X\nX\n"),
    });
    await expect(page.getByText(/Duplicate person name "X"/i)).toBeVisible();
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["A"]);

    await page.getByTestId("upload-file-input").setInputFiles({
      name: "reserved.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("N\nALL\n"),
    });
    await expect(
      page.getByText(/is a reserved keyword and cannot be used as a name/i),
    ).toBeVisible();
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["A"]);

    await page.getByTestId("upload-file-input").setInputFiles({
      name: "collide.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Team\n"),
    });
    await expect(page.getByText(/already used by an existing group/i)).toBeVisible();
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["A"]);
  });

  test("staff — a semantically identical upload creates no undo entry", async ({ page }) => {
    await page.goto("/people");
    await expect(page.getByTestId("people-add")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "A", history: [] },
        { id: "B", history: [] },
      ],
      staffGroups: [{ id: "G", members: ["A", "B"] }],
    });

    const before = await pastCount(page);
    await page.getByTestId("people-upload").click();
    await page.getByTestId("upload-file-input").setInputFiles({
      name: "same.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("A\nB\n"),
    });
    await expect(page.getByTestId("upload-dialog")).toHaveCount(0);
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["A", "B"]);
    expect(await pastCount(page)).toBe(before); // no spurious zundo entry
  });
});
