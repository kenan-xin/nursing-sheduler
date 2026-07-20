import { expect, test, type Page } from "@playwright/test";

// T08d — mode-aware shell integration. One filtered route registry (DL12 §2,
// nav-config.ts's `getNavGroupsForMode`) drives the sidebar, mobile drawer,
// Home cards, crumbs and `isRouteValidForMode` together, so this spec proves
// they agree rather than re-testing any single surface's own conformance
// (already covered by app-shell-rebuild.spec.ts / app-shell.spec.ts):
//  • Guided sidebar/Home hide the raw Constraints group + Export Layout;
//    Advanced shows them, plus the new Rules destination.
//  • The route-validity gate redirects an Advanced-only URL to Home once mode
//    adoption completes — never before (no transient false redirect).
//  • Advanced-only → Guided is a draft-guarded atomic transaction (Confirm
//    switches mode AND replaces to Home together; Cancel changes neither).
//  • The scenario store stays byte-identical across every mode transition,
//    including one that redirects.
//  • Rules' "Edit in Advanced" performs the inverse transaction (switch to
//    Advanced, land on the raw editor) as one atomic step.

type NsWindow = {
  __nsStore: {
    scenario: {
      getState(): Record<string, unknown> & { mutateScenario(x: unknown): void };
    };
    navGuard: {
      getState(): {
        registerDraft(reg: { id: string; label: string }): () => void;
      };
    };
  };
  __nsTestDraftCleanup?: () => void;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
});

async function gotoReadyHome(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("home-screen")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __nsStore?: unknown }).__nsStore),
  );
}

async function mutate(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    (window as unknown as NsWindow).__nsStore.scenario.getState().mutateScenario(p);
  }, patch);
}

async function storeSnapshot(page: Page): Promise<string> {
  return page.evaluate(() =>
    JSON.stringify((window as unknown as NsWindow).__nsStore.scenario.getState()),
  );
}

async function openTestDraft(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as NsWindow;
    w.__nsTestDraftCleanup = w.__nsStore.navGuard
      .getState()
      .registerDraft({ id: "e2e-mode-draft", label: "Test draft" });
  });
}

async function closeTestDraft(page: Page) {
  await page.evaluate(() => {
    (window as unknown as NsWindow).__nsTestDraftCleanup?.();
  });
}

test.describe("T08d — Guided/Advanced route registry", () => {
  test("Guided sidebar hides the raw Constraints group and Export Layout", async ({ page }) => {
    await gotoReadyHome(page);
    await expect(page.getByTestId("nav-group-setup")).toBeVisible();
    await expect(page.getByTestId("nav-group-constraints")).toHaveCount(0);
    await expect(page.getByTestId("nav-link-/rules")).toBeVisible();
    for (const path of [
      "/shift-type-requirements",
      "/shift-type-successions",
      "/shift-counts",
      "/shift-affinities",
      "/shift-type-coverings",
      "/export-layout",
    ]) {
      await expect(page.getByTestId(`nav-link-${path}`)).toHaveCount(0);
    }
    // Rules carries the Guided step 4 badge; no live count is ever shown.
    await expect(page.getByTestId("nav-step-/rules")).toHaveText("4");
  });

  test("Advanced sidebar shows the Constraints group with no Guided step numbers", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await page.getByTestId("mode-toggle-advanced").click();

    await expect(page.getByTestId("nav-group-constraints")).toBeVisible();
    await expect(page.getByTestId("nav-group-label-constraints")).toHaveText(/constraints/i);
    await expect(page.getByTestId("nav-link-/shift-type-requirements")).toBeVisible();
    await expect(page.getByTestId("nav-link-/export-layout")).toBeVisible();

    // Advanced never shows a Guided step number, even on a row that carries
    // one in Guided (Rules, guidedStep 4).
    await expect(page.getByTestId("nav-step-/rules")).toHaveCount(0);
    await expect(page.getByTestId("nav-step-/dates")).toHaveCount(0);
  });

  test("the /rules crumb reads Rules, not the Home fallback", async ({ page }) => {
    await gotoReadyHome(page);
    await page.getByTestId("nav-link-/rules").click();
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.getByTestId("route-crumb")).toHaveText("Rules");
  });

  test("Advanced Home lists Rules alongside the raw Constraints editors", async ({ page }) => {
    await gotoReadyHome(page);
    await page.getByTestId("mode-toggle-advanced").click();
    await expect(page.getByTestId("home-adv-/rules")).toBeVisible();
    await page.getByTestId("home-adv-/rules").click();
    await expect(page).toHaveURL(/\/rules$/);
  });

  test("the crumb for an Advanced-only route resolves through the same projection", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await page.getByTestId("mode-toggle-advanced").click();
    await page.getByTestId("nav-link-/export-layout").click();
    await expect(page).toHaveURL(/\/export-layout$/);
    await expect(page.getByTestId("route-crumb")).toHaveText("Export Layout");
  });
});

