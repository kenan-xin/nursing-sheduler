import { expect, test, type Page } from "@playwright/test";

// DR-3 acceptance for the bespoke Shifts card-grid (`/shift-types` → ShiftTypeGrid),
// carved from people-shift-types.spec.ts. Driven against a production build through
// the real T04 store (`window.__nsStore`); every outcome asserts the DURABLE store
// shape. Coverage (migrated, not dropped): reserved OFF/LEAVE locked, working-time
// persist + derivation, the #6-equal / #7-partial grid rejections, clear-working-
// time-on-edit, bare-duration preservation on an unrelated edit, keyboard reorder,
// and the shared Shift-groups duplicate. The Min/Preferred staffing tie-in is DR-4
// and is intentionally NOT covered here (a shift card without staffing is an intended
// intermediate). Pure-logic parity is pinned in components/shift-types/*.test.tsx and
// components/entity-editor/core/*.test.ts (vitest).

type ShiftRow = {
  id: unknown;
  description?: string;
  startTime?: string;
  endTime?: string;
  restMinutes?: number;
  durationMinutes?: number;
};
type StoreState = Record<string, unknown> & {
  shifts?: ShiftRow[];
  shiftGroups?: { id: string; members: unknown[] }[];
  cardsByKind?: {
    requirements: Array<{
      uid: string;
      shiftType: unknown;
      requiredNumPeople: number;
      preferredNumPeople?: number;
      qualifiedPeople?: unknown;
      date?: unknown;
      weight: number;
    }>;
  };
};

type NsWindow = {
  __nsStore: {
    scenario: {
      getState: () => StoreState & { mutateScenario: (patch: Record<string, unknown>) => void };
      temporal: {
        getState: () => { pastStates: unknown[]; futureStates: unknown[] };
      };
    };
  };
};

/** Type-tagged presentation key (mirror core `entityKey`) for building test ids. */
const sk = (id: string) => `string:${id}`;

function readState(page: Page) {
  return page.evaluate(() => (window as unknown as NsWindow).__nsStore.scenario.getState());
}
async function readShifts(page: Page) {
  return (await readState(page)).shifts ?? [];
}
async function readShiftGroups(page: Page) {
  return (await readState(page)).shiftGroups ?? [];
}
async function readRequirements(page: Page) {
  return (await readState(page)).cardsByKind?.requirements ?? [];
}
async function readHistoryLength(page: Page) {
  return page.evaluate(
    () => (window as unknown as NsWindow).__nsStore.scenario.temporal.getState().pastStates.length,
  );
}

/** Seed the durable store directly (the grid's store is the same singleton). */
async function seed(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}

