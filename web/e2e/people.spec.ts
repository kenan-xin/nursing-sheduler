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

// ---------------------------------------------------------------------------
// R2b — the v2 "Mint Canvas, Warm Ink" visual system, measured on the real route.
//
// This is the RESOLVED half of the route's own evidence: `components/people/
// people-v2-roles.test.tsx` pins which contract authored each surface, and these
// tests prove what Chromium actually paints and lays out. Both halves are needed —
// a role can be spelled correctly and still resolve to the wrong tone if a token
// moves, and a token can be right while a table container forgets to clip its own
// scroll region.
//
// F4's owner matrix covers `/people` in both themes, all four accents and the
// coarse-pointer lane. What is added here is what F4 deliberately does NOT assert
// per route: the exact resting tone, radius and elevation of THIS screen's named
// surfaces, its precise-pointer control sizes, its behaviour at the narrow
// viewport with a long list, and the route-level re-verification of the F3
// overlay's one ratified exception.
// ---------------------------------------------------------------------------

/** Resolve runtime tokens the way the app resolves them — through the cascade. */
async function resolveTokens(page: Page, tokens: string[]): Promise<Record<string, string>> {
  return page.evaluate((list) => {
    const out: Record<string, string> = {};
    for (const token of list) {
      const probe = document.createElement("div");
      probe.style.backgroundColor = `var(${token})`;
      document.body.appendChild(probe);
      out[token] = getComputedStyle(probe).backgroundColor;
      probe.remove();
    }
    return out;
  }, tokens);
}

async function gotoPeople(page: Page) {
  await page.goto("/people");
  await expect(page.getByTestId("people-add")).toBeVisible();
}

