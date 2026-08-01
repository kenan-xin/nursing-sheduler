import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// The className boundary for the surface authority.
//
// `surface.tsx` types the level/geometry tuples and the native <div> contract,
// but TypeScript cannot see INSIDE a string: nothing stops a consumer writing
// <Surface level="well" className="bg-surface rounded-card"> and silently
// defeating the recipe it just asked for. This is that half of the contract.
//
// It is built on a real TypeScript Program and TypeChecker, and every authority
// is matched by SYMBOL rather than by spelling. That is the whole point: a guard
// that matches the text "Surface" is defeated by `import { Surface as Box }`, by
// `import * as UI`, by a re-export, or by `const sv = surfaceVariants`. Symbol
// identity follows all of those to the same declaration.
//
// ENFORCEMENT MODEL: an explicit ALLOWLIST, and fail-closed.
//   A consumer's className may contain LAYOUT, POSITION, OVERFLOW and SIZING
//   utilities and nothing else, matched as exact utility FAMILIES with validated
//   values -- never by trusting a broad string prefix, which is how
//   `box-decoration-clone` once rode in behind `box-`. Arbitrary values and
//   arbitrary properties are rejected everywhere, including on allowed families;
//   a width the overlays genuinely need is expressed as a named recipe variant
//   instead. Anything the analyzer cannot PROVE is a failure, not a pass.
//
// FAIL-CLOSED SPECIFICALLY MEANS
//   • only an immutable `const` binding with a resolvable initializer is
//     followed; `let`/`var`, reassignment and any unproven binding fail opaque;
//   • wrapper forwarding is accepted only when the checker proves the actual
//     caller-facing prop name, and every JSX call site is then checked
//     transitively; a default initializer is inspected too; a differently named
//     prop is followed by its real name, not assumed to be `className`;
//   • a wrapper or the recipe referenced as a VALUE fails opaque, because its
//     call sites cannot then be enumerated;
//   • every recipe-option form is inspected: multiple arguments, spreads,
//     shorthand, static computed keys, and imported/local option objects.
//
// SCOPE: source files are derived from the repository tsconfig program, not from
// a directory convention, so production code outside app/ and components/ (e.g.
// lib/) is covered. Only declaration files, vendor code, generated build output
// and test/spec sources are excluded -- the last because the adversarial
// fixtures below deliberately contain violating class strings.
// ---------------------------------------------------------------------------

const webRoot = resolve(__dirname, "..", "..");

// --- the allowlist -------------------------------------------------------

/** Numeric spacing steps, fractions and the `px` step. */
const NUMERIC = /^\d+(?:\.\d+)?$/;
const FRACTION = /^\d+\/\d+$/;

type Family = { values: ReadonlySet<string>; numeric?: boolean; fraction?: boolean };

const set = (...values: string[]) => new Set(values);

/**
 * Utilities with no value slot. Each is layout, position or overflow. Note what
 * is ABSENT: `visible`, `invisible` and `collapse` are the visibility family and
 * are visual state, and `box-decoration-*` is a fragmentation/paint utility.
 */
const EXACT = set(
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "block",
  "inline-block",
  "inline",
  "contents",
  "flow-root",
  "list-item",
  "hidden",
  "table",
  "inline-table",
  "table-cell",
  "table-row",
  "table-column",
  "table-caption",
  "table-footer-group",
  "table-header-group",
  "table-row-group",
  "table-auto",
  "table-fixed",
  "border-collapse",
  "border-separate",
  "static",
  "fixed",
  "absolute",
  "relative",
  "sticky",
  "isolate",
  "isolation-auto",
  "container",
  "sr-only",
  "not-sr-only",
  "flex-row",
  "flex-row-reverse",
  "flex-col",
  "flex-col-reverse",
  "flex-wrap",
  "flex-wrap-reverse",
  "flex-nowrap",
  "grow",
  "shrink",
);

/** Families whose value slot is validated, so a prefix cannot widen the contract. */
const FAMILIES: Record<string, Family> = {
  w: {
    values: set("full", "auto", "fit", "min", "max", "screen", "px", "dvw", "svw", "lvw"),
    numeric: true,
    fraction: true,
  },
  h: {
    values: set("full", "auto", "fit", "min", "max", "screen", "px", "dvh", "svh", "lvh"),
    numeric: true,
    fraction: true,
  },
  "min-w": { values: set("full", "fit", "min", "max", "screen", "px", "0"), numeric: true },
  "max-w": {
    values: set(
      "full",
      "fit",
      "min",
      "max",
      "screen",
      "px",
      "none",
      "prose",
      "xs",
      "sm",
      "md",
      "lg",
      "xl",
      "2xl",
      "3xl",
      "4xl",
      "5xl",
      "6xl",
      "7xl",
    ),
    numeric: true,
  },
  "min-h": {
    values: set("full", "fit", "min", "max", "screen", "px", "0", "dvh", "svh", "lvh", "touch"),
    numeric: true,
  },
  "max-h": { values: set("full", "fit", "min", "max", "screen", "px", "none"), numeric: true },
  size: {
    values: set(
      "full",
      "auto",
      "fit",
      "min",
      "max",
      "px",
      "control",
      "control-sm",
      "control-lg",
      "touch",
    ),
    numeric: true,
    fraction: true,
  },
  aspect: { values: set("auto", "square", "video"), fraction: true },
  basis: { values: set("full", "auto", "px"), numeric: true, fraction: true },
  flex: { values: set("1", "auto", "initial", "none"), numeric: true },
  grow: { values: set("0"), numeric: true },
  shrink: { values: set("0"), numeric: true },
  order: { values: set("first", "last", "none"), numeric: true },
  "grid-cols": { values: set("none", "subgrid"), numeric: true },
  "grid-rows": { values: set("none", "subgrid"), numeric: true },
  "grid-flow": { values: set("row", "col", "dense", "row-dense", "col-dense"), numeric: false },
  "auto-cols": { values: set("auto", "min", "max", "fr") },
  "auto-rows": { values: set("auto", "min", "max", "fr") },
  col: { values: set("auto", "span-full"), numeric: false },
  row: { values: set("auto", "span-full"), numeric: false },
  gap: { values: set("px"), numeric: true },
  "gap-x": { values: set("px"), numeric: true },
  "gap-y": { values: set("px"), numeric: true },
  justify: {
    values: set(
      "start",
      "end",
      "center",
      "between",
      "around",
      "evenly",
      "stretch",
      "normal",
      "items-start",
      "items-end",
      "items-center",
      "items-stretch",
      "self-start",
      "self-end",
      "self-center",
      "self-stretch",
      "self-auto",
    ),
  },
  items: { values: set("start", "end", "center", "baseline", "stretch") },
  self: { values: set("auto", "start", "end", "center", "stretch", "baseline") },
  content: {
    values: set(
      "normal",
      "center",
      "start",
      "end",
      "between",
      "around",
      "evenly",
      "baseline",
      "stretch",
    ),
  },
  place: {
    values: set(
      "content-start",
      "content-end",
      "content-center",
      "content-between",
      "content-around",
      "content-evenly",
      "content-baseline",
      "content-stretch",
      "items-start",
      "items-end",
      "items-center",
      "items-baseline",
      "items-stretch",
      "self-auto",
      "self-start",
      "self-end",
      "self-center",
      "self-stretch",
    ),
  },
  p: { values: set("px"), numeric: true },
  px: { values: set("px"), numeric: true },
  py: { values: set("px"), numeric: true },
  pt: { values: set("px"), numeric: true },
  pr: { values: set("px"), numeric: true },
  pb: { values: set("px"), numeric: true },
  pl: { values: set("px"), numeric: true },
  ps: { values: set("px"), numeric: true },
  pe: { values: set("px"), numeric: true },
  m: { values: set("px", "auto"), numeric: true },
  mx: { values: set("px", "auto"), numeric: true },
  my: { values: set("px", "auto"), numeric: true },
  mt: { values: set("px", "auto"), numeric: true },
  mr: { values: set("px", "auto"), numeric: true },
  mb: { values: set("px", "auto"), numeric: true },
  ml: { values: set("px", "auto"), numeric: true },
  ms: { values: set("px", "auto"), numeric: true },
  me: { values: set("px", "auto"), numeric: true },
  "space-x": { values: set("px", "reverse"), numeric: true },
  "space-y": { values: set("px", "reverse"), numeric: true },
  inset: { values: set("auto", "full", "px"), numeric: true, fraction: true },
  "inset-x": { values: set("auto", "full", "px"), numeric: true, fraction: true },
  "inset-y": { values: set("auto", "full", "px"), numeric: true, fraction: true },
  top: { values: set("auto", "full", "px"), numeric: true, fraction: true },
  right: { values: set("auto", "full", "px"), numeric: true, fraction: true },
  bottom: { values: set("auto", "full", "px"), numeric: true, fraction: true },
  left: { values: set("auto", "full", "px"), numeric: true, fraction: true },
  start: { values: set("auto", "full", "px"), numeric: true, fraction: true },
  end: { values: set("auto", "full", "px"), numeric: true, fraction: true },
  z: { values: set("auto"), numeric: true },
  translate: { values: set("full", "px"), numeric: true, fraction: true },
  "translate-x": { values: set("full", "px"), numeric: true, fraction: true },
  "translate-y": { values: set("full", "px"), numeric: true, fraction: true },
  overflow: { values: set("auto", "hidden", "clip", "visible", "scroll") },
  "overflow-x": { values: set("auto", "hidden", "clip", "visible", "scroll") },
  "overflow-y": { values: set("auto", "hidden", "clip", "visible", "scroll") },
  overscroll: { values: set("auto", "contain", "none") },
  "overscroll-x": { values: set("auto", "contain", "none") },
  "overscroll-y": { values: set("auto", "contain", "none") },
  columns: {
    values: set(
      "auto",
      "3xs",
      "2xs",
      "xs",
      "sm",
      "md",
      "lg",
      "xl",
      "2xl",
      "3xl",
      "4xl",
      "5xl",
      "6xl",
      "7xl",
    ),
    numeric: true,
  },
  float: { values: set("start", "end", "right", "left", "none") },
  clear: { values: set("start", "end", "right", "left", "both", "none") },
  object: {
    values: set(
      "contain",
      "cover",
      "fill",
      "none",
      "scale-down",
      "bottom",
      "center",
      "left",
      "left-bottom",
      "left-top",
      "right",
      "right-bottom",
      "right-top",
      "top",
    ),
  },
  // `box-border` / `box-content` ONLY. `box-decoration-*` is paint, not layout.
  box: { values: set("border", "content") },
  "border-spacing": { values: set("px"), numeric: true },
};

export type ViolationReason = "not-layout" | "arbitrary";

export interface Violation {
  file: string;
  line: number;
  site: string;
  token: string;
  reason: ViolationReason;
}

export interface OpaqueSite {
  file: string;
  line: number;
  site: string;
  expression: string;
  reason: string;
}

/**
 * An illegal (role, emphasis) request — the OTHER half of the contract.
 *
 * The className allowlist governs what a consumer may ADD to a surface. This
 * governs what it may ASK the recipe for. `emphasis` describes the edge of a
 * recessed row, so `SurfaceVariantProps` makes it legal only on a `well` and
 * makes every other tuple unrepresentable in TypeScript. A caller can still
 * reach the recipe through `as any`, an untyped re-export, or a JS boundary,
 * so the same rule is re-checked here over the real program.
 */
