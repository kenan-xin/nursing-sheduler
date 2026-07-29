import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_NAV_ITEMS } from "@/components/shell/nav-config";
import {
  HARNESS_NO_PROTOTYPE,
  manifestInventory,
  rowForRoute,
  rowsForOwner,
  V2_HARNESS_ROUTES,
  V2_OWNERS,
  V2_PRODUCT_ROUTES,
  V2_RADIUS_CONTRACT,
  V2_RADIUS_ROLES,
  V2_READINESS_STRATEGIES,
  V2_ROLE_CONTRACT,
  V2_SEED_KEYS,
  V2_SELECTORS,
  V2_STYLE_OWNER_FILES,
  V2_SURFACE_MATRIX,
  V2_SURFACE_ROLES,
} from "./v2-surface-matrix";

// The manifest is the thing every other F4 artefact trusts, and it is frozen for
// the rest of the epic — nine parallel tickets and G1 read it and none of them
// may edit it. These are the properties that make that safe: it is COMPLETE (no
// route missing), CONSISTENT with the real route registry (no descriptor that
// contradicts the shipped app), and DISJOINT (no two tickets owning one file).

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

describe("inventory", () => {
  it("holds exactly 13 product routes and 4 harness routes", () => {
    expect(V2_PRODUCT_ROUTES).toHaveLength(13);
    expect(V2_HARNESS_ROUTES).toHaveLength(4);
    expect(V2_SURFACE_MATRIX).toHaveLength(17);
  });

  it("gives every route exactly one row", () => {
    const routes = V2_SURFACE_MATRIX.map((r) => r.route);
    expect(new Set(routes).size).toBe(routes.length);
    for (const route of routes) expect(rowForRoute(route)?.route).toBe(route);
  });

  it("assigns every row to a declared owner, and leaves no owner idle", () => {
    for (const row of V2_SURFACE_MATRIX) {
      expect(V2_OWNERS, `${row.route}`).toContain(row.owner);
    }
    for (const owner of V2_OWNERS) {
      expect(rowsForOwner(owner).length, `${owner} owns no row`).toBeGreaterThan(0);
    }
  });

  it("keeps R2a, R2b and R2c distinct", () => {
    expect(rowsForOwner("R2a").map((r) => r.route)).toEqual(["/dates"]);
    expect(rowsForOwner("R2b").map((r) => r.route)).toEqual(["/people"]);
    expect(rowsForOwner("R2c").map((r) => r.route)).toEqual(["/shift-types"]);
  });

  it("gives the foundation exactly the design-system reference", () => {
    expect(rowsForOwner("foundation").map((r) => r.route)).toEqual(["/design-system"]);
  });

  it("gives R6 its four rows — one product route plus three harnesses", () => {
    // The ticket's selector proof asserts this count from the outside; asserting
    // it here too means a manifest edit fails immediately rather than at the
    // moment someone runs the proof command.
    const rows = rowsForOwner("R6");
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.kind === "product")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "harness")).toHaveLength(3);
  });

  it("the R4 family is the five raw Card Editor routes", () => {
    expect(rowsForOwner("R4").map((r) => r.route)).toEqual([
      "/shift-type-requirements",
      "/shift-type-successions",
      "/shift-counts",
      "/shift-affinities",
      "/shift-type-coverings",
    ]);
  });

  it("excludes the features the adoption record put outside this epic", () => {
    // Export Layout, Roster and the gated AI destination have no shipped screen.
    // A row for one would be a route ticket verifying something that is not there.
    const routes = V2_SURFACE_MATRIX.map((r) => r.route);
    for (const absent of ["/export-layout", "/roster", "/schedule", "/ai", "/assistant"]) {
      expect(routes).not.toContain(absent);
    }
  });
});

describe("consistency with the shipped route registry", () => {
  it("the product rows are exactly the app's 13 navigable routes", () => {
    // Read from `nav-config` rather than a second hand-written list: a route
    // added to the product must fail HERE, not go silently unverified.
    expect([...V2_PRODUCT_ROUTES].sort()).toEqual(ALL_NAV_ITEMS.map((i) => i.path).sort());
  });

  it("every Advanced-only route declares readiness.mode = advanced", () => {
    // A direct visit to an `advancedOnly` route is redirected to Home by
    // `useRouteValidityGate` once the stored preference adopts. A row that
    // forgot this would verify Home's DOM while believing it was on the editor.
    for (const item of ALL_NAV_ITEMS) {
      const row = rowForRoute(item.path);
      expect(row, item.path).toBeDefined();
      expect(row!.readiness.mode, `${item.path} readiness.mode`).toBe(
        item.advancedOnly ? "advanced" : "guided",
      );
    }
  });

  it("every row's route resolves to a real Next.js page on disk", () => {
    const webRoot = resolve(__dirname, "..", "..");
    for (const row of V2_SURFACE_MATRIX) {
      const segment = row.route === "/" ? "" : row.route.slice(1);
      const candidates = [
        join(webRoot, "app", "(app)", segment, "page.tsx"),
        join(webRoot, "app", segment, "page.tsx"),
      ];
      expect(
        candidates.some(existsSync),
        `${row.route} has no page.tsx at ${candidates.join(" or ")}`,
      ).toBe(true);
    }
  });
});

