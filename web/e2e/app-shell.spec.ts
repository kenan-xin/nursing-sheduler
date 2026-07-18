import { expect, test, type Page } from "@playwright/test";

// T08 acceptance matrix (Playwright rows): open-draft + dirty-scenario nav guard
// (row 2, re-enabled — see below), New-schedule reset (row 3), app-wide undo/redo
// via Ctrl-Z/Y (row 4), and Guided-mode nav reachability incl. Export Layout
// (row 5). Row 1 (toggle ⇒ store byte-identical) is proven in
// lib/mode/mode.test.ts; the vitest half of row 3 in components/shell/reset.test.ts.
//
// Row 2 scope note (qq0.22): the nav/unload guard fires on an open card-editor
// draft (FR-PR-06) OR a "dirty" scenario (T08 acceptance row 2). qq0.21 had
// narrowed this to draft-only because Save/Load (spec §08) was unbuilt —
// `markSaved` had no caller, so `selectIsDirty` latched true after the first edit
// and armed the guard on every click. T17 shipped Save/Load: a YAML Download now
// calls `markSaved` (clearing dirty on success) and a Load resets the baseline, so
// dirty can return to clean — the whole-scenario "leave without saving?" warning is
// re-enabled here. Scenario edits still auto-persist to IndexedDB (T04); the
// warning is about unsaved-to-YAML, not data loss.
//
// The editor screens that would normally mutate the scenario belong to later
// tickets, so these specs drive the real T04 store through the `window.__nsStore`
// seam mounted by the shell (components/shell/test-bridge.tsx) — a genuine tracked
// mutation, not a mock.

// The fixed 13-tab nav set (spec 07 FR-ST-28). Grouped by the user-approved
// audit mapping as Home (headerless) → SET UP → OUTPUT → SYSTEM.
const NAV_PATHS = [
  "/",
  "/dates",
  "/people",
  "/shift-types",
  "/shift-type-requirements",
  "/shift-requests",
  "/shift-type-successions",
  "/shift-counts",
  "/shift-affinities",
  "/shift-type-coverings",
  "/optimize-and-export",
  "/export-layout",
  "/save-and-load",
];

/** Wait until the shell has hydrated (Home content past the hydration gate). */
async function gotoReadyHome(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("home-screen")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __nsStore?: unknown }).__nsStore),
  );
}

// Minimal typing for the store seam inside the browser context.
type NsWindow = {
  __nsStore: {
    scenario: {
      getState(): Record<string, unknown> & {
        mutateScenario(x: unknown): void;
        markSaved(): void;
      };
    };
    isDirty(): boolean;
    navGuard: { getState(): { setDraftOpen(open: boolean): void } };
  };
};

// A minimal but backend-valid scenario patch (mirrors e2e/save-load.spec.ts'
// VALID_SCENARIO_PATCH, kept in sync manually — the lib/scenario/test-fixtures.ts
// source isn't exported for browser-context use). Needed here (rather than the
// partial `{ rangeStart: ... }` patches used elsewhere in this file) because the
// qq0.22 round-trip test drives a real Download, which validates the draft before
// it clears dirty.
const VALID_SCENARIO_PATCH = {
  rangeStart: "2026-05-14",
  rangeEnd: "2026-05-20",
  staff: [{ id: "Alice", history: ["D"] }, { id: "Bob" }],
  staffGroups: [{ id: "Seniors", members: ["Alice", "Bob"] }],
  shifts: [
    {
      id: "D",
      description: "Day",
      startTime: "09:00",
      endTime: "17:00",
      restMinutes: 60,
      durationMinutes: 420,
    },
    { id: "E", description: "Evening" },
    { id: "N", description: "Night" },
  ],
  shiftGroups: [{ id: "DayOrEvening", members: ["D", "E"] }],
  dateGroups: [{ id: "FirstTwo", members: ["2026-05-14", "2026-05-15"] }],
  maxOneShiftPerDay: { description: "one per day" },
  cardsByKind: {
    requirements: [
      {
        uid: "r1",
        shiftType: "D",
        requiredNumPeople: 1,
        qualifiedPeople: "ALL",
        date: "ALL",
        weight: -1,
      },
    ],
    successions: [],
    counts: [],
    affinities: [],
    coverings: [],
  },
  reqData: [
    { uid: "c1", kind: "leave", person: "Alice", date: "2026-05-14" },
    { uid: "c2", kind: "request", person: "Bob", date: "2026-05-15", shiftType: "D", weight: 2 },
    { uid: "c3", kind: "off", person: "Bob", date: "2026-05-16", weight: 1 },
  ],
  exportLayout: {
    formatting: [{ uid: "f1", type: "row", people: ["Alice"], backgroundColor: "#ff0000" }],
    // Home's scenario-summary reads every exportLayout array (unlike the
    // save-load specs, which mutate while already on /save-and-load); a patch
    // missing these would crash computeScenarioSummary on the Home screen.
    extraColumns: [],
    extraRows: [],
  },
};

