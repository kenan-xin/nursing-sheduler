import { expect, test, type Page } from "@playwright/test";

// T08 acceptance matrix (Playwright rows): losable-draft nav guard (row 2),
// New-schedule reset (row 3), app-wide undo/redo via Ctrl-Z/Y (row 4), and
// Guided-mode nav reachability incl. Export Layout (row 5). Row 1 (toggle ⇒
// store byte-identical) is proven in lib/mode/mode.test.ts; the vitest half of
// row 3 in components/shell/reset.test.ts.
//
// Row 2 scope (T08a/b, DL12/reopened T08): the nav/unload guard fires ONLY on a
// registered losable draft (FR-PR-06) or, for browser unload only, an unsettled
// local write (`saving`/`error`). Internal navigation and the browser Back
// button never read the whole-scenario backup fingerprint (`selectIsDirty`) —
// DL12 rejected that "leave without saving?" warning as product behavior: a
// committed edit is already durable through T04 autosave, so there is nothing
// to warn about on an internal route change. `isDirty`/`markSaved` still exist
// (T08e will surface them as an honest, non-blocking "Backup out of date"
// display once T17's Workspace fingerprint lands) — this spec only asserts
// they no longer gate navigation.
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
    navGuard: {
      getState(): {
        registerDraft(registration: { id: string; label: string }): () => void;
      };
    };
  };
  __nsTestDraftCleanup?: () => void;
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

/** Register a losable test draft through the store seam (FR-PR-06, T08a). */
async function openTestDraft(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as NsWindow;
    w.__nsTestDraftCleanup = w.__nsStore.navGuard
      .getState()
      .registerDraft({ id: "e2e-test-draft", label: "Test draft" });
  });
}