export interface TupleViolation {
  file: string;
  line: number;
  site: string;
  tuple: string;
  reason: string;
}

/**
 * Splits a class into its variant chain and base utility, ignoring any ":"
 * inside [...] or (...) so `data-[open]:animate-in` is not split on its inner
 * colon. Brackets are rejected outright below, but the split must still be
 * correct in order to REPORT the right token.
 */
export function splitVariants(token: string): { variants: string[]; base: string } {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of token) {
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return { variants: parts.slice(0, -1), base: parts[parts.length - 1] };
}

/** Strips v3 leading and v4 trailing `!important`, and a leading negative sign. */
export function normalizeBase(base: string): string {
  let out = base.trim();
  if (out.startsWith("!")) out = out.slice(1);
  if (out.endsWith("!")) out = out.slice(0, -1);
  if (out.startsWith("-")) out = out.slice(1);
  return out;
}

/** `null` when the token is layout-only; otherwise why it is rejected. */
export function classifyToken(token: string): ViolationReason | null {
  const { base } = splitVariants(token);
  const bare = normalizeBase(base);
  if (!bare) return null;

  // No arbitrary value or property survives, on any family. The overlays' one
  // genuine arbitrary width lives in the recipe as a named `width` variant.
  if (bare.includes("[") || bare.includes("]") || bare.includes("(") || bare.includes(")")) {
    return "arbitrary";
  }

  if (EXACT.has(bare)) return null;

  // Longest family prefix first, so `min-w` beats `m` and `space-x` beats `space`.
  const names = Object.keys(FAMILIES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (!bare.startsWith(name + "-")) continue;
    const family = FAMILIES[name];
    const value = bare.slice(name.length + 1);
    if (family.values.has(value)) return null;
    if (family.numeric && NUMERIC.test(value)) return null;
    if (family.fraction && FRACTION.test(value)) return null;
    if ((name === "col" || name === "row") && /^(?:span|start|end)-\d+$/.test(value)) return null;
    return "not-layout";
  }
  return "not-layout";
}

// --- program construction ------------------------------------------------

export interface Analysis {
  violations: Violation[];
  opaque: OpaqueSite[];
  /** className expressions inspected. A bypass that drives this to 0 is a bug. */
  sites: number;
  /** Wrapper components whose callers were enumerated, as `Name.prop`. */
  wrappers: string[];
  /** True once both authority symbols were located. */
  authoritiesFound: boolean;
  /**
   * Reference closure. Every reference to a tracked authority, wrapper, recipe,
   * combiner, proven alias or recipe result is put in exactly one bucket. A
   * non-zero `unclassified` means the guard silently ignored an execution shape,
   * which is the failure mode this accounting exists to make impossible.
   */
  references: {
    discovered: number;
    sanctioned: number;
    violated: number;
    opaque: number;
    unclassified: number;
  };
  /**
   * The discovery FRONTIER, as distinct from the reference equation. The
   * equation can balance perfectly over an index that never saw a reference at
   * all, which is exactly how namespace element access, dynamic-import/require
   * acquisition and recipe-result shorthand stayed invisible. These counters
   * make the acquisition and transport paths themselves observable.
   */
  frontier: {
    /** import()/require() calls whose target module exports a tracked symbol. */
    moduleAcquisitions: number;
    moduleAcquisitionsOpaque: number;
    /** Computed member access on a namespace that holds a tracked export. */
    dynamicMemberAccess: number;
    /** References to a stored recipe result, and how many were refused. */
    recipeResultRefs: number;
    recipeResultOpaque: number;
  };
  /**
   * Recipe/Surface call sites that requested an `emphasis`, and the ones whose
   * (role, emphasis) tuple is illegal or unprovable. `checked` is the vacuity
   * guard: a change that stops finding emphasis sites at all must fail loudly
   * rather than report a clean empty list.
   */
  tuples: {
    checked: number;
    illegal: TupleViolation[];
  };
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  allowJs: true,
  noLib: true,
  noResolve: false,
  skipLibCheck: true,
  paths: { "@/*": ["./*"] },
};

