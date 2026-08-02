import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// P2-1 — TARGET-BOUND ownership of the inset-hairline surfaces.
//
// Every governed surface must get its tone/border/elevation/radius from
// `surfaceVariants({ role: "well", geometry: "control", emphasis: "hairline" })`
// and nothing else.
//
// WHY THIS CANNOT BE A RENDER CHECK: the recipe call and a raw reimplementation
// emit byte-identical class lists. That is precisely how the authority was
// bypassed while every raw-class assertion stayed green.
//
// WHY THIS CANNOT BE A FILE-WIDE CHECK (the P2 on the previous attempt): asking
// "does this file mention the tuple somewhere" passes when ONE of three icon
// tiles is raw-reimplemented and another still calls it. And asking "does this
// file contain no `bg-panel` + `shadow-well` literal" is defeated by splitting
// the tokens across two literals. Both are properties of the FILE; ownership is
// a property of each SURFACE NODE.
//
// So each governed node is located by a stable attribute, its `className`
// expression is resolved through `cn`/const-aliases down to the recipe calls it
// actually contributes, and that set must be exactly the governed tuple. The
// resolver is fail-closed: any shape it cannot prove is reported as unresolved
// and fails, rather than being ignored.
// ---------------------------------------------------------------------------

const WEB_ROOT = resolve(__dirname, "..", "..");

const GOVERNED_TUPLE = { role: "well", geometry: "control", emphasis: "hairline" } as const;

/**
 * The ONLY inline style properties a governed node may carry, per target.
 *
 * React's inline style beats every class, so a node that gets its tone from the
 * recipe can still override it here and no class-level oracle would notice — the
 * escape the closure review demonstrated with a paint-identical
 * `backgroundColor: "var(--color-panel)"`. The answer is a positive allowlist:
 * these surfaces legitimately own exactly one thing inline (a dimension with no
 * token), so anything else, of any kind, is refused.
 */
type StyleAllowlist = Readonly<Record<string, string>>;

/** A surface whose ownership is governed, located by a stable JSX attribute. */
interface GovernedSurface {
  readonly label: string;
  readonly file: string;
  /** Attribute whose presence/value identifies the node. */
  readonly attr: string;
  /** Exact value, or a predicate for generated values. */
  readonly value: string | ((raw: string) => boolean);
  /** How many such nodes must exist — a premise guard, so a selector that
   *  silently stops matching fails instead of vacuously passing. */
  readonly count: number;
  /** Exact inline style the node must carry — no more, no less. */
  readonly style: StyleAllowlist;
}

const GOVERNED: readonly GovernedSurface[] = [
  {
    label: "icon tile",
    file: "components/shift-types/shift-type-grid.tsx",
    attr: "data-slot",
    value: "shift-tile",
    // Reserved card, read card, and the open editor's header. Each is asserted
    // individually below, so raw-reimplementing any ONE of them fails.
    count: 3,
    // The prototype's 42px has no token; nothing else may be set inline.
    style: { width: "42", height: "42" },
  },
  {
    label: "working-time readout",
    file: "components/entity-editor/working-time-fields.tsx",
    attr: "data-testid",
    value: (raw) => raw.includes("-duration"),
    count: 1,
    // The absolute control token; nothing else may be set inline.
    style: { height: '"var(--ctl)"' },
  },
];

// ---------------------------------------------------------------------------
// CHECKER-BACKED SYMBOL IDENTITY.
//
// Round 5 resolved bindings by walking lexical scopes myself. That was better
// than the bare-name map it replaced, but it still MODELLED JavaScript scoping
// instead of asking the compiler — and it got `var` wrong: a function-scoped
// `var` inside a nested block hoists to the function, while the walker stopped
// at the block boundary and kept going outward to a module-level `const` of the
// same name. The illegal local won at runtime; the oracle judged the legal one.
//
// Resolution is now the TypeScript checker's. Every identifier is resolved to a
// SYMBOL, and every helper (`surfaceVariants`, `cn`/`clsx`/`twMerge`) must be
// the symbol the canonical module exports — not merely something spelled the
// same. Anything the checker cannot pin to exactly one const declaration is
// refused.
// ---------------------------------------------------------------------------

interface Analysis {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** The exported `surfaceVariants` symbol, or undefined if not resolvable. */
  readonly recipe: ts.Symbol | undefined;
  /** Canonical class combiners: `cn` and the `clsx`/`twMerge` it wraps. */
  readonly combiners: ReadonlySet<ts.Symbol>;
}

/** Keyed by SourceFile so the existing helper signatures stay unchanged. */
const ANALYSIS = new WeakMap<ts.SourceFile, Analysis>();

function analysisFor(sf: ts.SourceFile): Analysis {
  const found = ANALYSIS.get(sf);
  if (!found) throw new Error(`no checker registered for ${sf.fileName}`);
  return found;
}

/** Canonical symbol: an import alias is followed to what it actually names. */
function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function moduleExport(
  program: ts.Program,
  checker: ts.TypeChecker,
  suffix: string,
  name: string,
): ts.Symbol | undefined {
  const file = program.getSourceFiles().find((f) => f.fileName.endsWith(suffix));
  const moduleSymbol = file ? checker.getSymbolAtLocation(file) : undefined;
  if (!moduleSymbol) return undefined;
  const exported = checker.getExportsOfModule(moduleSymbol).find((e) => e.name === name);
  if (!exported) return undefined;
  return exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
}

function registerAnalysis(program: ts.Program, sf: ts.SourceFile): ts.SourceFile {
  const checker = program.getTypeChecker();
  const combiners = new Set<ts.Symbol>();
  for (const [suffix, name] of [
    ["lib/utils.ts", "cn"],
    ["lib/utils.tsx", "cn"],
  ] as const) {
    const symbol = moduleExport(program, checker, suffix, name);
    if (symbol) combiners.add(symbol);
  }
  ANALYSIS.set(sf, {
    program,
    checker,
    recipe:
      moduleExport(program, checker, "components/ui/surface.tsx", "surfaceVariants") ??
      moduleExport(program, checker, "components/ui/surface.ts", "surfaceVariants"),
    combiners,
  });
  return sf;
}

/** The repository program, built once from tsconfig so `@/` paths resolve. */
let repoProgram: ts.Program | undefined;
function getRepoProgram(): ts.Program {
  if (repoProgram) return repoProgram;
  const configPath = join(WEB_ROOT, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, WEB_ROOT);
  repoProgram = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true, skipLibCheck: true },
  });
  return repoProgram;
}

function parse(relPath: string): ts.SourceFile {
  const program = getRepoProgram();
  const absolute = resolve(WEB_ROOT, relPath);
  const sf = program.getSourceFiles().find((f) => resolve(f.fileName) === absolute);
  if (!sf) throw new Error(`${relPath} is not in the TypeScript program`);
  return registerAnalysis(program, sf);
}

/**
 * An in-memory program for adversarial fixtures, with the canonical modules
 * stubbed so `surfaceVariants` and `cn` resolve to real, distinct symbols. A
 * second "wrong module" is provided so a same-named import from elsewhere can be
 * proven NOT to be the authority.
 */
const FIXTURE_PRELUDE =
  `import { surfaceVariants } from "@/components/ui/surface";\n` +
  `import { cn } from "@/lib/utils";\n`;