describe("prototypes", () => {
  it("every product row names a canonical prototype that exists", () => {
    for (const row of V2_SURFACE_MATRIX.filter((r) => r.kind === "product")) {
      expect(row.prototype, row.route).not.toBe(HARNESS_NO_PROTOTYPE);
      expect(existsSync(join(REPO_ROOT, row.prototype)), `${row.route} → ${row.prototype}`).toBe(
        true,
      );
    }
  });

  it("every harness row records that it has no product prototype", () => {
    for (const row of V2_SURFACE_MATRIX.filter((r) => r.kind === "harness")) {
      expect(row.prototype, row.route).toBe(HARNESS_NO_PROTOTYPE);
    }
  });

  it("names no prototype for a screen this epic deliberately excludes", () => {
    const named = V2_SURFACE_MATRIX.map((r) => r.prototype);
    for (const excluded of ["ScreenExport", "ScreenSchedule", "ScreenAppendixAI"]) {
      expect(named.filter((p) => p.includes(excluded))).toEqual([]);
    }
  });
});

describe("seed and readiness descriptors", () => {
  it("every row names a declared seed strategy", () => {
    for (const row of V2_SURFACE_MATRIX) {
      expect(V2_SEED_KEYS, row.route).toContain(row.seed);
    }
  });

  it("every declared seed strategy is actually used", () => {
    // A named strategy nobody selects is a descriptor that has never been run.
    const used = new Set(V2_SURFACE_MATRIX.map((r) => r.seed));
    for (const key of V2_SEED_KEYS) expect([...used], `seed "${key}" is unused`).toContain(key);
  });

  it("every readiness descriptor is complete", () => {
    for (const row of V2_SURFACE_MATRIX) {
      const { strategy, marker, mode, storeSeam } = row.readiness;
      expect(V2_READINESS_STRATEGIES, row.route).toContain(strategy);
      expect(marker.trim(), `${row.route} marker`).not.toBe("");
      expect(["guided", "advanced", null], `${row.route} mode`).toContain(mode);
      // The two are the same fact stated twice, so they must not disagree: only a
      // row inside the `(app)` group has a hydration gate, a mode policy and the
      // store seam at all.
      expect(storeSeam, `${row.route} storeSeam`).toBe(strategy === "app-shell");
      expect(mode !== null, `${row.route} mode presence`).toBe(strategy === "app-shell");
    }
  });

  it("a row that cannot reach the store seam seeds nothing", () => {
    for (const row of V2_SURFACE_MATRIX) {
      if (row.readiness.storeSeam) continue;
      expect(["empty", "harness-self-seeded"], `${row.route} seed`).toContain(row.seed);
    }
  });
});

describe("semantic checks", () => {
  it("every check declares at least a role or a radius", () => {
    for (const row of V2_SURFACE_MATRIX) {
      for (const check of row.semanticChecks) {
        expect(
          check.role !== undefined || check.radius !== undefined,
          `${row.route} → ${check.label} asserts nothing`,
        ).toBe(true);
        expect(check.selector.trim(), `${row.route} → ${check.label}`).not.toBe("");
        if (check.role) expect(V2_SURFACE_ROLES).toContain(check.role);
        if (check.radius) expect(V2_RADIUS_ROLES).toContain(check.radius);
      }
    }
  });

  it("labels are unique within a row, so an observation maps to one check", () => {
    for (const row of V2_SURFACE_MATRIX) {
      const labels = row.semanticChecks.map((c) => c.label);
      expect(new Set(labels).size, `${row.route} has duplicate check labels`).toBe(labels.length);
    }
  });

  it("every row declares at least one check", () => {
    for (const row of V2_SURFACE_MATRIX) {
      expect(row.semanticChecks.length, `${row.route} declares no semantic check`).toBeGreaterThan(
        0,
      );
    }
  });

  it("the foundation row proves every surface role that has a specimen", () => {
    const foundation = rowForRoute("/design-system")!;
    const roles = new Set(foundation.semanticChecks.map((c) => c.role).filter(Boolean));
    // `drawer` is the mobile navigation plane and belongs to R1's shell, so it
    // has no specimen on the reference page — every other role does.
    for (const role of V2_SURFACE_ROLES) {
      if (role === "drawer") continue;
      expect([...roles], `role "${role}" has no foundation specimen check`).toContain(role);
    }
  });

  it("the foundation row proves every radius role", () => {
    const foundation = rowForRoute("/design-system")!;
    const radii = new Set(foundation.semanticChecks.map((c) => c.radius).filter(Boolean));
    for (const role of V2_RADIUS_ROLES) {
      expect([...radii], `radius role "${role}" is unproven`).toContain(role);
    }
  });
});

