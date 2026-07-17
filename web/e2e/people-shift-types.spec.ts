import { expect, test, type Page } from "@playwright/test";

// T09 acceptance (Playwright rows): the full spec-03 People + Shift Types editing
// surface driven against a production build. Every named outcome asserts the DURABLE
// STORE shape AND, where relevant, the store.temporal entry count — so a green test
// cannot mask a data-integrity gap or a spurious/absent undo entry. Coverage spans:
// add / full-edit / double-click inline edit / duplicate / immediate delete; native
// drag-reorder for items AND groups (and drag disabled while editing); the per-row
// group toggle chips and the controlled-draft transfer list (Save applies one commit,
// Cancel discards); typed-id identity (`1` vs `"1"` vs `"#1"`, numeric full edit
// beside string `"1"`); membership-draft reconciliation across external delete/rename
// (no resurrection, no silent drop); the People .txt/.csv bulk upload incl. reserved /
// group-id-collision rejection and identical-upload no-op; and the bare-duration
// preservation guardrail (DL10-D4). DL10 (no person role/seniority) is asserted too.
//
// Pure-logic parity is pinned in components/entity-editor/core/*.test.ts (vitest).

type StoreState = Record<string, unknown> & {
  staff?: { id: unknown; description?: string; history?: string[] }[];
  shifts?: {
    id: unknown;
    description?: string;
    startTime?: string;
    endTime?: string;
    restMinutes?: number;
    durationMinutes?: number;
  }[];
  staffGroups?: { id: string; members: unknown[] }[];
  shiftGroups?: { id: string; members: unknown[] }[];
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
async function readShifts(page: Page) {
  return (await readState(page)).shifts ?? [];
}
async function readStaffGroups(page: Page) {
  return (await readState(page)).staffGroups ?? [];
}
async function readShiftGroups(page: Page) {
  return (await readState(page)).shiftGroups ?? [];
}
/** store.temporal undo depth — how many tracked mutations are on the past stack. */
function pastCount(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().pastStates.length,
  );
}
/** store.temporal redo depth — how many undone mutations are on the future stack. */
function futureCount(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().futureStates.length,
  );
}
/**
 * Race a real Redo against an IMMEDIATE stale Save in ONE task, before React can
 * flush the close-on-external effect: redo(), then synchronously dispatch a click on
 * the still-mounted Save control. The submit handler's synchronous `isStale` guard —
 * not the passive effect — must make the Save a no-op (close-gate Major).
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

/** Seed the durable store directly (the editor's store is the same singleton). */
async function seed(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}
/** Drive real zundo temporal travel (undo/redo) the way Ctrl+Z / Ctrl+Y would. */
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

/** Reorder via native HTML5 drag (the editor uses draggable rows, not buttons). */
async function drag(page: Page, sourceTestId: string, targetTestId: string) {
  const src = `[data-testid="${sourceTestId}"]`;
  const dst = `[data-testid="${targetTestId}"]`;
  await page.dispatchEvent(src, "dragstart");
  await page.dispatchEvent(dst, "dragover");
  await page.dispatchEvent(dst, "drop");
  await page.dispatchEvent(src, "dragend");
}

async function addPerson(page: Page, id: string) {
  await page.getByTestId("add-item-toggle").click();
  await page.getByTestId("add-item-id").fill(id);
  await page.getByTestId("add-item-save").click();
}

