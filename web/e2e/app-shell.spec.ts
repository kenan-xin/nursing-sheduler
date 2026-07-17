import { expect, test, type Page } from "@playwright/test";

// T08 acceptance matrix (Playwright rows): open-draft nav guard (row 2, narrowed —
// see below), New-schedule reset (row 3), app-wide undo/redo via Ctrl-Z/Y (row 4),
// and Guided-mode nav reachability incl. Export Layout (row 5). Row 1 (toggle ⇒
// store byte-identical) is proven in lib/mode/mode.test.ts; the vitest half of
// row 3 in components/shell/reset.test.ts.
//
// Row 2 scope note (qq0.21): the nav/unload guard fires ONLY on an open card-editor
// draft (FR-PR-06), NOT on a merely "dirty" scenario. Scenario mutations
// auto-persist to IndexedDB (T04) so they can't be lost on navigation, and the
// Save/Load (YAML) feature that would clear dirty isn't built yet — so guarding on
// dirty fired on every click. The whole-scenario "leave without saving?" warning is
// deferred to qq0.22. These specs assert the narrowed policy: dirty-but-no-draft
// navigates freely; an open draft still prompts.
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
    scenario: { getState(): Record<string, unknown> & { mutateScenario(x: unknown): void } };
    isDirty(): boolean;
    navGuard: { getState(): { setDraftOpen(open: boolean): void } };
  };
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

  test("row 2 — a dirty scenario with no open draft navigates freely (qq0.21)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await mutate(page, { rangeStart: "2026-03-01" });
    // Dirty in the T04 sense (differs from the persisted baseline)…
    expect(await isDirty(page)).toBe(true);

    // …but with no card-editor draft open, the guard does NOT fire — the sidebar
    // link navigates directly. Scenario mutations auto-persist (T04), so there is
    // nothing to lose; the whole-scenario "leave without saving?" warning is
    // deferred to qq0.22. (This is the exact condition that popped the dialog on
    // every click before qq0.21.)
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

  test("qq0.21 — reload keeps the T04 baseline (restored-unsaved stays dirty) yet the nav guard is not armed", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    // Make a tracked edit and let the auto-persist write settle, but do NOT
    // markSaved (no UI action does yet — Save/Load is unbuilt).
    await mutate(page, { rangeStart: "2026-03-01" });
    expect(await isDirty(page)).toBe(true);
    await page.waitForTimeout(800);

    await page.reload();
    await expect(page.getByTestId("home-screen")).toBeVisible();
    await page.waitForFunction(() =>
      Boolean((window as unknown as { __nsStore?: unknown }).__nsStore),
    );

    // T04 contract preserved: the persisted baseline is RESTORED (not recomputed),
    // so restored-unsaved ≠ clean — the scenario is still dirty after reload. The
    // fix for qq0.21 is that the nav guard no longer consumes dirty, so with no
    // open draft every sidebar link still navigates without the "Unsaved changes"
    // dialog.
    expect(await isDirty(page)).toBe(true);
    await page.getByTestId("nav-link-/people").click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
  });

  test("row 2 — beforeunload guards an open draft, not a merely dirty scenario (browser leave)", async ({
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

    // Dirty scenario but NO open draft → still no prompt (qq0.21): scenario
    // mutations auto-persist and cannot be lost on leave.
    await mutate(page, { rangeStart: "2026-03-01" });
    expect(await isDirty(page)).toBe(true);
    expect(await dispatchUnload()).toBe(false);

    // Open card-editor draft → prompt (preventDefault), FR-PR-06.
    await setDraftOpen(page, true);
    expect(await dispatchUnload()).toBe(true);

    // Closing the draft clears the guard again.
    await setDraftOpen(page, false);
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