function parseFixtureSource(body: string, prelude = FIXTURE_PRELUDE): ts.SourceFile {
  const files: Record<string, string> = {
    "/components/ui/surface.tsx": `export function surfaceVariants(_o?: unknown): string { return ""; }\n`,
    "/lib/utils.ts": `export function cn(...a: unknown[]): string { return String(a); }\n`,
    "/impostor.ts":
      `export function surfaceVariants(_o?: unknown): string { return ""; }\n` +
      `export function cn(...a: unknown[]): string { return String(a); }\n`,
    "/fixture.tsx": prelude + body,
  };
  const host: ts.CompilerHost = {
    fileExists: (f) => f in files,
    readFile: (f) => files[f],
    getSourceFile: (f) =>
      f in files
        ? ts.createSourceFile(f, files[f], ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
        : undefined,
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
        else if (name.startsWith(".")) base = resolve(containing, "..", name);
        else return undefined;
        for (const candidate of [base, base + ".ts", base + ".tsx"]) {
          if (candidate in files) return { resolvedFileName: candidate, extension: ".tsx" };
        }
        return undefined;
      }),
  };
  const program = ts.createProgram({
    rootNames: Object.keys(files),
    options: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      noLib: true,
      skipLibCheck: true,
      baseUrl: "/",
    },
    host,
  });
  const sf = program.getSourceFile("/fixture.tsx")!;
  return registerAnalysis(program, sf);
}

/**
 * LEXICAL binding resolution.
 *
 * The previous version built one file-wide map keyed by bare NAME, so any
 * declaration anywhere in the file could answer for an identifier anywhere else.
 * A local illegal `const X` inside a component was silently replaced by a later
 * module-level legal `const X` of the same name, and the governed node passed.
 * **Name equality is not binding identity.**
 *
 * This resolves from the USE SITE outward: the first enclosing scope that
 * declares the name answers, and every way the answer could be wrong — shadowed,
 * ambiguous, imported, declared after use (TDZ), not a `const`, no initializer,
 * or declared only in a sibling scope — fails closed instead of guessing.
 *
 * A full `ts.Program` + checker would also resolve this. Lexical resolution is
 * used because the oracle governs two known files, needs no cross-module
 * resolution, and refuses every unprovable case rather than approximating it.
 */
type Binding =
  | { readonly kind: "ok"; readonly init: ts.Expression }
  | { readonly kind: "fail"; readonly reason: string };

/**
 * Resolve an identifier to its unique const initializer, by SYMBOL.
 *
 * Every refusal below is a case where the checker can see the binding but this
 * oracle declines to follow it, because following it would be a guess:
 *
 *   • an import alias — the initializer lives in another module;
 *   • more than one declaration — a merged or ambiguous symbol;
 *   • a `var` or `let` — reassignable, so the value at the use site is unknown
 *     (this is also what catches the hoisted nested-block `var`, which the
 *     lexical walker resolved to an outer const);
 *   • a function/class declaration, parameter, or destructuring pattern;
 *   • a const with no initializer.
 */
function resolveBinding(sf: ts.SourceFile, id: ts.Identifier): Binding {
  const { checker } = analysisFor(sf);
  const raw = checker.getSymbolAtLocation(id);
  if (!raw) return { kind: "fail", reason: `"${id.text}" resolves to no symbol` };
  if (raw.flags & ts.SymbolFlags.Alias) {
    return {
      kind: "fail",
      reason: `"${id.text}" is an imported binding, declared in another module`,
    };
  }
  const decls = raw.declarations ?? [];
  if (decls.length !== 1) {
    return {
      kind: "fail",
      reason: `"${id.text}" has ${decls.length} declarations (merged/ambiguous)`,
    };
  }
  const decl = decls[0];
  // A destructured binding is a BindingElement, not a VariableDeclaration — name
  // the actual mechanism rather than reporting a bare SyntaxKind.
  if (ts.isBindingElement(decl)) {
    return { kind: "fail", reason: `"${id.text}" comes from a destructuring pattern` };
  }
  if (!ts.isVariableDeclaration(decl)) {
    return {
      kind: "fail",
      reason: `"${id.text}" resolves to a ${ts.SyntaxKind[decl.kind]}, not a const initializer`,
    };
  }
  if (!ts.isIdentifier(decl.name)) {
    return { kind: "fail", reason: `"${id.text}" comes from a destructuring pattern` };
  }
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) {
    return {
      kind: "fail",
      reason: `"${id.text}" is not a const binding (var/let are reassignable)`,
    };
  }
  if (!decl.initializer) return { kind: "fail", reason: `"${id.text}" has no initializer` };
  // Temporal dead zone. The checker resolves the symbol happily, but a const read
  // before its own declaration is a runtime error — the value at the use site
  // does not exist, so following the initializer would be fiction.
  if (decl.getSourceFile() === id.getSourceFile() && decl.getStart() > id.getStart()) {
    return { kind: "fail", reason: `"${id.text}" is used before it is declared (TDZ)` };
  }
  return { kind: "ok", init: decl.initializer };
}

/** Is this call the canonical `surfaceVariants` export, by symbol? */
function isRecipeCall(sf: ts.SourceFile, callee: ts.Expression): boolean {
  const { checker, recipe } = analysisFor(sf);
  if (!recipe || !ts.isIdentifier(callee)) return false;
  return symbolAt(checker, callee) === recipe;
}

/** Is this call a canonical class combiner, by symbol? */
function isCombinerCall(sf: ts.SourceFile, callee: ts.Expression): boolean {
  const { checker, combiners } = analysisFor(sf);
  if (!ts.isIdentifier(callee)) return false;
  const symbol = symbolAt(checker, callee);
  return symbol !== undefined && combiners.has(symbol);
}

/** The literal `{ key: "value" }` of a recipe call, or null if not all literal. */
function recipeOptions(arg: ts.Expression | undefined): Record<string, string> | null {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  const out: Record<string, string> = {};
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) return null;
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (key === null) return null;
    if (!ts.isStringLiteral(prop.initializer)) return null;
    out[key] = prop.initializer.text;
  }
  return out;
}

interface Contribution {
  readonly tuples: Record<string, string>[];
  /** Literal class strings contributed directly at this node. */
  readonly literals: string[];
  /** Shapes the resolver refuses to model. Non-empty ⇒ failure. */
  readonly unresolved: string[];
}

/**
 * Static truthiness of a condition, when — and only when — it is a literal.
 * `undefined` means "not statically known", which is the conservative default.
 */
function staticTruthiness(node: ts.Expression): boolean | undefined {
  let n: ts.Expression = node;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) n = n.expression;
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(n) && n.text === "undefined") return false;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text.length > 0;
  if (ts.isNumericLiteral(n)) return Number(n.text) !== 0;
  return undefined;
}

/**
 * CONTROL FLOW.
 *
 * The previous version visited both arms of a conditional and both sides of a
 * logical operator and UNIONED the result, so `false ? surfaceVariants(…) :
 * "flex"` looked like it owned the recipe when at runtime the element only ever
 * gets `"flex"`. A union answers “could some path contribute the recipe?”;
 * ownership needs “does EVERY reachable path contribute it?”
 *
 * So an expression resolves to a list of ALTERNATIVES — one per runtime path —
 * and the caller requires every alternative to satisfy the contract
 * independently. Sequential composition (`cn(a, b)`, array elements, template
 * spans) is a cartesian product across alternatives. A statically-literal
 * condition collapses to the branch that actually runs; anything else keeps
 * both. Short-circuit outcomes are modelled explicitly, so the falsy path of
 * `cond && recipe` is a real alternative that contributes no recipe — and
 * therefore fails.
 */
