import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeSelector,
  DEFAULT_OWNER,
  MATRIX_OWNER_ENV,
  matchesAnyGlob,
  matchesGlob,
  ownerForPath,
  ownersForSelector,
  parseSelector,
  selectRows,
  selectRowsFromEnv,
  selectStyleOwnerPatterns,
  selectStyleOwnerPatternsFromEnv,
  STYLE_OWNER_ENV,
  V2OwnerSelectionError,
} from "./v2-owner-selection";
import { V2_OWNERS, V2_STYLE_OWNER_FILES, V2_SURFACE_MATRIX } from "./v2-surface-matrix";

/** `web/`, for the on-disk premise guards in the owner-exception block below. */
const WEB_ROOT = resolve(__dirname, "..", "..");

// Selection is the mechanism that lets nine tickets share one immutable manifest
// without a migration ledger. Everything below is about the two ways that could
// go quietly wrong: a selection that registers MORE than the caller asked for,
// and a selection that registers NOTHING while still reporting success.

describe("parseSelector", () => {
  it("defaults an unset variable to the foundation", () => {
    expect(parseSelector(undefined, MATRIX_OWNER_ENV)).toBe(DEFAULT_OWNER);
    expect(DEFAULT_OWNER).toBe("foundation");
  });

  it.each([...V2_OWNERS, "all"] as const)("accepts %s", (value) => {
    expect(parseSelector(value, MATRIX_OWNER_ENV)).toBe(value);
  });

  it("rejects an EMPTY value rather than treating it as unset", () => {
    // `V2_MATRIX_OWNER=` in a CI file reads as a deliberate selection. Widening
    // it to the default would silently run a different scope than was written.
    for (const empty of ["", "   ", "\t"]) {
      expect(() => parseSelector(empty, MATRIX_OWNER_ENV)).toThrow(V2OwnerSelectionError);
    }
  });

  it.each(["r1", "R1 ", " R1", "R2A", "FOUNDATION", "ALL", "R8", "R2", "foundation,R1"])(
    "rejects %s without quietly repairing it",
    (value) => {
      expect(() => parseSelector(value, MATRIX_OWNER_ENV)).toThrow(V2OwnerSelectionError);
    },
  );

  it("names the accepted values and the manifest inventory when it fails", () => {
    let message = "";
    try {
      parseSelector("R8", MATRIX_OWNER_ENV);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(MATRIX_OWNER_ENV);
    expect(message).toContain("R2a");
    expect(message).toContain("all");
    expect(message).toContain("/design-system");
    expect(message).toContain("/optimize-and-export");
  });
});

describe("selectRows", () => {
  it("registers ONLY the foundation row when nothing is selected", () => {
    // This is what keeps `pnpm test:e2e` green at F4 with no hidden route debt:
    // the unmigrated routes are not skipped, they are not registered.
    expect(selectRows(undefined).map((r) => r.route)).toEqual(["/design-system"]);
  });

  it("registers exactly R6's four rows", () => {
    expect(selectRows("R6").map((r) => r.route)).toEqual([
      "/optimize-and-export",
      "/optimize-screen-fixture",
      "/progress-chart-fixture",
      "/optimize-durable-fixture",
    ]);
  });

  it.each([
    ["R2a", ["/dates"]],
    ["R2b", ["/people"]],
    ["R2c", ["/shift-types"]],
    ["R1", ["/"]],
    ["R3", ["/rules"]],
    ["R5", ["/shift-requests"]],
    ["R7", ["/save-and-load"]],
  ])("registers exactly %s's rows", (owner, routes) => {
    expect(selectRows(owner).map((r) => r.route)).toEqual(routes);
  });

  it("registers all 17 rows for G1", () => {
    expect(selectRows("all")).toHaveLength(17);
    expect(selectRows("all").map((r) => r.route)).toEqual(V2_SURFACE_MATRIX.map((r) => r.route));
  });

  it("every owner's selection is a strict subset of `all`, and they partition it", () => {
    const perOwner = V2_OWNERS.flatMap((o) => selectRows(o).map((r) => r.route));
    expect(perOwner.sort()).toEqual(
      selectRows("all")
        .map((r) => r.route)
        .sort(),
    );
    expect(new Set(perOwner).size).toBe(perOwner.length);
  });

  it("preserves manifest order rather than selection order", () => {
    const all = selectRows("all").map((r) => r.route);
    const r4 = selectRows("R4").map((r) => r.route);
    expect(r4).toEqual(all.filter((route) => r4.includes(route)));
  });

  it("reads the environment when asked to", () => {
    expect(selectRowsFromEnv({ [MATRIX_OWNER_ENV]: "R7" }).map((r) => r.route)).toEqual([
      "/save-and-load",
    ]);
    expect(selectRowsFromEnv({}).map((r) => r.route)).toEqual(["/design-system"]);
  });
});

describe("selectStyleOwnerPatterns", () => {
  it("enumerates exactly R6's frozen presentation owners", () => {
    expect(selectStyleOwnerPatterns("R6")).toEqual([...V2_STYLE_OWNER_FILES.R6]);
  });

  it("defaults to the foundation set", () => {
    expect(selectStyleOwnerPatternsFromEnv({})).toEqual([...V2_STYLE_OWNER_FILES.foundation]);
  });

  it("unions every owner for `all`, without duplication", () => {
    const all = selectStyleOwnerPatterns("all");
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(V2_OWNERS.reduce((n, o) => n + V2_STYLE_OWNER_FILES[o].length, 0));
  });

  it("shares one vocabulary with the browser selector", () => {
    expect(() => selectStyleOwnerPatterns("R8", STYLE_OWNER_ENV)).toThrow(V2OwnerSelectionError);
    expect(() => selectStyleOwnerPatterns("", STYLE_OWNER_ENV)).toThrow(V2OwnerSelectionError);
  });
});

describe("ownersForSelector", () => {
  it("expands `all` and passes an owner through", () => {
    expect(ownersForSelector("all")).toEqual([...V2_OWNERS]);
    expect(ownersForSelector("R4")).toEqual(["R4"]);
  });
});

describe("activeSelector", () => {
  it("reports the selector in force", () => {
    expect(activeSelector(MATRIX_OWNER_ENV, { [MATRIX_OWNER_ENV]: "all" })).toBe("all");
    expect(activeSelector(STYLE_OWNER_ENV, {})).toBe("foundation");
  });
});

describe("glob matching", () => {
  it.each([
    ["components/ui/button.tsx", "components/ui/**/*.tsx", true],
    ["components/ui/nested/deep/thing.tsx", "components/ui/**/*.tsx", true],
    ["components/ui/button.ts", "components/ui/**/*.tsx", false],
    ["components/uix/button.tsx", "components/ui/**/*.tsx", false],
    ["app/globals.css", "app/globals.css", true],
    ["app/globals.css.map", "app/globals.css", false],
  ])("%s vs %s → %s", (path, pattern, expected) => {
    expect(matchesGlob(path, pattern)).toBe(expected);
  });

  it("matches a Next.js route group literally, parentheses and all", () => {
    // `(app)` is a directory name, not a regex group. Escaping is the difference
    // between owning one file and owning every file whose path contains "app".
    expect(matchesGlob("app/(app)/dates/page.tsx", "app/(app)/dates/page.tsx")).toBe(true);
    expect(matchesGlob("app/app/dates/page.tsx", "app/(app)/dates/page.tsx")).toBe(false);
    expect(
      matchesGlob(
        "app/(app)/optimize-durable-fixture/fixture-client.tsx",
        "app/(app)/optimize-durable-fixture/**/*.tsx",
      ),
    ).toBe(true);
  });

  it("a single star never crosses a path separator", () => {
    expect(matchesGlob("components/ui/button.tsx", "components/*/button.tsx")).toBe(true);
    expect(matchesGlob("components/ui/nested/button.tsx", "components/*/button.tsx")).toBe(false);
  });

  it("`**/` also matches zero segments", () => {
    expect(matchesGlob("components/optimize/callout.tsx", "components/optimize/**/*.tsx")).toBe(
      true,
    );
    expect(
      matchesGlob(
        "components/optimize/progress-chart/progress-chart.tsx",
        "components/optimize/**/*.tsx",
      ),
    ).toBe(true);
  });

  it("matchesAnyGlob is the disjunction of its patterns", () => {
    expect(matchesAnyGlob("components/home/home-screen.tsx", [...V2_STYLE_OWNER_FILES.R1])).toBe(
      true,
    );
    expect(matchesAnyGlob("components/home/home-screen.tsx", [...V2_STYLE_OWNER_FILES.R6])).toBe(
      false,
    );
  });
});

describe("ownerForPath", () => {
  it.each([
    ["app/globals.css", "foundation"],
    ["components/ui/button.tsx", "foundation"],
    ["components/theme/theme-toggle.tsx", "foundation"],
    ["components/entity-editor/transfer-list.tsx", "foundation"],
    ["components/shell/app-shell.tsx", "R1"],
    ["components/home/home-screen.tsx", "R1"],
    ["components/dates/dates-screen.tsx", "R2a"],
    ["components/people/people-table.tsx", "R2b"],
    ["components/shift-types/shift-type-grid.tsx", "R2c"],
    ["components/guided-rules/rules-screen.tsx", "R3"],
    ["components/card-editor/card-editor-shell.tsx", "R4"],
    ["components/counts/counts-editor.tsx", "R4"],
    ["components/requests/requests-matrix.tsx", "R5"],
    ["components/optimize/progress-chart/progress-chart.tsx", "R6"],
    ["app/progress-chart-fixture/fixture-client.tsx", "R6"],
    ["components/save-load/save-load-workspace.tsx", "R7"],
  ])("%s belongs to %s", (path, owner) => {
    expect(ownerForPath(path)).toBe(owner);
  });

  it("returns undefined for a path no owner claims", () => {
    expect(ownerForPath("lib/store/persistence.ts")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The one entity-editor exception (ii7.21.3).
//
// `components/entity-editor/**` is foundation's, with exactly one carve-out:
// `working-time-fields` is R2c's, because Shift Types is its only live UI
// consumer and the R2c ticket is authoritative about that. The cold review of
// `588244d..42c1c32` found the manifest and the ticket asserting opposite
// things, which meant `V2_STYLE_OWNER=R2c` did not scan a file R2c had changed.
//
// Every assertion below FAILS under the pre-fix mapping
// (`components/entity-editor/**/*.tsx` → foundation, absent from R2c), so this
// block is what stops the contradiction coming back.
// ---------------------------------------------------------------------------

const WORKING_TIME_PRESENTER = "components/entity-editor/working-time-fields.tsx";
const WORKING_TIME_TEST = "components/entity-editor/working-time-fields.test.tsx";

/** The other entity-editor presentation files, which stay foundation's. */
const FOUNDATION_ENTITY_EDITOR = [
  "components/entity-editor/groups-section.tsx",
  "components/entity-editor/groups-section.test.tsx",
  "components/entity-editor/transfer-list.tsx",
  "components/entity-editor/transfer-list.test.tsx",
];

describe("the working-time-fields owner exception", () => {
  it("assigns the presenter and its focused test to R2c, and nobody else", () => {
    expect(ownerForPath(WORKING_TIME_PRESENTER)).toBe("R2c");
    expect(ownerForPath(WORKING_TIME_TEST)).toBe("R2c");
  });

  it("removes both from the foundation selection", () => {
    // The half the pre-fix map got wrong in the other direction: leaving them in
    // foundation's sweep would make them owned TWICE, which is worse than the
    // original contradiction — two parallel tickets could both edit them.
    for (const path of [WORKING_TIME_PRESENTER, WORKING_TIME_TEST]) {
      expect(matchesAnyGlob(path, [...V2_STYLE_OWNER_FILES.foundation]), path).toBe(false);
    }
  });

  it("selects the presenter under the literal R2c style command", () => {
    // This is the exact predicate `app/v2-style-contract.test.ts` applies to
    // build its scan set, evaluated against the exact patterns the R2c selector
    // resolves to — so a pass here means `V2_STYLE_OWNER=R2c` really does scan
    // the file, not merely that some pattern somewhere mentions it.
    const r2c = selectStyleOwnerPatterns("R2c", STYLE_OWNER_ENV);
    expect(matchesAnyGlob(WORKING_TIME_PRESENTER, r2c)).toBe(true);

    // Guard the premise: a path that does not exist would satisfy the glob check
    // and still never be scanned, because the scanner walks the real tree.
    expect(existsSync(join(WEB_ROOT, WORKING_TIME_PRESENTER)), WORKING_TIME_PRESENTER).toBe(true);
    expect(existsSync(join(WEB_ROOT, WORKING_TIME_TEST)), WORKING_TIME_TEST).toBe(true);
  });

  it("is claimed exactly once across every owner", () => {
    for (const path of [WORKING_TIME_PRESENTER, WORKING_TIME_TEST]) {
      const claimants = V2_OWNERS.filter((owner) =>
        matchesAnyGlob(path, [...V2_STYLE_OWNER_FILES[owner]]),
      );
      expect(claimants, `${path} claimants`).toEqual(["R2c"]);
    }
  });

  it("leaves every OTHER entity-editor presentation file with foundation", () => {
    // The carve-out must be a carve-out, not a handover of the directory.
    for (const path of FOUNDATION_ENTITY_EDITOR) {
      expect(ownerForPath(path), path).toBe("foundation");
      expect(existsSync(join(WEB_ROOT, path)), `${path} must exist for this to mean anything`).toBe(
        true,
      );
      const claimants = V2_OWNERS.filter((owner) =>
        matchesAnyGlob(path, [...V2_STYLE_OWNER_FILES[owner]]),
      );
      expect(claimants, `${path} claimants`).toEqual(["foundation"]);
    }
  });

  it("never lets the exception reach entity-editor/core, which no owner claims", () => {
    // `core/**` is pure behaviour and is deliberately outside the presentation
    // owner map entirely; R2c consumes it and must not acquire it.
    for (const path of [
      "components/entity-editor/core/working-time.ts",
      "components/entity-editor/core/index.ts",
    ]) {
      expect(ownerForPath(path), path).toBeUndefined();
    }
  });

  it("changes no route row — this is a STATIC-ownership fix only", () => {
    // The manifest's browser half is frozen for the epic. A style-owner edit that
    // also moved a row would change what each ticket's matrices verify.
    expect(V2_SURFACE_MATRIX).toHaveLength(17);
    expect(selectRows("R2c").map((r) => r.route)).toEqual(["/shift-types"]);
    expect(selectRows("foundation").map((r) => r.route)).toEqual(["/design-system"]);
  });

  it("still fails closed on an invalid or empty style selector", () => {
    // The exception must not have introduced a widening fallback anywhere on the
    // style path.
    for (const bad of ["", "   ", "r2c", "R2C", "R2c ", "R8", "foundation,R2c"]) {
      expect(() => selectStyleOwnerPatterns(bad, STYLE_OWNER_ENV), bad).toThrow(
        V2OwnerSelectionError,
      );
    }
    // …and an unset selector still means foundation, not "everything".
    expect(selectStyleOwnerPatternsFromEnv({})).toEqual([...V2_STYLE_OWNER_FILES.foundation]);
  });
});