describe("role and radius contracts", () => {
  it("covers every role exactly once", () => {
    expect(Object.keys(V2_ROLE_CONTRACT).sort()).toEqual([...V2_SURFACE_ROLES].sort());
  });

  it("never puts an outer shadow on a well or an inset one on a raised surface", () => {
    // DESIGN.md §4 rule 1, encoded rather than restated in prose.
    expect(V2_ROLE_CONTRACT.well.elevation).toBe("inset");
    expect(V2_ROLE_CONTRACT.raised.elevation).toBe("outer");
    expect(V2_ROLE_CONTRACT.band.elevation).toBe("none");
    expect(V2_ROLE_CONTRACT.zebra.elevation).toBe("none");
    expect(V2_ROLE_CONTRACT.page.elevation).toBe("none");
  });

  it("reserves --panel for bands and true insets, never for zebra", () => {
    expect(V2_ROLE_CONTRACT.band.tone).toBe("--panel");
    expect(V2_ROLE_CONTRACT.well.tone).toBe("--panel");
    expect(V2_ROLE_CONTRACT.zebra.tone).toBe("--panel-alt");
  });

  it("pins the absolute radius values — never multiplied by the 0.9 baseline", () => {
    expect(V2_RADIUS_CONTRACT).toEqual({
      card: "16px",
      control: "12px",
      chip: "9px",
      pill: "999px",
      square: "0px",
    });
  });
});

describe("static file ownership", () => {
  it("declares a pattern set for every owner", () => {
    expect(Object.keys(V2_STYLE_OWNER_FILES).sort()).toEqual([...V2_OWNERS].sort());
    for (const owner of V2_OWNERS) {
      expect(V2_STYLE_OWNER_FILES[owner].length, `${owner} owns no source`).toBeGreaterThan(0);
    }
  });

  it("repeats no pattern across owners", () => {
    const all = V2_OWNERS.flatMap((o) => V2_STYLE_OWNER_FILES[o]);
    const duplicates = all.filter((p, i) => all.indexOf(p) !== i);
    expect(duplicates, `patterns claimed by two owners: ${duplicates.join(", ")}`).toEqual([]);
  });
});

describe("immutability", () => {
  it("is frozen through rows, descriptors, checks and exceptions", () => {
    expect(Object.isFrozen(V2_SURFACE_MATRIX)).toBe(true);
    for (const row of V2_SURFACE_MATRIX) {
      expect(Object.isFrozen(row), row.route).toBe(true);
      expect(Object.isFrozen(row.readiness), row.route).toBe(true);
      expect(Object.isFrozen(row.semanticChecks), row.route).toBe(true);
      expect(Object.isFrozen(row.axeExceptions), row.route).toBe(true);
      for (const check of row.semanticChecks) expect(Object.isFrozen(check)).toBe(true);
    }
  });

  it("refuses an in-place mutation from a spec", () => {
    expect(() => {
      (V2_SURFACE_MATRIX[0] as { route: string }).route = "/hijacked";
    }).toThrow();
    expect(V2_SURFACE_MATRIX[0].route).toBe("/design-system");
  });
});

describe("selection is registration-time, never a skip", () => {
  // The contract is that a row is not REGISTERED unless its owner is selected.
  // A `test.skip` would produce the same green run while leaving a growing pile
  // of unverified routes visible only in the reporter's skip count.
  const files = [
    "v2-surface-matrix.ts",
    "v2-owner-selection.ts",
    "v2-seed.ts",
    "v2-readiness.ts",
    "v2-visual-audit.ts",
    "../v2-readiness.spec.ts",
    "../v2-visual-system.spec.ts",
    "../v2-visual-regression.spec.ts",
    "../../app/v2-style-contract.test.ts",
  ];

  it.each(files)("%s contains no skip, fixme or conditional-skip annotation", (file) => {
    const source = readFileSync(join(__dirname, file), "utf8");
    // Matched as a CALL, and never when preceded by a backtick, so these files'
    // own prose ABOUT not skipping does not trip the guard that enforces it.
    //
    // `runIf` is listed alongside `skipIf` deliberately: it is the inverse
    // spelling of the same behaviour — the block is still REGISTERED and still
    // reported as skipped. Out-of-scope work is filtered before registration, so
    // a reporter's skip count stays at zero and cannot quietly become a backlog.
    expect(source, `${file} uses a skip annotation`).not.toMatch(
      /(?:^|[^`\w.])(?:test|it|describe)(?:\.\w+)*\.(?:skip|fixme|todo)\s*\(|\b(?:skipIf|runIf)\s*\(/m,
    );
  });
});

describe("diagnostics", () => {
  it("the inventory string names every owner and every route", () => {
    const inventory = manifestInventory();
    for (const owner of V2_OWNERS) expect(inventory).toContain(owner);
    for (const row of V2_SURFACE_MATRIX) expect(inventory).toContain(row.route);
  });

  it("the selector vocabulary is the owners plus `all`", () => {
    expect([...V2_SELECTORS]).toEqual([...V2_OWNERS, "all"]);
  });
});