function resolveClassNamePaths(sf: ts.SourceFile, expr: ts.Expression): Contribution[] {
  const EMPTY: Contribution = { tuples: [], literals: [], unresolved: [] };
  const merge = (a: Contribution, b: Contribution): Contribution => ({
    tuples: [...a.tuples, ...b.tuples],
    literals: [...a.literals, ...b.literals],
    unresolved: [...a.unresolved, ...b.unresolved],
  });
  const cross = (left: Contribution[], right: Contribution[]): Contribution[] =>
    left.flatMap((l) => right.map((r) => merge(l, r)));
  const only = (c: Partial<Contribution>): Contribution[] => [{ ...EMPTY, ...c }];

  const active = new Set<ts.Node>();

  const alts = (node: ts.Node): Contribution[] => {
    // Cycle guard: an alias that refers to itself resolves to a refusal, never
    // to infinite recursion.
    if (active.has(node)) return only({ unresolved: ["cyclic class expression"] });
    active.add(node);
    try {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return only({ literals: [node.text] });
      }
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
        return alts(node.expression);

      if (ts.isConditionalExpression(node)) {
        const known = staticTruthiness(node.condition);
        if (known === true) return alts(node.whenTrue);
        if (known === false) return alts(node.whenFalse);
        // Both arms are reachable, so both must own the recipe on their own.
        return [...alts(node.whenTrue), ...alts(node.whenFalse)];
      }

      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        const known = staticTruthiness(node.left);
        if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
          // left falsy ⇒ the VALUE is left's falsy value: no classes at all.
          if (known === true) return alts(node.right);
          if (known === false) return only({});
          return [...only({}), ...alts(node.right)];
        }
        if (op === ts.SyntaxKind.BarBarToken) {
          if (known === true) return alts(node.left);
          if (known === false) return alts(node.right);
          return [...alts(node.left), ...alts(node.right)];
        }
        if (op === ts.SyntaxKind.QuestionQuestionToken) {
          // Only `null`/`undefined` take the right side; other falsy values do not.
          const nullish =
            node.left.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(node.left) && node.left.text === "undefined");
          if (nullish) return alts(node.right);
          if (known !== undefined) return alts(node.left);
          return [...alts(node.left), ...alts(node.right)];
        }
        return only({ unresolved: [`unmodelled operator ${ts.tokenToString(op)}`] });
      }

      if (ts.isTemplateExpression(node)) {
        let paths = only({ literals: [node.head.text] });
        for (const span of node.templateSpans) {
          paths = cross(paths, alts(span.expression));
          paths = cross(paths, only({ literals: [span.literal.text] }));
        }
        return paths;
      }

      if (ts.isArrayLiteralExpression(node)) {
        let paths: Contribution[] = only({});
        for (const el of node.elements) {
          paths = cross(paths, alts(ts.isSpreadElement(el) ? el.expression : el));
        }
        return paths;
      }

      if (ts.isObjectLiteralExpression(node)) {
        const literals: string[] = [];
        const unresolved: string[] = [];
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property)) {
            const key = property.name;
            if (ts.isIdentifier(key) || ts.isStringLiteral(key)) literals.push(key.text);
            else if (ts.isComputedPropertyName(key) && ts.isStringLiteral(key.expression)) {
              literals.push(key.expression.text);
            } else unresolved.push("dynamic computed key in a class list");
          } else if (ts.isShorthandPropertyAssignment(property)) {
            literals.push(property.name.text);
          } else unresolved.push("spread inside a class object literal");
        }
        return only({ literals, unresolved });
      }

      if (ts.isCallExpression(node)) {
        if (!ts.isIdentifier(node.expression)) {
          return only({ unresolved: [`indirect call ${node.expression.getText(sf)}`] });
        }
        const callee = node.expression.text;
        // Identity, not spelling: a locally-declared or wrong-module
        // `surfaceVariants` is NOT the authority, and neither is a shadowed `cn`.
        if (isRecipeCall(sf, node.expression)) {
          const options = recipeOptions(node.arguments[0]);
          return options === null
            ? only({ unresolved: ["surfaceVariants called with a non-literal argument"] })
            : only({ tuples: [options] });
        }
        if (isCombinerCall(sf, node.expression)) {
          let paths: Contribution[] = only({});
          for (const argument of node.arguments) paths = cross(paths, alts(argument));
          return paths;
        }
        return only({
          unresolved: [
            `opaque call ${callee}(...) — not the canonical surfaceVariants or class combiner`,
          ],
        });
      }

      if (ts.isIdentifier(node)) {
        const bound = resolveBinding(sf, node);
        return bound.kind === "fail" ? only({ unresolved: [bound.reason] }) : alts(bound.init);
      }

      // A bare `true`/`false`/`null`/`undefined` in a class list contributes
      // nothing — which for a governed node means that path owns no recipe.
      if (
        node.kind === ts.SyntaxKind.TrueKeyword ||
        node.kind === ts.SyntaxKind.FalseKeyword ||
        node.kind === ts.SyntaxKind.NullKeyword ||
        ts.isNumericLiteral(node) ||
        (ts.isIdentifier(node) && (node as ts.Identifier).text === "undefined")
      ) {
        return only({});
      }
      return only({ unresolved: [`unmodelled ${ts.SyntaxKind[node.kind]}`] });
    } finally {
      active.delete(node);
    }
  };

  return alts(expr);
}

/**
 * Backwards-compatible single-contribution view, used only where the caller
 * genuinely wants the union (the reserved-card negative, which asserts that NO
 * path contributes a tuple).
 */
function resolveClassName(sf: ts.SourceFile, expr: ts.Expression): Contribution {
  const paths = resolveClassNamePaths(sf, expr);
  return {
    tuples: paths.flatMap((p) => p.tuples),
    literals: paths.flatMap((p) => p.literals),
    unresolved: paths.flatMap((p) => p.unresolved),
  };
}

/**
 * Normalize a Tailwind token to its terminal utility, stripping the WHOLE
 * variant chain rather than one prefix.
 *
 * The previous version removed a single `[a-z-]+:`, so `hover:bg-panel` was
 * caught but `dark:hover:bg-panel` and `2xl:bg-panel` walked past it. Splitting
 * on `:` at bracket depth zero handles arbitrary chains, digit-leading
 * breakpoints, and `data-[open]:` / `aria-[…]:` / `group-[…]:` segments whose
 * own colons live inside brackets.
 *
 * Returns `null` when the token cannot be proven — unbalanced brackets, an empty
 * terminal — so the caller fails closed instead of guessing.
 */
export function terminalUtility(token: string): string | null {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of token) {
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") {
      depth--;
      if (depth < 0) return null; // unbalanced
    }
    if (ch === ":" && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (depth !== 0) return null; // unbalanced
  segments.push(current);
  // EVERY segment must be non-empty, not just the terminal. `dark::flex` has a
  // balanced but EMPTY intermediate variant and previously slipped through,
  // contradicting the claim that balanced-but-empty tokens fail closed.
  if (segments.some((s) => s === "")) return null;
  const base = segments[segments.length - 1].replace(/^!/, "").replace(/!$/, "");
  return base === "" ? null : base;
}

/** Conventional utility prefixes the recipe owns. */
const OWNED_CHANNELS = /^-?(bg-|border($|-)|shadow($|-)|rounded($|-)|ring($|-))/;