/** Apply a real tracked scenario mutation through the store seam. */
async function mutate(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}

/** Arm/disarm the open-draft nav guard through the store seam (FR-PR-06). */
async function setDraftOpen(page: Page, open: boolean) {
  await page.evaluate((o) => {
    (window as unknown as NsWindow).__nsStore.navGuard.getState().setDraftOpen(o);
  }, open);
}

/** Read a single scenario field from the live store. */
async function readField(page: Page, key: string): Promise<unknown> {
  return page.evaluate(
    (k) => (window as unknown as NsWindow).__nsStore.scenario.getState()[k],
    key,
  );
}

async function isDirty(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as NsWindow).__nsStore.isDirty());
}

test.describe("T08 app shell", () => {
  // Opt into the store seam (test-bridge.tsx) before any page script runs. Set on
  // every page in the context so it survives client-side navigations too. In a
  // real production deployment nothing sets this, so the store is never exposed.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
    });
  });

  test("row 2 — a dirty scenario with no open draft prompts the guard (qq0.22)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await mutate(page, VALID_SCENARIO_PATCH);
    // Dirty in the T04 sense (differs from the persisted baseline)…
    expect(await isDirty(page)).toBe(true);

    // …and with no card-editor draft open, the whole-scenario guard now fires too
    // (T08 acceptance row 2, re-enabled in qq0.22 — this is the exact condition
    // qq0.21 had to narrow away while `markSaved` had no caller). "Stay" cancels.
    await page.getByTestId("nav-link-/people").click();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await page.getByTestId("confirm-dialog-cancel").click();
    expect(new URL(page.url()).pathname).toBe("/");
    expect(await isDirty(page)).toBe(true);

    // Save the round trip: navigate to Save & Load (guard fires again since still
    // dirty — confirm "Leave without saving" to get there), then Download, which
    // calls `markSaved` on a successful write (T17) and clears dirty.
    await page.getByTestId("nav-link-/save-and-load").click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page).toHaveURL(/\/save-and-load$/);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("scenario-download-button").click(),
    ]);
    expect(download.suggestedFilename()).toBe("scenario.yaml");
    expect(await isDirty(page)).toBe(false);

    // Clean again → the guard no longer fires on further navigation.
    await page.getByTestId("nav-link-/people").click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
  });

  test("row 2 — an open card-editor draft prompts the guard before navigation (FR-PR-06)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    // Arm the open-draft guard through the store seam (a real editor form does this
    // via useCardEditorDraftGuard; the end-to-end path is covered in counts.spec.ts
    // / affinities.spec.ts). The scenario stays clean, isolating draftOpen as the
    // only reason the guard can fire.
    await setDraftOpen(page, true);
    expect(await isDirty(page)).toBe(false);

    // Attempt to navigate via the sidebar → guard dialog intercepts.
    await page.getByTestId("nav-link-/people").click();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();

    // "Stay" cancels — the route is unchanged.
    await page.getByTestId("confirm-dialog-cancel").click();
    expect(new URL(page.url()).pathname).toBe("/");

    // Attempt again and confirm "Leave without saving" → navigation proceeds.
    await page.getByTestId("nav-link-/people").click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page).toHaveURL(/\/people$/);
  });

  test("row 3 — Start over resets all slices after confirm", async ({ page }) => {
    await gotoReadyHome(page);
    // The reset affordance now lives in Save & Load (MINOR 8). Route there while
    // the scenario is still clean (no guard), then dirty it and reset.
    await page.getByTestId("nav-link-/save-and-load").click();
    await expect(page.getByTestId("start-over-card")).toBeVisible();

    await mutate(page, {
      rangeStart: "2026-03-01",
      staff: [{ _k: "p1", id: 1, description: "Nurse A" }],
    });
    expect(await isDirty(page)).toBe(true);

    await page.getByTestId("new-schedule-button").click();
    await page.getByTestId("confirm-dialog-confirm").click();

    // Confirmation toast + every slice back to the empty default.
    await expect(page.getByText("New schedule created")).toBeVisible();
    expect(await readField(page, "rangeStart")).toBe("");
    expect((await readField(page, "staff")) as unknown[]).toHaveLength(0);
    expect(await isDirty(page)).toBe(false);
  });

  test("row 4 — Ctrl/Cmd+Z/Y undo/redo app-wide, Alt/Shift rejected", async ({ page }) => {
    await gotoReadyHome(page);
    await mutate(page, { rangeStart: "2026-06-01" });
    expect(await readField(page, "rangeStart")).toBe("2026-06-01");
    await expect(page.getByTestId("undo-button")).toBeEnabled();

    // Control family.
    await page.keyboard.press("Control+z");
    expect(await readField(page, "rangeStart")).toBe("");
    await page.keyboard.press("Control+y");
    expect(await readField(page, "rangeStart")).toBe("2026-06-01");

    // Meta (Cmd) family — the handler accepts Ctrl OR Meta (FR-ST-21).
    await page.keyboard.press("Meta+z");
    expect(await readField(page, "rangeStart")).toBe("");
    await page.keyboard.press("Meta+y");
    expect(await readField(page, "rangeStart")).toBe("2026-06-01");

    // Alt or Shift additionally held must be REJECTED even with the modifier.
    await page.keyboard.press("Control+Alt+z");
    expect(await readField(page, "rangeStart")).toBe("2026-06-01");
    await page.keyboard.press("Control+Shift+z");
    expect(await readField(page, "rangeStart")).toBe("2026-06-01");
    await page.keyboard.press("Meta+Alt+z");
    expect(await readField(page, "rangeStart")).toBe("2026-06-01");

    // The button surface reflects the same history and drives the same undo.
    await page.getByTestId("undo-button").click();
    expect(await readField(page, "rangeStart")).toBe("");
  });

  test("qq0.22 — reload keeps the T04 baseline (restored-unsaved stays dirty) and the nav guard re-arms", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    // Make a tracked edit and let the auto-persist write settle, but do NOT
    // markSaved (no UI Download in this test).
    await mutate(page, { rangeStart: "2026-03-01" });
    expect(await isDirty(page)).toBe(true);
    await page.waitForTimeout(800);

    await page.reload();
    await expect(page.getByTestId("home-screen")).toBeVisible();
    await page.waitForFunction(() =>
      Boolean((window as unknown as { __nsStore?: unknown }).__nsStore),
    );

    // T04 contract preserved: the persisted baseline is RESTORED (not recomputed),
    // so restored-unsaved ≠ clean — the scenario is still dirty after reload. Since
    // qq0.22 re-enabled the dirty branch, the nav guard is armed again post-reload
    // too, with no open draft required.
    expect(await isDirty(page)).toBe(true);
    await page.getByTestId("nav-link-/people").click();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page).toHaveURL(/\/people$/);
  });

  test("row 2 — beforeunload guards an open draft AND a dirty scenario (browser leave, qq0.22)", async ({
    page,
  }) => {
    await gotoReadyHome(page);

    // Dispatch a cancelable beforeunload and observe whether the shell handler
    // called preventDefault (which is what triggers the browser's leave prompt).
    const dispatchUnload = () =>
      page.evaluate(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      });

    // Clean → no prompt.
    expect(await dispatchUnload()).toBe(false);

    // Dirty scenario but NO open draft → now prompts too (qq0.22): the
    // whole-scenario guard is re-enabled now that `markSaved` has a real caller
    // (T17's Download).
    await mutate(page, { rangeStart: "2026-03-01" });
    expect(await isDirty(page)).toBe(true);
    expect(await dispatchUnload()).toBe(true);

    // Open card-editor draft on top of dirty → still prompts, FR-PR-06.
    await setDraftOpen(page, true);
    expect(await dispatchUnload()).toBe(true);

    // Closing the draft alone does NOT clear the guard while still dirty — dirty
    // is an independent trigger now, not merely a proxy for draftOpen.
    await setDraftOpen(page, false);
    expect(await dispatchUnload()).toBe(true);

    // Only clearing dirty (markSaved, mirroring a real Download) fully disarms it.
    await page.evaluate(() =>
      (window as unknown as NsWindow).__nsStore.scenario.getState().markSaved(),
    );
    expect(await isDirty(page)).toBe(false);
    expect(await dispatchUnload()).toBe(false);
  });

  test("row 5 — Guided mode keeps every capability reachable, incl. Export Layout", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    // Guided is the default lens.
    await expect(page.getByTestId("mode-toggle-guided")).toHaveAttribute("aria-selected", "true");

    // Every one of the 13 nav entries is present AND navigable in Guided mode —
    // nothing unreachable (critique #8), incl. Export Layout. Scenario stays clean
    // here, so each click routes directly (no guard).
    for (const path of NAV_PATHS) {
      await expect(page.getByTestId(`nav-link-${path}`)).toBeVisible();
      await page.getByTestId(`nav-link-${path}`).click();
      // Client-side navigation commits asynchronously — use the auto-retrying
      // URL matcher rather than reading page.url() synchronously (which races the
      // Next router push).
      await expect(page).toHaveURL((url) => url.pathname === path);
      await expect(page.getByTestId(path === "/" ? "home-screen" : "screen")).toBeVisible();
    }
  });

  test("mode — persisted Advanced adopts after mount with no hydration mismatch", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));

    await page.addInitScript(() => localStorage.setItem("ns-app-mode", "advanced"));
    await page.goto("/");
    await expect(page.getByTestId("home-screen")).toBeVisible();

    // Server + first paint render Guided; after mount the stored Advanced value is
    // adopted, so the toggle and the model agree (the bug was a stale Guided toggle).
    await expect(page.getByTestId("mode-toggle-advanced")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("mode-toggle-guided")).toHaveAttribute("aria-selected", "false");
    await expect(page.getByTestId("home-screen")).toContainText("every editor directly");

    // No hydration-mismatch console errors (favicon 404 is benign).
    const unexpected = errors.filter((t) => !/favicon/i.test(t));
    expect(unexpected, errors.join(" | ")).toEqual([]);
  });

  test("mode — reachable on mobile via the drawer (<640px)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await gotoReadyHome(page);

    // The top-bar toggle is hidden at this width; the drawer must carry it.
    await expect(page.getByTestId("mode-toggle-guided")).toBeHidden();

    await page.getByTestId("mobile-nav-trigger").click();
    const drawer = page.getByTestId("mobile-nav-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("mode-toggle-advanced").click();
    await expect(drawer.getByTestId("mode-toggle-advanced")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
