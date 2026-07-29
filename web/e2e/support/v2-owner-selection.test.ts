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