/** CSS properties that carry tone, edge, elevation or radius. */
const VISUAL_PROPERTIES = new Set([
  "background",
  "background-color",
  "background-image",
  "border",
  "border-color",
  "border-width",
  "border-style",
  "border-radius",
  "box-shadow",
  "color",
  "outline",
  "outline-color",
  "fill",
  "stroke",
  "opacity",
  "filter",
  "backdrop-filter",
]);

/**
 * Whether a normalized utility takes a channel the recipe owns.
 *
 * Tailwind's arbitrary-PROPERTY form `[background:var(--color-panel)]` names a
 * CSS property directly, so it carries no conventional prefix — it passed this
 * oracle 20/20 while only the shared analyzer caught it. An arbitrary property
 * whose name cannot be parsed is treated as owning, so refusal is fail-closed.
 */
export function ownsRecipeChannel(base: string): boolean {
  if (base.startsWith("[")) {
    const named = base.match(/^\[\s*([a-zA-Z-]+)\s*:/);
    if (!named) return true; // cannot prove it is harmless
    return VISUAL_PROPERTIES.has(named[1].toLowerCase());
  }
  return OWNED_CHANNELS.test(base);
}

interface FoundNode {
  readonly line: number;
  /** The EFFECTIVE className after applying the attribute list in source order. */
  readonly className: ts.Expression | null;
  /** The EFFECTIVE style after applying the attribute list in source order. */
  readonly style: ts.Expression | null;
  /** Fatal problems found while modelling the attribute list. Non-empty ⇒ fail. */
  readonly attrProblems: string[];
}

/**
 * Resolve an expression to the property map of an object literal, following
 * immutable const aliases and nested spreads. `null` when it cannot be proven.
 */
function objectLiteralProps(
  sf: ts.SourceFile,
  expr: ts.Expression,
  depth = 0,
): Map<string, ts.Expression> | null {
  // Depth cap doubles as the cycle guard: `const A = { ...A }` cannot recur
  // forever, and a self-referential alias resolves to null rather than hanging.
  if (depth > 8) return null;
  let node: ts.Expression = expr;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
  if (ts.isIdentifier(node)) {
    // Resolved by SYMBOL, so a shadowed, hoisted, imported or ambiguous binding
    // is refused rather than answered by something merely spelled the same.
    const bound = resolveBinding(sf, node);
    return bound.kind === "ok" ? objectLiteralProps(sf, bound.init, depth + 1) : null;
  }
  if (!ts.isObjectLiteralExpression(node)) return null;
  const out = new Map<string, ts.Expression>();
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const inner = objectLiteralProps(sf, prop.expression, depth + 1);
      if (!inner) return null;
      for (const [k, v] of inner) out.set(k, v);
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) return null;
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (key === null) return null;
    out.set(key, prop.initializer);
  }
  return out;
}

/**
 * The inline style a node declares, resolved through immutable const aliases and
 * object spreads. Values are compared as SOURCE TEXT, so `42` and `"42px"` are
 * distinguishable and no evaluation is implied.
 */
function resolveStyle(
  sf: ts.SourceFile,
  expr: ts.Expression | null,
): { props: Record<string, string>; unresolved: string[] } {
  const props: Record<string, string> = {};
  const unresolved: string[] = [];
  const seen = new Set<ts.Node>();

  const visit = (node: ts.Node): void => {
    if (seen.has(node)) return;
    seen.add(node);

    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
      return visit(node.expression);
    if (ts.isIdentifier(node)) {
      const bound = resolveBinding(sf, node);
      if (bound.kind === "fail") {
        unresolved.push(`style alias: ${bound.reason}`);
        return;
      }
      return visit(bound.init);
    }
    if (!ts.isObjectLiteralExpression(node)) {
      unresolved.push(`style is ${ts.SyntaxKind[node.kind]}, which cannot be proven`);
      return;
    }
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        visit(prop.expression);
        continue;
      }
      if (!ts.isPropertyAssignment(prop)) {
        unresolved.push(`style has a ${ts.SyntaxKind[prop.kind]} member`);
        continue;
      }
      const key =
        ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
      if (key === null) {
        unresolved.push("style has a computed key");
        continue;
      }
      const value = prop.initializer;
      const isLiteral =
        ts.isStringLiteral(value) ||
        ts.isNumericLiteral(value) ||
        ts.isNoSubstitutionTemplateLiteral(value);
      if (!isLiteral) {
        unresolved.push(`style.${key} is dynamic (${ts.SyntaxKind[value.kind]})`);
        continue;
      }
      // Later assignments win, matching object-literal semantics.
      props[key] = value.getText(sf);
    }
  };

  if (expr) visit(expr);
  return { props, unresolved };
}

