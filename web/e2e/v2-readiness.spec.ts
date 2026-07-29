import { expect, test } from "@playwright/test";
import { V2_SURFACE_MATRIX, type V2Row } from "./support/v2-surface-matrix";
import {
  buildSeedPatch,
  prepareRow,
  seedRecordsBackup,
  seedRow,
  SEED_STAFF_IDS,
} from "./support/v2-seed";
import { awaitRowReady } from "./support/v2-readiness";

// F4 — the all-row readiness smoke.
//
// This suite runs ALL SEVENTEEN rows, at F4, before any route has been
// re-skinned. It is deliberately readiness-ONLY: it proves that every row can
// reset, seed, navigate and settle against the shipped app, and asserts nothing
// about v2 styling. Demanding v2 conformance from an unmigrated route here would
// produce a suite that is red for months, and a suite that is expected to be red
// stops being read.
//
// What it therefore does prove, before the parallel wave opens:
//   • every seed descriptor targets a store that actually accepts it;
//   • every readiness descriptor settles on the route it names (an Advanced-only
//     route that forgot its mode lands on Home instead, and is caught here);
//   • every marker exists in the shipped source;
//   • the reset is real — each row starts from an empty durable store;
//   • nothing throws while getting there.
//
// Unlike the other two F4 suites this one ignores `V2_MATRIX_OWNER`: the point
// of a foundation checkpoint is that the WHOLE matrix was proven navigable
// before nine tickets started depending on it.

/** Read the durable scenario slice through the e2e store seam. */
async function readScenario(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const store = (
      window as unknown as {
        __nsStore?: { scenario: { getState(): Record<string, unknown> } };
      }
    ).__nsStore;
    if (!store) return null;
    const state = store.scenario.getState();
    return {
      staff: (state.staff as unknown[] | undefined)?.length ?? 0,
      shifts: (state.shifts as unknown[] | undefined)?.length ?? 0,
      reqData: (state.reqData as unknown[] | undefined)?.length ?? 0,
      rangeStart: (state.rangeStart as string | undefined) ?? "",
      cards: Object.fromEntries(
        Object.entries((state.cardsByKind as Record<string, unknown[]>) ?? {}).map(([k, v]) => [
          k,
          v.length,
        ]),
      ),
    };
  });
}

function backupStatus(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __nsStore?: { backupStatus(): string } }).__nsStore?.backupStatus() ??
      null,
  );
}

for (const row of V2_SURFACE_MATRIX satisfies readonly V2Row[]) {
  test(`${row.owner} · ${row.route} — resets, seeds, navigates and settles`, async ({ page }) => {
    // Only uncaught page exceptions are collected. Console errors are NOT a
    // signal here: `/optimize-and-export` and the durable harness talk to a
    // backend that is deliberately absent from this suite's webServer, so their
    // failed fetches are expected and would drown a real error in noise.
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(`${err.name}: ${err.message}`));

    await prepareRow(page, row);
    await page.goto(row.route);
    await awaitRowReady(page, row);

    // --- the reset is real, not assumed ------------------------------------
    const before = await readScenario(page);
    if (row.readiness.storeSeam) {
      expect(before, `${row.route}: the store seam should be mounted`).not.toBeNull();

      if (row.seed === "harness-self-seeded") {
        // The durable harness writes its own minimum required data into the REAL
        // store on mount, so "empty after reset" is the wrong claim here. The
        // claim that matters is the same one in substance: the state on screen
        // is the harness's own deterministic seed and not a leftover from a
        // previous row.
        expect(
          before!.staff + before!.shifts,
          `${row.route}: the harness should have seeded itself by the time it is ready`,
        ).toBeGreaterThan(0);
        expect(
          before!.reqData,
          `${row.route}: the harness seeds no request cells, so any here are leftovers`,
        ).toBe(0);
      } else {
        expect(
          { staff: before!.staff, shifts: before!.shifts, reqData: before!.reqData },
          `${row.route} started from a non-empty durable store — the reset did not take`,
        ).toEqual({ staff: 0, shifts: 0, reqData: 0 });
      }
    }

    // --- seed, then settle again -------------------------------------------
    await seedRow(page, row);
    await awaitRowReady(page, row);

    const patch = buildSeedPatch(row.seed);
    if (patch !== null) {
      const after = await readScenario(page);
      expect(after, `${row.route}: the store seam disappeared after seeding`).not.toBeNull();
      // The seed must have LANDED, not merely been dispatched: `mutateScenario`
      // no-ops before hydration reports ready, so a race here would look exactly
      // like a passing test with an empty screen.
      expect(after!.staff, `${row.route}: seeded staff`).toBe(SEED_STAFF_IDS.length);
      expect(after!.rangeStart, `${row.route}: seeded roster start`).toBe(patch.rangeStart);

      if (patch.reqData) {
        expect(after!.reqData, `${row.route}: seeded request cells`).toBe(
          (patch.reqData as unknown[]).length,
        );
      }
      if (patch.cardsByKind) {
        for (const [kind, cards] of Object.entries(
          patch.cardsByKind as Record<string, unknown[]>,
        )) {
          expect(after!.cards[kind], `${row.route}: seeded ${kind}`).toBe(cards.length);
        }
      }
    }

    if (seedRecordsBackup(row.seed)) {
      expect(await backupStatus(page), `${row.route}: Workspace backup after seeding`).toBe(
        "current",
      );
    }

    // --- still on the route we asked for, and nothing threw -----------------
    expect(new URL(page.url()).pathname, `${row.route}: settled route`).toBe(row.route);
    expect(pageErrors, `${row.route} raised: ${pageErrors.join(" | ")}`).toEqual([]);
  });
}

test("the smoke covers every manifest row", () => {
  // The loop above is what registers the rows, so this guards the loop itself:
  // a filter accidentally introduced there would shrink the smoke silently.
  expect(V2_SURFACE_MATRIX).toHaveLength(17);
});
