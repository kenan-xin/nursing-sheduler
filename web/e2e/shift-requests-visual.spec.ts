import { expect, test, type Page } from "@playwright/test";

// R5 route-local visual/geometry proof for the migrated Shift Requests surface.
//
// The universal v2 battery (`v2-visual-system.spec.ts`, run for the R5 row in
// both `chromium` and `v2-touch`) already proves No-Black, semantic roles, axe
// AA, scrim provenance, status/solid-fill pairing, coarse-pointer targets and
// the coarse row/column geometry. This spec narrows in on what the universal
// battery does NOT assert: the matrix's square L1 geometry, its data cells'
// squareness, and the resolved status-ink pairing on real seeded cells in DARK
// mode — the discriminating context where `--success` and `--successink`
// (likewise warn/error) resolve to different colours, so a tint painted with the
// base colour would be a real status-pairing defect rather than a theoretical
// one. No `Math.round` on the geometry: the assertions compare raw computed
// values and raw bounding boxes.

type NsWindow = {
  __nsStore: {
    scenario: {
      getState: () => Record<string, unknown> & {
        mutateScenario: (patch: Record<string, unknown>) => void;
      };
    };
  };
};

async function waitForStore(page: Page) {
  await page.waitForFunction(() => Boolean((window as unknown as NsWindow).__nsStore));
}

async function gotoReady(page: Page, theme: "light" | "dark") {
  await page.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("ns-theme", t);
      } catch {}
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    },
    [theme] as const,
  );
  await page.goto("/shift-requests");
  await waitForStore(page);
  await expect(page.getByRole("heading", { name: "Requests & Leave" })).toBeVisible();
}

async function seed(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}

/** Resolve a CSS variable to its computed value on this page, via a probe. */
async function resolveVar(page: Page, prop: "color" | "backgroundColor", token: string) {
  return page.evaluate(
    ([p, t]) => {
      const probe = document.createElement("div");
      probe.style[p === "color" ? "color" : "backgroundColor"] = `var(${t})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe)[p];
      probe.remove();
      return value;
    },
    [prop, token] as const,
  );
}

const BASE_SEED = {
  rangeStart: "2026-01-01",
  rangeEnd: "2026-01-05",
  staff: [
    { id: "Aisha", history: [] },
    { id: "Chloe", history: [] },
  ],
  shifts: [{ id: "AM" }, { id: "PM" }],
};

// One cell of each day-state/sign so every status pairing is provable on real
// paint. Dates format as bare "DD" for a same-month range.
const SEEDED_REQUESTS = [
  { kind: "leave", person: "Aisha", date: "01" },
  { kind: "off", person: "Aisha", date: "02", weight: -3 },
  { kind: "request", person: "Aisha", date: "03", shiftType: "AM", weight: 5 },
  { kind: "request", person: "Chloe", date: "03", shiftType: "PM", weight: -5 },
];

test.describe("R5 shift requests — migrated surface geometry and paint", () => {
  test("the matrix container is a square L1 surface: square corners, surface tone, real shadow", async ({
    page,
  }) => {
    await gotoReady(page, "light");
    await seed(page, { ...BASE_SEED, reqData: SEEDED_REQUESTS });
    await expect(page.getByTestId("requests-matrix")).toBeVisible();

    const matrix = page.getByTestId("requests-matrix");
    // Raw computed geometry — no rounding.
    const geometry = await matrix.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        radius: s.borderRadius,
        bg: s.backgroundColor,
        shadow: s.boxShadow,
      };
    });
    expect(geometry.radius).toBe("0px");
    expect(geometry.shadow, "an L1 surface carries --sh-1, never 'none'").not.toBe("none");

    const surface = await resolveVar(page, "backgroundColor", "--surface");
    expect(geometry.bg).toBe(surface);
  });

  test("matrix data cells stay square (no card radius leaks into the grid)", async ({ page }) => {
    await gotoReady(page, "light");
    await seed(page, { ...BASE_SEED, reqData: SEEDED_REQUESTS });
    await expect(page.getByTestId("cell-Aisha-01")).toBeVisible();

    const radii = await page.evaluate(() => {
      const cells = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid^="cell-Aisha-"]'),
      );
      return cells.map((el) => getComputedStyle(el).borderRadius);
    });
    expect(radii.length).toBeGreaterThan(0);
    // Every data cell is square: a single rounded corner would be a geometry leak.
    for (const r of radii) expect(r).toBe("0px");
  });

  // The discriminating case: in dark mode the base and ink tiers of each status
  // resolve to DIFFERENT colours, so a tint painted with the base colour is a
  // real status-pairing defect. This proves the resolved paint, not the class.
  test("status cells pair their tint with the matching semantic ink in dark mode", async ({
    page,
  }) => {
    await gotoReady(page, "dark");
    await seed(page, { ...BASE_SEED, reqData: SEEDED_REQUESTS });

    const cases = [
      { testid: "cell-Aisha-01", tint: "--brandtint", ink: "--brandink", label: "leave" },
      { testid: "cell-Aisha-02", tint: "--errortint", ink: "--errorink", label: "off" },
      { testid: "cell-Aisha-03", tint: "--successtint", ink: "--successink", label: "positive" },
      { testid: "cell-Chloe-03", tint: "--warntint", ink: "--warnink", label: "negative" },
    ];

    for (const c of cases) {
      await expect(page.getByTestId(c.testid)).toBeVisible();
      const cell = page.getByTestId(c.testid);
      const bg = await cell.evaluate((el) => getComputedStyle(el).backgroundColor);
      const color = await cell.evaluate((el) => getComputedStyle(el).color);
      const tint = await resolveVar(page, "backgroundColor", c.tint);
      const ink = await resolveVar(page, "color", c.ink);
      expect(bg, `${c.label}: cell background resolves to its status tint`).toBe(tint);
      expect(color, `${c.label}: cell text resolves to its paired semantic ink`).toBe(ink);
    }
  });

  test("quick-paint error status pairs errortint with errorink (prototype quickStatusStyle)", async ({
    page,
  }) => {
    await gotoReady(page, "dark");
    await seed(page, { ...BASE_SEED, reqData: SEEDED_REQUESTS });
    // Select a target but leave the weight invalid → "error" tone.
    await page.getByTestId("requests-tab-quick").click();
    await expect(page.getByTestId("quick-paint-panel")).toBeVisible();
    await page.getByTestId("quick-paint-chip-AM").click();
    await page.getByTestId("quick-paint-weight-input").fill("abc");
    await expect(page.getByTestId("quick-paint-status")).toContainText(/valid weight/);

    const status = page.getByTestId("quick-paint-status");
    const paint = await status.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color };
    });
    const errortint = await resolveVar(page, "backgroundColor", "--errortint");
    const errorink = await resolveVar(page, "color", "--errorink");
    expect(paint.bg).toBe(errortint);
    expect(paint.color).toBe(errorink);
  });
});