test.describe.serial("T09 people & shift-types editors", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("people — add, inline-edit description, duplicate, immediate delete; no role/seniority (DL10)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();

    await addPerson(page, "Alice");
    await addPerson(page, "Bob");
    await expect(page.getByTestId(`item-row-${sk("Alice")}`)).toBeVisible();
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["Alice", "Bob"]);
    expect((await readStaff(page)).every((p) => Array.isArray(p.history))).toBe(true);

    await expect(page.getByTestId(`item-row-${sk("Alice")}`)).not.toContainText(
      /role|seniority|senior|junior/i,
    );

    // Double-click inline edit of the description; Enter commits the trimmed value.
    await page.getByTestId(`item-desc-text-${sk("Alice")}`).dblclick();
    await page.getByTestId(`item-desc-input-${sk("Alice")}`).fill("Charge nurse");
    await page.getByTestId(`item-desc-input-${sk("Alice")}`).press("Enter");
    expect((await readStaff(page)).find((p) => p.id === "Alice")?.description).toBe("Charge nurse");

    // Duplicate → "Alice copy" inserted right after the source.
    await page.getByTestId(`item-dup-${sk("Alice")}`).click();
    await expect(page.getByTestId(`item-row-${sk("Alice copy")}`)).toBeVisible();
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["Alice", "Alice copy", "Bob"]);

    // Delete is immediate — NO confirmation dialog (FR-ED-14 / Minor 2).
    await page.getByTestId(`item-delete-${sk("Alice copy")}`).click();
    await expect(page.getByTestId(`item-row-${sk("Alice copy")}`)).toHaveCount(0);
    await expect(page.getByTestId("confirm-dialog-confirm")).toHaveCount(0);
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["Alice", "Bob"]);
  });

  test("people — drag reorder moves the durable order; drag disabled while editing", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
        { id: "P3", history: [] },
      ],
      staffGroups: [],
    });

    await drag(page, `item-row-${sk("P3")}`, `item-row-${sk("P1")}`);
    await expect
      .poll(async () => (await readStaff(page)).map((p) => p.id))
      .toEqual(["P3", "P1", "P2"]);

    // Enter edit mode → rows are no longer draggable, so a drag attempt is a no-op.
    await page.getByTestId(`item-edit-${sk("P1")}`).click();
    await expect(page.getByTestId(`item-row-${sk("P3")}`)).toHaveAttribute("draggable", "false");
    await drag(page, `item-row-${sk("P3")}`, `item-row-${sk("P2")}`);
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["P3", "P1", "P2"]);
  });

  test("people — reserved ALL rejected (add + case-insensitive); synthetic ALL group read-only", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();

    await page.getByTestId("add-item-toggle").click();
    await page.getByTestId("add-item-id").fill("ALL");
    await expect(page.getByTestId("add-item-id")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("add-item-save")).toBeDisabled();
    await page.getByTestId("add-item-id").fill("all");
    await expect(page.getByTestId("add-item-save")).toBeDisabled();
    await page.getByTestId("add-item-cancel").click();

    await expect(page.getByTestId("synthetic-ALL")).toBeVisible();
    await expect(page.getByTestId("group-edit-ALL")).toHaveCount(0);
  });

  test("people — group add with members, reserved/dup rejection, duplicate keeps members", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
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

  test("people — group rename cascades, group delete removes it; group drag reorders", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [
        { id: "Team", members: ["P1"] },
        { id: "Bench", members: [] },
      ],
    });

    // Group drag reorder → [Bench, Team].
    await drag(page, "group-row-Team", "group-row-Bench");
    await expect
      .poll(async () => (await readStaffGroups(page)).map((g) => g.id))
      .toEqual(["Bench", "Team"]);

    // Rename Team → Seniors via the edit form (id + description + members, one commit).
    await page.getByTestId("group-edit-Team").click();
    await page.getByTestId("group-edit-id-Team").fill("Seniors");
    await page.getByTestId("group-save-Team").click();
    await expect(page.getByTestId("group-row-Seniors")).toBeVisible();
    expect((await readStaffGroups(page)).find((g) => g.id === "Seniors")?.members).toEqual(["P1"]);

    await page.getByTestId("group-delete-Seniors").click();
    await expect(page.getByTestId("group-row-Seniors")).toHaveCount(0);
    expect((await readStaffGroups(page)).map((g) => g.id)).toEqual(["Bench"]);
  });

  test("people — group membership is one Save/Cancel transaction; Add all is one undo entry (M4)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
        { id: "P3", history: [] },
      ],
      staffGroups: [{ id: "G", members: [] }],
    });

    // Cancel discards draft toggles — no commit, no undo entry.
    await page.getByTestId("group-edit-G").click();
    const beforeCancel = await pastCount(page);
    await page
      .getByTestId("transfer-list-G")
      .getByRole("button", { name: /Add P1 to group/i })
      .click();
    await page.getByTestId("group-cancel-G").click();
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual([]);
    expect(await pastCount(page)).toBe(beforeCancel);

    // Add all + Save = exactly ONE undo entry, all three members in item order.
    await page.getByTestId("group-edit-G").click();
    const beforeAddAll = await pastCount(page);
    await page.getByTestId("transfer-add-all-G").click();
    await page.getByTestId("group-save-G").click();
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual([
      "P1",
      "P2",
      "P3",
    ]);
    expect((await pastCount(page)) - beforeAddAll).toBe(1);
  });

  test("people — an external membership change VISIBLY closes the open group form; no resurrection (M1/M5)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
      ],
      staffGroups: [{ id: "G", members: ["P1", "P2"] }],
    });

    await page.getByTestId("group-edit-G").click();
    await expect(page.getByTestId("transfer-list-G")).toBeVisible();
    // External change (here a delete of P1) while the form is open → the form closes
    // (visible cancellation), so no stale draft can be written back.
    await seed(page, {
      staff: [{ id: "P2", history: [] }],
      staffGroups: [{ id: "G", members: ["P2"] }],
    });
    await expect(page.getByTestId("transfer-list-G")).toHaveCount(0);
    await expect(page.getByTestId("group-row-G")).toBeVisible();
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["P2"]);
  });

  test("people — an external rename VISIBLY closes the open item form; membership preserved (M5)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [{ id: "Team", members: ["P1"] }],
    });

    await page.getByTestId(`item-edit-${sk("P1")}`).click();
    // External rename Team → Seniors while the item form is open → form closes; the
    // cascade already moved P1, and nothing stale is written over it.
    await seed(page, { staffGroups: [{ id: "Seniors", members: ["P1"] }] });
    await expect(page.getByTestId(`item-edit-${sk("P1")}-save`)).toHaveCount(0);
    expect((await readStaffGroups(page)).find((g) => g.id === "Seniors")?.members).toEqual(["P1"]);
  });

  test('people — numeric 1, string "1", string "#1" are distinct rows; editing one leaves the rest (M1)', async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [
        { id: 1, history: [] },
        { id: "1", history: [] },
        { id: "#1", history: [] },
      ],
      staffGroups: [],
    });

    // Three disjoint rows — the numeric and the legal string "#1" never collide.
    await expect(page.getByTestId(`item-row-${nk(1)}`)).toBeVisible();
    await expect(page.getByTestId(`item-row-${sk("1")}`)).toBeVisible();
    await expect(page.getByTestId(`item-row-${sk("#1")}`)).toBeVisible();

    // Inline-rename the NUMERIC 1; the two string rows stay untouched.
    await page.getByTestId(`item-id-text-${nk(1)}`).dblclick();
    await page.getByTestId(`item-id-input-${nk(1)}`).fill("one");
    await page.getByTestId(`item-id-input-${nk(1)}`).press("Enter");
    await expect
      .poll(async () => (await readStaff(page)).map((p) => p.id))
      .toEqual(["one", "1", "#1"]);
  });

  test('people — numeric 1 is full-editable beside string "1"; its type survives (M2)', async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [
        { id: 1, history: [] },
        { id: "1", history: [] },
      ],
      staffGroups: [],
    });

    await page.getByTestId(`item-edit-${nk(1)}`).click();
    // Unchanged id text preserves the numeric id → Save is NOT falsely blocked.
    await expect(page.getByTestId(`item-edit-${nk(1)}-save`)).toBeEnabled();
    await page.getByTestId(`item-edit-${nk(1)}-desc`).fill("Numeric one");
    await page.getByTestId(`item-edit-${nk(1)}-save`).click();

    const staff = await readStaff(page);
    expect(staff[0].id).toBe(1); // still the NUMBER 1, not "1"
    expect(staff[0].description).toBe("Numeric one");
    expect(staff[1].id).toBe("1"); // string sibling untouched
  });

  test("people — a compound item edit is exactly one undo entry", async ({ page }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [{ id: "G", members: [] }],
    });

    await page.getByTestId(`item-edit-${sk("P1")}`).click();
    const before = await pastCount(page);
    await page.getByTestId(`item-edit-${sk("P1")}-desc`).fill("Renamed note");
    await page.getByTestId(`item-edit-${sk("P1")}-group-G`).click(); // add to group G
    await page.getByTestId(`item-edit-${sk("P1")}-save`).click();
    expect((await pastCount(page)) - before).toBe(1);
    expect((await readStaff(page))[0].description).toBe("Renamed note");
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["P1"]);

    // One Undo reverses the whole compound edit; one Redo reapplies it.
    await undo(page);
    expect((await readStaff(page))[0].description ?? "").toBe("");
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual([]);
    await redo(page);
    expect((await readStaff(page))[0].description).toBe("Renamed note");
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["P1"]);
  });

  test("people — EDIT-ITEM local chip + concurrent Redo: form closes, no stale write (Major 1)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    // Arm a redoable future that will add P1 to H: seed H=[P1] then Undo → H=[].
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
    // Open P1's edit form and locally select group G (draft only, no commit).
    await page.getByTestId(`item-edit-${sk("P1")}`).click();
    await page.getByTestId(`item-edit-${sk("P1")}-group-G`).click();
    // Precondition: the local G selection is visibly ON (a real edit that could be lost).
    await expect(page.getByTestId(`item-edit-${sk("P1")}-group-G`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Concurrent app-wide Redo re-applies H=[P1] → the open form VISIBLY closes.
    await redo(page);
    await expect(page.getByTestId(`item-edit-${sk("P1")}-save`)).toHaveCount(0);
    // No stale save: the local G intent was discarded (form closed), H=[P1] applied,
    // and Redo added exactly its own single entry (no spurious membership write).
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual([]);
    expect((await readStaffGroups(page)).find((g) => g.id === "H")?.members).toEqual(["P1"]);
    expect(await pastCount(page)).toBe(past + 1);
    expect(await futureCount(page)).toBe(future - 1);
  });

  test("people — EDIT-GROUP local member + concurrent Redo: form closes, no stale write (Major 1)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
      ],
      staffGroups: [{ id: "G", members: [] }],
    });
    await seed(page, {
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
      ],
      staffGroups: [{ id: "G", members: ["P2"] }],
    });
    await undo(page); // G back to []
    const past = await pastCount(page);
    const future = await futureCount(page);

    await page.getByTestId("group-edit-G").click();
    await page
      .getByTestId("transfer-list-G")
      .getByRole("button", { name: /Add P1 to group/i })
      .click(); // local draft add P1 (no commit)
    // Precondition: P1 is visibly in the MEMBERS pane (a real local edit).
    await expect(page.getByTestId("transfer-members-G")).toContainText("P1");
    await redo(page); // external G=[P2] → form closes
    await expect(page.getByTestId("transfer-list-G")).toHaveCount(0);
    // Local P1 intent discarded via visible close; durable is exactly the Redo result,
    // and Redo added exactly its own entry (no spurious membership write).
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["P2"]);
    expect(await pastCount(page)).toBe(past + 1);
    expect(await futureCount(page)).toBe(future - 1);
  });

  test("people — ADD-ITEM selected group renamed by Redo: form closes, no stale group write (Major 1)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [{ id: "Team", members: [] }],
    });
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [{ id: "Seniors", members: [] }],
    });
    await undo(page); // back to Team
    const past = await pastCount(page);
    const future = await futureCount(page);

    // Open the ADD-item form and select the Team chip in the draft.
    await page.getByTestId("add-item-toggle").click();
    await page.getByTestId("add-item-id").fill("P2");
    await page.getByTestId("add-item-group-Team").click();
    await expect(page.getByTestId("add-item-group-Team")).toHaveAttribute("aria-pressed", "true");
    await redo(page); // Team → Seniors; the add form (which never rebased before) closes
    await expect(page.getByTestId("add-item-form")).toHaveCount(0);
    // No stale write: P2 was never added, Seniors stays empty; Redo added only its own entry.
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["P1"]);
    expect((await readStaffGroups(page)).find((g) => g.id === "Seniors")?.members).toEqual([]);
    expect(await pastCount(page)).toBe(past + 1);
    expect(await futureCount(page)).toBe(future - 1);
  });

  test("people — ADD-GROUP selected member renamed by Redo: form closes, no stale member write (Major 1)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, { staff: [{ id: "P1", history: [] }], staffGroups: [] });
    await seed(page, { staff: [{ id: "PX", history: [] }], staffGroups: [] });
    await undo(page); // back to P1
    const past = await pastCount(page);
    const future = await futureCount(page);

    await page.getByTestId("add-group-toggle").click();
    await page.getByTestId("add-group-id").fill("Team");
    await page
      .getByTestId("transfer-list-__new__")
      .getByRole("button", { name: /Add P1 to group/i })
      .click();
    await expect(page.getByTestId("transfer-members-__new__")).toContainText("P1");
    await redo(page); // P1 → PX; add-group form closes
    await expect(page.getByTestId("add-group-form")).toHaveCount(0);
    expect((await readStaffGroups(page)).map((g) => g.id)).toEqual([]);
    expect(await pastCount(page)).toBe(past + 1);
    expect(await futureCount(page)).toBe(future - 1);
  });

  test("people — EDIT-ITEM immediate stale Save racing Redo is a no-op (close-gate Major)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
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

    await page.getByTestId(`item-edit-${sk("P1")}`).click();
    await page.getByTestId(`item-edit-${sk("P1")}-group-G`).click(); // local draft G
    // Race: Redo + immediate Save dispatch in ONE task, before the close effect flushes.
    await redoThenClick(page, `item-edit-${sk("P1")}-save`);
    // The synchronous guard makes the Save a no-op: durable is exactly the Redo result,
    // with NO stale G=[P1] write and NO extra history entry.
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual([]);
    expect((await readStaffGroups(page)).find((g) => g.id === "H")?.members).toEqual(["P1"]);
    expect(await pastCount(page)).toBe(past + 1);
    await expect(page.getByTestId(`item-edit-${sk("P1")}-save`)).toHaveCount(0);
  });

  test("people — EDIT-GROUP immediate stale Save racing Redo is a no-op (close-gate Major)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
      ],
      staffGroups: [{ id: "G", members: [] }],
    });
    await seed(page, {
      staff: [
        { id: "P1", history: [] },
        { id: "P2", history: [] },
      ],
      staffGroups: [{ id: "G", members: ["P2"] }],
    });
    await undo(page); // G back to []
    const past = await pastCount(page);

    await page.getByTestId("group-edit-G").click();
    await page
      .getByTestId("transfer-list-G")
      .getByRole("button", { name: /Add P1 to group/i })
      .click(); // local draft add P1
    // Race: Redo + immediate Save dispatch in one task.
    await redoThenClick(page, "group-save-G");
    // No stale write: durable is exactly the Redo result (G=[P2]), one entry only.
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["P2"]);
    expect(await pastCount(page)).toBe(past + 1);
    await expect(page.getByTestId("transfer-list-G")).toHaveCount(0);
  });

  test("people — unrelated durable meta churn leaves the open form and Save commits (no over-fire)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [{ id: "G", members: [] }],
    });

    await page.getByTestId("group-edit-G").click();
    await page
      .getByTestId("transfer-list-G")
      .getByRole("button", { name: /Add P1 to group/i })
      .click(); // local draft add P1
    // Unrelated meta churn (not items/groups) must NOT close the form or block Save —
    // the staleness predicate keys only on the item/group slices.
    await seed(page, { rangeStart: "2099-01-01" });
    await expect(page.getByTestId("transfer-list-G")).toBeVisible();
    const past = await pastCount(page);
    await page.getByTestId("group-save-G").click();
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["P1"]);
    expect(await pastCount(page)).toBe(past + 1); // the Save commits as its own entry
  });

  test("people — item rename → Undo → Redo round-trips durably", async ({ page }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [{ id: "P1", history: [] }],
      staffGroups: [{ id: "G", members: ["P1"] }],
    });

    // Rename P1 → Alice via inline edit (cascade rewrites the group member).
    await page.getByTestId(`item-id-text-${sk("P1")}`).dblclick();
    await page.getByTestId(`item-id-input-${sk("P1")}`).fill("Alice");
    await page.getByTestId(`item-id-input-${sk("P1")}`).press("Enter");
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["Alice"]);
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["Alice"]);

    await undo(page);
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["P1"]);
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["P1"]);
    await redo(page);
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["Alice"]);
    expect((await readStaffGroups(page)).find((g) => g.id === "G")?.members).toEqual(["Alice"]);
  });

  test("people — an unrelated edit preserves a loaded WHITESPACE id verbatim (M3)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, { staff: [{ id: " P1 ", history: [] }], staffGroups: [] });

    // Edit only the description; the whitespace id must NOT be trimmed/renamed.
    await page.getByTestId(`item-edit-${sk(" P1 ")}`).click();
    await page.getByTestId(`item-edit-${sk(" P1 ")}-desc`).fill("Whitespace nurse");
    await page.getByTestId(`item-edit-${sk(" P1 ")}-save`).click();

    const staff = await readStaff(page);
    expect(staff[0].id).toBe(" P1 "); // verbatim — no silent trim/rename
    expect(staff[0].description).toBe("Whitespace nurse");
  });

  test('people — inline no-op on numeric 1 (beside string "1") closes with no false duplicate (Minor 2)', async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [
        { id: 1, history: [] },
        { id: "1", history: [] },
      ],
      staffGroups: [],
    });

    // Open the numeric inline id editor and blur WITHOUT changing the text.
    await page.getByTestId(`item-id-text-${nk(1)}`).dblclick();
    await page.getByTestId(`item-id-input-${nk(1)}`).blur();
    // Editor closes (no stuck input), no duplicate toast, ids + types intact.
    await expect(page.getByTestId(`item-id-input-${nk(1)}`)).toHaveCount(0);
    await expect(page.getByText(/already used by another/i)).toHaveCount(0);
    const staff = await readStaff(page);
    expect(staff[0].id).toBe(1);
    expect(staff[1].id).toBe("1");
  });

  test("people — bulk upload reorders existing, adds new, moves unmentioned to the tail", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "A", history: [] },
        { id: "B", history: [] },
        { id: "C", history: [] },
      ],
      staffGroups: [],
    });

    await page.getByTestId("upload-toggle").click();
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

  test("people — bulk upload rejects intra-file duplicate, reserved, and group-id collision (M6)", async ({
    page,
  }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [{ id: "A", history: [] }],
      staffGroups: [{ id: "Team", members: [] }],
    });

    // Intra-file duplicate aborts atomically.
    await page.getByTestId("upload-toggle").click();
    await page.getByTestId("upload-file-input").setInputFiles({
      name: "dup.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("X\nX\n"),
    });
    await expect(page.getByText(/Duplicate person name "X"/i)).toBeVisible();
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["A"]);

    // Reserved name aborts (M6).
    await page.getByTestId("upload-file-input").setInputFiles({
      name: "reserved.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("N\nALL\n"),
    });
    await expect(
      page.getByText(/is a reserved keyword and cannot be used as a name/i),
    ).toBeVisible();
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["A"]);

    // A new name colliding with an existing group id aborts (M6).
    await page.getByTestId("upload-file-input").setInputFiles({
      name: "collide.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Team\n"),
    });
    await expect(page.getByText(/already used by an existing group/i)).toBeVisible();
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["A"]);
  });

  test("people — a semantically identical upload creates no undo entry (M8)", async ({ page }) => {
    await page.goto("/people");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      staff: [
        { id: "A", history: [] },
        { id: "B", history: [] },
      ],
      staffGroups: [{ id: "G", members: ["A", "B"] }],
    });

    const before = await pastCount(page);
    await page.getByTestId("upload-toggle").click();
    await page.getByTestId("upload-file-input").setInputFiles({
      name: "same.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("A\nB\n"),
    });
    // Dialog closes on a successful (here no-op) upload; give the commit a beat.
    await expect(page.getByTestId("upload-dialog")).toHaveCount(0);
    expect((await readStaff(page)).map((p) => p.id)).toEqual(["A", "B"]);
    expect(await pastCount(page)).toBe(before); // no spurious zundo entry
  });

  test("shift-types — OFF/LEAVE synthetic read-only; add a clock shift persists working time", async ({
    page,
  }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await expect(page.getByTestId("synthetic-OFF")).toBeVisible();
    await expect(page.getByTestId("synthetic-LEAVE")).toBeVisible();

    await page.getByTestId("add-item-toggle").click();
    await page.getByTestId("add-item-id").fill("Day");
    await page.getByTestId("add-item-start").selectOption("08:00");
    await page.getByTestId("add-item-end").selectOption("16:00");
    await expect(page.getByTestId("add-item-duration")).toHaveValue("480");
    await page.getByTestId("add-item-save").click();

    await expect(page.getByTestId(`item-row-${sk("Day")}`)).toBeVisible();
    expect((await readShifts(page)).find((s) => s.id === "Day")).toMatchObject({
      id: "Day",
      startTime: "08:00",
      endTime: "16:00",
      durationMinutes: 480,
    });
  });

  test("shift-types — duplicate preserves working time; grid rejections (#6 equal, #7 partial)", async ({
    page,
  }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      shifts: [{ id: "Day", startTime: "08:00", endTime: "16:00", durationMinutes: 480 }],
      shiftGroups: [],
    });

    await page.getByTestId(`item-dup-${sk("Day")}`).click();
    expect((await readShifts(page)).find((s) => s.id === "Day copy")).toMatchObject({
      startTime: "08:00",
      endTime: "16:00",
      durationMinutes: 480,
    });

    await page.getByTestId("add-item-toggle").click();
    await page.getByTestId("add-item-id").fill("Bad");
    await page.getByTestId("add-item-start").selectOption("09:00");
    await page.getByTestId("add-item-end").selectOption("09:00");
    await expect(page.getByText(/must differ/i)).toBeVisible();
    await expect(page.getByTestId("add-item-save")).toBeDisabled();

    await page.getByTestId("add-item-end").selectOption("");
    await expect(page.getByText(/provided together/i)).toBeVisible();
    await expect(page.getByTestId("add-item-save")).toBeDisabled();
  });

  test("shift-types — clearing working time on edit persists as removal (Major 5, first round)", async ({
    page,
  }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      shifts: [{ id: "Day", startTime: "08:00", endTime: "16:00", durationMinutes: 480 }],
      shiftGroups: [],
    });

    await page.getByTestId(`item-edit-${sk("Day")}`).click();
    await page.getByTestId(`item-edit-${sk("Day")}-wt-clear`).click();
    await page.getByTestId(`item-edit-${sk("Day")}-save`).click();

    const day = (await readShifts(page)).find((s) => s.id === "Day");
    expect(day?.startTime ?? null).toBeNull();
    expect(day?.endTime ?? null).toBeNull();
    expect(day?.durationMinutes ?? null).toBeNull();
    expect(day?.restMinutes ?? null).toBeNull();
  });

  test("shift-types — a loaded bare-duration shift survives an unrelated edit (DL10-D4 guardrail)", async ({
    page,
  }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    // A valid producer shape: bare durationMinutes, NO clocks (spec 01 accepts it).
    await seed(page, { shifts: [{ id: "Flex", durationMinutes: 480 }], shiftGroups: [] });

    await page.getByTestId(`item-edit-${sk("Flex")}`).click();
    await page.getByTestId(`item-edit-${sk("Flex")}-desc`).fill("Flexible shift");
    await page.getByTestId(`item-edit-${sk("Flex")}-save`).click();

    const flex = (await readShifts(page)).find((s) => s.id === "Flex");
    expect(flex?.durationMinutes).toBe(480); // preserved, not force-cleared
    expect(flex?.startTime ?? null).toBeNull(); // no clocks injected
    expect(flex?.endTime ?? null).toBeNull();
    expect(flex?.description).toBe("Flexible shift");
  });

  test("shift-types — shift group duplicate keeps members", async ({ page }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-item-toggle")).toBeVisible();
    await seed(page, {
      shifts: [{ id: "Day" }, { id: "Night" }],
      shiftGroups: [{ id: "Working", members: ["Day", "Night"] }],
    });

    await page.getByTestId("group-dup-Working").click();
    await expect(page.getByTestId("group-row-Working copy")).toBeVisible();
    expect((await readShiftGroups(page)).find((g) => g.id === "Working copy")?.members).toEqual([
      "Day",
      "Night",
    ]);
  });
});