/** An in-memory program, used by the adversarial fixtures. */
export function createFixtureProgram(files: Record<string, string>): ts.Program {
  const sources = new Map<string, string>();
  for (const [name, text] of Object.entries(files)) sources.set("/" + name, text);

  const host: ts.CompilerHost = {
    fileExists: (f) => sources.has(f),
    readFile: (f) => sources.get(f),
    getSourceFile: (f) => {
      const text = sources.get(f);
      return text === undefined
        ? undefined
        : ts.createSourceFile(f, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    },
    getDefaultLibFileName: () => "/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    resolveModuleNames: (names, containing) =>
      names.map((name) => {
        let base: string;
        if (name.startsWith("@/")) base = "/" + name.slice(2);
        else if (name.startsWith(".")) base = resolve(dirname(containing), name);
        else return undefined;
        for (const candidate of [base, base + ".ts", base + ".tsx", base + "/index.ts"]) {
          if (sources.has(candidate)) return { resolvedFileName: candidate, extension: ".tsx" };
        }
        return undefined;
      }),
  };

  return ts.createProgram({
    rootNames: [...sources.keys()],
    options: { ...COMPILER_OPTIONS, baseUrl: "/" },
    host,
  });
}

/**
 * The repository program, derived from tsconfig rather than from a directory
 * convention. Root files are the production sources; everything they import is
 * pulled in by the compiler, so a consumer anywhere in the graph is analyzed.
 */
export function createRepoProgram(): { program: ts.Program; roots: string[] } {
  const configPath = join(webRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, webRoot);

  const roots = parsed.fileNames.filter((file) => {
    const rel = file.slice(webRoot.length + 1);
    if (file.endsWith(".d.ts")) return false; // declaration/vendor
    if (rel.includes("node_modules/")) return false; // vendor
    if (rel.startsWith(".next/")) return false; // generated build output
    if (/\.(test|spec)\.tsx?$/.test(rel)) return false; // test/spec sources
    if (rel.startsWith("e2e/")) return false; // browser test sources
    return true;
  });

  return {
    program: ts.createProgram({
      rootNames: roots,
      options: { ...parsed.options, noEmit: true, skipLibCheck: true },
    }),
    roots,
  };
}

// --- analysis ------------------------------------------------------------

// --- analysis ------------------------------------------------------------
//
// The invariant is REFERENCE CLOSURE, not a growing list of recognized shapes.
// Every reference to a tracked symbol -- Surface, a registered wrapper, the
// recipe, a combiner, a proven immutable alias of any of those, or a stored
// recipe result -- is put in exactly one bucket: sanctioned (and fully
// analyzed), violated, or opaque with an exact site. Nothing is silently
// ignored, and the accounting asserts the three buckets sum to the number
// discovered.
//
// The sanctioned grammar is deliberately small: direct JSX use of an authority
// or wrapper, direct invocation of the recipe or a combiner, an immutable
// `const` alias whose own references are themselves closed, a recipe result
// passed straight into a combiner call, and import/export plumbing. Everything
// else -- `.call`/`.apply`/`.bind`, `React.createElement`, storage in an object
// or array, a conditional or logical alias, an HOC result, a getter, an
// argument to an unknown function -- fails opaque. That is a deliberate refusal
// to model JavaScript execution: the guard rejects rather than guesses, and the
// authoring API it supports is the one the live code actually uses.

type TrackedKind = "surface" | "wrapper" | "recipe" | "combiner" | "recipe-result";

export function analyzeProgram(program: ts.Program, rootFilter?: (f: string) => boolean): Analysis {
  const checker = program.getTypeChecker();
  const violations: Violation[] = [];
  const opaque: OpaqueSite[] = [];
  let sites = 0;

  const analyzed = program
    .getSourceFiles()
    .filter((f) => !f.isDeclarationFile && !f.fileName.includes("node_modules"))
    .filter((f) => (rootFilter ? rootFilter(f.fileName) : true));

  const canonical = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
    if (!symbol) return undefined;
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const symbolAt = (node: ts.Node): ts.Symbol | undefined =>
    canonical(checker.getSymbolAtLocation(node));

  function isConstBinding(declaration: ts.VariableDeclaration): boolean {
    const list = declaration.parent;
    return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
  }

  const lineOf = (file: ts.SourceFile, node: ts.Node) =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const rel = (file: ts.SourceFile) =>
    file.fileName.startsWith(webRoot) ? file.fileName.slice(webRoot.length + 1) : file.fileName;

  // --- locate the authorities by symbol ---
  const moduleExport = (suffix: string, name: string): ts.Symbol | undefined => {
    const file = analyzed.find((f) => f.fileName.endsWith(suffix));
    const moduleSymbol = file ? checker.getSymbolAtLocation(file) : undefined;
    if (!moduleSymbol) return undefined;
    return canonical(checker.getExportsOfModule(moduleSymbol).find((e) => e.name === name));
  };

  const surfaceSymbol = moduleExport("components/ui/surface.tsx", "Surface");
  const recipeSymbol = moduleExport("components/ui/surface.tsx", "surfaceVariants");

  const tracked = new Map<ts.Symbol, TrackedKind>();
  if (surfaceSymbol) tracked.set(surfaceSymbol, "surface");
  if (recipeSymbol) tracked.set(recipeSymbol, "recipe");
  const cnSymbol = moduleExport("lib/utils.ts", "cn");
  if (cnSymbol) tracked.set(cnSymbol, "combiner");
  const utilFile = analyzed.find((f) => f.fileName.endsWith("lib/utils.ts"));
  utilFile?.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !node.importClause?.namedBindings) return;
    const bindings = node.importClause.namedBindings;
    if (!ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      if (["clsx", "twMerge"].includes(element.name.text)) {
        const symbol = symbolAt(element.name);
        if (symbol) tracked.set(symbol, "combiner");
      }
    }
  });

  // --- index every reference, by the symbol it actually binds ---
  //
  // Discovery must start from the executable AST shapes that can ACQUIRE or
  // TRANSPORT an authority, not only from nodes whose symbol already resolves to
  // a tracked one. Three shapes are indexed beyond plain identifiers and property
  // access, each of which previously entered the program without being seen:
  //   • statically named element access (`UI["Surface"]`), resolved through the
  //     object's type to the same export symbol as `UI.Surface`;
  //   • object shorthand (`{ s }`), whose name node carries a PROPERTY symbol --
  //     the transported value only appears through
  //     `getShorthandAssignmentValueSymbol`;
  //   • module acquisition via dynamic `import()` / CommonJS `require()`, handled
  //     in the frontier scan below.
  interface Ref {
    file: ts.SourceFile;
    node: ts.Node;
    symbol: ts.Symbol;
  }
  const refs: Ref[] = [];
  const refsBySymbol = new Map<ts.Symbol, Ref[]>();
  const addRef = (file: ts.SourceFile, node: ts.Node, symbol: ts.Symbol) => {
    const ref: Ref = { file, node, symbol };
    refs.push(ref);
    const list = refsBySymbol.get(symbol) ?? [];
    list.push(ref);
    refsBySymbol.set(symbol, list);
  };

  /** `obj["Name"]` -> the property symbol, so a namespace member resolves. */
  const staticElementAccessSymbol = (node: ts.ElementAccessExpression): ts.Symbol | undefined => {
    const argument = node.argumentExpression;
    if (!argument || !ts.isStringLiteral(argument)) return undefined;
    const objectType = checker.getTypeAtLocation(node.expression);
    return canonical(objectType.getProperty(argument.text));
  };

  for (const file of analyzed) {
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const symbol = symbolAt(node.name);
        if (symbol) addRef(file, node, symbol);
      } else if (ts.isElementAccessExpression(node)) {
        const symbol = staticElementAccessSymbol(node);
        if (symbol) addRef(file, node, symbol);
      } else if (ts.isShorthandPropertyAssignment(node)) {
        const symbol = canonical(checker.getShorthandAssignmentValueSymbol(node));
        if (symbol) addRef(file, node.name, symbol);
      } else if (
        ts.isIdentifier(node) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
        !(ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) &&
        !(ts.isJsxAttribute(node.parent) && node.parent.name === node)
      ) {
        const symbol = symbolAt(node);
        if (symbol) addRef(file, node, symbol);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  const kindOfCallee = (expression: ts.Expression): TrackedKind | undefined => {
    if (ts.isPropertyAccessExpression(expression)) {
      // `f.call(...)` etc. is never a sanctioned invocation of a tracked symbol.
      const symbol = symbolAt(expression.name);
      return symbol ? tracked.get(symbol) : undefined;
    }
    const symbol = symbolAt(expression);
    return symbol ? tracked.get(symbol) : undefined;
  };

  // --- grow the tracked set: immutable aliases and stored recipe results ---
  const growTracked = (): boolean => {
    let grew = false;
    for (const file of analyzed) {
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const own = symbolAt(node.name);
          if (own && !tracked.has(own) && isConstBinding(node)) {
            const init = node.initializer;
            if (
              ts.isIdentifier(init) ||
              ts.isPropertyAccessExpression(init) ||
              (ts.isElementAccessExpression(init) &&
                !!init.argumentExpression &&
                ts.isStringLiteral(init.argumentExpression))
            ) {
              const source = ts.isElementAccessExpression(init)
                ? canonical(
                    checker
                      .getTypeAtLocation(init.expression)
                      .getProperty((init.argumentExpression as ts.StringLiteral).text),
                  )
                : symbolAt(ts.isIdentifier(init) ? init : init.name);
              const kind = source ? tracked.get(source) : undefined;
              if (kind) {
                tracked.set(own, kind);
                grew = true;
              }
            } else if (ts.isCallExpression(init) && kindOfCallee(init.expression) === "recipe") {
              tracked.set(own, "recipe-result");
              grew = true;
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    return grew;
  };
  for (let i = 0; i < 10 && growTracked(); i++) void 0;

  // --- class-expression resolution (unchanged semantics, fail-closed) ---
  interface Ctx {
    file: ts.SourceFile;
    site: string;
    seen: Set<ts.Node>;
  }

  const wrappers = new Map<ts.Symbol, Set<string>>();

  const markOpaque = (ctx: Ctx, node: ts.Node, reason: string) => {
    const file = node.getSourceFile() ?? ctx.file;
    opaque.push({
      file: rel(file),
      line: lineOf(file, node),
      site: ctx.site,
      expression: node.getText(file).replace(/\s+/g, " ").slice(0, 80),
      reason,
    });
  };

  const pushTokens = (ctx: Ctx, text: string, at: ts.Node) => {
    const file = at.getSourceFile() ?? ctx.file;
    for (const token of text.split(/\s+/).filter(Boolean)) {
      const reason = classifyToken(token);
      if (reason) {
        violations.push({ file: rel(file), line: lineOf(file, at), site: ctx.site, token, reason });
      }
    }
  };

  /** True only for a deeply immutable, non-accessor options object. */
  const optionsProven = (symbol: ts.Symbol, seen = new Set<ts.Symbol>()): boolean => {
    if (seen.has(symbol)) return false;
    seen.add(symbol);
    const declaration = symbol.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !isConstBinding(declaration) ||
      !declaration.initializer ||
      !ts.isObjectLiteralExpression(declaration.initializer)
    ) {
      return false;
    }
    if (!literalProven(declaration.initializer, seen)) return false;
    // Every reference must be a read in a sanctioned options position; anything
    // else (property or index assignment, destructuring, escape into a call,
    // closure capture) leaves the value unprovable at the use site.
    for (const ref of refsBySymbol.get(symbol) ?? []) {
      if (ref.node === declaration.name) continue;
      const parent = ref.node.parent;
      const sanctioned =
        (ts.isSpreadAssignment(parent) && parent.expression === ref.node) ||
        (ts.isCallExpression(parent) &&
          parent.arguments.includes(ref.node as ts.Expression) &&
          kindOfCallee(parent.expression) === "recipe");
      if (!sanctioned) return false;
    }
    return true;
  };

  const literalProven = (literal: ts.ObjectLiteralExpression, seen: Set<ts.Symbol>): boolean => {
    for (const property of literal.properties) {
      if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
        return false;
      }
      if (ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name)) {
        if (!ts.isStringLiteral(property.name.expression)) return false;
      }
      if (ts.isSpreadAssignment(property)) {
        const inner = property.expression;
        if (ts.isObjectLiteralExpression(inner)) {
          if (!literalProven(inner, seen)) return false;
        } else if (ts.isIdentifier(inner)) {
          const symbol = symbolAt(inner);
          if (!symbol || !optionsProven(symbol, seen)) return false;
        } else return false;
      }
    }
    return true;
  };

  const collect = (ctx: Ctx, node: ts.Node): void => {
    if (ctx.seen.has(node)) return;
    ctx.seen.add(node);
    const owner = node.getSourceFile() ?? ctx.file;
    const local: Ctx = { ...ctx, file: owner };

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      pushTokens(local, node.text, node);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      pushTokens(local, node.head.text, node);
      for (const span of node.templateSpans) {
        collect(local, span.expression);
        pushTokens(local, span.literal.text, span.literal);
      }
      return;
    }
    if (ts.isJsxExpression(node)) {
      if (node.expression) collect(local, node.expression);
      else markOpaque(local, node, "empty className expression");
      return;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      collect(local, node.expression);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      collect(local, node.whenTrue);
      collect(local, node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      collect(local, node.left);
      collect(local, node.right);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        collect(local, ts.isSpreadElement(element) ? element.expression : element);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          const key = property.name;
          if (ts.isIdentifier(key) || ts.isStringLiteral(key)) pushTokens(local, key.text, key);
          else if (ts.isComputedPropertyName(key) && ts.isStringLiteral(key.expression)) {
            pushTokens(local, key.expression.text, key);
          } else markOpaque(local, key, "dynamic computed key in a class list");
        } else if (ts.isShorthandPropertyAssignment(property)) {
          pushTokens(local, property.name.text, property);
        } else {
          markOpaque(local, property, "spread inside a class object literal");
        }
      }
      return;
    }
    if (ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.NullKeyword) return;
    if (
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      (ts.isIdentifier(node) && node.text === "undefined")
    ) {
      return;
    }

    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const reference = ts.isIdentifier(node) ? node : node.name;
      const symbol = symbolAt(reference);
      if (!symbol) {
        markOpaque(local, node, "unresolved reference '" + reference.getText(owner) + "'");
        return;
      }
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];

      if (declaration && ts.isBindingElement(declaration)) {
        const pattern = declaration.parent;
        const parameter = pattern.parent;
        if (ts.isObjectBindingPattern(pattern) && ts.isParameter(parameter)) {
          if (declaration.dotDotDotToken) {
            markOpaque(local, node, "a rest binding cannot be proven to be a class source");
            return;
          }
          const callerName = (declaration.propertyName ?? declaration.name).getText(
            declaration.getSourceFile(),
          );
          const component = componentSymbolOf(parameter);
          if (!component) {
            markOpaque(local, node, "className forwarded from an unnamed component");
            return;
          }
          if (declaration.initializer) collect(local, declaration.initializer);
          const props = wrappers.get(component) ?? new Set<string>();
          props.add(callerName);
          wrappers.set(component, props);
          tracked.set(component, "wrapper");
          return;
        }
        markOpaque(local, node, "destructured binding that is not a component prop");
        return;
      }
      if (declaration && ts.isParameter(declaration)) {
        markOpaque(local, node, "whole-props parameter used as a class source");
        return;
      }
      if (declaration && ts.isVariableDeclaration(declaration)) {
        if (!isConstBinding(declaration)) {
          markOpaque(local, node, "mutable binding — its value at use is not proven");
          return;
        }
        if (!declaration.initializer) {
          markOpaque(local, node, "const without a resolvable initializer");
          return;
        }
        collect({ ...local, file: declaration.getSourceFile() }, declaration.initializer);
        return;
      }
      markOpaque(local, node, "unresolvable class source '" + reference.getText(owner) + "'");
      return;
    }

    if (ts.isCallExpression(node)) {
      const kind = kindOfCallee(node.expression);
      // `.call` / `.apply` / `.bind` never reach here as a sanctioned callee.
      if (kind === "combiner" && !ts.isPropertyAccessExpression(node.expression)) {
        for (const argument of node.arguments) collect(local, argument);
        return;
      }
      if (kind === "recipe" && !ts.isPropertyAccessExpression(node.expression)) {
        for (const argument of node.arguments) collectRecipeOptions(local, argument);
        return;
      }
      markOpaque(local, node, "unmodelled call in a class source");
      return;
    }
    markOpaque(local, node, "unresolved " + ts.SyntaxKind[node.kind]);
  };

  const collectRecipeOptions = (ctx: Ctx, node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
          markOpaque(ctx, property, "accessor property in recipe options");
          continue;
        }
        if (ts.isPropertyAssignment(property)) {
          const key = property.name;
          let named: string | null = null;
          if (ts.isIdentifier(key) || ts.isStringLiteral(key)) named = key.text;
          else if (ts.isComputedPropertyName(key) && ts.isStringLiteral(key.expression)) {
            named = key.expression.text;
          } else {
            markOpaque(ctx, key, "dynamic computed key in recipe options");
            continue;
          }
          if (named === "className" || named === "class") collect(ctx, property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          if (property.name.text === "className" || property.name.text === "class") {
            const valueSymbol = canonical(checker.getShorthandAssignmentValueSymbol(property));
            const declaration = valueSymbol?.valueDeclaration;
            if (
              declaration &&
              ts.isVariableDeclaration(declaration) &&
              isConstBinding(declaration) &&
              declaration.initializer
            ) {
              collect({ ...ctx, file: declaration.getSourceFile() }, declaration.initializer);
            } else {
              markOpaque(ctx, property, "shorthand className whose value is not a proven constant");
            }
          }
        } else if (ts.isSpreadAssignment(property)) {
          collectRecipeOptions(ctx, property.expression);
        }
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node);
      if (symbol && optionsProven(symbol)) {
        const declaration = symbol.valueDeclaration as ts.VariableDeclaration;
        collectRecipeOptions(
          { ...ctx, file: declaration.getSourceFile() },
          declaration.initializer!,
        );
        return;
      }
      markOpaque(ctx, node, "recipe option object is not provably immutable");
      return;
    }
    if (node.kind === ts.SyntaxKind.UndefinedKeyword) return;
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return;
    markOpaque(ctx, node, "unprovable recipe argument");
  };

  function componentSymbolOf(parameter: ts.ParameterDeclaration): ts.Symbol | undefined {
    const fn = parameter.parent;
    if (ts.isFunctionDeclaration(fn) && fn.name) return symbolAt(fn.name);
    let holder: ts.Node | undefined = fn.parent;
    while (holder && ts.isCallExpression(holder)) holder = holder.parent;
    if (holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
      return symbolAt(holder.name);
    }
    if (ts.isFunctionExpression(fn) && fn.name) return symbolAt(fn.name);
    return undefined;
  }

  const inspect = (file: ts.SourceFile, node: ts.Node, site: string) => {
    sites += 1;
    collect({ file, site, seen: new Set<ts.Node>() }, node);
  };

  function restExcludes(reference: ts.Identifier, propName: string): boolean {
    const symbol = symbolAt(reference);
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !ts.isBindingElement(declaration) || !declaration.dotDotDotToken) {
      return false;
    }
    const pattern = declaration.parent;
    if (!ts.isObjectBindingPattern(pattern)) return false;
    return pattern.elements.some(
      (element) =>
        !element.dotDotDotToken &&
        (element.propertyName ?? element.name).getText(declaration.getSourceFile()) === propName,
    );
  }

  const inspectJsxAttributes = (
    file: ts.SourceFile,
    attributes: ts.JsxAttributes,
    site: string,
    propName: string,
  ) => {
    for (const attribute of attributes.properties) {
      if (ts.isJsxAttribute(attribute)) {
        if (attribute.name.getText(file) !== propName) continue;
        if (attribute.initializer) inspect(file, attribute.initializer, site);
        continue;
      }
      const expression = attribute.expression;
      if (expression && ts.isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) {
          if (ts.isPropertyAssignment(property)) {
            const key = property.name;
            let named: string | null = null;
            if (ts.isIdentifier(key) || ts.isStringLiteral(key)) named = key.text;
            else if (ts.isComputedPropertyName(key) && ts.isStringLiteral(key.expression)) {
              named = key.expression.text; // a STATIC computed key is just a key
            } else {
              sites += 1;
              opaque.push({
                file: rel(file),
                line: lineOf(file, key),
                site,
                expression: key.getText(file).slice(0, 80),
                reason: "dynamic computed key in a JSX spread",
              });
              continue;
            }
            if (named === propName) inspect(file, property.initializer, site);
          } else if (ts.isShorthandPropertyAssignment(property)) {
            if (property.name.text === propName) inspect(file, property.name, site);
          } else {
            sites += 1;
            opaque.push({
              file: rel(file),
              line: lineOf(file, property),
              site,
              expression: property.getText(file).slice(0, 80),
              reason: "nested spread in a JSX attribute object",
            });
          }
        }
        continue;
      }
      if (expression && ts.isIdentifier(expression) && restExcludes(expression, propName)) continue;
      sites += 1;
      opaque.push({
        file: rel(file),
        line: lineOf(file, attribute),
        site,
        expression: attribute.getText(file).slice(0, 80),
        reason: "JSX spread that may carry " + propName,
      });
    }
  };

  // --- reference closure: every tracked reference gets exactly one outcome ---
  const classified = new Set<ts.Node>();
  let sanctionedCount = 0;
  let violatedCount = 0;
  let opaqueRefCount = 0;
  let recipeResultRefs = 0;
  let recipeResultOpaque = 0;
  const analyzedWrapperProps = new Set<string>();
  const wrapperKey = (symbol: ts.Symbol, prop: string) =>
    String((symbol as unknown as { id?: number }).id ?? symbol.name) + " " + prop;

  const refOpaque = (ref: Ref, reason: string) => {
    opaque.push({
      file: rel(ref.file),
      line: lineOf(ref.file, ref.node),
      site: "reference",
      expression: ref.node.getText(ref.file).replace(/\s+/g, " ").slice(0, 80),
      reason,
    });
  };

  /** Declaration plumbing: an import/export binding is not an execution shape. */
  const isPlumbing = (node: ts.Node): boolean => {
    const parent = node.parent;
    if (!parent) return false;
    return (
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isExportAssignment(parent) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isFunctionDeclaration(parent) && parent.name === node) ||
      ts.isTypeQueryNode(parent) ||
      ts.isTypeReferenceNode(parent)
    );
  };

  const isConstAliasInitializer = (node: ts.Node): boolean => {
    const parent = node.parent;
    if (!parent || !ts.isVariableDeclaration(parent)) return false;
    if (parent.initializer !== node || !isConstBinding(parent)) return false;
    if (!ts.isIdentifier(parent.name)) return false;
    const own = symbolAt(parent.name);
    // The alias must itself be tracked, so its own references are closed too.
    return !!own && tracked.has(own);
  };

  /**
   * Walks up from a recipe call through the composition forms `collect` already
   * understands, and requires the result to land in a combiner argument, an
   * immutable const (which becomes a tracked recipe result), or a className JSX
   * expression. Anything else means the classes were composed out of sight.
   */
  function resultReachesSanctionedSink(call: ts.CallExpression): boolean {
    let node: ts.Node = call;
    let parent = node.parent;
    while (parent) {
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isConditionalExpression(parent) ||
        (ts.isBinaryExpression(parent) &&
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(parent.operatorToken.kind))
      ) {
        node = parent;
        parent = parent.parent;
        continue;
      }
      break;
    }
    if (!parent) return false;
    if (
      ts.isCallExpression(parent) &&
      parent.arguments.includes(node as ts.Expression) &&
      !ts.isPropertyAccessExpression(parent.expression) &&
      kindOfCallee(parent.expression) === "combiner"
    ) {
      return true;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && isConstBinding(parent)) {
      return true;
    }
    return ts.isJsxExpression(parent);
  }

  function containsRecipeRef(node: ts.Node): boolean {
    let found = false;
    const visit = (child: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(child) && kindOfCallee(child.expression) === "recipe") {
        found = true;
        return;
      }
      if (ts.isIdentifier(child)) {
        const symbol = symbolAt(child);
        if (symbol && tracked.get(symbol) === "recipe-result") {
          found = true;
          return;
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  }

  const classifyPass = () => {
    for (const ref of refs) {
      if (classified.has(ref.node)) continue;
      const kind = tracked.get(ref.symbol);
      if (!kind) continue;
      classified.add(ref.node);

      const before = violations.length;
      let outcome: "sanctioned" | "opaque" = "opaque";
      const parent = ref.node.parent;

      if (isPlumbing(ref.node) || isConstAliasInitializer(ref.node)) {
        outcome = "sanctioned";
      } else if (kind === "surface" || kind === "wrapper") {
        const isTag =
          parent &&
          (ts.isJsxSelfClosingElement(parent) || ts.isJsxOpeningElement(parent)) &&
          parent.tagName === ref.node;
        if (isTag) {
          outcome = "sanctioned";
          const props =
            kind === "surface" ? new Set(["className"]) : (wrappers.get(ref.symbol) ?? new Set());
          for (const prop of props) {
            inspectJsxAttributes(
              ref.file,
              (parent as ts.JsxOpeningElement).attributes,
              kind === "surface" ? "Surface" : "<" + ref.symbol.name + ">",
              prop,
            );
            analyzedWrapperProps.add(wrapperKey(ref.symbol, prop));
          }
        } else if (parent && ts.isJsxClosingElement(parent) && parent.tagName === ref.node) {
          outcome = "sanctioned";
        } else {
          refOpaque(ref, "authority reference outside direct JSX use");
        }
      } else if (kind === "recipe" || kind === "combiner") {
        const invoked = parent && ts.isCallExpression(parent) && parent.expression === ref.node;
        if (invoked) {
          outcome = "sanctioned";
          const call = parent as ts.CallExpression;
          if (kind === "recipe") {
            inspect(ref.file, call, "surfaceVariants");
            // Invoking the recipe is sanctioned, but its RESULT must also land
            // somewhere the guard can see. `join(surfaceVariants({}), "bg-panel")`
            // invokes it legitimately and then composes the result with visual
            // classes inside a function this guard knows nothing about.
            if (!resultReachesSanctionedSink(call)) {
              outcome = "opaque";
              refOpaque(ref, "recipe result flows into an unsanctioned position");
            }
          } else if (call.arguments.some((a) => containsRecipeRef(a))) {
            inspect(ref.file, call, "surfaceVariants");
          }
        } else {
          refOpaque(
            ref,
            kind === "recipe"
              ? "recipe referenced outside a direct call, so its call sites are not enumerable"
              : "combiner referenced outside a direct call",
          );
        }
      } else if (kind === "recipe-result") {
        recipeResultRefs += 1;
        const passedToCombiner =
          parent &&
          ts.isCallExpression(parent) &&
          parent.arguments.includes(ref.node as ts.Expression) &&
          !ts.isPropertyAccessExpression(parent.expression) &&
          kindOfCallee(parent.expression) === "combiner";
        if (passedToCombiner) outcome = "sanctioned";
        else {
          recipeResultOpaque += 1;
          refOpaque(ref, "recipe result transported outside a direct combiner call");
        }
      }

      if (outcome === "opaque") opaqueRefCount += 1;
      else if (violations.length > before) violatedCount += 1;
      else sanctionedCount += 1;
    }
  };

  // Analysis discovers wrappers, which are themselves tracked and whose
  // references must then be classified. Iterate until nothing new appears.
  for (let round = 0; round < 25; round++) {
    const beforeRefs = classified.size;
    const beforeTracked = tracked.size;
    classifyPass();
    for (const [symbol, props] of wrappers) {
      for (const prop of props) {
        if (analyzedWrapperProps.has(wrapperKey(symbol, prop))) continue;
        analyzedWrapperProps.add(wrapperKey(symbol, prop));
        for (const ref of refs) {
          if (ref.symbol !== symbol) continue;
          const parent = ref.node.parent;
          if (
            parent &&
            (ts.isJsxSelfClosingElement(parent) || ts.isJsxOpeningElement(parent)) &&
            parent.tagName === ref.node
          ) {
            inspectJsxAttributes(ref.file, parent.attributes, "<" + symbol.name + ">", prop);
          }
        }
      }
    }
    if (classified.size === beforeRefs && tracked.size === beforeTracked) break;
  }

  // --- frontier scan: module acquisition and dynamic member access ---
  //
  // A tracked authority can also be ACQUIRED rather than referenced: through a
  // dynamic import(), a CommonJS require(), or a computed member access on a
  // namespace. None of those are supported authoring forms, so each is refused
  // with an exact site rather than modelled. Acquiring an UNTRACKED module --
  // `await import("exceljs")` in the optimize path -- is none of this guard's
  // business and is ignored, so the frontier stays keyed to the authority rather
  // than to dynamic loading in general.
  let moduleAcquisitions = 0;
  let moduleAcquisitionsOpaque = 0;
  let dynamicMemberAccess = 0;

  const exportsTracked = (moduleSymbol: ts.Symbol): boolean =>
    checker.getExportsOfModule(moduleSymbol).some((e) => tracked.has(canonical(e)!));

  const trackedModuleTarget = (specifier: ts.Expression, from: ts.SourceFile): boolean => {
    if (!ts.isStringLiteralLike(specifier)) return false;
    const direct = checker.getSymbolAtLocation(specifier);
    if (direct) return exportsTracked(direct);
    // `require("...")` in a .ts file gives the checker nothing, so the specifier
    // is resolved against the program's own files instead.
    const text = specifier.text;
    let base: string | null = null;
    if (text.startsWith("@/")) base = text.slice(2);
    else if (text.startsWith(".")) {
      const dir = from.fileName.slice(0, from.fileName.lastIndexOf("/"));
      const parts = [...dir.split("/"), ...text.split("/")];
      const out: string[] = [];
      for (const part of parts) {
        if (part === "." || part === "") continue;
        if (part === "..") out.pop();
        else out.push(part);
      }
      base = out.join("/");
    }
    if (base === null) return false;
    const target = analyzed.find((f) => {
      const name = f.fileName.replace(/\.(tsx?|jsx?)$/, "").replace(/^\/+/, "");
      const wanted = base!.replace(/^\/+/, "");
      return name === wanted || name.endsWith("/" + wanted) || name === wanted + "/index";
    });
    const moduleSymbol = target ? checker.getSymbolAtLocation(target) : undefined;
    return !!moduleSymbol && exportsTracked(moduleSymbol);
  };

  const objectHoldsTracked = (expression: ts.Expression): boolean => {
    const type = checker.getTypeAtLocation(expression);
    return type.getProperties().some((property) => tracked.has(canonical(property)!));
  };

  const frontierOpaque = (file: ts.SourceFile, node: ts.Node, reason: string) => {
    opaque.push({
      file: rel(file),
      line: lineOf(file, node),
      site: "acquisition",
      expression: node.getText(file).replace(/\s+/g, " ").slice(0, 80),
      reason,
    });
  };

  for (const file of analyzed) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
        if (dynamicImport || requireCall) {
          const argument = node.arguments[0];
          const form = dynamicImport ? "dynamic import()" : "require()";
          if (argument && ts.isStringLiteralLike(argument)) {
            if (trackedModuleTarget(argument, file)) {
              moduleAcquisitions += 1;
              moduleAcquisitionsOpaque += 1;
              frontierOpaque(
                file,
                node,
                form +
                  " acquires a module exporting a Surface authority, which is not a supported authoring form",
              );
            }
          } else if (argument) {
            // A specifier that cannot be read statically could name the authority
            // module, and nothing downstream would know.
            moduleAcquisitions += 1;
            moduleAcquisitionsOpaque += 1;
            frontierOpaque(
              file,
              node,
              form + " with a non-literal specifier cannot be proven not to acquire an authority",
            );
          }
        }
      }
      if (ts.isElementAccessExpression(node)) {
        const argument = node.argumentExpression;
        const named = argument && ts.isStringLiteral(argument);
        if (!named && argument && objectHoldsTracked(node.expression)) {
          dynamicMemberAccess += 1;
          frontierOpaque(
            file,
            node,
            "computed member access on a namespace holding a Surface authority",
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  // --- tuple legality: the public (role, emphasis) contract ---------------
  //
  // Fail-closed, like everything else here: an `emphasis` whose role or value
  // cannot be PROVEN is reported, not assumed legal.
  const tupleViolations: TupleViolation[] = [];
  let tuplesChecked = 0;

  type Option = { values: string[] | null; present: boolean };
  const ABSENT: Option = { values: [], present: false };

  /** The string values an expression can take, or null when unprovable. */
  const stringValues = (node: ts.Expression | undefined): string[] | null => {
    if (!node) return [];
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (node.kind === ts.SyntaxKind.NullKeyword) return [];
    if (ts.isIdentifier(node) && node.text === "undefined") return [];
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return stringValues(node.expression);
    }
    // Both arms of a ternary are real possibilities, so both are checked.
    if (ts.isConditionalExpression(node)) {
      const whenTrue = stringValues(node.whenTrue);
      const whenFalse = stringValues(node.whenFalse);
      return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
    }
    return null;
  };

  const readOption = (literal: ts.ObjectLiteralExpression, name: string): Option => {
    let found = ABSENT;
    for (const property of literal.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = property.name;
        const named =
          ts.isIdentifier(key) || ts.isStringLiteral(key)
            ? key.text
            : ts.isComputedPropertyName(key) && ts.isStringLiteral(key.expression)
              ? key.expression.text
              : null;
        if (named === name) found = { values: stringValues(property.initializer), present: true };
      } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
        found = { values: null, present: true };
      } else if (ts.isSpreadAssignment(property)) {
        const inner = property.expression;
        if (ts.isObjectLiteralExpression(inner)) {
          const nested = readOption(inner, name);
          if (nested.present) found = nested;
        } else {
          // An unprovable spread may carry either key; refuse rather than guess.
          found = { values: null, present: true };
        }
      }
    }
    return found;
  };

  const jsxOption = (attributes: ts.JsxAttributes, name: string): Option => {
    let found = ABSENT;
    for (const attribute of attributes.properties) {
      if (ts.isJsxAttribute(attribute)) {
        if (attribute.name.getText(attribute.getSourceFile()) !== name) continue;
        const init = attribute.initializer;
        if (!init) found = { values: null, present: true };
        else if (ts.isStringLiteral(init)) found = { values: [init.text], present: true };
        else if (ts.isJsxExpression(init))
          found = { values: stringValues(init.expression), present: true };
        else found = { values: null, present: true };
      } else {
        // A spread onto <Surface> may carry either prop.
        found = { values: null, present: true };
      }
    }
    return found;
  };

  const checkTuple = (
    file: ts.SourceFile,
    node: ts.Node,
    site: string,
    roleOption: Option,
    emphasisOption: Option,
  ) => {
    if (!emphasisOption.present) return;
    const emphasis = emphasisOption.values;
    // An explicit `undefined` asks for nothing at all.
    if (emphasis && emphasis.length === 0) return;
    tuplesChecked += 1;
    const push = (tuple: string, reason: string) =>
      tupleViolations.push({ file: rel(file), line: lineOf(file, node), site, tuple, reason });

    // Legality is a property of the ROLE: every emphasis value is legal on a
    // `well` and none is legal anywhere else. So the role must be provable, and
    // the emphasis value need only be named in the report. That distinction
    // matters for the `Surface` adapter itself, which forwards a typed
    // `emphasis` prop (unprovable by value) into a literal `role: "well"`.
    if (roleOption.values === null) {
      push("<unprovable>", "an `emphasis` whose role cannot be proven");
      return;
    }
    // No role means the recipe's own default, which is `surface` — not a well.
    const roles = roleOption.present && roleOption.values.length ? roleOption.values : ["surface"];
    const named = emphasis ? emphasis.join("|") : "<any>";
    for (const role of roles) {
      if (role !== "well") {
        push(
          role + " + " + named,
          "`emphasis` is the edge of a RECESSED ROW and is legal only on `well`",
        );
      }
    }
  };

  for (const file of analyzed) {
    const visitTuples = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        !ts.isPropertyAccessExpression(node.expression) &&
        kindOfCallee(node.expression) === "recipe"
      ) {
        for (const argument of node.arguments) {
          if (ts.isObjectLiteralExpression(argument)) {
            checkTuple(
              file,
              argument,
              "surfaceVariants()",
              readOption(argument, "role"),
              readOption(argument, "emphasis"),
            );
          }
        }
      } else if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = node.tagName;
        const identifier = ts.isPropertyAccessExpression(tag) ? tag.name : tag;
        const symbol = ts.isIdentifier(identifier) ? symbolAt(identifier) : undefined;
        if (symbol && tracked.get(symbol) === "surface") {
          checkTuple(
            file,
            node,
            "<Surface>",
            jsxOption(node.attributes, "level"),
            jsxOption(node.attributes, "emphasis"),
          );
        }
      }
      ts.forEachChild(node, visitTuples);
    };
    visitTuples(file);
  }

  const discovered = refs.filter((r) => tracked.has(r.symbol)).length;
  const wrapperNames = [...wrappers.entries()].flatMap(([symbol, props]) =>
    [...props].map((prop) => symbol.name + "." + prop),
  );

  return {
    violations,
    opaque,
    sites,
    wrappers: wrapperNames,
    authoritiesFound: !!surfaceSymbol && !!recipeSymbol,
    references: {
      discovered,
      sanctioned: sanctionedCount,
      violated: violatedCount,
      opaque: opaqueRefCount,
      unclassified: discovered - (sanctionedCount + violatedCount + opaqueRefCount),
    },
    frontier: {
      moduleAcquisitions,
      moduleAcquisitionsOpaque,
      dynamicMemberAccess,
      recipeResultRefs,
      recipeResultOpaque,
    },
    tuples: {
      checked: tuplesChecked,
      illegal: tupleViolations,
    },
  };
}
// ---------------------------------------------------------------------------
// Classifier fixtures. The repo gate only means something if the classifier
// actually rejects, so every allowed family gets a positive case AND an
// adversarial collision case beside it.
// ---------------------------------------------------------------------------