// T08d repair (P2): `isRouteValidForMode` and the crumb resolver were
// independently re-deriving the Guided/Advanced policy instead of reading
// `getNavGroupsForMode`. This matrix proves every registered route agrees
// between the sidebar (desktop + mobile drawer) and the two consumers, in
// both modes — not just the handful of routes the other describe blocks
// happen to exercise.
const GUIDED_VISIBLE_PATHS = [
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
  "/export-layout",
];
const ALL_REGISTERED_PATHS = [...GUIDED_VISIBLE_PATHS, ...ADVANCED_ONLY_PATHS];

test.describe("T08d repair — complete route/mode matrix (desktop + mobile)", () => {
  test("desktop sidebar matches the Guided/Advanced split for every registered route", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    for (const path of ALL_REGISTERED_PATHS) {
      const expectedGuided = GUIDED_VISIBLE_PATHS.includes(path);
      await expect(page.getByTestId(`nav-link-${path}`)).toHaveCount(expectedGuided ? 1 : 0);
    }

    await page.getByTestId("mode-toggle-advanced").click();
    for (const path of ALL_REGISTERED_PATHS) {
      await expect(page.getByTestId(`nav-link-${path}`)).toHaveCount(1);
    }
  });

  test("mobile drawer matches the same Guided/Advanced split", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await gotoReadyHome(page);
    await page.getByTestId("mobile-nav-trigger").click();
    const drawer = page.getByTestId("mobile-nav-drawer");
    await expect(drawer).toBeVisible();

    for (const path of ALL_REGISTERED_PATHS) {
      const expectedGuided = GUIDED_VISIBLE_PATHS.includes(path);
      await expect(drawer.getByTestId(`nav-link-${path}`)).toHaveCount(expectedGuided ? 1 : 0);
    }

    await drawer.getByTestId("mode-toggle-advanced").click();
    for (const path of ALL_REGISTERED_PATHS) {
      await expect(drawer.getByTestId(`nav-link-${path}`)).toHaveCount(1);
    }
  });
});

