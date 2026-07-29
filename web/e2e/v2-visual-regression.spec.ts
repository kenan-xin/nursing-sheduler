import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { activeSelector, MATRIX_OWNER_ENV } from "./support/v2-owner-selection";
import { rowForRoute, type V2Row } from "./support/v2-surface-matrix";
import { prepareRow, seedRow } from "./support/v2-seed";
import { awaitRowReady, enterScreenshotMode } from "./support/v2-readiness";

// F4 — committed visual baselines.
//
// Two halves with two different owners, in one file so the snapshot directory
// has exactly one author:
//
//   • the FOUNDATION baselines, owned by F4 and live from this ticket onward.
//     They cover `/design-system`, which is where the token contract, the
//     surface ladder, the radius roles and the elevation ramp are all rendered
//     side by side — a change to any of them shows up here before it reaches a
//     product route.
//   • the G1 REPRESENTATIVE runner, which registers only under
//     `V2_MATRIX_OWNER=all`. One stable screen per route family, captured once
//     at final convergence rather than accumulated ticket by ticket.
//
// Route tickets edit neither this file nor its committed snapshots. That is the
// point of the split: nine parallel tickets writing into one snapshot directory
// would produce baselines nobody reviewed together, and a screenshot nobody
// reviewed is a screenshot that only proves the last person's output.
//
// Determinism comes from the shared readiness contract plus screenshot mode
// (a test-only root attribute that suppresses motion and the caret) — not from
// a diff tolerance. The comparison stays exact.

const SELECTOR = activeSelector(MATRIX_OWNER_ENV);

const THEMES = ["light", "dark"] as const;

/**
 * The `/design-system` sections captured as baselines. Section-scoped rather
 * than full-page on purpose: a 5,000px full-page capture turns any spacing
 * change anywhere into one unreadable diff, whereas a section diff says which
 * part of the contract moved.
 */
const FOUNDATION_SECTIONS = [
  { id: "palette", why: "every --color-* token, in one grid" },
  { id: "surfaces", why: "the L0→L2 ladder and all nine recipe roles" },
  { id: "radius", why: "the four radius roles plus the explicit square" },
  { id: "shadows", why: "the five elevation tokens and the directional exception" },
  { id: "components", why: "the shadcn/Base UI primitives at their v2 variants" },
] as const;

/**
 * One stable screen per route family, for G1. Deliberately NOT one per route:
 * the technical plan takes a hybrid position — semantic checks everywhere,
 * selective pixels — because a full combinatorial baseline matrix is a
 * maintenance surface nobody re-reviews.
 */
const G1_REPRESENTATIVES = [
  { route: "/", family: "shell + Home" },
  { route: "/people", family: "setup editor" },
  { route: "/shift-counts", family: "Card Editor" },
  { route: "/shift-requests", family: "Requests" },
  { route: "/optimize-and-export", family: "Optimize" },
  { route: "/save-and-load", family: "Save & Load" },
] as const;

async function loadForCapture(page: Page, row: V2Row, theme: (typeof THEMES)[number]) {
  await prepareRow(page, row);
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("ns-theme", t);
      window.localStorage.setItem("ns-accent", "teal");
    } catch {}
  }, theme);

  await page.goto(row.route);
  await awaitRowReady(page, row);
  await seedRow(page, row);
  await awaitRowReady(page, row);

  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-accent", "teal");
  if (theme === "dark") await expect(html).toHaveClass(/dark/);
  else await expect(html).not.toHaveClass(/dark/);

  await enterScreenshotMode(page);
}

// ---------------------------------------------------------------------------
// Foundation baselines — owned by F4
// ---------------------------------------------------------------------------

const FOUNDATION_ROW = rowForRoute("/design-system")!;

test.describe("foundation baselines — /design-system", () => {
  for (const theme of THEMES) {
    for (const section of FOUNDATION_SECTIONS) {
      test(`${section.id} — ${theme} (${section.why})`, async ({ page }) => {
        await loadForCapture(page, FOUNDATION_ROW, theme);

        const target = page.getByTestId(section.id);
        await expect(target).toBeVisible();
        await expect(target).toHaveScreenshot(`design-system-${section.id}-${theme}.png`, {
          animations: "disabled",
          caret: "hide",
        });
      });
    }
  }
});

// ---------------------------------------------------------------------------
// G1 representative baselines — registered only for the final convergence run
// ---------------------------------------------------------------------------