/** Unregister the losable test draft opened by {@link openTestDraft}. */
async function closeTestDraft(page: Page) {
  await page.evaluate(() => {
    (window as unknown as NsWindow).__nsTestDraftCleanup?.();
  });
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

  test("row 2 — a dirty scenario with no open draft navigates immediately (DL12)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await mutate(page, VALID_SCENARIO_PATCH);
    // Dirty in the T04/backup sense (differs from the persisted baseline)…
    expect(await isDirty(page)).toBe(true);

    // …but with no losable draft open, internal navigation is immediate — DL12
    // rejected the old whole-scenario "leave without saving?" warning. The
    // committed edit is already durable through T04 autosave.
    await page.getByTestId("nav-link-/people").click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();

    // The backup fingerprint is untouched by navigation — still dirty, and a
    // real Download still clears it (T08e will surface this as a non-blocking
    // "Backup out of date" display; this spec only proves it never gates nav).
    await page.getByTestId("nav-link-/save-and-load").click();
    await expect(page).toHaveURL(/\/save-and-load$/);
    expect(await isDirty(page)).toBe(true);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("scenario-download-button").click(),
    ]);
    expect(download.suggestedFilename()).toBe("scenario.yaml");
    expect(await isDirty(page)).toBe(false);
  });

  test("row 2 — an open card-editor draft prompts the guard before navigation (FR-PR-06)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    // Register a losable draft through the store seam (a real editor form does
    // this via useLosableDraft; the end-to-end path is covered in counts.spec.ts
    // / affinities.spec.ts). The scenario stays clean, isolating the open draft as
    // the only reason the guard can fire.
    await openTestDraft(page);
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

  test("row 2 — browser Back is intercepted by an open losable draft (T08b history sentinel)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await page.getByTestId("nav-link-/people").click();
    await expect(page).toHaveURL(/\/people$/);

    await openTestDraft(page);

    // The FIRST physical Back must not leave silently — the sentinel swallows it
    // and the staged confirm dialog appears instead; the URL stays on /people.
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await expect(page).toHaveURL(/\/people$/);

    // Cancel ("Stay") reinstates the sentinel — no visible change, and the guard
    // is re-armed for a second attempt (no history loop).
    await page.getByTestId("confirm-dialog-cancel").click();
    await expect(page).toHaveURL(/\/people$/);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await expect(page).toHaveURL(/\/people$/);

    // Confirm performs the ONE real Back the user originally pressed — landing on
    // the actual prior page (Home), not a repeat of the same /people entry.
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("row 2 — a repeated physical Back before the dialog is decided cannot lose the original navigation (T08f P1)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await page.getByTestId("nav-link-/people").click();
    await expect(page).toHaveURL(/\/people$/);
    await openTestDraft(page);

    await page.goBack();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await expect(page).toHaveURL(/\/people$/);

    // A SECOND physical Back while the dialog is still open (no decision made
    // yet) must stay shielded — it must not traverse to the actual prior route
    // out from under the open dialog, and the guard must not silently swap in
    // a second, differently-scoped intent.
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await expect(page).toHaveURL(/\/people$/);

    // Cancel must still land the user exactly where they started.
    await page.getByTestId("confirm-dialog-cancel").click();
    await expect(page).toHaveURL(/\/people$/);

    // A subsequent Back + Confirm still reaches the real prior page (Home) —
    // the repeated press earlier did not consume or corrupt that navigation.
    await page.goBack();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("row 2 — closing the final draft with no navigation lets the very next Back through (T08f P1)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await page.getByTestId("nav-link-/people").click();
    await expect(page).toHaveURL(/\/people$/);

    await openTestDraft(page);
    await closeTestDraft(page); // Save/Cancel dismissed it — no navigation happened

    // The very next physical Back must reach Home directly — no swallowed
    // no-op press from a sentinel left behind by the closed draft.
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
  });

  test("row 2 — a guarded push to a new page leaves that page's own Back guard fully armed (T08f P1)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await page.getByTestId("nav-link-/people").click();
    await expect(page).toHaveURL(/\/people$/);

    // Guarded push away from /people while a draft is open there.
    await openTestDraft(page);
    await page.getByTestId("nav-link-/shift-types").click();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page).toHaveURL(/\/shift-types$/);
    await closeTestDraft(page); // the old page's draft is gone; this is a no-op here

    // A FRESH draft opened on the new page must still get its own Back guard —
    // a stale "armed" flag surviving the push must not silently skip arming.
    await openTestDraft(page);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await expect(page).toHaveURL(/\/shift-types$/);
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page).toHaveURL(/\/people$/);
  });

  test("row 2 — confirming a guarded push collapses the old route's sentinel, so two Backs reach Home directly (T08g)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await page.getByTestId("nav-link-/people").click();
    await expect(page).toHaveURL(/\/people$/);

    // Arm the People sentinel, then confirm a guarded push to Shift Types —
    // the sentinel must be collapsed away, not stacked underneath the new route.
    await openTestDraft(page);
    await page.getByTestId("nav-link-/shift-types").click();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page).toHaveURL(/\/shift-types$/);
    await closeTestDraft(page); // resolved on arrival — nothing left to guard

    // Neither Back press may be a swallowed no-op against a leftover People
    // duplicate: the first reaches People, the second reaches Home directly.
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
    await expect(page).toHaveURL(/\/people$/);

    await page.goBack();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
  });

  test("row 2 — a confirmed guarded push survives the source editor's real unmount cleanup (T08h)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await page.getByTestId("nav-link-/people").click();
    await expect(page).toHaveURL(/\/people$/);

    // A REAL route-owned draft — the People add-item form — not the test-bridge
    // seam. Its `useLosableDraft` registration unmounts for real when the route
    // changes, which is exactly the lifecycle this race depends on.
    await page.getByTestId("add-item-toggle").click();
    await expect(page.getByTestId("add-item-form")).toBeVisible();

    await page.getByTestId("nav-link-/shift-types").click();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await page.getByTestId("confirm-dialog-confirm").click();

    // The confirmed navigation must hold even though the People editor (and its
    // real draft registration) unmounts right here. Before T08h, that unmount's
    // cleanup read the sentinel as still armed and called `history.back()`,
    // silently undoing this confirmed push back to People.
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
    await expect(page).toHaveURL(/\/shift-types$/);
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/shift-types$/);

    // With the source draft gone via real unmount and no destination draft open,
    // neither Back press is swallowed or reopens the dialog: the first reaches
    // People, the second reaches Home.
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
    await expect(page).toHaveURL(/\/people$/);

    await page.goBack();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
  });

  test("row 2 — a GuardedLink preserves native middle-click/new-tab behavior (T08f P2)", async ({
    page,
    context,
  }) => {
    await gotoReadyHome(page);
    await page.getByTestId("nav-link-/dates").click();
    await expect(page).toHaveURL(/\/dates$/);

    // Middle-click on the "Continue to staff" GuardedLink must open a new tab
    // via native anchor behavior, not the SPA guard — the current tab must not
    // navigate at all.
    const [newPage] = await Promise.all([
      context.waitForEvent("page"),
      page.getByTestId("dates-continue").click({ button: "middle" }),
    ]);
    await newPage.waitForLoadState();
    await expect(newPage).toHaveURL(/\/people$/);
    await expect(page).toHaveURL(/\/dates$/);
    await newPage.close();

    // A plain primary click still intercepts and navigates the current tab.
    await page.getByTestId("dates-continue").click();
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

  test("qq0.22 — reload keeps the T04 baseline (restored-unsaved stays dirty) but never gates nav (DL12)", async ({
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

    // T04 contract preserved: the persisted baseline is RESTORED (not
    // recomputed), so restored-unsaved ≠ clean — the scenario is still dirty
    // after reload. DL12: that backup-fingerprint dirtiness never gates internal
    // navigation, with no open draft required — the edit is already durable.
    expect(await isDirty(page)).toBe(true);
    await page.getByTestId("nav-link-/people").click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
  });

  test("row 2 — beforeunload guards an open draft or an unsettled local write, never the backup fingerprint", async ({
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

    // Mutating and dispatching in the SAME evaluate call (no `await` between
    // them) catches the local-persistence status synchronously flipped to
    // "saving" by the write — before the drain microtask settles it — so the
    // unload guard must warn while the write is still in flight.
    const savingWarns = await page.evaluate(
      (patch) => {
        const w = window as unknown as NsWindow;
        w.__nsStore.scenario.getState().mutateScenario(patch);
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      },
      { rangeStart: "2026-03-01" },
    );
    expect(savingWarns).toBe(true);

    // Dirty in the T04/backup sense…
    expect(await isDirty(page)).toBe(true);
    // …but once the write settles to "saved" with no open draft, the backup
    // fingerprint alone never re-arms the unload guard (DL12).
    await page.waitForTimeout(800);
    expect(await dispatchUnload()).toBe(false);

    // Open a losable draft → prompts, FR-PR-06.
    await openTestDraft(page);
    expect(await dispatchUnload()).toBe(true);

    // Closing the draft, with the write long settled, fully disarms it —
    // dirty/backup state plays no part.
    await closeTestDraft(page);
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

  test("mode — the transition transaction commits immediately with an open draft (T08c, no route changes today)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await openTestDraft(page);

    // Every shipped route is valid in both modes today (T08d hasn't restricted
    // any yet), so the mode-transition transaction finds nothing to unmount and
    // commits without ever staging the shared guard dialog.
    await page.getByTestId("mode-toggle-advanced").click();
    await expect(page.getByTestId("mode-toggle-advanced")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
    await expect(page).toHaveURL(/\/$/);

    // The draft itself is untouched — same-route mode changes never unmount it.
    await page.getByTestId("mode-toggle-guided").click();
    await expect(page.getByTestId("mode-toggle-guided")).toHaveAttribute("aria-selected", "true");
    await closeTestDraft(page);
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
