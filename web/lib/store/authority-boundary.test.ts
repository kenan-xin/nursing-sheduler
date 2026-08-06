// The authority-boundary gate (T03F1 finding 7), replacing the source regex scan.
//
// WHY AN AST AND NOT A REGEX. The previous gate matched text: `from "@/lib/repository"`
// and `useScenarioStore.setState(`. Every one of those is trivially evadable, and not
// hypothetically — these are the shapes real code drifts into:
//
//     import { createScenarioRepository as mint } from "@/lib/repository";   // alias
//     import * as repo from '@/lib/repository';                              // namespace + quotes
//     export { commit } from "@/lib/repository";                            // re-export
//     const s = useScenarioStore; s["setState"]({ ... });                   // bracket access
//     const { setState } = useScenarioStore; setState({ ... });             // destructured
//
// The regex saw none of them. This walks the TypeScript AST instead, so the rule is
// about the MEANING of the code: which module a specifier resolves to, and whether a
// value that came from the projection is used to write.
//
// TypeScript is already a devDependency and the compiler API is stable, so there is
// no new tool in the build for this.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SOURCE_DIRS = ["app", "components", "lib", "e2e"];

/**
 * The ONE module that may bridge the durable repository and the live projection.
 * Everything else reaches durable state through the command bus.
 */
const ADAPTER = "lib/store/authority.ts";

/** Modules that legitimately construct or wire the adapter, plus its own tests. */
const REPOSITORY_ALLOWED = new Set([
  ADAPTER,
  "lib/store/spine.ts",
  "lib/store/ownership.ts",
  "lib/store/test-authority.ts",
  "lib/store/authority.test.ts",
  "lib/store/authority-fencing.test.ts",
  "lib/store/authority-boundary.test.ts",
  // Pins the database-name literal the Playwright helper duplicates.
  "e2e/support/v2-seed.test.ts",
]);

/** Modules that may publish into the scenario projection. */
const PROJECTION_WRITE_ALLOWED = new Set([
  ADAPTER,
  "lib/store/test-authority.ts",
  "lib/store/authority-boundary.test.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = SOURCE_DIRS.flatMap((dir) => walk(join(ROOT, dir))).map((file) =>
  relative(ROOT, file),
);

/**
 * Parse once per file and share across every rule below.
 *
 * Six rules over ~560 files is six full parses of the app if this is not cached,
 * which is slow enough to time out under a parallel suite — a gate that flakes under
 * load is a gate people learn to ignore.
 */
const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  const cached = parsed.get(file);
  if (cached) return cached;
  const source = ts.createSourceFile(
    file,
    readFileSync(join(ROOT, file), "utf8"),
    ts.ScriptTarget.ESNext,
    // Parent pointers, so a rule can ask what an identifier is being used FOR.
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  parsed.set(file, source);
  return source;
}

/** Every node in a file, depth-first. Cached alongside the parse. */
const walked = new Map<ts.SourceFile, ts.Node[]>();
function nodes(source: ts.SourceFile): ts.Node[] {
  const cached = walked.get(source);
  if (cached) return cached;
  const out: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  walked.set(source, out);
  return out;
}

/**
 * The module a specifier names, quote form irrelevant (the AST already carries the
 * decoded string, so `'...'`, `"..."` and a template all arrive identically).
 */
function moduleOf(node: ts.Node): string | null {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const specifier = node.moduleSpecifier;
    if (specifier && ts.isStringLiteralLike(specifier)) return specifier.text;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const first = node.arguments[0];
    if (first && ts.isStringLiteralLike(first)) return first.text;
  }
  return null;
}

/** Whether `specifier` resolves into the durable repository module graph. */
function isRepositoryModule(specifier: string, file: string): boolean {
  if (specifier === "@/lib/repository" || specifier.startsWith("@/lib/repository/")) return true;
  // Relative imports from inside `lib/repository` are internal, not a boundary
  // crossing; from anywhere else a relative path INTO it is the same violation.
  if (!specifier.startsWith(".")) return false;
  const resolved = join(file, "..", specifier).replace(/\\/g, "/");
  return resolved.startsWith("lib/repository/") || resolved === "lib/repository";
}

/** The property being accessed, whether written `a.b` or `a["b"]`. */
function accessedName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const argument = node.argumentExpression;
    if (ts.isStringLiteralLike(argument)) return argument.text;
  }
  return null;
}