/** Every JSX element in `sf` whose `attr` matches, with its className expression. */
function findGoverned(sf: ts.SourceFile, surface: GovernedSurface): FoundNode[] {
  const found: FoundNode[] = [];
  const attrText = (a: ts.JsxAttribute): string | null => {
    const init = a.initializer;
    if (!init) return null;
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression) return init.expression.getText(sf);
    return null;
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      let matches = false;
      let className: ts.Expression | null = null;
      let style: ts.Expression | null = null;
      const attrProblems: string[] = [];
      // SOURCE ORDER, last-wins — which is what React actually does. A later
      // spread overrides an earlier explicit attribute, and an earlier spread is
      // genuinely overwritten by a later explicit one. The previous version
      // collapsed spreads into an unenforced boolean, so a trailing
      // `{...{ style: { backgroundColor } }}` transferred paint authority away
      // from the recipe with all 20 tests still green.
      for (const prop of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(prop)) {
          const props = objectLiteralProps(sf, prop.expression);
          if (!props) {
            attrProblems.push(
              `JSX spread {...${prop.expression.getText(sf).slice(0, 40)}} cannot be resolved, ` +
                `so it may carry className or style`,
            );
            continue;
          }
          if (props.has("className")) className = props.get("className")!;
          if (props.has("style")) style = props.get("style")!;
          continue;
        }
        if (!ts.isJsxAttribute(prop) || !ts.isIdentifier(prop.name)) continue;
        const name = prop.name.text;
        if (name === surface.attr) {
          const raw = attrText(prop);
          if (raw !== null) {
            matches =
              typeof surface.value === "string" ? raw === surface.value : surface.value(raw);
          }
        }
        if (name === "className") {
          const init = prop.initializer;
          if (init && ts.isJsxExpression(init) && init.expression) className = init.expression;
          else if (init && ts.isStringLiteral(init)) className = init;
          else attrProblems.push("className is present but has no resolvable initializer");
        }
        if (name === "style") {
          const init = prop.initializer;
          if (init && ts.isJsxExpression(init) && init.expression) style = init.expression;
          else attrProblems.push("style is present but has no resolvable initializer");
        }
      }
      if (matches) {
        found.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          className,
          style,
          attrProblems,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("inset-hairline surfaces are owned by the shared recipe, per node", () => {
  for (const surface of GOVERNED) {
    describe(`${surface.label} (${surface.file})`, () => {
      const sf = parse(surface.file);
      const nodes = findGoverned(sf, surface);

      it(`has exactly ${surface.count} governed node(s)`, () => {
        // Premise guard: if the attribute is renamed or a tile is dropped, this
        // fails rather than letting the per-node assertions pass vacuously.
        expect(
          nodes.length,
          `expected ${surface.count} node(s) with ${surface.attr}, found ${nodes.length}`,
        ).toBe(surface.count);
      });

      // One assertion PER INSTANCE, so raw-reimplementing any single one fails
      // even when its siblings still call the tuple.
      for (const [index, node] of nodes.entries()) {
        it(`instance ${index + 1} (line ${node.line}) is owned by the recipe`, () => {
          // Attribute-list modelling first: an unresolvable spread means the
          // effective className/style below cannot be trusted at all.
          expect(
            node.attrProblems,
            `line ${node.line} has attributes this oracle cannot model: ` +
              node.attrProblems.join("; "),
          ).toEqual([]);
          expect(node.className, "the governed node has no className").not.toBeNull();

          // EVERY runtime path must own the recipe on its own. A union across
          // branches would let `cond ? recipe : "flex"` pass while the element
          // sometimes renders with no recipe at all.
          const paths = resolveClassNamePaths(sf, node.className!);
          expect(paths.length, `line ${node.line} produced no class path`).toBeGreaterThan(0);

          paths.forEach((resolved, pathIndex) => {
            const where = `line ${node.line}, path ${pathIndex + 1} of ${paths.length}`;
            expect(
              resolved.unresolved,
              `${where} contains shapes this oracle refuses to model, so ownership ` +
                `cannot be proven: ${resolved.unresolved.join("; ")}`,
            ).toEqual([]);

            expect(
              resolved.tuples,
              `${where} must derive its surface from exactly one ` +
                `surfaceVariants(${JSON.stringify(GOVERNED_TUPLE)}) call, but contributed ` +
                `${JSON.stringify(resolved.tuples)}`,
            ).toEqual([{ ...GOVERNED_TUPLE }]);

            // No literal beside the recipe may re-state what the recipe owns.
            const tokens = resolved.literals.flatMap((lit) => lit.split(/\s+/)).filter(Boolean);
            const unprovable = tokens.filter((t) => terminalUtility(t) === null);
            expect(
              unprovable,
              `${where} has class tokens this oracle cannot normalize: ${unprovable.join(", ")}`,
            ).toEqual([]);
            const trespass = tokens.filter((t) => ownsRecipeChannel(terminalUtility(t)!));
            expect(
              trespass,
              `${where} hand-authors ${trespass.join(", ")} beside the recipe`,
            ).toEqual([]);
          });

          // INLINE STYLE. React's style wins over every class, so a node can own
          // the recipe's channels here without any class-level oracle noticing.
          // Only the exact load-bearing dimension for this target is allowed.
          const styleResult = resolveStyle(sf, node.style);
          expect(
            styleResult.unresolved,
            `line ${node.line} has an inline style this oracle cannot prove: ` +
              styleResult.unresolved.join("; "),
          ).toEqual([]);
          expect(
            styleResult.props,
            `line ${node.line} must declare exactly ${JSON.stringify(surface.style)} inline ` +
              `and nothing else — every other property, visual or not, is refused because ` +
              `inline style outranks the recipe`,
          ).toEqual({ ...surface.style });
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Adversarial fixtures for the ORACLE ITSELF.
  //
  // The live-source assertions above prove today's code is clean; they cannot
  // prove the oracle would notice if it stopped being clean. These parse small
  // in-memory sources and assert the verdict directly, so each escape route is
  // executable evidence rather than a claim. Nothing is written to the worktree.
  // -------------------------------------------------------------------------
  describe("oracle fixtures — inline style", () => {
    const TILE = {
      label: "fixture tile",
      file: "fixture.tsx",
      attr: "data-slot",
      value: "shift-tile",
      count: 1,
      style: { width: "42", height: "42" },
    } as const satisfies GovernedSurface;

    const fixture = (attrs: string) =>
      parseFixtureSource(
        `const BOX = { width: 42, height: 42 };\n` +
          `const X = <div data-slot="shift-tile" ${attrs} />;\n`,
      );

    const styleOf = (attrs: string) => {
      const sf = fixture(attrs);
      const nodes = findGoverned(sf, TILE);
      expect(nodes).toHaveLength(1);
      return resolveStyle(sf, nodes[0].style);
    };

    it("accepts the exact invariant dimensions, literal or via an alias", () => {
      expect(styleOf(`style={{ width: 42, height: 42 }}`)).toEqual({
        props: { width: "42", height: "42" },
        unresolved: [],
      });
      // The real spelling: an immutable module-level alias.
      expect(styleOf(`style={BOX}`).props).toEqual({ width: "42", height: "42" });
      // A spread of that alias resolves to the same thing.
      expect(styleOf(`style={{ ...BOX }}`).props).toEqual({ width: "42", height: "42" });
    });

    it("REJECTS the paint-identical backgroundColor escape", () => {
      // The exact mutation the closure review used: visually a no-op today, but
      // inline style outranks the recipe and stops tracking it.
      const result = styleOf(`style={{ ...BOX, backgroundColor: "var(--color-panel)" }}`);
      expect(result.unresolved).toEqual([]);
      expect(result.props).not.toEqual({ ...TILE.style });
      expect(result.props.backgroundColor).toBe('"var(--color-panel)"');
    });

    it.each([
      ["border", `style={{ ...BOX, border: "1px solid var(--color-line2)" }}`],
      ["boxShadow", `style={{ ...BOX, boxShadow: "inset 0 1px 2px rgba(0,0,0,.05)" }}`],
      ["borderRadius", `style={{ ...BOX, borderRadius: "12px" }}`],
      ["background", `style={{ ...BOX, background: "var(--color-panel)" }}`],
    ])("REJECTS an extra %s property", (_label, attrs) => {
      const result = styleOf(attrs);
      expect(result.props).not.toEqual({ ...TILE.style });
    });

    it("REJECTS a missing dimension", () => {
      expect(styleOf(`style={{ width: 42 }}`).props).not.toEqual({ ...TILE.style });
    });

    it("fails CLOSED on a dynamic or unprovable style", () => {
      expect(styleOf(`style={{ width: 42, height: computeHeight() }}`).unresolved).not.toEqual([]);
      expect(styleOf(`style={someProp}`).unresolved).not.toEqual([]);
      expect(styleOf(`style={{ ...spreadFromProps }}`).unresolved).not.toEqual([]);
      expect(styleOf(`style={cond ? BOX : OTHER}`).unresolved).not.toEqual([]);
    });

    // The escape the ultimate review demonstrated: a LATER spread wins over the
    // explicit legal style, exactly as React applies it. These assert the
    // oracle's verdict, not an unused metadata bit — which is why the previous
    // spread fixture passed while the hole was open.
    it("REJECTS a later spread that overrides an allowed style", () => {
      const sf = fixture(`style={BOX} {...{ style: { backgroundColor: "var(--color-panel)" } }}`);
      const node = findGoverned(sf, TILE)[0];
      expect(node.attrProblems).toEqual([]);
      const resolved = resolveStyle(sf, node.style);
      expect(resolved.props).toEqual({ backgroundColor: '"var(--color-panel)"' });
      expect(resolved.props).not.toEqual({ ...TILE.style });
    });

    it("REJECTS a later spread that overrides className", () => {
      const sf = fixture(`className={cn("flex", X)} {...{ className: "bg-panel shadow-well" }}`);
      const node = findGoverned(sf, TILE)[0];
      const resolved = resolveClassName(sf, node.className!);
      expect(resolved.tuples).toEqual([]); // the recipe contribution is gone
    });

    it("accepts an earlier illegal spread PROVABLY overwritten by a later legal style", () => {
      // Source order is modelled honestly: last wins, so this really is clean.
      const sf = fixture(
        `{...{ style: { backgroundColor: "var(--color-panel)" } }} style={{ width: 42, height: 42 }}`,
      );
      const node = findGoverned(sf, TILE)[0];
      expect(node.attrProblems).toEqual([]);
      expect(resolveStyle(sf, node.style).props).toEqual({ ...TILE.style });
    });

    it("fails CLOSED on an unresolvable JSX spread", () => {
      for (const attrs of [`{...rest} style={BOX}`, `style={BOX} {...props.extra}`]) {
        expect(findGoverned(fixture(attrs), TILE)[0].attrProblems).not.toEqual([]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Binding identity. The round-4 oracle keyed aliases by bare NAME across the
  // whole file, so a local illegal declaration could be answered by an unrelated
  // module-level one of the same name. Name equality is not binding identity.
  // -------------------------------------------------------------------------
  describe("oracle fixtures — lexical binding", () => {
    const RESERVED = {
      label: "fixture reserved card",
      file: "fixture.tsx",
      attr: "data-testid",
      value: (raw: string) => raw.includes("synthetic-"),
      count: 1,
      style: {},
    } as const satisfies GovernedSurface;

    const parseFixture = (src: string) => parseFixtureSource(src);

    const TILE = {
      label: "fixture tile",
      file: "fixture.tsx",
      attr: "data-slot",
      value: "shift-tile",
      count: 1,
      style: { width: "42", height: "42" },
    } as const satisfies GovernedSurface;

    /** The governed node's effective style, as the oracle would judge it. */
    const judge = (src: string) => {
      const sf = parseFixture(src);
      const nodes = findGoverned(sf, RESERVED);
      expect(nodes).toHaveLength(1);
      return { node: nodes[0], style: resolveStyle(sf, nodes[0].style) };
    };

    it("REJECTS a local illegal spread masked by a later module-level legal const", () => {
      // THE REPRODUCER. The local binding is what actually runs; the round-4
      // bare-name map returned the module-level one and passed the target.
      const { node, style } = judge(`
        function ReservedCard() {
          const REVIEW_SHADOW_PROPS = { style: { backgroundColor: "var(--color-panel)" } };
          return <div data-testid="synthetic-OFF" style={{}} {...REVIEW_SHADOW_PROPS} />;
        }
        const REVIEW_SHADOW_PROPS = { style: {} };
      `);
      expect(node.attrProblems).toEqual([]);
      // The LOCAL illegal binding won, so the effective style is not the allowlist.
      expect(style.props).toEqual({ backgroundColor: '"var(--color-panel)"' });
      expect(style.props).not.toEqual({ ...RESERVED.style });
    });

    it("ACCEPTS the inverse — local legal binding, module-level illegal of the same name", () => {
      const { style } = judge(`
        const REVIEW_SHADOW_PROPS = { style: { backgroundColor: "var(--color-panel)" } };
        function ReservedCard() {
          const REVIEW_SHADOW_PROPS = { style: {} };
          return <div data-testid="synthetic-OFF" {...REVIEW_SHADOW_PROPS} />;
        }
      `);
      expect(style.props).toEqual({});
    });

    it("honours a NESTED shadow — the innermost binding wins", () => {
      const { style } = judge(`
        const P = { style: {} };
        function Outer() {
          const P = { style: { border: "1px solid red" } };
          function Inner() {
            const P = { style: { backgroundColor: "var(--color-panel)" } };
            return <div data-testid="synthetic-OFF" {...P} />;
          }
          return Inner;
        }
      `);
      expect(style.props).toEqual({ backgroundColor: '"var(--color-panel)"' });
    });

    it("fails CLOSED when the only same-named const is in a SIBLING scope", () => {
      // Not visible from the use site, so there is no binding to resolve — and
      // the bare-name map would have handed over the sibling's value.
      // The spread cannot be resolved, so the failure surfaces on the ATTRIBUTE
      // LIST — which is the channel that makes the whole node unjudgeable.
      const { node } = judge(`
        function Sibling() {
          const P = { style: {} };
          return P;
        }
        function ReservedCard() {
          return <div data-testid="synthetic-OFF" {...P} />;
        }
      `);
      expect(node.attrProblems.length).toBeGreaterThan(0);
    });

    it.each([
      [
        "TDZ — used before its own declaration",
        `function R() {
           const el = <div data-testid="synthetic-OFF" {...P} />;
           const P = { style: {} };
           return el;
         }`,
      ],
      [
        "let, not const",
        `let P = { style: {} };
         const R = () => <div data-testid="synthetic-OFF" {...P} />;`,
      ],
      [
        "imported binding — initializer lives in another module",
        `import { P } from "./elsewhere";
         const R = () => <div data-testid="synthetic-OFF" {...P} />;`,
      ],
    ])("fails CLOSED on %s", (_label, src) => {
      expect(judge(src).node.attrProblems.length).toBeGreaterThan(0);
    });

    it.each([
      [
        "function declaration",
        `function P() { return { style: {} }; }
         const R = () => <div data-testid="synthetic-OFF" {...P} />;`,
        /not a const initializer/,
      ],
      [
        "class declaration",
        `class P { }
         const R = () => <div data-testid="synthetic-OFF" {...P} />;`,
        /not a const initializer/,
      ],
      [
        "destructured const",
        `const { P } = someObject;
         const R = () => <div data-testid="synthetic-OFF" {...P} />;`,
        /destructuring pattern/,
      ],
      [
        "callback parameter",
        `const R = items.map((P) => <div data-testid="synthetic-OFF" {...P} />);`,
        /not a const initializer/,
      ],
      [
        "declaration with no initializer",
        `declare const P: { style: object };
         const R = () => <div data-testid="synthetic-OFF" {...P} />;`,
        /no initializer/,
      ],
    ])("fails CLOSED on a %s, with a truthful reason", (_label, src, reason) => {
      const sf = parseFixtureSource(src);
      const node = findGoverned(sf, RESERVED)[0];
      // The spread itself is refused, so the node is unjudgeable — which is the
      // fail-closed outcome.
      expect(node.attrProblems.length).toBeGreaterThan(0);
      // And the underlying reason is the mechanism, not a generic message.
      const id = (() => {
        let found: ts.Identifier | undefined;
        const walk = (n: ts.Node) => {
          if (ts.isJsxSpreadAttribute(n) && ts.isIdentifier(n.expression)) found = n.expression;
          ts.forEachChild(n, walk);
        };
        walk(sf);
        return found!;
      })();
      const bound = resolveBinding(sf, id);
      expect(bound.kind).toBe("fail");
      if (bound.kind === "fail") expect(bound.reason).toMatch(reason);
    });

    it("leaves duplicate same-scope declarations to typecheck, which rejects them", () => {
      // Not an oracle guard, and saying otherwise would be false: TypeScript
      // treats a redeclared block-scoped const as a DIAGNOSTIC, not a merged
      // symbol — the checker still reports exactly one declaration, so the
      // "more than one declaration" refusal cannot fire. `pnpm typecheck` is a
      // required gate, so the codebase cannot contain this shape. Asserted here
      // against the real compiler rather than claimed about another tool.
      const sf = parseFixtureSource(`function R() {
           const P = { style: {} };
           const P = { style: { backgroundColor: "red" } };
           return <div data-testid="synthetic-OFF" {...P} />;
         }`);
      const { program } = analysisFor(sf);
      const errors = [
        ...program.getSemanticDiagnostics(sf),
        ...program.getSyntacticDiagnostics(sf),
      ];
      expect(errors.length, "a duplicate block-scoped const must not compile").toBeGreaterThan(0);
      expect(
        errors.some((d) => d.code === 2451),
        "expected TS2451 Cannot redeclare",
      ).toBe(true);
    });

    it("REJECTS the reviewer bypass — a nested-block `var` shadowing a legal module const", () => {
      // THE ROUND-5 HOLE. `var` is FUNCTION-scoped, so this hoists to R() and is
      // what actually runs; the lexical walker stopped at the block boundary and
      // resolved outward to the legal module-level const instead.
      const { node, style } = judge(`
        const SAFE = { style: {} };
        function R() {
          if (true) {
            var SAFE = { style: { backgroundColor: "var(--color-panel)" } };
          }
          return <div data-testid="synthetic-OFF" {...SAFE} />;
        }
      `);
      // Refused: a `var` is reassignable, so its value at the use site is not
      // provable — and it is emphatically NOT the module const.
      expect(node.attrProblems.length).toBeGreaterThan(0);
      expect(style.props).not.toEqual({ backgroundColor: '"var(--color-panel)"' });
      // And emphatically not resolved to the legal module const either.
      expect(style.props).toEqual({});
    });

    it("REJECTS a locally-declared or wrong-module `surfaceVariants`", () => {
      // Shadowed in-file: same spelling, different symbol.
      const shadowed = parseFixtureSource(
        `function surfaceVariants(_o?: unknown) { return "bg-panel shadow-well"; }\n` +
          `const X = <div data-slot="shift-tile" className={surfaceVariants({ role: "well", geometry: "control", emphasis: "hairline" })} />;\n`,
        "", // no canonical prelude — the local declaration is all there is
      );
      const local = findGoverned(shadowed, TILE)[0];
      expect(resolveClassName(shadowed, local.className!).tuples).toEqual([]);

      // Imported from the wrong module: also same spelling, different symbol.
      const wrongModule = parseFixtureSource(
        `const X = <div data-slot="shift-tile" className={surfaceVariants({ role: "well", geometry: "control", emphasis: "hairline" })} />;\n`,
        `import { surfaceVariants } from "@/impostor";\n`,
      );
      const wrong = findGoverned(wrongModule, TILE)[0];
      const resolved = resolveClassName(wrongModule, wrong.className!);
      expect(resolved.tuples, "an impostor module is not the authority").toEqual([]);
      expect(resolved.unresolved.length).toBeGreaterThan(0);
    });

    it("REJECTS a shadowed `cn`, so its arguments are not silently traversed", () => {
      const sf = parseFixtureSource(
        `function cn(...a: unknown[]) { return String(a); }\n` +
          `const X = <div data-slot="shift-tile" className={cn("flex", surfaceVariants({ role: "well", geometry: "control", emphasis: "hairline" }))} />;\n`,
        `import { surfaceVariants } from "@/components/ui/surface";\n`,
      );
      const node = findGoverned(sf, TILE)[0];
      const resolved = resolveClassName(sf, node.className!);
      // A non-canonical combiner is opaque; nothing inside it is credited.
      expect(resolved.tuples).toEqual([]);
      expect(resolved.unresolved.join(" ")).toMatch(/opaque call cn/);
    });

    it("ACCEPTS the canonical imports and aliases the live code actually uses", () => {
      const sf = parseFixtureSource(
        `const BOX = { width: 42, height: 42 };\n` +
          `const RECIPE = surfaceVariants({ role: "well", geometry: "control", emphasis: "hairline" });\n` +
          `const X = <div data-slot="shift-tile" style={BOX} className={cn("flex flex-none", RECIPE)} />;\n`,
      );
      const node = findGoverned(sf, TILE)[0];
      expect(node.attrProblems).toEqual([]);
      expect(resolveClassName(sf, node.className!).tuples).toEqual([
        { role: "well", geometry: "control", emphasis: "hairline" },
      ]);
      expect(resolveStyle(sf, node.style).props).toEqual({ width: "42", height: "42" });
    });

    it("fails CLOSED on a self-referential alias cycle", () => {
      const { node } = judge(`
        const A = { ...A };
        const R = () => <div data-testid="synthetic-OFF" {...A} />;
      `);
      expect(node.attrProblems.length).toBeGreaterThan(0);
    });

    it("resolves className aliases by symbol, not by bare name", () => {
      const sf = parseFixture(`
        function ReservedCard() {
          const CLS = "bg-panel shadow-well";
          return <div data-testid="synthetic-OFF" className={CLS} />;
        }
        const CLS = "flex";
      `);
      const node = findGoverned(sf, RESERVED)[0];
      const resolved = resolveClassName(sf, node.className!);
      // The LOCAL illegal string is what resolves, so the trespass is visible.
      const tokens = resolved.literals.flatMap((l) => l.split(/\s+/)).filter(Boolean);
      expect(tokens.filter((t) => ownsRecipeChannel(terminalUtility(t)!))).not.toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // CONTROL FLOW. The round-6 resolver unioned both arms of a conditional and
  // both sides of a logical operator, so an untaken branch could supply the
  // recipe for a path that never runs. Ownership is a property of EVERY
  // reachable path, not of their union.
  // -------------------------------------------------------------------------
  describe("oracle fixtures — control flow", () => {
    const TILE_CF = {
      label: "cf tile",
      file: "fixture.tsx",
      attr: "data-slot",
      value: "shift-tile",
      count: 1,
      style: {},
    } as const satisfies GovernedSurface;

    const RECIPE = `surfaceVariants({ role: "well", geometry: "control", emphasis: "hairline" })`;
    const TUPLE = { role: "well", geometry: "control", emphasis: "hairline" };

    /** Alternatives for a governed node whose className is `expr`. */
    const paths = (expr: string) => {
      const sf = parseFixtureSource(
        `const X = <div data-slot="shift-tile" className={${expr}} />;`,
      );
      const node = findGoverned(sf, TILE_CF)[0];
      return resolveClassNamePaths(sf, node.className!);
    };
    /** Does every path own exactly the governed tuple? */
    const everyPathOwns = (expr: string) => {
      const all = paths(expr);
      return (
        all.length > 0 &&
        all.every(
          (p) => p.unresolved.length === 0 && JSON.stringify(p.tuples) === JSON.stringify([TUPLE]),
        )
      );
    };

    it("REJECTS the `false ? recipe : flex` bypass, and its inverse", () => {
      // The untaken arm supplies the recipe; the live arm is a bare layout
      // string. A union said “owned”; per-path says the live path owns nothing.
      expect(everyPathOwns(`false ? ${RECIPE} : "flex"`)).toBe(false);
      expect(paths(`false ? ${RECIPE} : "flex"`)).toHaveLength(1); // collapsed to the live arm
      // Inverse: the live arm IS the recipe, so this is genuinely owned.
      expect(everyPathOwns(`false ? "flex" : ${RECIPE}`)).toBe(true);
      expect(everyPathOwns(`true ? ${RECIPE} : "flex"`)).toBe(true);
    });

    it("requires BOTH arms of a dynamic ternary to own the recipe", () => {
      expect(everyPathOwns(`cond ? ${RECIPE} : "flex"`)).toBe(false); // one arm only
      expect(everyPathOwns(`cond ? "flex" : ${RECIPE}`)).toBe(false);
      expect(everyPathOwns(`cond ? ${RECIPE} : ${RECIPE}`)).toBe(true); // both arms
      expect(paths(`cond ? ${RECIPE} : "flex"`)).toHaveLength(2);
    });

    it("models `&&` short-circuit: the falsy path contributes no recipe", () => {
      expect(everyPathOwns(`cond && ${RECIPE}`)).toBe(false);
      expect(everyPathOwns(`true && ${RECIPE}`)).toBe(true); // statically taken
      expect(everyPathOwns(`false && ${RECIPE}`)).toBe(false); // never runs
      expect(paths(`cond && ${RECIPE}`)).toHaveLength(2);
    });

    it("models `||` and `??` outcomes", () => {
      expect(everyPathOwns(`cond || ${RECIPE}`)).toBe(false); // truthy path is `cond`
      expect(everyPathOwns(`"" || ${RECIPE}`)).toBe(true); // statically falsy left
      expect(everyPathOwns(`"flex" || ${RECIPE}`)).toBe(false); // statically truthy left
      expect(everyPathOwns(`maybe ?? ${RECIPE}`)).toBe(false); // non-nullish path is `maybe`
      expect(everyPathOwns(`null ?? ${RECIPE}`)).toBe(true);
    });

    it("expands nested conditionals into every reachable path", () => {
      expect(everyPathOwns(`a ? (b ? ${RECIPE} : "flex") : ${RECIPE}`)).toBe(false);
      expect(everyPathOwns(`a ? (b ? ${RECIPE} : ${RECIPE}) : ${RECIPE}`)).toBe(true);
      expect(paths(`a ? (b ? "x" : "y") : "z"`)).toHaveLength(3);
    });

    it("keeps a conditional INSIDE cn() honest, per path", () => {
      // The live code shape, with a conditional smuggled in beside the recipe.
      expect(everyPathOwns(`cn("flex", ${RECIPE})`)).toBe(true);
      expect(everyPathOwns(`cn("flex", cond ? ${RECIPE} : "")`)).toBe(false);
      expect(everyPathOwns(`cn("flex", cond && "bg-panel", ${RECIPE})`)).toBe(true);
      // …but the trespassing token still shows up on the path that has it.
      const withTrespass = paths(`cn("flex", cond && "bg-panel", ${RECIPE})`);
      expect(withTrespass).toHaveLength(2);
      expect(withTrespass.some((p) => p.literals.includes("bg-panel"))).toBe(true);
    });
  });

  describe("oracle fixtures — variant chains", () => {
    it("normalizes an arbitrary chain to its terminal utility", () => {
      expect(terminalUtility("bg-panel")).toBe("bg-panel");
      expect(terminalUtility("hover:bg-panel")).toBe("bg-panel");
      // Both spellings that walked past the single-prefix regex.
      expect(terminalUtility("dark:hover:bg-panel")).toBe("bg-panel");
      expect(terminalUtility("2xl:bg-panel")).toBe("bg-panel");
      // Bracketed variants whose own colons must not split the chain.
      expect(terminalUtility("data-[open]:bg-panel")).toBe("bg-panel");
      expect(terminalUtility("group-[[data-x]:hover]:bg-panel")).toBe("bg-panel");
      expect(terminalUtility("aria-[sort=ascending]:dark:2xl:shadow-well")).toBe("shadow-well");
      expect(terminalUtility("peer-focus/name:rounded-control")).toBe("rounded-control");
      expect(terminalUtility("!hover:bg-panel")).toBe("bg-panel");
    });

    it("fails CLOSED on a token it cannot parse", () => {
      expect(terminalUtility("data-[open:bg-panel")).toBeNull(); // unbalanced
      expect(terminalUtility("hover:")).toBeNull(); // empty terminal
      expect(terminalUtility("bg-panel]")).toBeNull(); // unbalanced
      // Balanced but EMPTY intermediate segments — previously accepted, which
      // contradicted the documented closure.
      expect(terminalUtility("dark::flex")).toBeNull();
      expect(terminalUtility(":flex")).toBeNull();
      expect(terminalUtility("dark::hover:bg-panel")).toBeNull();
    });

    it("still catches every owned channel after normalization", () => {
      for (const token of [
        "dark:hover:bg-panel",
        "2xl:border-line2",
        "data-[open]:shadow-well",
        "md:rounded-control",
        "focus:ring-2",
      ]) {
        expect(ownsRecipeChannel(terminalUtility(token)!), token).toBe(true);
      }
    });

    it("treats an arbitrary PROPERTY naming a visual channel as ownership", () => {
      // No conventional prefix, so the old check waved these through 20/20.
      for (const token of [
        "[background:var(--color-panel)]",
        "dark:[background-color:red]",
        "[box-shadow:inset_0_1px_2px_rgba(0,0,0,.05)]",
        "hover:[border-radius:12px]",
        "[border:1px_solid_var(--color-line2)]",
      ]) {
        expect(ownsRecipeChannel(terminalUtility(token)!), token).toBe(true);
      }
      // An unparseable arbitrary property is refused rather than guessed at.
      expect(ownsRecipeChannel("[not-a-declaration]")).toBe(true);
      // A layout arbitrary property is still fine.
      expect(ownsRecipeChannel("[grid-area:header]")).toBe(false);
    });

    it("leaves legitimate layout utilities alone", () => {
      for (const token of [
        "flex",
        "flex-none",
        "items-center",
        "justify-center",
        "gap-1.5",
        "px-2.5",
        "overflow-hidden",
        "pointer-coarse:min-h-touch",
        "sm:grid-cols-2",
      ]) {
        expect(ownsRecipeChannel(terminalUtility(token)!), token).toBe(false);
      }
    });
  });

  it("the reserved card is explicitly NOT on the recipe, by adjudication", () => {
    // The cold review of `57ce7b6` adjudicated this: no role emits `--surface` +
    // a `--line2` hairline + no elevation, and inventing a foundation role for a
    // single justified composition is not warranted. Pinned so a later reader
    // does not "finish the job" — and bound to the NODE, not just the constant.
    const sf = parse("components/shift-types/shift-type-grid.tsx");
    const nodes = findGoverned(sf, {
      label: "reserved card",
      file: "components/shift-types/shift-type-grid.tsx",
      attr: "data-testid",
      value: (raw) => raw.includes("synthetic-") && !raw.includes("reason"),
      count: 1,
      // The reserved card owns nothing inline at all.
      style: {},
    });
    expect(nodes).toHaveLength(1);

    const resolved = resolveClassName(sf, nodes[0].className!);
    expect(resolved.unresolved).toEqual([]);
    // Deliberately NO recipe tuple here.
    expect(resolved.tuples).toEqual([]);
    // And it may not smuggle the composition back in through inline style.
    const reservedStyle = resolveStyle(sf, nodes[0].style);
    expect(reservedStyle.unresolved).toEqual([]);
    expect(reservedStyle.props).toEqual({});
    const tokens = resolved.literals.flatMap((l) => l.split(/\s+/)).filter(Boolean);
    expect(tokens).toContain("bg-surface");
    expect(tokens).toContain("border-line2");
    expect(tokens).toContain("rounded-card");
    expect(tokens.some((t) => t.startsWith("shadow-"))).toBe(false);
  });
});
