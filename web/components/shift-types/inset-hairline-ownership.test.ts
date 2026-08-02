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
  },
  {
    label: "working-time readout",
    file: "components/entity-editor/working-time-fields.tsx",
    attr: "data-testid",
    value: (raw) => raw.includes("-duration"),
    count: 1,
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

/** Module-level `const NAME = <expr>` initializers, for alias resolution. */
function constInitializers(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      out.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
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
  const consts = constInitializers(sf);
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
      const init = consts.get(node.text);
      if (!init) {
        unresolved.push(`unresolved identifier ${node.text}`);
        return;
      }
      visit(init);
      return;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return;
    unresolved.push(`unmodelled ${ts.SyntaxKind[node.kind]}`);
  };

  visit(expr);
  return { tuples, literals, unresolved };
}

interface FoundNode {
  readonly line: number;
  readonly className: ts.Expression | null;
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
      for (const prop of node.attributes.properties) {
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
        }
      }
      if (matches) {
        found.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          className,
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

          // And no literal beside the recipe may re-state what the recipe owns.
          const OWNED_CHANNELS = /^(bg-|border($|-)|shadow-|rounded-)/;
          const trespass = resolved.literals
            .flatMap((lit) => lit.split(/\s+/))
            .filter(Boolean)
            .map((token) => token.replace(/^[a-z-]+:/, ""))
            .filter((token) => OWNED_CHANNELS.test(token));
          expect(
            trespass,
            `line ${node.line} hand-authors ${trespass.join(", ")} beside the recipe`,
          ).toEqual([]);
        });
      }
    });
  }

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
    });
    expect(nodes).toHaveLength(1);

    const resolved = resolveClassName(sf, nodes[0].className!);
    expect(resolved.unresolved).toEqual([]);
    // Deliberately NO recipe tuple here.
    expect(resolved.tuples).toEqual([]);
    const tokens = resolved.literals.flatMap((l) => l.split(/\s+/)).filter(Boolean);
    expect(tokens).toContain("bg-surface");
    expect(tokens).toContain("border-line2");
    expect(tokens).toContain("rounded-card");
    expect(tokens.some((t) => t.startsWith("shadow-"))).toBe(false);
  });
});