test.describe("T08d — route-validity gate on direct URL visits", () => {
  test("a stored Advanced preference adopts on an Advanced-only URL with no false Home redirect", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.addInitScript(() => localStorage.setItem("ns-app-mode", "advanced"));
    await page.goto("/shift-type-requirements");

    // The server/first-paint default is Guided, but the stored Advanced
    // preference adopts before the route-validity gate ever redirects — the
    // route must settle here, never bounce through "/".
    await expect(page.getByTestId("screen")).toBeVisible();
    await expect(page).toHaveURL(/\/shift-type-requirements$/);
    await expect(page.getByTestId("mode-toggle-advanced")).toHaveAttribute("aria-selected", "true");
    expect(errors).toEqual([]);
  });

  test("a Guided-default direct visit to an Advanced-only URL redirects to Home", async ({
    page,
  }) => {
    await page.goto("/shift-type-requirements");
    await expect(page.getByTestId("home-screen")).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("mode-toggle-guided")).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("T08d — Advanced-only → Guided atomic transaction", () => {
  test("with no open draft, Guided replaces to Home atomically", async ({ page }) => {
    await gotoReadyHome(page);
    await page.getByTestId("mode-toggle-advanced").click();
    await page.getByTestId("nav-link-/shift-type-requirements").click();
    await expect(page).toHaveURL(/\/shift-type-requirements$/);

    await page.getByTestId("mode-toggle-guided").click();
    await expect(page.getByTestId("mode-toggle-guided")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("home-screen")).toBeVisible();
  });

  test("with an open draft, Cancel leaves both mode and route unchanged, and restores pointer focus to Advanced (T08d repair P2)", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await page.getByTestId("mode-toggle-advanced").click();
    await page.getByTestId("nav-link-/shift-type-requirements").click();
    await expect(page).toHaveURL(/\/shift-type-requirements$/);
    await openTestDraft(page);

    // A real pointer click focuses the clicked (Guided) button before its
    // onClick even runs — the exact browser behavior a jsdom `.click()` can't
    // reproduce, and the one the P2 finding was about.
    await page.getByTestId("mode-toggle-guided").click();

    // The staged confirm dialog's focus trap then takes focus off the mode
    // tablist. Asserting Guided *stays* focused here is a racy transient — the
    // trap deterministically supersedes it (under parallel load the trap wins
    // before the assertion polls), so assert the stable states instead: the
    // dialog is up and focus has genuinely left the still-selected Advanced tab.
    // That keeps the post-Cancel restore below a real move, never a vacuous
    // no-op, without racing a transient the product never guarantees.
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await expect(page.getByTestId("mode-toggle-advanced")).not.toBeFocused();
    await page.getByTestId("confirm-dialog-cancel").click();

    await expect(page.getByTestId("mode-toggle-advanced")).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/shift-type-requirements$/);
    // Focus must return to the still-selected Advanced tab (T08d repair P2's
    // `onCancelled`), never be left in the dialog or on the now-unselected
    // Guided tab (tabIndex=-1) where the browser's own close-restore would put
    // it.
    await expect(page.getByTestId("mode-toggle-advanced")).toBeFocused();
    await closeTestDraft(page);
  });

  test("with an open draft, Confirm switches mode and replaces to Home together", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await page.getByTestId("mode-toggle-advanced").click();
    await page.getByTestId("nav-link-/shift-type-requirements").click();
    await expect(page).toHaveURL(/\/shift-type-requirements$/);
    await openTestDraft(page);

    await page.getByTestId("mode-toggle-guided").click();
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeVisible();
    await page.getByTestId("confirm-dialog-confirm").click();

    await expect(page.getByTestId("mode-toggle-guided")).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("home-screen")).toBeVisible();
  });

  test("the scenario store stays byte-identical across a redirecting mode switch", async ({
    page,
  }) => {
    await gotoReadyHome(page);
    await mutate(page, {
      staff: [{ _k: "p1", id: 1, description: "A" }],
      cardsByKind: {
        requirements: [{ uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1 }],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });

    await page.getByTestId("mode-toggle-advanced").click();
    await page.getByTestId("nav-link-/shift-type-requirements").click();
    await expect(page).toHaveURL(/\/shift-type-requirements$/);
    const before = await storeSnapshot(page);

    await page.getByTestId("mode-toggle-guided").click();
    await expect(page).toHaveURL(/\/$/);
    const after = await storeSnapshot(page);

    expect(after).toBe(before);
  });
});

test.describe("T08d — Rules 'Edit in Advanced' inverse transaction", () => {
  test("opens the owning raw editor and switches to Advanced as one step", async ({ page }) => {
    await gotoReadyHome(page);
    await mutate(page, {
      cardsByKind: {
        requirements: [
          { uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1, description: "Day cap" },
        ],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    await page.getByTestId("nav-link-/rules").click();
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.getByTestId("mode-toggle-guided")).toHaveAttribute("aria-selected", "true");

    await page.getByTestId("rules-open-advanced-banner").click();

    await expect(page).toHaveURL(/\/shift-type-requirements$/);
    await expect(page.getByTestId("mode-toggle-advanced")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Unsaved changes" })).toBeHidden();
  });
});