// Registration-time, like every other selection in F4: under any other selector
// these tests do not exist, rather than existing and being skipped. A route
// ticket running `V2_MATRIX_OWNER=R5` therefore cannot create, update or
// invalidate a representative baseline even by accident.
for (const representative of SELECTOR === "all" ? G1_REPRESENTATIVES : []) {
  const row = rowForRoute(representative.route);
  if (!row) throw new Error(`no manifest row for representative ${representative.route}`);

  test.describe(`G1 representative — ${representative.family}`, () => {
    for (const theme of THEMES) {
      test(`${representative.route} — ${theme}`, async ({ page }) => {
        await loadForCapture(page, row, theme);
        await expect(page).toHaveScreenshot(`representative-${row.owner}-${theme}.png`, {
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Baseline availability
// ---------------------------------------------------------------------------

// Playwright names a snapshot `<name>-<project>-<platform>.png`, so a baseline is
// per-platform by construction: macOS and Linux rasterise the same page
// differently and always will.

/**
 * The names this project/platform must find committed, in a stable order.
 */
function expectedBaselineNames(projectName: string, platform: string): string[] {
  return FOUNDATION_SECTIONS.flatMap((section) =>
    THEMES.map((theme) => `design-system-${section.id}-${theme}-${projectName}-${platform}.png`),
  );
}

function missingBaselines(projectName: string, platform: string): string[] {
  const dir = join(__dirname, "v2-visual-regression.spec.ts-snapshots");
  return expectedBaselineNames(projectName, platform).filter(
    (name) => !existsSync(join(dir, name)),
  );
}

// ---------------------------------------------------------------------------
// Baseline preflight — a real gate, not a racing sibling
//
// Playwright 1.61.1's `updateSnapshots` is `'all' | 'changed' | 'missing' |
// 'none'`, defaulting to `'missing'` (verified in
// node_modules/playwright/types/test.d.ts). Under `'missing'` an absent baseline
// is WRITTEN and the test fails; on a configured retry the file now exists, so
// the retry compares the run against its own freshly written output and passes.
// That is the failure this gate exists to prevent, and it is why the check must
// happen BEFORE any writer runs rather than beside them.
//
// `beforeAll` is the mechanism: it runs before every test in this file, in each
// worker, so under default mode a missing baseline aborts the file before a
// single screenshot can be written — no ordering luck involved. The previous
// version was a peer `test()`, which raced the writers and failed the very
// update run whose job is to create them.
// ---------------------------------------------------------------------------
test.beforeAll(() => {
  const projectName = test.info().project.name;
  const platform = process.platform;
  const mode = test.info().config.updateSnapshots;
  const missing = missingBaselines(projectName, platform);

  // An explicit `--update-snapshots` run is the one context where writing is the
  // intent, so the preflight reports rather than blocks. It stays deterministic:
  // the decision is read from config, never from what happens to be on disk yet.
  if (mode === "all" || mode === "changed") {
    // eslint-disable-next-line no-console -- the permission must be visible in the run log
    console.log(
      `[v2-baseline-preflight] updateSnapshots="${mode}": regeneration permitted for ` +
        `${projectName}-${platform}; ${missing.length} of ` +
        `${expectedBaselineNames(projectName, platform).length} baseline(s) absent and will be written.`,
    );
    return;
  }

  if (missing.length > 0) {
    throw new Error(
      `[v2-baseline-preflight] No committed baseline for ${projectName}-${platform} ` +
        `(updateSnapshots="${mode}").\n` +
        `darwin and linux are both committed; any other platform needs its own set, generated ` +
        `once in an environment matching that platform's CI lane with\n` +
        `  pnpm exec playwright test e2e/v2-visual-regression.spec.ts --project=chromium --update-snapshots\n` +
        `and committed. Failing here, before any screenshot is written, is deliberate: under\n` +
        `updateSnapshots="missing" a comparison would create the absent file and a retry would\n` +
        `then pass against it. Missing:\n  ` +
        missing.join("\n  "),
    );
  }
});

test("both approved platforms keep a complete committed baseline set", () => {
  // A static inventory assertion, independent of which platform is running and
  // of any writer: darwin and linux were each generated and reviewed in their
  // own environment, so neither may quietly lose a section.
  const dir = join(__dirname, "v2-visual-regression.spec.ts-snapshots");
  const gaps = ["darwin", "linux"].flatMap((platform) =>
    expectedBaselineNames("chromium", platform)
      .filter((name) => !existsSync(join(dir, name)))
      .map((name) => name),
  );
  expect(gaps, `incomplete committed baseline set:\n  ${gaps.join("\n  ")}`).toEqual([]);
});

test("the representative runner belongs to G1 alone", () => {
  // The count is the contract: six families, and they register only for `all`.
  expect(G1_REPRESENTATIVES).toHaveLength(6);
  for (const representative of G1_REPRESENTATIVES) {
    expect(rowForRoute(representative.route), representative.route).toBeDefined();
  }
  expect(new Set(G1_REPRESENTATIVES.map((r) => rowForRoute(r.route)!.owner)).size).toBe(6);
});
