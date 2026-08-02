import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

function parse(relPath: string): ts.SourceFile {
  return ts.createSourceFile(
    relPath,
    readFileSync(resolve(WEB_ROOT, relPath), "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );
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

/** Does this node introduce a declaration scope? */
function isScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** Declarations of `name` introduced DIRECTLY by this scope, not by nested ones. */
function declarationsInScope(scope: ts.Node, name: string): ts.Node[] {
  const hits: ts.Node[] = [];
  const scan = (node: ts.Node) => {
    // Never descend into a nested scope: those are different bindings.
    if (isScopeBoundary(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      hits.push(node);
    } else if (ts.isImportSpecifier(node) && node.name.text === name) {
      hits.push(node);
    } else if (ts.isNamespaceImport(node) && node.name.text === name) {
      hits.push(node);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      hits.push(node);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      hits.push(node);
    }
    ts.forEachChild(node, scan);
  };
  ts.forEachChild(scope, scan);
  return hits;
}

function resolveBinding(useSite: ts.Node, name: string): Binding {
  for (let scope: ts.Node | undefined = useSite; scope; scope = scope.parent) {
    if (!isScopeBoundary(scope)) continue;
    const hits = declarationsInScope(scope, name);
    if (hits.length === 0) continue; // not declared here — look outward

    if (hits.length > 1) {
      return { kind: "fail", reason: `"${name}" has ${hits.length} declarations in one scope` };
    }
    const decl = hits[0];
    if (!ts.isVariableDeclaration(decl)) {
      return {
        kind: "fail",
        reason: `"${name}" resolves to a ${ts.SyntaxKind[decl.kind]}, not a const initializer`,
      };
    }
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) {
      return { kind: "fail", reason: `"${name}" is not a const binding` };
    }
    if (!decl.initializer) return { kind: "fail", reason: `"${name}" has no initializer` };
    // Temporal dead zone: a const used before its own declaration is a runtime
    // error, never a silent fallback to some other binding of the same name.
    if (decl.getStart() > useSite.getStart()) {
      return { kind: "fail", reason: `"${name}" is used before it is declared (TDZ)` };
    }
    return { kind: "ok", init: decl.initializer };
  }
  return { kind: "fail", reason: `no visible binding for "${name}"` };
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
 * What a `className` expression actually contributes, resolved through `cn` and
 * immutable const aliases. Fail-closed by construction.
 */
function resolveClassName(sf: ts.SourceFile, expr: ts.Expression): Contribution {
  const tuples: Record<string, string>[] = [];
  const literals: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<ts.Node>();

  const visit = (node: ts.Node): void => {
    if (seen.has(node)) return;
    seen.add(node);

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push(node.text);
      return;
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
      return visit(node.expression);
    if (ts.isConditionalExpression(node)) {
      visit(node.whenTrue);
      visit(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      visit(node.left);
      visit(node.right);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      literals.push(node.head.text);
      for (const span of node.templateSpans) {
        visit(span.expression);
        literals.push(span.literal.text);
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      if (!ts.isIdentifier(node.expression)) {
        unresolved.push(`indirect call ${node.expression.getText(sf)}`);
        return;
      }
      const callee = node.expression.text;
      if (callee === "surfaceVariants") {
        const options = recipeOptions(node.arguments[0]);
        if (options === null) unresolved.push("surfaceVariants called with a non-literal argument");
        else tuples.push(options);
        return;
      }
      if (callee === "cn" || callee === "clsx" || callee === "twMerge") {
        node.arguments.forEach(visit);
        return;
      }
      unresolved.push(`opaque call ${callee}(...)`);
      return;
    }
    if (ts.isIdentifier(node)) {
      const bound = resolveBinding(node, node.text);
      if (bound.kind === "fail") {
        unresolved.push(bound.reason);
        return;
      }
      visit(bound.init);
      return;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return;
    unresolved.push(`unmodelled ${ts.SyntaxKind[node.kind]}`);
  };

  visit(expr);
  return { tuples, literals, unresolved };
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
function objectLiteralProps(expr: ts.Expression, depth = 0): Map<string, ts.Expression> | null {
  if (depth > 8) return null;
  let node: ts.Expression = expr;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
  if (ts.isIdentifier(node)) {
    // Resolved from the USE SITE, so a shadowed or unprovable binding is refused
    // rather than answered by an unrelated declaration of the same name.
    const bound = resolveBinding(node, node.text);
    return bound.kind === "ok" ? objectLiteralProps(bound.init, depth + 1) : null;
  }
  if (!ts.isObjectLiteralExpression(node)) return null;
  const out = new Map<string, ts.Expression>();
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const inner = objectLiteralProps(prop.expression, depth + 1);
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
      const bound = resolveBinding(node, node.text);
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
          const props = objectLiteralProps(prop.expression);
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
          const resolved = resolveClassName(sf, node.className!);

          expect(
            resolved.unresolved,
            `className contains shapes this oracle refuses to model, so ownership ` +
              `cannot be proven: ${resolved.unresolved.join("; ")}`,
          ).toEqual([]);

          expect(
            resolved.tuples,
            `line ${node.line} must derive its surface from exactly one ` +
              `surfaceVariants(${JSON.stringify(GOVERNED_TUPLE)}) call, but contributed ` +
              `${JSON.stringify(resolved.tuples)}`,
          ).toEqual([{ ...GOVERNED_TUPLE }]);

          // No literal beside the recipe may re-state what the recipe owns.
          // Variant chains are normalized to their terminal utility, and an
          // unprovable token fails rather than being waved through.
          const tokens = resolved.literals.flatMap((lit) => lit.split(/\s+/)).filter(Boolean);
          const unprovable = tokens.filter((t) => terminalUtility(t) === null);
          expect(
            unprovable,
            `line ${node.line} has class tokens this oracle cannot normalize: ${unprovable.join(", ")}`,
          ).toEqual([]);
          const trespass = tokens.filter((t) => ownsRecipeChannel(terminalUtility(t)!));
          expect(
            trespass,
            `line ${node.line} hand-authors ${trespass.join(", ")} beside the recipe`,
          ).toEqual([]);

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
      ts.createSourceFile(
        "fixture.tsx",
        `const BOX = { width: 42, height: 42 };\n` +
          `const X = <div data-slot="shift-tile" ${attrs} />;\n`,
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TSX,
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

    const parseFixture = (src: string) =>
      ts.createSourceFile("fixture.tsx", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);

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
      [
        "declared twice in one scope",
        `function R() {
           const P = { style: {} };
           const P = { style: { backgroundColor: "red" } };
           return <div data-testid="synthetic-OFF" {...P} />;
         }`,
      ],
    ])("fails CLOSED on %s", (_label, src) => {
      expect(judge(src).node.attrProblems.length).toBeGreaterThan(0);
    });

    it("resolves className aliases lexically too, not by bare name", () => {
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
