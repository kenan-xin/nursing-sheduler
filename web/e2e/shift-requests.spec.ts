import { expect, test, type Page } from "@playwright/test";

// T11 acceptance smoke: the Shift Requests matrix driven against a production
// build through the real T04 store (`window.__nsStore`), mirroring the seeding
// pattern established by successions.spec.ts/counts.spec.ts. Covers:
//  • the required-data gate (FR-SR-01/02) when the scenario is missing dates;
//  • the matrix rendering + a Normal-mode cell-editor round-trip (Paid leave),
//    verified against BOTH the rendered cell AND the derived "Current shift
//    requests" table/footer count;
//  • one Quick-paint drag across two cells, verified as one durable write
//    (a single `zundo` history entry for a 2-cell gesture).
//
// Click-to-edit is the primary path (robust); the drag case uses real
// `page.mouse` events rather than React synthetic dispatch, matching how a
// user actually paints.

type NsWindow = {
  __nsStore: {
    scenario: {
      getState: () => Record<string, unknown> & {
        reqData: unknown[];
        mutateScenario: (patch: Record<string, unknown>) => void;
      };
      temporal: {
        getState: () => { pastStates: unknown[] };
      };
    };
  };
};

async function waitForStore(page: Page) {
  await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsStore));
}

/**
 * Navigate + wait for hydration to actually settle. The durable store's
 * `mutateScenario` no-ops until the spine reports `ready`, and `__nsStore`
 * mounts (and the empty-state required-data gate renders) before that flip —
 * so waiting on `__nsStore` alone races hydration. The gate/heading only ever
 * renders past `HydrationGate`, so its visibility is a reliable ready signal.
 */
async function gotoReady(page: Page) {
  await page.goto("/shift-requests");
  await waitForStore(page);
  await expect(page.getByRole("heading", { name: "Requests & Leave" })).toBeVisible();
}

/** Seed the durable store directly (mirrors successions.spec.ts's `seed`). */
async function seed(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}

function readReqData(page: Page) {
  return page.evaluate(() => (window as unknown as NsWindow).__nsStore.scenario.getState().reqData);
}

function pastCount(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().pastStates.length,
  );
}

// Same-month range → date-item ids format as bare "DD" (T10 span-format rule).
const BASE_SEED = {
  rangeStart: "2026-01-01",
  rangeEnd: "2026-01-05",
  staff: [
    { id: "Aisha", history: [] },
    { id: "Chloe", history: [] },
  ],
  shifts: [{ id: "AM" }, { id: "PM" }],
};

test.describe("T11 shift requests matrix", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("required-data gate: no roster range shows the prioritized dates guidance (FR-SR-01/02)", async ({
    page,
  }) => {
    await gotoReady(page);
    await expect(page.getByTestId("requests-required-data-gate")).toBeVisible();
    await expect(page.getByTestId("requests-required-data-gate")).toContainText("Dates");
    // The matrix itself must not render alongside the gate.
    await expect(page.getByTestId("requests-matrix")).toHaveCount(0);
  });

  test("matrix renders and a Normal-mode Paid leave edit round-trips (one undo entry)", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();
    await expect(page.getByTestId("row-Aisha")).toBeVisible();
    await expect(page.getByTestId("col-head-3")).toBeVisible(); // 3 synthetic date-group cols precede date items

    const before = await pastCount(page);
    await page.getByTestId("cell-Aisha-01").click();
    await expect(page.getByTestId("cell-preference-editor")).toBeVisible();
    await page.getByTestId("cell-editor-tab-leave").click();
    await page.getByTestId("cell-editor-save").click();
    await expect(page.getByTestId("cell-preference-editor")).toHaveCount(0);

    // Rendered cell reflects the day-state.
    await expect(page.getByTestId("cell-Aisha-01")).toContainText("Leave");

    // Derived "Current shift requests" table + footer both reflect the one write.
    await expect(page.getByTestId("requests-count")).toHaveText("1");
    await expect(page.getByTestId("requests-footer")).toContainText("1 requests");

    const reqData = (await readReqData(page)) as {
      uid?: string;
      kind: string;
      person: string;
      date: string;
    }[];
    expect(reqData).toMatchObject([{ kind: "leave", person: "Aisha", date: "01" }]);
    // A manually-created cell carries a durable, non-positional uid (T17r P1) so
    // Workspace serialization never falls back to a content/index-derived id.
    expect(typeof reqData[0].uid).toBe("string");
    expect(reqData[0].uid).toBeTruthy();
    expect((await pastCount(page)) - before).toBe(1);
  });

  test("quick-paint drag across two cells applies one preference each in a single undo entry", async ({
    page,
  }) => {
    await gotoReady(page);
    await seed(page, BASE_SEED);
    await expect(page.getByTestId("requests-matrix")).toBeVisible();

    await page.getByTestId("requests-tab-quick").click();
    await expect(page.getByTestId("quick-paint-panel")).toBeVisible();
    await page.getByTestId("quick-paint-chip-AM").click();
    await page.getByTestId("quick-paint-weight-input").fill("5");

    const before = await pastCount(page);
    const cellA = page.getByTestId("cell-Chloe-02");
    const cellB = page.getByTestId("cell-Chloe-03");
    // The matrix + surrounding chrome push the row below the fold at default
    // viewport size — scroll both into view (page + the matrix's own inner
    // scroll pane) before reading real screen coordinates for `page.mouse`.
    await cellA.scrollIntoViewIfNeeded();
    await cellB.scrollIntoViewIfNeeded();
    const boxA = await cellA.boundingBox();
    const boxB = await cellB.boundingBox();
    if (!boxA || !boxB) throw new Error("expected both drag cells to have a bounding box");

    await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
    await page.mouse.down();
    await page.mouse.move(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect(cellA).toContainText("AM (+5)");
    await expect(cellB).toContainText("AM (+5)");
    await expect(page.getByTestId("requests-footer")).toContainText("2 requests");

    const reqData = (await readReqData(page)) as {
      person: string;
      date: string;
      shiftType: string;
    }[];
    expect(reqData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ person: "Chloe", date: "02", shiftType: "AM" }),
        expect.objectContaining({ person: "Chloe", date: "03", shiftType: "AM" }),
      ]),
    );
    // One drag across two cells is one durable write, regardless of cells crossed.
    expect((await pastCount(page)) - before).toBe(1);
  });
});
