import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// DR-5 boundary guard. The generic `EntityEditor` shell is retired — People and
// Shift Types are bespoke screens (`PeopleTable` / `ShiftTypeGrid`) over the shared
// `entity-editor/core`. This test keeps the shell from being resurrected: the module
// must stay deleted, and nothing in the source tree may import it. The `core`,
// `groups-section`, `transfer-list`, and `working-time-fields` modules are the kept,
// still-shared substrate and are deliberately NOT matched.

const ROOT = process.cwd();
const SELF = fileURLToPath(import.meta.url);
const SCAN_DIRS = ["app", "components", "lib"];
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/; // ts tsx js jsx mjs cjs mts cts

// A module specifier that resolves to the retired shell: the `entity-editor/entity-editor`
// path (aliased `@/…`, relative, or nested) or the in-directory `./entity-editor` sibling,
// with an optional JS/TS extension. Does NOT match `entity-editor/core` etc.
const SHELL_SPEC = String.raw`(?:(?:[^"'\s]*\/)?entity-editor\/entity-editor|\.\/entity-editor)(?:\.[cm]?[jt]sx?)?`;
// Matched after a static import / re-export (`from`), a side-effect or dynamic `import`,
// or a `require` — so `import x from`, `import "…"`, `import("…")`, `require("…")`, and
// `export … from "…"` are all caught, not only bare `from` imports.
const SHELL_IMPORT = new RegExp(
  String.raw`\b(?:from|import|require)\b\s*\(?\s*["']${SHELL_SPEC}["']`,
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

describe("EntityEditor retirement (DR-5)", () => {
  it("has deleted the generic shell module and its component test", () => {
    expect(existsSync(join(ROOT, "components/entity-editor/entity-editor.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, "components/entity-editor/entity-editor.test.tsx"))).toBe(false);
  });

  it("is imported by nothing in the source tree", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      const abs = join(ROOT, dir);
      if (!existsSync(abs)) continue;
      for (const file of walk(abs)) {
        if (file === SELF) continue; // this guard names the path in its own assertions
        if (SHELL_IMPORT.test(readFileSync(file, "utf8"))) {
          offenders.push(file.replace(`${ROOT}/`, ""));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