test.describe.serial("DR-3 Shifts card-grid", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(30_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("OFF/LEAVE reserved cards render locked; adding a clock shift persists working time", async ({
    page,
  }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
    await expect(page.getByTestId("synthetic-OFF")).toBeVisible();
    await expect(page.getByTestId("synthetic-LEAVE")).toBeVisible();
    // Reserved cards show a lock + reason, never a raw editable/disabled control.
    await expect(page.getByTestId("synthetic-OFF-reason")).toBeVisible();
    await expect(page.getByTestId("shift-edit-OFF")).toHaveCount(0);

    await page.getByTestId("add-shift-toggle").click();
    await page.getByTestId("shift-add-code").fill("Day");
    await page.getByTestId("shift-add-start").selectOption("08:00");
    await page.getByTestId("shift-add-end").selectOption("16:00");
    // Working(auto) derivation is visible whenever start+end are set.
    await expect(page.getByTestId("shift-add-duration")).toContainText("8h");
    await page.getByTestId("shift-add-save").click();

    await expect(page.getByTestId(`shift-card-${sk("Day")}`)).toBeVisible();
    expect((await readShifts(page)).find((s) => s.id === "Day")).toMatchObject({
      id: "Day",
      startTime: "08:00",
      endTime: "16:00",
      durationMinutes: 480,
    });
  });

  test("grid rejections — #6 equal start/end and #7 partial clock block save", async ({ page }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();

    await page.getByTestId("add-shift-toggle").click();
    await page.getByTestId("shift-add-code").fill("Bad");
    await page.getByTestId("shift-add-start").selectOption("09:00");
    await page.getByTestId("shift-add-end").selectOption("09:00");
    await expect(page.getByText(/must differ/i)).toBeVisible();
    await expect(page.getByTestId("shift-add-save")).toBeDisabled();

    await page.getByTestId("shift-add-end").selectOption("");
    await expect(page.getByText(/provided together/i)).toBeVisible();
    await expect(page.getByTestId("shift-add-save")).toBeDisabled();
  });

  test("clearing working time on edit persists as removal", async ({ page }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
    await seed(page, {
      shifts: [{ id: "Day", startTime: "08:00", endTime: "16:00", durationMinutes: 480 }],
      shiftGroups: [],
    });

    await page.getByTestId(`shift-edit-${sk("Day")}`).click();
    await page.getByTestId(`shift-edit-${sk("Day")}-start`).selectOption("");
    await page.getByTestId(`shift-edit-${sk("Day")}-end`).selectOption("");
    await page.getByTestId(`shift-edit-${sk("Day")}-save`).click();

    const day = (await readShifts(page)).find((s) => s.id === "Day");
    expect(day?.startTime ?? null).toBeNull();
    expect(day?.endTime ?? null).toBeNull();
    expect(day?.durationMinutes ?? null).toBeNull();
    expect(day?.restMinutes ?? null).toBeNull();
  });

  test("a loaded bare-duration shift survives an unrelated edit (DL10-D4 guardrail)", async ({
    page,
  }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
    // A valid producer shape: bare durationMinutes, NO clocks (spec 01 accepts it).
    await seed(page, { shifts: [{ id: "Flex", durationMinutes: 480 }], shiftGroups: [] });

    await page.getByTestId(`shift-edit-${sk("Flex")}`).click();
    await page.getByTestId(`shift-edit-${sk("Flex")}-name`).fill("Flexible shift");
    await page.getByTestId(`shift-edit-${sk("Flex")}-save`).click();

    const flex = (await readShifts(page)).find((s) => s.id === "Flex");
    expect(flex?.durationMinutes).toBe(480); // preserved, not force-cleared
    expect(flex?.startTime ?? null).toBeNull(); // no clocks injected
    expect(flex?.endTime ?? null).toBeNull();
    expect(flex?.description).toBe("Flexible shift");
  });

  test("keyboard reorder (Up/Down) moves the durable order", async ({ page }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
    await seed(page, {
      shifts: [{ id: "A" }, { id: "B" }, { id: "C" }],
      shiftGroups: [],
    });

    await expect(page.getByTestId(`shift-move-up-${sk("A")}`)).toBeDisabled();
    await page.getByTestId(`shift-move-down-${sk("A")}`).click();
    await expect
      .poll(async () => (await readShifts(page)).map((s) => s.id))
      .toEqual(["B", "A", "C"]);
  });

  test("shift group duplicate keeps members", async ({ page }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
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

  test("staffing flow creates one shared rule, then rename + collapse stays atomic", async ({
    page,
  }) => {
    await page.goto("/shift-types");
    await expect(page.getByTestId("add-shift-toggle")).toBeVisible();

    await page.getByTestId("add-shift-toggle").click();
    await page.getByTestId("shift-add-code").fill("Day");
    await page.getByTestId("shift-add-required").fill("2");
    await page.getByTestId("shift-add-preferred").fill("3");
    await page.getByTestId("shift-add-save").click();

    await expect(page.getByTestId(`staffing-min-${sk("Day")}`)).toHaveText("2");
    expect((await readRequirements(page))[0]).toMatchObject({
      shiftType: ["Day"],
      qualifiedPeople: ["ALL"],
      date: ["ALL"],
      requiredNumPeople: 2,
      preferredNumPeople: 3,
      weight: -50,
    });

    const before = await readHistoryLength(page);
    await page.getByTestId(`shift-edit-${sk("Day")}`).click();
    await page.getByTestId(`shift-edit-${sk("Day")}-code`).fill("AM");
    await page.getByTestId(`shift-edit-${sk("Day")}-required`).fill("4");
    await page.getByTestId(`shift-edit-${sk("Day")}-preferred`).fill("4");
    await expect(page.getByTestId(`shift-edit-${sk("Day")}-preferred-collapse`)).toContainText(
      "weight reset from -50 to -1",
    );
    await page.getByTestId(`shift-edit-${sk("Day")}-save`).click();

    expect(await readHistoryLength(page)).toBe(before + 1);
    expect((await readShifts(page)).map((shift) => shift.id)).toEqual(["AM"]);
    expect((await readRequirements(page))[0]).toMatchObject({
      shiftType: ["AM"],
      requiredNumPeople: 4,
      weight: -1,
    });
    expect((await readRequirements(page))[0].preferredNumPeople).toBeUndefined();
  });
});

// Layout guard for the Time-on-floor clock row, which only over-subscribes in its
// COMPOSED state: an overnight shift adds the "+1 day" badge beside the two clock
// selects, and each select carries the shared Select's caret gutter. At the widths
// where the card grid is 3-up the children then want more than one line.
//
// This lives in e2e and not vitest because the assertion IS layout — wrapping,
// overflow and text clipping are all resolved by the engine against the real
// stylesheet, and jsdom computes none of it. The failure mode is silent and visual
// (a select pushed past the card edge, or digits chopped off a time with no ellipsis
// to warn you), so nothing else in the suite goes red when it breaks.
//
// The row overflowed for overnight shifts even before the caret gutter existed; the
// gutter only made it unmissable. Assertions are on the invariant — nothing escapes
// the row, no glyphs are clipped — rather than on `flex-wrap` specifically, so a
// future fix that stacks the row differently still passes.
test.describe("DR-5 shift card — the overnight clock row wraps instead of overflowing", () => {
  // 1100 is where the card grid turns 3-up (the prototype's ns-grid3 ladder), so
  // 1100–1280 is the narrowest a card gets. Density used to inflate this row at
  // the larger end of its range; the knob is gone (bmw.8) and the 0.9 baseline
  // is baked as literals in globals.css, so the guard now runs once per width at
  // that single scale.
  const WIDTHS = [1100, 1150, 1280];

  for (const width of WIDTHS) {
    test(`${width}px`, async ({ page }, testInfo) => {
      testInfo.setTimeout(30_000);
      await page.setViewportSize({ width, height: 1300 });
      await page.goto("/shift-types");
      await expect(page.getByTestId("add-shift-toggle")).toBeVisible();

      await page.getByTestId("add-shift-toggle").click();
      await page.getByTestId("shift-add-code").fill("Night");
      // end <= start is the overnight case, which is what summons the badge.
      await page.getByTestId("shift-add-start").selectOption("19:00");
      await page.getByTestId("shift-add-end").selectOption("07:00");

      const row = page.getByTestId("shift-add-clocks");
      // Guard the premise: without the badge this row is not the composed state
      // the test exists for, and every assertion below would pass trivially.
      await expect(row.getByText("+1 day")).toBeVisible();

      const geometry = await row.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const children = [...el.children];
        const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
        return {
          rowWidth: box.width,
          // What the children would need laid out on ONE line.
          oneLineNeed:
            children.reduce((sum, c) => sum + c.getBoundingClientRect().width, 0) +
            gap * (children.length - 1),
          lineCount: new Set(children.map((c) => Math.round(c.getBoundingClientRect().top))).size,
          escapes: children
            .filter((c) => c.getBoundingClientRect().right > box.right + 1)
            .map((c) => c.getAttribute("data-testid") ?? c.textContent?.trim() ?? "?"),
          overflows: el.scrollWidth > el.clientWidth + 1,
          // A select whose text is wider than its content box chops glyphs with no
          // ellipsis — the failure mode of "shrink instead of wrap".
          clipped: [...el.querySelectorAll("select")]
            .filter((s) => s.scrollWidth > s.clientWidth + 1)
            .map((s) => s.getAttribute("data-testid") ?? "?"),
        };
      });

      expect(geometry.escapes, "no child may extend past the row").toEqual([]);
      expect(geometry.overflows, "the row must not overflow").toBe(false);
      expect(geometry.clipped, "no clock select may clip its time").toEqual([]);

      // Prove the test is in the regime it was written for: where one line is not
      // enough, the row must actually have taken a second one. Asserted only when
      // the arithmetic demands it, since the widest band still fits on one line.
      if (geometry.oneLineNeed > geometry.rowWidth + 1) {
        expect(
          geometry.lineCount,
          `children need ${Math.round(geometry.oneLineNeed)}px in a ${Math.round(
            geometry.rowWidth,
          )}px row, so the row must wrap`,
        ).toBeGreaterThan(1);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// R2c — v2 "Mint Canvas, Warm Ink" on /shift-types.
//
// Complementary to `components/shift-types/shift-types-v2-roles.test.tsx` and
// `components/entity-editor/working-time-fields.test.tsx`, and neither half is
// sufficient alone. Those suites prove AUTHORITY — which contract emitted each
// class — because a hand-authored `bg-surface border-line shadow-1` box and the
// shared `surface` role are indistinguishable once the browser has resolved
// them. This suite proves the RESOLVED result: tone compared against the runtime
// token read through the live cascade (never a hardcoded hex), the absolute
// radius and control tokens measured RAW, and the elevation direction observed.
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

/**
 * The same idea for elevation. Comparing against the RESOLVED token is what makes
 * the claim theme-aware and provenance-bearing: an eyeballed "has some shadow"
 * passes on a hand-authored cast, and a hardcoded rgba string passes in exactly
 * one theme.
 */
async function resolveShadows(page: Page, tokens: string[]): Promise<Record<string, string>> {
  return page.evaluate((list) => {
    const out: Record<string, string> = {};
    for (const token of list) {
      const probe = document.createElement("div");
      probe.style.boxShadow = `var(${token})`;
      document.body.appendChild(probe);
      out[token] = getComputedStyle(probe).boxShadow;
      probe.remove();
    }
    return out;
  }, tokens);
}

/**
 * Tailwind composes `box-shadow` from four always-present slots (inset ring,
 * ring, ring-offset, and the utility's own), so a utility-driven element resolves
 * with leading `rgba(0, 0, 0, 0) 0px 0px 0px 0px` layers that the bare probe has
 * no reason to carry. Dropping the layers that PAINT NOTHING is not a loosening:
 * the remaining layers still have to be byte-identical to the token, so a
 * hand-authored cast — or a genuine extra visible layer — still fails.
 */
const paintedLayers = (shadow: string) =>
  shadow
    .replace(/(?:^|,\s*)rgba\(0,\s*0,\s*0,\s*0\)\s+0px 0px 0px 0px/g, "")
    .replace(/^\s*,\s*/, "")
    .trim();

async function gotoShifts(page: Page) {
  await page.goto("/shift-types");
  await expect(page.getByTestId("add-shift-toggle")).toBeVisible();
}

/** The ward used by every visual case below — two clock shifts and one group. */
async function seedWard(page: Page) {
  await seed(page, {
    shifts: [
      {
        id: "Day",
        description: "Day shift",
        startTime: "08:00",
        endTime: "16:00",
        durationMinutes: 480,
      },
      {
        id: "Night",
        description: "Night shift",
        startTime: "19:00",
        endTime: "07:00",
        durationMinutes: 720,
      },
    ],
    shiftGroups: [{ id: "Working", members: ["Day", "Night"] }],
  });
  await expect(page.getByTestId(`shift-card-${sk("Night")}`)).toBeVisible();
}

/**
 * The fixed eight-entry shift data palette (DESIGN.md §2 "Shift colour palette").
 * It has no owner on this route and must not acquire one here: it stays literal
 * data-mark colour in whatever screen eventually draws roster chips, never a
 * theme-token family, and never varies by theme. `/shift-types` painting one of
 * these would be the first step of exactly that drift.
 */
const SHIFT_PALETTE = [
  "#f8e2b8",
  "#7a5310",
  "#d4a038",
  "#f6dbcd",
  "#9a4726",
  "#cf7049",
  "#e4ecd0",
  "#586a22",
  "#8fa243",
  "#d8e0f2",
  "#374777",
  "#6274ad",
  "#e9dbf0",
  "#653f8e",
  "#9670bd",
  "#d3e9e3",
  "#1b6a5d",
  "#3d9587",
  "#f7dae2",
  "#9a3153",
  "#c66184",
  "#2b2733",
  "#ece6f2",
  "#5c5468",
];

const hexToRgb = (hex: string) =>
  `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

test.describe("R2c — v2 visual system on /shift-types", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(45_000);
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  for (const theme of ["light", "dark"] as const) {
    test(`the surface ladder resolves in the ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 1200 });
      await page.addInitScript((t) => {
        try {
          window.localStorage.setItem("ns-theme", t);
        } catch {}
      }, theme);
      await gotoShifts(page);
      const html = page.locator("html");
      if (theme === "dark") await expect(html).toHaveClass(/dark/);
      else await expect(html).not.toHaveClass(/dark/);

      await seedWard(page);

      const tone = await resolveTokens(page, [
        "--bg",
        "--surface",
        "--panel",
        "--panel-alt",
        "--brand",
      ]);
      const cast = await resolveShadows(page, ["--sh-1", "--sh-2", "--sh-well"]);

      // L0 — the screen root is the recessed page plane, and it is never a box.
      const root = page.getByTestId("screen");
      await expect(root).toHaveCSS("background-color", tone["--bg"]);
      await expect(root).toHaveCSS("border-radius", "0px");
      expect(await root.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");

      // L1 — a resting shift card at --surface / 16px / an OUTER cast.
      const card = page.getByTestId(`shift-card-${sk("Day")}`);
      await expect(card).toHaveCSS("background-color", tone["--surface"]);
      await expect(card).toHaveCSS("border-radius", "16px");
      const cardShadow = await card.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(paintedLayers(cardShadow), "a resting card carries exactly --sh-1").toBe(
        paintedLayers(cast["--sh-1"]),
      );
      expect(cardShadow, "a resting card is never an inset").not.toContain("inset");

      // A reserved day-state is the SAME L1 card. "Locked" is the AUTO badge and
      // the absent action row, not a second tone — a --panel tile recedes in
      // light and RISES in dark, so tone cannot carry it across both themes.
      const reserved = page.getByTestId("synthetic-OFF");
      await expect(reserved).toHaveCSS("background-color", tone["--surface"]);
      await expect(reserved).toHaveCSS("border-radius", "16px");

      // well — the icon tile is an inset island on the chip radius. Direction of
      // light is fixed: inset only, never an outer cast (DESIGN.md §4 rule 1).
      const tile = card.locator('[data-slot="shift-tile"]');
      await expect(tile).toHaveCSS("background-color", tone["--panel"]);
      await expect(tile).toHaveCSS("border-radius", "9px");
      const tileShadow = await tile.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(paintedLayers(tileShadow), "a well carries exactly --sh-well").toBe(
        paintedLayers(cast["--sh-well"]),
      );
      expect(tileShadow, "a well takes the inset cast").toContain("inset");

      // L1 selected — the open editor keeps the --surface plane and takes a
      // --brand edge, rather than v1's --brandtint wash.
      await page.getByTestId(`shift-edit-${sk("Day")}`).click();
      const form = page.getByTestId(`shift-edit-form-${sk("Day")}`);
      await expect(form).toHaveCSS("background-color", tone["--surface"]);
      await expect(form).toHaveCSS("border-color", tone["--brand"]);
      await expect(form).toHaveCSS("border-radius", "16px");
      const formShadow = await form.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(paintedLayers(formShadow), "the selected card lifts to exactly --sh-2").toBe(
        paintedLayers(cast["--sh-2"]),
      );
      expect(formShadow, "a lifted card is never an inset").not.toContain("inset");

      // well — the derived working-time readout, inside the editor card.
      const readout = page.getByTestId(`shift-edit-${sk("Day")}-duration`);
      await expect(readout).toHaveCSS("background-color", tone["--panel"]);
      await expect(readout).toHaveCSS("border-radius", "12px");
      expect(
        paintedLayers(await readout.evaluate((el) => getComputedStyle(el).boxShadow)),
        "the readout carries exactly --sh-well",
      ).toBe(paintedLayers(cast["--sh-well"]));
    });
  }

  test("the fixed shift data palette is painted nowhere on this route, in either theme", async ({
    browser,
  }) => {
    const wanted = new Set(SHIFT_PALETTE.map(hexToRgb));
    const seen: string[] = [];

    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
      const page = await context.newPage();
      await page.addInitScript((t) => {
        (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
        try {
          window.localStorage.setItem("ns-theme", t);
        } catch {}
      }, theme);
      await gotoShifts(page);
      await seedWard(page);
      await page.getByTestId(`shift-edit-${sk("Day")}`).click();

      const painted = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll("*"))) {
          const s = getComputedStyle(el);
          out.push(s.backgroundColor, s.color, s.borderTopColor, s.fill as string);
        }
        return out;
      });
      for (const value of painted) if (wanted.has(value)) seen.push(`${theme}: ${value}`);
      await context.close();
    }

    expect(
      seen,
      "a shift data-palette colour is painted on /shift-types — the ramp belongs to " +
        "roster marks and must not become a route or theme colour",
    ).toEqual([]);
  });

  test("real control geometry on a precise pointer — raw boxes on the absolute tokens", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await gotoShifts(page);
    await seedWard(page);

    // RAW dimensions, never rounded. `--ctl` 36 and `--ctl-lg`/`--touch-min` 44
    // are absolute integer tokens the 0.9 density baseline is forbidden to touch,
    // so the unrounded box is what has to land on them. `Math.round` here would
    // not be tolerance — it would widen "exactly 36" into any value in
    // [35.5, 36.5), which is precisely the undersizing this test exists to catch.
    // Text-driven WIDTHS are fractional by construction, so only the token-bound
    // axes are asserted.
    for (const testId of [
      "add-shift-toggle",
      `shift-edit-${sk("Day")}`,
      `shift-delete-${sk("Day")}`,
    ]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.height, `${testId} height`).toBe(36);
    }

    // Icon actions own BOTH axes at 36px — set on the control itself, never on a
    // pseudo-element hitbox.
    for (const testId of [`shift-move-up-${sk("Day")}`, `shift-move-down-${sk("Day")}`]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.width, `${testId} width`).toBe(36);
      expect(box!.height, `${testId} height`).toBe(36);
    }

    await page.getByTestId(`shift-edit-${sk("Day")}`).click();
    const prefix = `shift-edit-${sk("Day")}`;
    for (const testId of [
      `${prefix}-code`,
      `${prefix}-name`,
      `${prefix}-start`,
      `${prefix}-end`,
      `${prefix}-rest`,
      `${prefix}-required`,
      `${prefix}-preferred`,
      `${prefix}-save`,
      `${prefix}-cancel`,
    ]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.height, `${testId} height`).toBe(36);
    }

    // The derived readout is not a control, but it sits in the same row as the
    // Rest select and must hold the same absolute height or the row steps.
    const readout = await page.getByTestId(`${prefix}-duration`).boundingBox();
    expect(readout!.height, "working readout height").toBe(36);

    // The icon tiles are the one deliberately token-bound decorative box.
    const tile = await page
      .getByTestId(`shift-card-${sk("Night")}`)
      .locator('[data-slot="shift-tile"]')
      .boundingBox();
    expect(tile!.width, "icon tile width").toBe(44);
    expect(tile!.height, "icon tile height").toBe(44);
  });

  test("every real target reaches 44px on an actual coarse pointer", async ({ browser }) => {
    // A real touch context, because `hasTouch` is what flips the pointer media
    // query — a context that silently stayed fine-pointer would measure the 36px
    // sizes and report success for exactly the wrong reason.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
    await gotoShifts(page);

    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      "the context must actually be a coarse pointer",
    ).toBe(true);

    await seedWard(page);
    await page.getByTestId(`shift-edit-${sk("Day")}`).click();
    const prefix = `shift-edit-${sk("Day")}`;

    for (const testId of [
      "add-shift-toggle",
      `${prefix}-code`,
      `${prefix}-name`,
      `${prefix}-start`,
      `${prefix}-end`,
      `${prefix}-rest`,
      `${prefix}-required`,
      `${prefix}-preferred`,
      `${prefix}-save`,
      `${prefix}-cancel`,
    ]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box!.height, `${testId} coarse height`).toBeGreaterThanOrEqual(44);
    }

    // The readout follows the controls it sits beside, so the row does not step.
    const readout = await page.getByTestId(`${prefix}-duration`).boundingBox();
    expect(readout!.height, "working readout coarse height").toBeGreaterThanOrEqual(44);

    // Nothing escapes a 390px viewport, editor open.
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);

    await context.close();
  });

  test("the drop candidate wears the shared drop-target language, not a raw inset shadow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await gotoShifts(page);
    await seedWard(page);

    const tone = await resolveTokens(page, ["--panel-alt", "--brand"]);

    // Synthetic HTML5 drag events: a completed `dragAndDrop` would reorder and
    // tear the state down before it could be measured, and the mid-drag paint is
    // the whole subject here.
    await page.evaluate(() => {
      const source = document.querySelector('[data-testid="shift-card-string:Day"]')!;
      const target = document.querySelector('[data-testid="shift-card-string:Night"]')!;
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true }));
    });

    const target = page.getByTestId(`shift-card-${sk("Night")}`);
    await expect(target).toHaveCSS("background-color", tone["--panel-alt"]);
    await expect(target).toHaveCSS("border-style", "dashed");
    await expect(target).toHaveCSS("border-color", tone["--brand"]);
    // Still a card — the drop state changes the language, never the geometry.
    await expect(target).toHaveCSS("border-radius", "16px");

    const source = page.getByTestId(`shift-card-${sk("Day")}`);
    expect(Number(await source.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
  });

  test("the card grid holds its layout ladder and never overflows the page", async ({ page }) => {
    await gotoShifts(page);
    await seedWard(page);

    // `.ns-grid3`'s own layout-ladder steps — one-up, two-up at 640, three-up at
    // 1100 — not the nearest TYPE-ladder breakpoint (DESIGN.md §1).
    for (const [width, columns] of [
      [390, 1],
      [900, 2],
      [1440, 3],
    ] as const) {
      await page.setViewportSize({ width, height: 1200 });
      const measured = await page.evaluate(() => {
        const grid = document.querySelector('[data-testid="shift-grid"]') as HTMLElement;
        return {
          columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
          pageScroll: document.documentElement.scrollWidth,
          pageClient: document.documentElement.clientWidth,
        };
      });
      expect(measured.columns, `${width}px column count`).toBe(columns);
      expect(measured.pageScroll, `${width}px page overflow`).toBeLessThanOrEqual(
        measured.pageClient + 1,
      );
    }
  });

  test("no data surface on the route is rounded, and no control is square", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await gotoShifts(page);
    await seedWard(page);
    await page.getByTestId(`shift-edit-${sk("Day")}`).click();

    const report = await page.evaluate(() => {
      const dataSurfaces = Array.from(
        document.querySelectorAll("table, thead, tbody, tfoot, tr, th, td"),
      );
      const rounded = dataSurfaces
        .filter((el) => getComputedStyle(el).borderRadius !== "0px")
        .map((el) => `${el.tagName.toLowerCase()} → ${getComputedStyle(el).borderRadius}`);

      // Every real control on the route must have LEFT v1's radius: 0 doctrine.
      // Scoped to the screen root: the app shell is R1's surface, and R2c does
      // not get to assert over another owner's controls.
      const screen = document.querySelector('[data-testid="screen"]')!;
      const controls = Array.from(
        screen.querySelectorAll("button, input, select"),
      ) as HTMLElement[];
      const square = controls
        .filter((el) => getComputedStyle(el).borderTopLeftRadius === "0px")
        .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? "?"}]`);
      return { measured: dataSurfaces.length, rounded, controlCount: controls.length, square };
    });

    expect(report.rounded, "data surfaces stay square").toEqual([]);
    expect(report.controlCount, "the sweep must actually reach controls").toBeGreaterThan(10);
    expect(report.square, "every control carries a v2 radius").toEqual([]);
  });
});