// Parsing the whole app is real work even cached, and this suite runs alongside
// ~190 others. The allowance is for the SHARED first parse, not for a slow rule.
describe("authority boundary (AST)", { timeout: 60_000 }, () => {
  it("only the projection adapter imports the durable repository", () => {
    // Catches aliases, namespace imports, re-exports, dynamic `import()`, relative
    // paths and any quote form — the AST reports the resolved specifier, so the
    // spelling of the import is irrelevant.
    const offenders = FILES.filter(
      (file) => !REPOSITORY_ALLOWED.has(file) && !file.startsWith("lib/repository/"),
    ).filter((file) =>
      nodes(parse(file)).some((node) => {
        const specifier = moduleOf(node);
        return specifier !== null && isRepositoryModule(specifier, file);
      }),
    );

    expect(offenders).toEqual([]);
  });

  it("nothing outside the adapter writes the scenario projection", () => {
    // The rule is on the OPERATION, not on a spelling: any `setState`/`getState`-based
    // write reached through a value named after the scenario projection counts,
    // including `store["setState"](...)` and a destructured `const { setState } = ...`.
    const offenders: string[] = [];
    for (const file of FILES) {
      if (PROJECTION_WRITE_ALLOWED.has(file)) continue;
      const source = parse(file);
      const projectionNames = new Set<string>(["useScenarioStore", "scenarioStore"]);
      // Locals bound to the projection (`const scenario = useScenarioStore`).
      for (const node of nodes(source)) {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          ts.isIdentifier(node.initializer) &&
          projectionNames.has(node.initializer.text)
        ) {
          projectionNames.add(node.name.text);
        }
      }

      const violates = nodes(source).some((node) => {
        // `<projection>.setState(...)` / `<projection>["setState"](...)`
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          if (accessedName(node) !== "setState") return false;
          const target = node.expression;
          return ts.isIdentifier(target) && projectionNames.has(target.text);
        }
        // `const { setState } = <projection>` — the writer escapes by destructuring.
        if (
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer &&
          ts.isIdentifier(node.initializer) &&
          projectionNames.has(node.initializer.text)
        ) {
          return node.name.elements.some(
            (element) =>
              ts.isIdentifier(element.name) &&
              (element.propertyName ?? element.name).getText(source) === "setState",
          );
        }
        return false;
      });
      if (violates) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it("the retired mutator NAMES appear nowhere in real code", () => {
    // `mutateScenario` was the unrestricted "patch live state and let persist catch
    // up" action. Nothing replaces it under that name, so the identifier itself is
    // the rule — which makes a half-migrated call site fail here rather than at
    // review-reading speed. Checked as IDENTIFIERS, so a mention in prose is fine.
    const allowed = new Set([
      "lib/store/authority-boundary.test.ts",
      // A sanitizer fixture asserting a store-action-shaped FOREIGN key is dropped.
      "lib/store/persistence.test.ts",
    ]);
    const offenders = FILES.filter((file) => !allowed.has(file)).filter((file) => {
      const source = parse(file);
      return nodes(source).some(
        (node) =>
          (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === "mutateScenario",
      );
    });

    expect(offenders).toEqual([]);
  });

  it("zundo and the retired persist write-behind are gone", () => {
    const offenders = FILES.filter(
      (file) => file !== "lib/store/authority-boundary.test.ts",
    ).filter((file) => {
      const source = parse(file);
      return nodes(source).some((node) => {
        const specifier = moduleOf(node);
        if (specifier === "zundo") return true;
        // The projection is no longer a `persist`-wrapped store, in any spelling.
        if (specifier === "zustand/middleware") {
          return (
            ts.isImportDeclaration(node) &&
            node.importClause?.namedBindings !== undefined &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            node.importClause.namedBindings.elements.some(
              (element) => (element.propertyName ?? element.name).text === "persist",
            )
          );
        }
        return false;
      });
    });

    expect(offenders).toEqual([]);
  });

  it("nothing reaches a zundo temporal handle", () => {
    const offenders = FILES.filter(
      (file) => file !== "lib/store/authority-boundary.test.ts",
    ).filter((file) => {
      const source = parse(file);
      return nodes(source).some((node) => accessedName(node) === "temporal");
    });

    expect(offenders).toEqual([]);
  });

  it("the scenario projection module defines no setter", () => {
    // Belt and braces at the DEFINITION: if a setter were added back to the store's
    // state shape, the rules above would pass until something used it.
    const source = parse("lib/store/scenario-store.ts");
    const definesSetter = nodes(source).some(
      (node) =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "set",
    );

    expect(definesSetter).toBe(false);
  });

  it("the gate itself rejects every evasion shape", () => {
    // A gate nobody has tried to defeat is a gate nobody knows works. These are the
    // exact spellings the regex scan let through, checked against the same predicates
    // the rules above use.
    const evasions = [
      `import { createScenarioRepository as mint } from "@/lib/repository";`,
      `import * as repo from '@/lib/repository';`,
      `export { commit } from "@/lib/repository";`,
      `const later = await import("@/lib/repository/schema");`,
      `import { NurseSchedulerDb } from "../repository/schema";`,
    ];
    for (const [index, code] of evasions.entries()) {
      const source = ts.createSourceFile(
        `lib/store/evasion-${index}.ts`,
        code,
        ts.ScriptTarget.ESNext,
        true,
      );
      const caught = nodes(source).some((node) => {
        const specifier = moduleOf(node);
        return specifier !== null && isRepositoryModule(specifier, `lib/store/evasion-${index}.ts`);
      });
      expect(caught, `import evasion not caught: ${code}`).toBe(true);
    }

    const writeEvasions = [
      `const s = useScenarioStore; s["setState"]({});`,
      `useScenarioStore.setState({});`,
      `const { setState } = useScenarioStore; setState({});`,
    ];
    for (const [index, code] of writeEvasions.entries()) {
      const source = ts.createSourceFile(`probe-${index}.ts`, code, ts.ScriptTarget.ESNext, true);
      const projectionNames = new Set<string>(["useScenarioStore"]);
      for (const node of nodes(source)) {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          ts.isIdentifier(node.initializer) &&
          projectionNames.has(node.initializer.text)
        ) {
          projectionNames.add(node.name.text);
        }
      }
      const caught = nodes(source).some((node) => {
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          return (
            accessedName(node) === "setState" &&
            ts.isIdentifier(node.expression) &&
            projectionNames.has(node.expression.text)
          );
        }
        if (
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer &&
          ts.isIdentifier(node.initializer) &&
          projectionNames.has(node.initializer.text)
        ) {
          return node.name.elements.some(
            (element) => (element.propertyName ?? element.name).getText(source) === "setState",
          );
        }
        return false;
      });
      expect(caught, `projection-write evasion not caught: ${code}`).toBe(true);
    }
  });
});