test.describe("R2b — v2 visual system on /people", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  for (const theme of ["light", "dark"] as const) {
    test(`surface ladder resolves in the ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.addInitScript((t) => {
        try {
          window.localStorage.setItem("ns-theme", t);
        } catch {}
      }, theme);
      await gotoPeople(page);
      const html = page.locator("html");
      if (theme === "dark") await expect(html).toHaveClass(/dark/);
      else await expect(html).not.toHaveClass(/dark/);

      await seed(page, {
        staff: [
          { id: "Aisha Rahman", history: [] },
          { id: "Priya Nair", history: [] },
        ],
        staffGroups: [{ id: "Seniors", members: ["Aisha Rahman"] }],
      });

      const tone = await resolveTokens(page, ["--bg", "--surface", "--panel", "--panel-alt"]);

      // L0: the screen root is the recessed page plane, and it is never a box.
      const root = page.getByTestId("screen");
      await expect(root).toHaveCSS("background-color", tone["--bg"]);
      await expect(root).toHaveCSS("border-radius", "0px");
      expect(await root.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");

      // L1: the table container rests at --surface / 16px / --sh-1, and CLIPS —
      // its scroll region ends the card (DESIGN.md §4 rule 3).
      const wrap = page.getByTestId("people-table-wrap");
      await expect(wrap).toHaveCSS("background-color", tone["--surface"]);
      await expect(wrap).toHaveCSS("border-radius", "16px");
      const wrapShadow = await wrap.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(wrapShadow, "the table card must carry a resting elevation").not.toBe("none");
      expect(wrapShadow, "a resting card is never an inset").not.toContain("inset");
      expect(await wrap.evaluate((el) => getComputedStyle(el).overflowY)).not.toBe("visible");

      // band: the column header spans the whole card, so it is --panel, square, flat.
      const band = page.getByRole("columnheader", { name: "Nurse" }).locator("..");
      await expect(band).toHaveCSS("background-color", tone["--panel"]);
      await expect(band).toHaveCSS("border-radius", "0px");
      expect(await band.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");

      // Row hover is --panel-alt. `--panel` is reserved for bands and true insets,
      // so a row taking it would be indistinguishable from the header above it.
      const row = page.getByTestId(`people-row-${sk("Priya Nair")}`);
      await row.hover();
      await expect(row).toHaveCSS("background-color", tone["--panel-alt"]);
    });
  }

  test("every table data surface stays square", async ({ page }) => {
    await gotoPeople(page);
    await seed(page, {
      staff: Array.from({ length: 8 }, (_, i) => ({ id: `Nurse ${i + 1}`, history: [] })),
      staffGroups: [{ id: "Seniors", members: ["Nurse 1"] }],
    });

    const report = await page.evaluate(() => {
      const table = document.querySelector('[data-testid="people-table"]')!;
      const nodes = [table, ...Array.from(table.querySelectorAll("thead, tbody, tr, th, td"))];
      const rounded = nodes
        .filter((el) => getComputedStyle(el).borderRadius !== "0px")
        .map((el) => `${el.tagName.toLowerCase()} → ${getComputedStyle(el).borderRadius}`);
      return { measured: nodes.length, rounded };
    });

    // Vacuity guard: eight rows × four cells plus the header must be measured.
    expect(report.measured).toBeGreaterThan(40);
    expect(report.rounded, "a table data surface was rounded").toEqual([]);
  });

  test("the open inline editor row takes the brand-edged selection, not a tint wash", async ({
    page,
  }) => {
    await gotoPeople(page);
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [{ id: "Seniors", members: [] }],
    });

    const tone = await resolveTokens(page, ["--surface", "--brand", "--brandtint", "--onbrand"]);
    await page.getByTestId(`people-edit-${sk("P1")}`).click();

    const row = page.getByTestId(`people-edit-row-${sk("P1")}`);
    await expect(row).toHaveCSS("background-color", tone["--surface"]);
    await expect(row).toHaveCSS("border-top-color", tone["--brand"]);
    // The prototype washes the editing row in --brandtint; v2 reserves that tone
    // for the selection MARKS, which sit inside this very row.
    await expect(row).not.toHaveCSS("background-color", tone["--brandtint"]);

    // A pressed membership toggle IS a selection mark: the brand fill carries its
    // paired ON-colour, never a hand-picked foreground.
    const chip = page.getByTestId(`people-group-${sk("P1")}-Seniors`);
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(chip).toHaveCSS("background-color", tone["--brand"]);
    await expect(chip).toHaveCSS("color", tone["--onbrand"]);
  });

  test("real control geometry on a precise pointer — 44px CTA, 36px actions and fields", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoPeople(page);
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [{ id: "Seniors", members: [] }],
    });

    // RAW dimensions, never rounded. `--ctl-lg` 44, `--ctl` 36 and `--ctl-sm` 32
    // are absolute integer tokens that the 0.9 density baseline is forbidden to
    // touch, so the unrounded box is what has to land on them. `Math.round` here
    // would not be tolerance — it would widen every claim below into a half-pixel
    // band (“exactly 36” becoming any value in [35.5, 36.5)), which is precisely
    // the undersizing this test exists to catch. Measured on the shipped tree at
    // device pixel ratios 1, 1.5 and 2 and at both 1280px and 390px: every
    // dimension asserted here is exactly integral, so equality is the truthful
    // contract and no tolerance is warranted. (Text-driven WIDTHS are fractional
    // by construction — the CTA is 187.875px — which is why only the token-bound
    // axes are asserted.)

    // The prototype's 44px primary action, on a real anchor.
    const cta = await page.getByTestId("people-continue").boundingBox();
    expect(cta!.height, "Continue CTA height").toBe(44);

    // Icon actions own BOTH axes at the absolute 36px control size — set on the
    // control itself, so its own box is what is measured here.
    for (const testId of [
      `people-edit-${sk("P1")}`,
      `people-dup-${sk("P1")}`,
      `people-delete-${sk("P1")}`,
    ]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.width, `${testId} width`).toBe(36);
      expect(box!.height, `${testId} height`).toBe(36);
    }

    // Fields and default actions are a height claim; the 0.9 density baseline must
    // not be able to shrink them.
    for (const testId of ["people-search", "people-add", "people-upload"]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.height, `${testId} height`).toBe(36);
    }

    // The inline membership toggles are the small step, and still real controls.
    await page.getByTestId(`people-edit-${sk("P1")}`).click();
    const chip = await page.getByTestId(`people-group-${sk("P1")}-Seniors`).boundingBox();
    expect(chip!.height, "membership toggle height").toBe(32);
  });

  test("a long list at the narrow viewport scrolls the table, not the page", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoPeople(page);
    await seed(page, {
      staff: Array.from({ length: 40 }, (_, i) => ({
        id: `Nurse With A Long Name ${i + 1}`,
        history: [],
      })),
      staffGroups: [{ id: "Seniors", members: ["Nurse With A Long Name 1"] }],
    });
    await expect(page.getByTestId(`people-row-${sk("Nurse With A Long Name 40")}`)).toBeVisible();

    const report = await page.evaluate(() => {
      const doc = document.documentElement;
      const wrap = document.querySelector('[data-testid="people-table-wrap"]')!;
      return {
        pageScroll: doc.scrollWidth,
        pageClient: doc.clientWidth,
        wrapScroll: wrap.scrollWidth,
        wrapClient: wrap.clientWidth,
      };
    });

    // The 520px-min table is wider than a 390px viewport by construction; the
    // point is that IT scrolls and the page does not.
    expect(report.wrapScroll).toBeGreaterThan(report.wrapClient);
    expect(report.pageScroll).toBeLessThanOrEqual(report.pageClient + 1);
  });

  test("the search and no-results states keep real, reachable controls", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoPeople(page);
    await seed(page, { staff: [{ id: "Alice", history: [] }], staffGroups: [] });

    await page.getByTestId("people-search").fill("zzz");
    await expect(page.getByTestId("people-empty")).toContainText("No matches");

    // Both clears are genuine controls, not bare glyphs, and both still work.
    const inlineClear = await page.getByTestId("people-search-clear").boundingBox();
    expect(inlineClear!.width).toBeGreaterThan(0);
    await page.getByTestId("people-empty-clear").click();
    await expect(page.getByTestId(`people-row-${sk("Alice")}`)).toBeVisible();
    await expect(page.getByTestId("people-search")).toHaveValue("");

    const report = await page.evaluate(() => ({
      pageScroll: document.documentElement.scrollWidth,
      pageClient: document.documentElement.clientWidth,
    }));
    expect(report.pageScroll).toBeLessThanOrEqual(report.pageClient + 1);
  });

  // The F3 overlay is consumed as-is by this route. Its one ratified exception —
  // People upload IGNORES Escape, because a stray Escape after the OS file picker
  // closes used to throw the whole bulk-reorder flow away — is re-verified HERE, at
  // route level, because R2b changes what surrounds the trigger and a regression
  // would surface as "the dialog closed" rather than as an F3 unit failure.
  test("the upload overlay still ignores Escape, and still closes every other way", async ({
    page,
  }) => {
    await gotoPeople(page);
    await seed(page, { staff: [{ id: "A", history: [] }], staffGroups: [] });
    const before = await pastCount(page);

    await page.getByTestId("people-upload").click();
    await expect(page.getByTestId("upload-dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("upload-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("upload-dialog")).toBeVisible();

    // The close control still closes it, and nothing was committed either way.
    await page.getByTestId("upload-dialog-close").click();
    await expect(page.getByTestId("upload-dialog")).toHaveCount(0);
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["A"]);
    expect(await pastCount(page)).toBe(before);

    // Reopening still works, so the ignored Escape left no wedged state behind.
    await page.getByTestId("people-upload").click();
    await expect(page.getByTestId("upload-dialog")).toBeVisible();
  });
});
