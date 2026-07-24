import { expect, test, type Page } from "@playwright/test";

// T08 acceptance matrix (Playwright rows): losable-draft nav guard (row 2),
// New-schedule reset (row 3), app-wide undo/redo via Ctrl-Z/Y (row 4), and
// Guided-mode nav reachability (row 5). Row 1 (toggle ⇒
// store byte-identical) is proven in lib/mode/mode.test.ts; the vitest half of
// row 3 in components/shell/reset.test.ts.
//
// Row 2 scope (T08a/b, DL12/reopened T08): the nav/unload guard fires ONLY on a
// registered losable draft (FR-PR-06) or, for browser unload only, an unsettled
// local write (`saving`/`error`). Internal navigation and the browser Back
// button never read the whole-scenario backup fingerprint (`selectBackupStatus`) —
// DL12 rejected that "leave without saving?" warning as product behavior: a
// committed edit is already durable through T04 autosave, so there is nothing
// to warn about on an internal route change. `backupStatus`/`recordBackup` still
// exist (T08e surfaces them as an honest, non-blocking tri-state No backup /
// Backup current / Backup out of date display over T17's Workspace fingerprint) —
// this spec only asserts they no longer gate navigation.
//
// The editor screens that would normally mutate the scenario belong to later
// tickets, so these specs drive the real T04 store through the `window.__nsStore`
// seam mounted by the shell (components/shell/test-bridge.tsx) — a genuine tracked
// mutation, not a mock.

// The route set (spec 07 FR-ST-28, less the backlog-deferred Export Layout
// screen — T15 / nursing-sheduler-qq0.15), split by the DL12 §2 Guided/Advanced
// matrix (T08d): Guided foregrounds Dates, People, Shift Types, Rules and Shift
// Requests; Advanced adds the raw Constraints group. Every route still exists —
// the two lists below just record which mode each is reachable in DIRECTLY from
// the sidebar.
const GUIDED_NAV_PATHS = [
  "/",
  "/dates",
  "/people",
  "/shift-types",
  "/rules",
  "/shift-requests",
  "/optimize-and-export",
  "/save-and-load",
];

const ADVANCED_ONLY_PATHS = [
  "/shift-type-requirements",
  "/shift-type-successions",
  "/shift-counts",
  "/shift-affinities",
  "/shift-type-coverings",
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
        recordBackup(): void;
      };
    };
    backupStatus(): "none" | "current" | "stale";
    persistenceStatus(): "restoring" | "saving" | "saved" | "error";
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
// it records the backup.
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

/**
 * Record a current Workspace backup (as a successful plain Download would). Load/New
 * no longer invent a backup (T17r review P0), so a scenario is only "stale" against
 * a real prior backup — tests that need a stale precondition record one before editing.
 */
async function recordBackup(page: Page) {
  await page.evaluate(() => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().recordBackup();
  });
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

async function backupStatus(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as NsWindow).__nsStore.backupStatus());
}

/**
 * Wait for the durable persist queue to quiesce (persistence status settles to
 * `saved`). A tracked write — including `recordBackup`'s fingerprint write —
 * synchronously flips the status to `saving`, which correctly arms the browser
 * unload guard until the write drains. A "clean, no prompt" assertion must wait
 * for that settle with this deterministic seam, not race the in-flight write
 * (and not paper over it with an arbitrary timeout).
 */