describe("classifyToken — exact families, no prefix trust", () => {
  it.each([
    // the collisions the previous prefix-based allowlist laundered
    ["box-border", "box-decoration-clone"],
    ["overflow-visible", "visible"],
    ["overflow-hidden", "invisible"],
    ["table-fixed", "collapse"],
    ["w-full", "w-[--brand]"],
    ["max-w-md", "max-w-[calc(100%-2rem)]"],
    ["p-5", "placeholder-ink"],
    ["m-2", "mix-blend-multiply"],
    ["items-center", "italic"],
    ["grow", "grayscale"],
    ["shrink-0", "shadow-1"],
    ["inset-0", "inset-shadow-sm"],
    ["z-50", "z-[999]"],
    ["gap-2", "gap-[3px]"],
    ["object-cover", "object-[--x]"],
    ["translate-x-1/2", "translate-x-[3px]"],
    ["col-span-2", "col-[span_2]"],
    ["flex-1", "filter"],
    ["order-1", "outline-2"],
    ["basis-0", "bg-panel"],
  ])("permits %s but rejects the neighbouring %s", (allowed, rejected) => {
    expect(classifyToken(allowed), allowed).toBeNull();
    expect(classifyToken(rejected), rejected).not.toBeNull();
  });

  it("rejects every bracket and paren form, on any family", () => {
    for (const token of [
      "w-[calc(100%-2rem)]",
      "max-w-[calc(100%-2rem)]",
      "w-[--brand]",
      "h-[228px]",
      "top-[calc(100%+7px)]",
      "p-[3px]",
      "[box-shadow:none]",
      "[background:var(--panel)]",
      "bg-(--brand)",
      "hover:[box-shadow:none]",
      "sm:max-w-[40rem]",
    ]) {
      expect(classifyToken(token), token).toBe("arbitrary");
    }
  });

  it("rejects visual and state utilities outright", () => {
    for (const token of [
      "bg-surface",
      "text-ink2",
      "border-brand",
      "border",
      "border-2",
      "border-t",
      "border-line",
      "border-x",
      "border-y",
      "border-t-brand",
      "rounded-card",
      "shadow-1",
      "drop-shadow-sm",
      "ring-2",
      "ring-inset",
      "opacity-50",
      "cursor-grab",
      "transition-colors",
      "duration-fast",
      "animate-fade",
      "blur-sm",
      "backdrop-blur-sm",
      "pointer-events-none",
      "font-semibold",
      "text-body",
      "uppercase",
      "truncate",
      "sr-only-x",
      "bg-panel!",
      "!bg-panel",
      "border-2!",
      "dark:bg-surface2",
    ]) {
      expect(classifyToken(token), token).not.toBeNull();
    }
  });

  it("keeps the layout vocabulary the shipped consumers actually use", () => {
    for (const token of [
      "flex",
      "grid",
      "hidden",
      "isolate",
      "relative",
      "fixed",
      "sticky",
      "flex-col",
      "flex-row",
      "items-center",
      "items-stretch",
      "justify-between",
      "self-start",
      "gap-1",
      "gap-1.5",
      "gap-2",
      "gap-3",
      "gap-4",
      "gap-6",
      "p-1",
      "p-3",
      "p-4",
      "p-5",
      "p-6",
      "px-4",
      "px-5",
      "py-3.5",
      "py-4",
      "-mx-5",
      "-mb-5",
      "w-full",
      "w-fit",
      "min-w-0",
      "size-4",
      "h-20",
      "overflow-hidden",
      "overflow-y-auto",
      "inset-0",
      "left-1/2",
      "top-1/2",
      "z-50",
      "-translate-x-1/2",
      "-translate-y-1/2",
      "grid-cols-3",
      "col-span-2",
      "sm:grid-cols-2",
      "grid3:grid-cols-3",
      "panes2:grid-cols-2",
      "pointer-coarse:min-h-touch",
      "sm:max-w-md",
      "sm:flex-row",
      "border-collapse",
      "border-spacing-0",
      "shrink-0",
      "flex-1",
    ]) {
      expect(classifyToken(token), token).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial fixtures. Every probe from the round-two review, each of which
// previously returned sites=0/violations=0/opaque=0.
// ---------------------------------------------------------------------------

const SURFACE_SRC = `
import { cva } from "cva";
export const surfaceVariants = (o?: any) => "";
export const Surface = (p: any) => null;
`;
const UTILS_SRC = `export function cn(...i: any[]) { return ""; }`;

function analyzeFixture(files: Record<string, string>): Analysis {
  return analyzeProgram(
    createFixtureProgram({
      "components/ui/surface.tsx": SURFACE_SRC,
      "lib/utils.ts": UTILS_SRC,
      ...files,
    }),
  );
}

/**
 * Tuple-legality fixtures. TypeScript already makes these unrepresentable
 * (`SurfaceVariantProps`), so each of these reaches the recipe through the
 * untyped fixture stub — which is exactly the `as any` / JS-boundary case the
 * analyzer exists to cover.
 */
describe("adversarial fixtures — (role, emphasis) tuple legality", () => {
  const head = `import { Surface, surfaceVariants } from "@/components/ui/surface";
        import { cn } from "@/lib/utils";
        `;

  const illegal = (body: string, label: string, expected: string) => {
    const r = analyzeFixture({ "components/probe.tsx": head + body });
    expect(r.authoritiesFound, label).toBe(true);
    expect(
      r.tuples.illegal.map((v) => v.tuple),
      label,
    ).toContain(expected);
  };

  it("rejects page + hairline", () => {
    illegal(
      `export const A = cn(surfaceVariants({ role: "page", emphasis: "hairline" }));`,
      "page+hairline",
      "page + hairline",
    );
  });

  it("rejects raised + drop-candidate", () => {
    illegal(
      `export const A = cn(surfaceVariants({ role: "raised", emphasis: "drop-candidate" }));`,
      "raised+candidate",
      "raised + drop-candidate",
    );
  });

  it("rejects an emphasis with NO role, which defaults to `surface`", () => {
    illegal(
      `export const A = cn(surfaceVariants({ geometry: "control", emphasis: "hairline" }));`,
      "default role",
      "surface + hairline",
    );
  });

  it("rejects an illegal <Surface> level/emphasis pair", () => {
    illegal(
      `export const A = () => <Surface level="raised" geometry="card" emphasis="hairline" />;`,
      "jsx",
      "raised + hairline",
    );
  });

  it("catches a conditional emphasis and names BOTH arms in the report", () => {
    // Legality is decided by the role, so neither arm can rescue this call — but
    // the report still has to say which values were asked for.
    illegal(
      `export const A = (o: boolean) => cn(surfaceVariants({ role: "surface", emphasis: o ? "hairline" : "drop-candidate" }));`,
      "ternary",
      "surface + hairline|drop-candidate",
    );
  });

  it("catches an illegal role chosen by a ternary, even when one arm is legal", () => {
    illegal(
      `export const A = (o: boolean) => cn(surfaceVariants({ role: o ? "well" : "raised", emphasis: "hairline" }));`,
      "ternary role",
      "raised + hairline",
    );
  });

  it("refuses an emphasis whose role cannot be proven", () => {
    illegal(
      `declare const role: any;
       export const A = cn(surfaceVariants({ role, emphasis: "hairline" }));`,
      "unprovable role",
      "<unprovable>",
    );
  });

  it("refuses an emphasis carried by an unprovable spread", () => {
    illegal(
      `declare const extra: any;
       export const A = cn(surfaceVariants({ role: "well", ...extra }));`,
      "spread",
      "<unprovable>",
    );
  });

  it("accepts the two sanctioned recessed-row tuples", () => {
    const r = analyzeFixture({
      "components/probe.tsx":
        head +
        `export const A = cn(surfaceVariants({ role: "well", geometry: "control", emphasis: "hairline" }));
         export const B = cn(surfaceVariants({ role: "well", geometry: "control", emphasis: "drop-candidate" }));
         export const C = (o: boolean) => cn(surfaceVariants({ role: "well", geometry: "control", emphasis: o ? "drop-candidate" : "hairline" }));
         export const D = () => <Surface level="well" geometry="control" emphasis="hairline" />;`,
    });
    expect(r.tuples.illegal).toEqual([]);
    // Four sites asked for an emphasis; none of them was refused.
    expect(r.tuples.checked).toBe(4);
  });

  it("ignores a call that asks for no emphasis at all", () => {
    const r = analyzeFixture({
      "components/probe.tsx":
        head + `export const A = cn(surfaceVariants({ role: "page", geometry: "square" }));`,
    });
    expect(r.tuples.checked).toBe(0);
    expect(r.tuples.illegal).toEqual([]);
  });
});

/** No executable bypass may report a clean, empty result. */
function expectCaught(result: Analysis, label: string) {
  expect(result.authoritiesFound, label + ": authorities must resolve").toBe(true);
  const caught = result.violations.length + result.opaque.length;
  expect(
    caught,
    label + ": expected a violation or an opaque site, got sites=" + result.sites,
  ).toBeGreaterThan(0);
}

describe("adversarial fixtures — symbol identity", () => {
  it("follows a renamed authority import", () => {
    const r = analyzeFixture({
      "components/probe.tsx": `
        import { Surface as Box, surfaceVariants as sv } from "@/components/ui/surface";
        import { cn } from "@/lib/utils";
        export const A = () => <Box level="page" geometry="square" className="bg-panel" />;
        export const B = cn(sv({ role: "well" }), "shadow-3");
      `,
    });
    expectCaught(r, "renamed import");
    expect(r.violations.map((v) => v.token).sort()).toEqual(["bg-panel", "shadow-3"]);
  });

  it("follows a namespace authority import", () => {
    const r = analyzeFixture({
      "components/probe.tsx": `
        import * as UI from "@/components/ui/surface";
        import { cn } from "@/lib/utils";
        export const A = () => <UI.Surface level="page" geometry="square" className="bg-panel" />;
        export const B = cn(UI.surfaceVariants({ role: "well" }), "rounded-card");
      `,
    });
    expectCaught(r, "namespace import");
    expect(r.violations.map((v) => v.token).sort()).toEqual(["bg-panel", "rounded-card"]);
  });

  it("follows a re-exported authority", () => {
    const r = analyzeFixture({
      "components/reexport.ts": `export { Surface, surfaceVariants } from "@/components/ui/surface";`,
      "components/probe.tsx": `
        import { Surface } from "@/components/reexport";
        export const A = () => <Surface level="page" geometry="square" className="shadow-2" />;
      `,
    });
    expectCaught(r, "re-export");
    expect(r.violations.map((v) => v.token)).toEqual(["shadow-2"]);
  });

  it("follows an aliased combiner", () => {
    const r = analyzeFixture({
      "components/probe.tsx": `
        import { surfaceVariants } from "@/components/ui/surface";
        import { cn as merge } from "@/lib/utils";
        export const A = merge(surfaceVariants({ role: "well" }), "bg-panel");
      `,
    });
    expectCaught(r, "aliased combiner");
    expect(r.violations.map((v) => v.token)).toEqual(["bg-panel"]);
  });

  it("treats the recipe stored as a value as an authority reference", () => {
    const r = analyzeFixture({
      "components/probe.tsx": `
        import { surfaceVariants } from "@/components/ui/surface";
        import { cn } from "@/lib/utils";
        const sv = surfaceVariants;
        export const A = cn(sv({ role: "well" }), "bg-panel");
      `,
    });
    expectCaught(r, "recipe as value");
    expect(r.sites).toBeGreaterThan(0);
    expect(r.violations.map((v) => v.token)).toEqual(["bg-panel"]);
  });

  it("fails closed when the recipe escapes to an unknown consumer", () => {
    const r = analyzeFixture({
      "components/probe.tsx": `
        import { surfaceVariants } from "@/components/ui/surface";
        declare function register(f: unknown): void;
        register(surfaceVariants);
      `,
    });
    expectCaught(r, "recipe escapes");
    expect(r.opaque.some((o) => o.site === "reference")).toBe(true);
    expect(r.references.opaque).toBeGreaterThan(0);
  });

  it("distinguishes same-name bindings in different lexical scopes", () => {
    const r = analyzeFixture({
      "components/probe.tsx": `
        import { Surface } from "@/components/ui/surface";
        export function A() {
          const styles = "bg-panel";
          return <Surface level="page" geometry="square" className={styles} />;
        }
        export function B() {
          const styles = "flex";
          return <Surface level="page" geometry="square" className={styles} />;
        }
      `,
    });
    expectCaught(r, "lexical scopes");
    // Only A's binding is a violation; B's resolves to a layout class.
    expect(r.violations.map((v) => v.token)).toEqual(["bg-panel"]);
  });
});

describe("adversarial fixtures — mutation and wrappers", () => {
  it("fails closed on a mutable binding", () => {
    const r = analyzeFixture({
      "components/probe.tsx": `
        import { Surface } from "@/components/ui/surface";
        let visual = "flex";
        visual = "bg-panel";
        export const A = () => <Surface level="page" geometry="square" className={visual} />;
      `,
    });
    expectCaught(r, "mutable binding");
    expect(r.opaque.some((o) => o.reason.includes("mutable"))).toBe(true);
  });

  it("follows a wrapper prop that is NOT named className", () => {
    const r = analyzeFixture({
      "components/ui/panel.tsx": `
        import { Surface } from "@/components/ui/surface";
        export function Panel({ styles }: { styles?: string }) {
          return <Surface level="page" geometry="square" className={styles} />;
        }
      `,
      "components/probe.tsx": `
        import { Panel } from "@/components/ui/panel";
        export const A = () => <Panel styles="bg-panel" />;
      `,
    });
    expectCaught(r, "renamed wrapper prop");
    expect(r.wrappers).toContain("Panel.styles");
    expect(r.violations.map((v) => v.token)).toEqual(["bg-panel"]);
  });

  it("inspects a violating default on a forwarded prop", () => {
    const r = analyzeFixture({
      "components/probe.tsx": `
        import { Surface } from "@/components/ui/surface";
        export function Panel({ className = "bg-panel" }: { className?: string }) {
          return <Surface level="page" geometry="square" className={className} />;
        }
      `,
    });
    expectCaught(r, "violating default");
    expect(r.violations.map((v) => v.token)).toEqual(["bg-panel"]);
  });

  it("follows an aliased wrapper at its call site", () => {
    const r = analyzeFixture({
      "components/ui/card.tsx": `
        import { surfaceVariants } from "@/components/ui/surface";
        import { cn } from "@/lib/utils";
        export function Card({ className, ...props }: { className?: string }) {
          return <div className={cn(surfaceVariants({ role: "surface" }), className)} {...props} />;
        }
      `,
      "components/probe.tsx": `
        import { Card as Panel } from "@/components/ui/card";
        export const A = () => <Panel className="bg-panel" />;
      `,
    });
    expectCaught(r, "aliased wrapper");
    expect(r.violations.map((v) => v.token)).toEqual(["bg-panel"]);
  });

  it("fails closed when a wrapper is used as a value", () => {
    const r = analyzeFixture({
      "components/ui/card.tsx": `
        import { surfaceVariants } from "@/components/ui/surface";
        import { cn } from "@/lib/utils";
        export function Card({ className, ...props }: { className?: string }) {
          return <div className={cn(surfaceVariants({ role: "surface" }), className)} {...props} />;
        }
      `,
      "components/probe.tsx": `
        import { Card } from "@/components/ui/card";
        declare function wrap(c: unknown): unknown;
        export const Aliased = wrap(Card);
      `,
    });
    expectCaught(r, "wrapper as value");
    expect(r.opaque.some((o) => o.site === "reference")).toBe(true);
    expect(r.references.opaque).toBeGreaterThan(0);
  });
});

describe("adversarial fixtures — recipe option forms", () => {
  const head = `
    import { surfaceVariants } from "@/components/ui/surface";
    import { cn } from "@/lib/utils";
  `;

  it("inspects a spread option object", () => {
    const r = analyzeFixture({
      "components/probe.tsx":
        head +
        `const opts = { className: "bg-panel" };
        export const A = surfaceVariants({ role: "well", ...opts });`,
    });
    expectCaught(r, "spread options");
    expect(r.violations.map((v) => v.token)).toEqual(["bg-panel"]);
  });

  it("inspects a shorthand className option", () => {
    const r = analyzeFixture({
      "components/probe.tsx":
        head +
        `const className = "shadow-3";
        export const A = surfaceVariants({ role: "well", className });`,
    });
    expectCaught(r, "shorthand option");
    expect(r.violations.map((v) => v.token)).toEqual(["shadow-3"]);
  });

  it("inspects a static computed className key", () => {
    const r = analyzeFixture({
      "components/probe.tsx":
        head + `export const A = surfaceVariants({ ["className"]: "rounded-card" });`,
    });
    expectCaught(r, "computed option key");
    expect(r.violations.map((v) => v.token)).toEqual(["rounded-card"]);
  });

  it("fails closed on an unprovable option object", () => {
    const r = analyzeFixture({
      "components/probe.tsx":
        head +
        `declare const opts: any;
        export const A = surfaceVariants(opts);`,
    });
    expectCaught(r, "unprovable options");
  });

  it("catches a detached recipe result composed later", () => {
    const r = analyzeFixture({
      "components/probe.tsx":
        head +
        `const s = surfaceVariants({ role: "well" });
        export const A = cn(s, "bg-panel");`,
    });
    expectCaught(r, "detached result");
    expect(r.violations.map((v) => v.token)).toEqual(["bg-panel"]);
  });

  it("resolves an imported class constant", () => {
    const r = analyzeFixture({
      "components/styles.ts": `export const visual = "bg-panel";`,
      "components/probe.tsx": `
        import { Surface } from "@/components/ui/surface";
        import { visual } from "@/components/styles";
        export const A = () => <Surface level="page" geometry="square" className={visual} />;
      `,
    });
    expectCaught(r, "imported constant");
    expect(r.violations.map((v) => v.token)).toEqual(["bg-panel"]);
  });

  it("inspects a JSX spread that could carry className", () => {
    const r = analyzeFixture({
      "components/probe.tsx": `
        import { Surface } from "@/components/ui/surface";
        export const A = () => <Surface level="page" geometry="square" {...{ className: "bg-panel" }} />;
      `,
    });
    expectCaught(r, "jsx spread");
    expect(r.violations.map((v) => v.token)).toEqual(["bg-panel"]);
  });

  it("analyzes a consumer OUTSIDE app/ and components/", () => {
    const r = analyzeFixture({
      "lib/panel.tsx": `
        import { Surface } from "@/components/ui/surface";
        export const LibPanel = () => <Surface level="page" geometry="square" className="bg-panel" />;
      `,
    });
    expectCaught(r, "lib consumer");
    expect(r.violations.map((v) => v.token)).toEqual(["bg-panel"]);
  });

  it("passes a genuinely layout-only consumer", () => {
    const r = analyzeFixture({
      "components/probe.tsx":
        head +
        `import { Surface } from "@/components/ui/surface";
        export const A = () => <Surface level="surface" geometry="card" className="flex flex-col gap-2 p-4" />;
        export const B = cn("flex overflow-hidden", surfaceVariants({ role: "surface" }));`,
    });
    expect(r.violations).toEqual([]);
    expect(r.opaque).toEqual([]);
    expect(r.sites).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Round-three adversarial matrix: reference closure.
//
// Each row is an executable route by which an authority, wrapper, recipe,
// combiner or recipe result can be reached in a shape the guard does not
// sanction. Every one must produce a violation or an opaque site, and none may
// leave an unclassified reference behind.
// ---------------------------------------------------------------------------

const HEAD = `
  import { Surface, surfaceVariants } from "@/components/ui/surface";
  import { cn } from "@/lib/utils";
`;
const CARD = `
  import { surfaceVariants } from "@/components/ui/surface";
  import { cn } from "@/lib/utils";
  export function Card({ className, ...props }: { className?: string }) {
    return <div className={cn(surfaceVariants({ role: "surface" }), className)} {...props} />;
  }
`;

const CLOSURE_ROWS: readonly (readonly [string, string])[] = [
  // --- authority escapes ---
  [
    "mutable authority alias",
    HEAD + `let B: any = Surface; B = null; export const A = () => <B className="bg-panel" />;`,
  ],
  [
    "conditional authority alias",
    HEAD +
      `declare const t: boolean; const B = t ? Surface : Surface; export const A = () => <B className="bg-panel" />;`,
  ],
  [
    "logical authority alias",
    HEAD +
      `declare const f: any; const B = f || Surface; export const A = () => <B className="bg-panel" />;`,
  ],
  [
    "HOC-wrapped authority",
    HEAD +
      `declare function hoc(c: unknown): any; const B = hoc(Surface); export const A = () => <B className="bg-panel" />;`,
  ],
  [
    "authority held in an object",
    HEAD + `const reg = { S: Surface }; export const A = () => <reg.S className="bg-panel" />;`,
  ],
  ["authority held in an array", HEAD + `const reg = [Surface]; export const A = reg[0];`],
  [
    "authority behind a getter",
    HEAD + `const reg = { get S() { return Surface; } }; export const A = reg.S;`,
  ],
  [
    "React.createElement authority",
    HEAD +
      `import * as React from "react"; export const A = React.createElement(Surface, { className: "bg-panel" });`,
  ],
  [
    "authority passed as an argument",
    HEAD + `declare function render(c: unknown): void; render(Surface);`,
  ],
  // --- recipe escapes ---
  ["recipe .call", HEAD + `export const A = cn(surfaceVariants.call(null, {}), "bg-panel");`],
  ["recipe .apply", HEAD + `export const A = cn(surfaceVariants.apply(null, [{}]), "bg-panel");`],
  [
    "recipe .bind",
    HEAD + `const b = surfaceVariants.bind(null); export const A = cn(b({}), "bg-panel");`,
  ],
  [
    "recipe stored in an object",
    HEAD + `const reg = { sv: surfaceVariants }; export const A = cn(reg.sv({}), "bg-panel");`,
  ],
  [
    "recipe behind a getter",
    HEAD + `const reg = { get sv() { return surfaceVariants; } }; export const A = reg.sv;`,
  ],
  [
    "recipe as a bare value",
    HEAD + `declare function keep(f: unknown): void; keep(surfaceVariants);`,
  ],
  // --- combiner escapes ---
  ["combiner .call", HEAD + `export const A = cn.call(null, surfaceVariants({}), "bg-panel");`],
  ["combiner .apply", HEAD + `export const A = cn.apply(null, [surfaceVariants({}), "bg-panel"]);`],
  [
    "combiner .bind",
    HEAD + `const m = cn.bind(null); export const A = m(surfaceVariants({}), "bg-panel");`,
  ],
  [
    "unknown local combiner",
    HEAD +
      `declare function join(...p: unknown[]): string; export const A = join(surfaceVariants({}), "bg-panel");`,
  ],
  // --- recipe-result composition ---
  [
    "recipe result in a binary expression",
    HEAD + `const s = surfaceVariants({}); export const A = s + " bg-panel";`,
  ],
  [
    "recipe result in a template",
    HEAD + `const s = surfaceVariants({}); export const A = \`\${s} bg-panel\`;`,
  ],
  [
    "recipe result in a conditional",
    HEAD +
      `declare const t: boolean; const s = surfaceVariants({}); export const A = t ? s : "bg-panel";`,
  ],
  [
    "recipe result in a logical",
    HEAD + `const s = surfaceVariants({}); export const A = s || "bg-panel";`,
  ],
  [
    "recipe result in an object",
    HEAD + `const s = surfaceVariants({}); export const A = { cls: s };`,
  ],
  ["recipe result in an array", HEAD + `const s = surfaceVariants({}); export const A = [s];`],
  [
    "recipe result returned",
    HEAD + `const s = surfaceVariants({}); export function A() { return s; }`,
  ],
  [
    "recipe result as an unknown argument",
    HEAD + `declare function take(v: unknown): void; const s = surfaceVariants({}); take(s);`,
  ],
  // --- option-object mutation ---
  [
    "option object property assignment",
    HEAD +
      `const o: any = { className: "flex" }; o.className = "bg-panel"; export const A = surfaceVariants(o);`,
  ],
  [
    "option object index assignment",
    HEAD +
      `const o: any = { className: "flex" }; o["className"] = "bg-panel"; export const A = surfaceVariants(o);`,
  ],
  [
    "option object destructuring assignment",
    HEAD +
      `const o: any = { className: "flex" }; ({ className: o.className } = { className: "bg-panel" }); export const A = surfaceVariants(o);`,
  ],
  [
    "option object captured by a closure",
    HEAD +
      `const o: any = { className: "flex" }; const f = () => { o.className = "bg-panel"; }; f(); export const A = surfaceVariants(o);`,
  ],
  [
    "option object with an accessor",
    HEAD +
      `const o = { get className() { return "bg-panel"; } }; export const A = surfaceVariants(o);`,
  ],
  [
    "option object escaping through a call",
    HEAD +
      `declare function mutate(x: unknown): void; const o = { className: "flex" }; mutate(o); export const A = surfaceVariants(o);`,
  ],
  [
    "option object nested mutable spread",
    HEAD +
      `let inner: any = { className: "bg-panel" }; const o = { ...inner }; export const A = surfaceVariants(o);`,
  ],
  // --- JSX spread keys ---
  [
    "dynamic computed JSX spread key",
    HEAD + `declare const k: string; export const A = () => <Surface {...{ [k]: "bg-panel" }} />;`,
  ],
  [
    "static computed JSX spread key",
    HEAD + `export const A = () => <Surface {...{ ["className"]: "bg-panel" }} />;`,
  ],
];

describe("round-three matrix — no authority reference escapes classification", () => {
  it.each(CLOSURE_ROWS)("closes: %s", (_label, source) => {
    const r = analyzeFixture({ "components/probe.tsx": source });
    expect(r.authoritiesFound).toBe(true);
    expect(r.references.unclassified).toBe(0);
    expect(
      r.violations.length + r.opaque.length,
      "expected a violation or an opaque site; sites=" + r.sites,
    ).toBeGreaterThan(0);
  });
});

describe("round-three matrix — wrapper identity and chains", () => {
  it("keeps same-named transitive wrappers independent by symbol", () => {
    const r = analyzeFixture({
      "components/ui/card.tsx": CARD,
      "components/a/panel.tsx": `
        import { Card } from "@/components/ui/card";
        export function Panel({ className }: { className?: string }) {
          return <Card className={className} />;
        }
      `,
      "components/b/panel.tsx": `
        import { Card } from "@/components/ui/card";
        export function Panel({ styles }: { styles?: string }) {
          return <Card className={styles} />;
        }
      `,
      "components/probe.tsx": `
        import { Panel as A } from "@/components/a/panel";
        import { Panel as B } from "@/components/b/panel";
        export const X = () => <A className="bg-panel" />;
        export const Y = () => <B styles="shadow-3" />;
      `,
    });
    expect(r.references.unclassified).toBe(0);
    // Two distinct Panel symbols, each with its own prop name.
    expect(r.wrappers).toEqual(expect.arrayContaining(["Panel.className", "Panel.styles"]));
    expect(r.violations.map((v) => v.token).sort()).toEqual(["bg-panel", "shadow-3"]);
  });

  it.each([
    [
      "wrapper held in an object",
      `const reg = { C: Card }; export const A = () => <reg.C className="bg-panel" />;`,
    ],
    ["wrapper as a bare value", `declare function keep(c: unknown): void; keep(Card);`],
    [
      "wrapper via createElement",
      `import * as React from "react"; export const A = React.createElement(Card, { className: "bg-panel" });`,
    ],
    [
      "mutable wrapper alias",
      `let P: any = Card; P = null; export const A = () => <P className="bg-panel" />;`,
    ],
  ])("closes: %s", (_label, body) => {
    const r = analyzeFixture({
      "components/ui/card.tsx": CARD,
      "components/probe.tsx": `import { Card } from "@/components/ui/card";\n` + body,
    });
    expect(r.references.unclassified).toBe(0);
    expect(r.violations.length + r.opaque.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Round-four matrix: the DISCOVERY FRONTIER.
//
// The reference equation can balance perfectly over an index that never saw a
// reference. Each row below is an executable acquisition or transport path that
// previously entered the program with sites/violations/opaque/unclassified all
// zero. Every row must now change the accounting AND produce a violation or an
// opaque site.
// ---------------------------------------------------------------------------

const REEXPORT = `export { Surface, surfaceVariants } from "@/components/ui/surface";`;

describe("round-four matrix -- authority acquisition", () => {
  it("resolves namespace element access to the same symbol as property access", () => {
    const r = analyzeFixture({
      "components/probe.tsx": `
        import * as UI from "@/components/ui/surface";
        const Box = UI["Surface"];
        export const A = () => <Box level="page" geometry="square" className="bg-panel" />;
      `,
    });
    // Resolved, not merely refused: the alias enters normal reference closure, so
    // the class on it is a concrete violation.
    expect(r.violations.map((v) => v.token)).toEqual(["bg-panel"]);
    expect(r.references.unclassified).toBe(0);
  });

  it("refuses computed member access on an authority namespace", () => {
    const r = analyzeFixture({
      "components/probe.tsx": `
        import * as UI from "@/components/ui/surface";
        declare const key: string;
        export const Box = UI[key];
      `,
    });
    expect(r.frontier.dynamicMemberAccess).toBeGreaterThan(0);
    expect(r.opaque.some((o) => o.site === "acquisition")).toBe(true);
  });

  it.each([
    [
      "awaited dynamic import destructuring",
      `const p = async () => { const { Surface: Box } = await import("@/components/ui/surface"); return <Box className="bg-panel" />; };`,
    ],
    [
      "dynamic import then-chain",
      `const p = import("@/components/ui/surface").then((m) => m.Surface);`,
    ],
    [
      "dynamic import of a re-export module",
      `const p = async () => { const { Surface } = await import("@/components/reexport"); return Surface; };`,
    ],
    [
      "CommonJS destructuring",
      `declare function require(s: string): any; const { Surface: Box } = require("@/components/ui/surface"); export const A = () => <Box className="bg-panel" />;`,
    ],
    [
      "CommonJS property access",
      `declare function require(s: string): any; const Box = require("@/components/ui/surface").Surface; export const A = () => <Box className="bg-panel" />;`,
    ],
    [
      "CommonJS of a re-export module",
      `declare function require(s: string): any; const Box = require("@/components/reexport").Surface;`,
    ],
    ["non-literal dynamic specifier", `declare const spec: string; const p = import(spec);`],
  ])("refuses acquisition: %s", (_label, body) => {
    const r = analyzeFixture({
      "components/reexport.ts": REEXPORT,
      "components/probe.tsx": body,
    });
    expect(r.frontier.moduleAcquisitions).toBeGreaterThan(0);
    expect(r.frontier.moduleAcquisitionsOpaque).toBeGreaterThan(0);
    expect(r.opaque.some((o) => o.site === "acquisition")).toBe(true);
    expect(r.references.unclassified).toBe(0);
  });

  it("ignores dynamic acquisition of an UNTRACKED module", () => {
    // `await import("exceljs")` ships in the optimize path. The frontier is keyed
    // to the authority, not to dynamic loading in general.
    const r = analyzeFixture({
      "components/other.ts": `export const unrelated = 1;`,
      "components/probe.tsx": `const p = async () => (await import("@/components/other")).unrelated;`,
    });
    expect(r.frontier.moduleAcquisitions).toBe(0);
    expect(r.opaque).toEqual([]);
  });
});

describe("round-four matrix -- recipe-result transport", () => {
  const head = `
    import { surfaceVariants } from "@/components/ui/surface";
    import { cn } from "@/lib/utils";
  `;

  it.each([
    [
      "object shorthand then retrieval",
      `const s = surfaceVariants({}); const bag = { s }; export const A = cn(bag.s, "bg-panel");`,
    ],
    [
      "exported spread of shorthand",
      `const s = surfaceVariants({}); export const bag = { ...{ s } };`,
    ],
    ["nested shorthand", `const s = surfaceVariants({}); export const bag = { inner: { s } };`],
    ["shorthand in an array element", `const s = surfaceVariants({}); export const bag = [{ s }];`],
    ["shorthand exported directly", `const s = surfaceVariants({}); export const bag = { s };`],
    ["renamed property storage", `const s = surfaceVariants({}); export const bag = { cls: s };`],
  ])("refuses transport: %s", (_label, body) => {
    const r = analyzeFixture({ "components/probe.tsx": head + body });
    expect(r.frontier.recipeResultRefs).toBeGreaterThan(0);
    expect(r.frontier.recipeResultOpaque).toBeGreaterThan(0);
    expect(r.references.unclassified).toBe(0);
    expect(r.violations.length + r.opaque.length).toBeGreaterThan(0);
  });

  it("still sanctions a recipe result passed straight into a combiner", () => {
    const r = analyzeFixture({
      "components/probe.tsx":
        head + `const s = surfaceVariants({}); export const A = cn(s, "flex");`,
    });
    expect(r.frontier.recipeResultRefs).toBeGreaterThan(0);
    expect(r.frontier.recipeResultOpaque).toBe(0);
    expect(r.violations).toEqual([]);
    expect(r.opaque).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The repository gate, over the real TypeScript program.
// ---------------------------------------------------------------------------

describe("every Surface / surfaceVariants consumer keeps className layout-only", () => {
  const { program, roots } = createRepoProgram();
  const result = analyzeProgram(
    program,
    (f) => f.startsWith(webRoot) && !f.includes("node_modules"),
  );

  it("builds the program from tsconfig, not a directory convention", () => {
    expect(roots.some((f) => f.includes("/lib/"))).toBe(true);
    expect(roots.some((f) => /\.(test|spec)\.tsx?$/.test(f))).toBe(false);
    expect(roots.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("locates both authority symbols", () => {
    expect(result.authoritiesFound).toBe(true);
  });

  it("finds consumers to check, so the gate cannot pass vacuously", () => {
    expect(result.sites).toBeGreaterThan(10);
  });

  it("enumerates the shared wrappers' callers", () => {
    expect(result.wrappers).toEqual(
      expect.arrayContaining(["Card.className", "SkeletonCard.className"]),
    );
  });

  it("finds real emphasis call sites, so the tuple gate cannot pass vacuously", () => {
    // GroupsSection is the only owner that asks for one today: the auto row via
    // <Surface emphasis>, and the custom row via surfaceVariants(). If this ever
    // drops to 0 the tuple rule below is checking nothing.
    expect(result.tuples.checked).toBeGreaterThan(0);
  });

  it("requests no illegal (role, emphasis) tuple anywhere in the program", () => {
    expect(
      result.tuples.illegal,
      result.tuples.illegal.length + " illegal surface tuple(s)",
    ).toEqual([]);
  });

  it("accounts for every authority reference, with no unclassified remainder", () => {
    const {
      discovered,
      sanctioned,
      violated,
      opaque: opaqueRefs,
      unclassified,
    } = result.references;
    expect(discovered).toBeGreaterThan(20);
    expect(sanctioned + violated + opaqueRefs).toBe(discovered);
    expect(unclassified).toBe(0);
  });

  it("closes the acquisition and transport frontier, not only the equation", () => {
    const f = result.frontier;
    // Nothing in the live tree acquires an authority module dynamically, indexes
    // a namespace computedly, or transports a recipe result out of a combiner
    // call. Each of these is proven refused by the round-four fixtures, so a zero
    // here is a measured fact rather than an untested path.
    expect(f.moduleAcquisitionsOpaque, "unsupported authority module acquisition").toBe(0);
    expect(f.dynamicMemberAccess, "computed access on an authority namespace").toBe(0);
    expect(f.recipeResultOpaque, "recipe result transported out of a combiner call").toBe(0);
    // The live tree stores no recipe result at all -- every call site invokes the
    // recipe inline inside `cn(...)` -- so `recipeResultRefs` is legitimately 0
    // here. The transport path is therefore proven by the round-four fixtures
    // rather than by production usage, and is deliberately NOT asserted non-zero:
    // that would assert a usage the codebase does not have.
    expect(f.recipeResultRefs).toBeGreaterThanOrEqual(0);
  });

  it("reports no non-layout utility", () => {
    const report = result.violations
      .map((v) => v.file + ":" + v.line + " [" + v.site + "] " + v.token + " (" + v.reason + ")")
      .join("\n");
    expect(result.violations, "surface className violations:\n" + report).toEqual([]);
  });

  it("resolves every class source and every reference", () => {
    const report = result.opaque
      .map((o) => o.file + ":" + o.line + " [" + o.site + "] " + o.expression + " :: " + o.reason)
      .join("\n");
    expect(result.opaque, "unresolved surface sources/references:\n" + report).toEqual([]);
  });
});