async function waitForPersistSettled(page: Page) {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as NsWindow).__nsStore.persistenceStatus()))
    .toBe("saved");
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

  test("row 2 — a scenario with a stale backup and no open draft navigates immediately (DL12)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    // Establish a baseline (as a Download would), then edit so the scenario is
    // genuinely stale against it — Load/New no longer invent a backup (T17r P0).
    await recordBackup(page);
    await mutate(page, VALID_SCENARIO_PATCH);
    // Stale in the backup sense (differs from the recorded backup)…
    expect(await backupStatus(page)).toBe("stale");

    // …but with no losable draft open, internal navigation is immediate — DL12
    // rejected the old whole-scenario "leave without saving?" warning. The
    // committed edit is already durable through T04 autosave.
    await page.getByTestId("nav-link-/people").click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();

    // The backup fingerprint is untouched by navigation — still stale, and a
    // real Download still clears it (T08e will surface this as a non-blocking
    // "Backup out of date" display; this spec only proves it never gates nav).
    await page.getByTestId("nav-link-/save-and-load").click();
    await expect(page).toHaveURL(/\/save-and-load$/);
    expect(await backupStatus(page)).toBe("stale");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("scenario-download-button").click(),
    ]);
    expect(download.suggestedFilename()).toBe("scenario.yaml");
    expect(await backupStatus(page)).toBe("current");
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
    expect(await backupStatus(page)).toBe("none");

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

    // A REAL route-owned draft — the People (Staff) add-nurse inline row (DR-2's
    // bespoke PeopleTable) — not the test-bridge seam. Its `useLosableDraft`
    // registration unmounts for real when the route changes, which is exactly the
    // lifecycle this race depends on.
    await page.getByTestId("people-add").click();
    await expect(page.getByTestId("people-edit-row-__new__")).toBeVisible();

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
    // the scenario's backup is still current (no guard), then make it stale and reset.
    await page.getByTestId("nav-link-/save-and-load").click();
    await expect(page.getByTestId("start-over-card")).toBeVisible();

    // Record a backup first (Load/New no longer invent one — T17r P0), then make it stale.
    await recordBackup(page);
    await mutate(page, {
      rangeStart: "2026-03-01",
      staff: [{ _k: "p1", id: 1, description: "Nurse A" }],
    });
    expect(await backupStatus(page)).toBe("stale");

    await page.getByTestId("new-schedule-button").click();
    await page.getByTestId("confirm-dialog-confirm").click();

    // Confirmation toast + every slice back to the empty default.
    await expect(page.getByText("New schedule created")).toBeVisible();
    expect(await readField(page, "rangeStart")).toBe("");
    expect((await readField(page, "staff")) as unknown[]).toHaveLength(0);
    expect(await backupStatus(page)).toBe("none");
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

  test("qq0.22 — reload keeps the T04 backup (restored-unsaved stays stale) but never gates nav (DL12)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    // Establish a backup baseline (as a Download would), then make a tracked edit
    // and let the auto-persist write settle. Both the baseline and the edited state
    // persist, so reload can restore them — Load/New no longer invent a baseline
    // (T17r P0), so a stale precondition requires a real prior backup.
    await recordBackup(page);
    await mutate(page, { rangeStart: "2026-03-01" });
    expect(await backupStatus(page)).toBe("stale");
    await page.waitForTimeout(800);

    await page.reload();
    await expect(page.getByTestId("home-screen")).toBeVisible();
    await page.waitForFunction(() =>
      Boolean((window as unknown as { __nsStore?: unknown }).__nsStore),
    );

    // T04 contract preserved: the persisted baseline is RESTORED (not
    // recomputed), so restored-unsaved ≠ current — the scenario's backup is still stale
    // after reload. DL12: that backup-fingerprint dirtiness never gates internal
    // navigation, with no open draft required — the edit is already durable.
    expect(await backupStatus(page)).toBe("stale");
    await page.getByTestId("nav-link-/people").click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
  });

  test("row 2 — beforeunload guards an open draft or an unsettled local write, never the backup fingerprint", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    // Record a backup (as a Download would) so a later edit is stale against
    // it — the store starts clean (current === baseline), and Load/New no longer
    // invent a baseline (T17r P0). recordBackup persists the fingerprint (a real
    // durable write that arms the unload guard while "saving"), so wait for that
    // write to settle before the clean baseline below — otherwise the "no
    // prompt" assertion races the in-flight backup write (deterministic seam,
    // not an arbitrary timeout).
    await recordBackup(page);
    await waitForPersistSettled(page);

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

    // Stale in the backup sense…
    expect(await backupStatus(page)).toBe("stale");
    // …but once the write settles to "saved" with no open draft, the backup
    // fingerprint alone never re-arms the unload guard (DL12). Wait on the same
    // deterministic saved-state seam rather than an arbitrary timeout.
    await waitForPersistSettled(page);
    expect(await dispatchUnload()).toBe(false);

    // Open a losable draft → prompts, FR-PR-06.
    await openTestDraft(page);
    expect(await dispatchUnload()).toBe(true);

    // Closing the draft, with the write long settled, fully disarms it —
    // backup state plays no part.
    await closeTestDraft(page);
    expect(await dispatchUnload()).toBe(false);
  });

  test("row 5 — Guided mode keeps every Guided destination reachable", async ({ page }) => {
    await gotoReadyHome(page);
    // Guided is the default lens.
    await expect(page.getByTestId("mode-toggle-guided")).toHaveAttribute("aria-selected", "true");

    // Every Guided nav entry is present AND navigable — nothing unreachable
    // (critique #8). Scenario stays clean here, so each click routes directly
    // (no guard).
    for (const path of GUIDED_NAV_PATHS) {
      await expect(page.getByTestId(`nav-link-${path}`)).toBeVisible();
      await page.getByTestId(`nav-link-${path}`).click();
      // Client-side navigation commits asynchronously — use the auto-retrying
      // URL matcher rather than reading page.url() synchronously (which races the
      // Next router push).
      await expect(page).toHaveURL((url) => url.pathname === path);
      await expect(page.getByTestId(path === "/" ? "home-screen" : "screen")).toBeVisible();
    }

    // The raw Constraints editors are Advanced-only (DL12 §2) — not listed
    // directly in the Guided sidebar.
    for (const path of ADVANCED_ONLY_PATHS) {
      await expect(page.getByTestId(`nav-link-${path}`)).toHaveCount(0);
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

  test("mode — the transition transaction commits immediately when the route survives the switch", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await openTestDraft(page);

    // Home ("/") is valid in both modes, so the mode-transition transaction
    // finds nothing to unmount and commits without ever staging the shared
    // guard dialog. The draft-guarded Advanced-only → Guided redirect is
    // covered in mode-aware-shell.spec.ts.
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
