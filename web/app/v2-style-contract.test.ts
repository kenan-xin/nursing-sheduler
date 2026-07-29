import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import postcss, { type ChildNode, type Container } from "postcss";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { V2_OWNERS, V2_STYLE_OWNER_FILES, type V2Owner } from "../e2e/support/v2-surface-matrix";
import {
  activeSelector,
  matchesAnyGlob,
  ownerForPath,
  selectStyleOwnerPatternsFromEnv,
  STYLE_OWNER_ENV,
} from "../e2e/support/v2-owner-selection";

// ---------------------------------------------------------------------------
// F4 — the STATIC half of the split No-Black enforcement.
//
// `getComputedStyle()` discards where a value came from: a dark-mode shadow that
// resolves to `rgba(0, 0, 0, 0.34)` looks identical whether it arrived through
// `var(--sh-1)` or was typed by hand into a component. The runtime scanner in
// `e2e/support/v2-visual-audit.ts` therefore cannot judge provenance, and this
// file is the gate that can — it reads the SOURCE, so it sees the difference.
// Acceptance is the conjunction of the two; neither is sufficient alone.
//
// What is rejected: `black`, every zero-channel hex/rgb/hsl literal, arbitrary
// translucent-black literals, raw scrims, and consumer shadow literals — the
// last EVEN WHEN the literal is byte-identical to a canonical value, because a
// duplicate is exactly what stops tracking the token it was copied from.
//
// What is allowed, and nothing else: black inside the canonical dark `--sh-*`
// declarations, and black as a `color-mix()` derivation ENDPOINT (a mix input is
// not rendered paint — v2 technical plan, "Accent selection and derived tokens").
//
// Scope is `V2_STYLE_OWNER`, using the same owner vocabulary and the same frozen
// file sets as the browser matrix. Unset means `foundation`.
// ---------------------------------------------------------------------------

const WEB_ROOT = resolve(__dirname, "..");

// ===========================================================================
// Colour literals
// ===========================================================================

interface ColorLiteral {
  /** The literal exactly as authored. */
  text: string;
  r: number;
  g: number;
  b: number;
  a: number;
}

// One pass over a value, catching every authoring form a colour can take. The
// `black` keyword is matched on a word boundary so `blackboard` is not a colour.
const COLOR_LITERAL = new RegExp(
  [
    String.raw`#[0-9a-fA-F]{3,8}\b`,
    String.raw`\brgba?\([^()]*\)`,
    String.raw`\bhsla?\([^()]*\)`,
    String.raw`\bblack\b`,
  ].join("|"),
  "g",
);

function decodeHex(text: string): ColorLiteral | null {
  const raw = text.slice(1);
  const expand = (s: string) =>
    s
      .split("")
      .map((c) => c + c)
      .join("");
  let hex: string;
  if (raw.length === 3 || raw.length === 4) hex = expand(raw);
  else if (raw.length === 6 || raw.length === 8) hex = raw;
  else return null;
  const byte = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return {
    text,
    r: byte(0),
    g: byte(1),
    b: byte(2),
    a: hex.length === 8 ? byte(3) / 255 : 1,
  };
}

function decodeFunctional(text: string): ColorLiteral | null {
  const inner = text.slice(text.indexOf("(") + 1, text.lastIndexOf(")"));
  const parts = inner
    .split(/[,/]/)
    .flatMap((p) => p.trim().split(/\s+/))
    .filter((p) => p !== "");
  if (parts.length < 3) return null;

  const value = (p: string) => (p.endsWith("%") ? Number(p.slice(0, -1)) : Number(p));
  const nums = parts.map(value);
  if (nums.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  const alpha = parts.length >= 4 ? (parts[3].endsWith("%") ? nums[3] / 100 : nums[3]) : 1;
  if (!Number.isFinite(alpha)) return null;

  if (/^hsla?\(/i.test(text)) {
    // Only LIGHTNESS decides blackness in HSL: hsl(210, 80%, 0%) is black at any
    // hue or saturation, which is precisely how a black would sneak past a
    // channel-only check.
    const lightness = parts[2].endsWith("%") ? nums[2] : nums[2] * 100;
    const isBlack = lightness === 0;
    return { text, r: isBlack ? 0 : 1, g: isBlack ? 0 : 1, b: isBlack ? 0 : 1, a: alpha };
  }

  // rgb() percentages are 0..100 of 255; either way zero is zero.
  return { text, r: nums[0], g: nums[1], b: nums[2], a: alpha };
}

/** Decode one authored colour literal, or null when it is not one we model. */
export function decodeColorLiteral(text: string): ColorLiteral | null {
  if (text.toLowerCase() === "black") return { text, r: 0, g: 0, b: 0, a: 1 };
  if (text.startsWith("#")) return decodeHex(text);
  if (/^(?:rgba?|hsla?)\(/i.test(text)) return decodeFunctional(text);
  return null;
}

/** Every colour literal in a value, decoded. Undecodable tokens are dropped. */
export function findColorLiterals(value: string): ColorLiteral[] {
  return (value.match(COLOR_LITERAL) ?? [])
    .map(decodeColorLiteral)
    .filter((c): c is ColorLiteral => c !== null);
}

export function isBlackLiteral(color: ColorLiteral): boolean {
  return color.r === 0 && color.g === 0 && color.b === 0 && color.a > 0;
}

/** A translucent literal of ANY hue — the shape a hand-rolled scrim takes. */
export function isTranslucentLiteral(color: ColorLiteral): boolean {
  return color.a > 0 && color.a < 1;
}

// ===========================================================================
// Findings
// ===========================================================================

export interface StyleFinding {
  file: string;
  line: number;
  snippet: string;
  reason: string;
}

function formatFindings(findings: readonly StyleFinding[]): string {
  return findings
    .map((f) => `  ${f.file}:${f.line}\n    ${f.snippet}\n    └─ ${f.reason}`)
    .join("\n");
}

// ===========================================================================
// CSS provenance scanner
// ===========================================================================

/** The six canonical runtime elevation tokens. */
export const CANONICAL_SHADOW_TOKENS = [
  "--sh-1",
  "--sh-2",
  "--sh-3",
  "--sh-edge",
  "--sh-well",
  "--sh-side",
] as const;

const SHADOW_TOKEN_SET = new Set<string>(CANONICAL_SHADOW_TOKENS);

/** Properties whose value is elevation and must therefore alias a token. */
const SHADOW_PROPS = /^(?:box-shadow|text-shadow|-webkit-box-shadow)$/i;

/** Properties whose value paints a plane, where a translucent literal is a scrim. */
const BACKGROUND_PROPS = /^background(?:-color|-image)?$/i;

function selectorChain(node: ChildNode): string[] {
  const chain: string[] = [];
  let current: Container | undefined = node.parent as Container | undefined;
  while (current) {
    if (current.type === "rule")
      chain.unshift((current as unknown as { selector: string }).selector);
    else if (current.type === "atrule") {
      const at = current as unknown as { name: string; params: string };
      chain.unshift(`@${at.name} ${at.params}`);
    }
    current = current.parent as Container | undefined;
  }
  return chain;
}

/**
 * Whether a declaration is one of the canonical DARK shadow definitions — the
 * one place in the whole system where black is legitimately authored.
 *
 * Both halves are required. The property must be a canonical `--sh-*` token AND
 * the enclosing selector must be the dark theme: a black `--sh-1` in `:root`
 * would be a light-mode shadow painted black, which DESIGN.md §4 forbids in as
 * many words ("warm brown-tinted in light mode — never neutral grey or black").
 */
function isCanonicalDarkShadowDecl(prop: string, chain: readonly string[]): boolean {
  if (!SHADOW_TOKEN_SET.has(prop)) return false;
  return chain.some((selector) => /(^|[^\w-])\.dark\b/.test(selector));
}

/**
 * Strip every `color-mix(…)` call from a value, so its endpoints are excluded
 * from the literal scan. A mix input is a derivation term, not rendered paint.
 */
function stripColorMix(value: string): string {
  let out = value;
  for (;;) {
    const start = out.toLowerCase().indexOf("color-mix(");
    if (start === -1) return out;
    let depth = 0;
    let end = -1;
    for (let i = out.indexOf("(", start); i < out.length; i++) {
      if (out[i] === "(") depth++;
      else if (out[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) return out.slice(0, start);
    out = out.slice(0, start) + " " + out.slice(end + 1);
  }
}

/** Whether a value is nothing but `var(--sh-*)` references (plus `!important`). */
export function isTokenOnlyShadow(value: string): boolean {
  const stripped = value.replace(/!important/gi, "").trim();
  if (stripped === "" || /^(?:none|inherit|initial|unset|revert)$/i.test(stripped)) return true;
  const refs = [...stripped.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
  if (refs.length === 0) return false;
  if (!refs.every((ref) => SHADOW_TOKEN_SET.has(ref))) return false;
  // Nothing may remain once the var() calls are removed but separators — a
  // `var(--sh-1), 0 0 0 2px rgba(0,0,0,.5)` must not pass on its first term.
  const residue = stripped.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "").replace(/[\s,]/g, "");
  return residue === "";
}

/** Scan one CSS source for provenance violations. */
export function scanCssSource(file: string, css: string): StyleFinding[] {
  const findings: StyleFinding[] = [];
  const root = postcss.parse(css, { from: file });

  const push = (node: ChildNode, snippet: string, reason: string) => {
    findings.push({ file, line: node.source?.start?.line ?? 0, snippet, reason });
  };

  root.walkDecls((decl) => {
    const chain = selectorChain(decl);
    const snippet = `${decl.prop}: ${decl.value}`;

    // --- black provenance -------------------------------------------------
    if (!isCanonicalDarkShadowDecl(decl.prop, chain)) {
      for (const color of findColorLiterals(stripColorMix(decl.value))) {
        if (isBlackLiteral(color)) {
          push(
            decl,
            snippet,
            `authors the black literal ${JSON.stringify(color.text)}. Black is allowed only in the ` +
              `canonical .dark --sh-* declarations and as a color-mix() endpoint.`,
          );
        }
      }
    }

    // --- raw scrims -------------------------------------------------------
    // A translucent literal painting a plane is a hand-rolled scrim. Exactly two
    // declarations may author one: `--scrim`, the token every consumer is meant
    // to reach for instead, and the `--sh-*` elevation tokens, which are
    // translucent by construction. Custom properties are included in the check
    // so a second, differently-named scrim token cannot be introduced quietly.
    const authorsPlane = BACKGROUND_PROPS.test(decl.prop) || decl.prop.startsWith("--");
    const isScrimToken = decl.prop === "--scrim";
    if (authorsPlane && !isScrimToken && !SHADOW_TOKEN_SET.has(decl.prop)) {
      for (const color of findColorLiterals(stripColorMix(decl.value))) {
        if (isTranslucentLiteral(color)) {
          push(
            decl,
            snippet,
            `paints a plane with the translucent literal ${JSON.stringify(color.text)} — a raw scrim. ` +
              `Overlays use var(--scrim).`,
          );
        }
      }
    }

    // --- shadow provenance ------------------------------------------------
    // The `--sh-*` definitions ARE the values, so they are exempt; everything
    // else that sets elevation must alias one of them. A literal is rejected
    // even when it is byte-identical to the token it copies — a duplicate stops
    // tracking its source the moment either one is retuned.
    const definesToken = SHADOW_TOKEN_SET.has(decl.prop);
    const setsElevation = SHADOW_PROPS.test(decl.prop) || /^--shadow-[\w-]+$/.test(decl.prop);
    if (setsElevation && !definesToken && !isTokenOnlyShadow(decl.value)) {
      push(
        decl,
        snippet,
        `authors an elevation value directly. Every shadow must alias one of ` +
          `${CANONICAL_SHADOW_TOKENS.join(", ")} through var().`,
      );
    }
  });

  return findings;
}

// ===========================================================================
// TS/TSX provenance scanner
// ===========================================================================

/** Utility families whose `-black` form bypasses the ink ramp entirely. */
const BLACK_UTILITY =
  /^(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|caret|accent|divide|shadow|placeholder)-black(?:\/\d{1,3})?$/;

/** The only shadow utility suffixes the emitted theme actually publishes. */
const ALLOWED_SHADOW_SUFFIXES = new Set([
  "1",
  "2",
  "3",
  "edge",
  "well",
  "side",
  "dialog",
  "toast",
  "none",
  "inherit",
  "initial",
  "unset",
]);

/** Strip Tailwind variant prefixes (`hover:`, `dark:`, `pointer-coarse:`, `!`). */
function bareUtility(token: string): string {
  const last = token.lastIndexOf(":");
  const bare = last === -1 ? token : token.slice(last + 1);
  return bare.replace(/^!/, "");
}

/**
 * Judge one whitespace-delimited token from a class-list-shaped string literal.
 * Returns a reason, or null when the token is fine.
 */
export function judgeSourceToken(token: string): string | null {
  const bare = bareUtility(token);

  if (BLACK_UTILITY.test(bare)) {
    return `uses the Tailwind default-palette utility ${JSON.stringify(bare)}. The ink ramp is warm espresso; there is no black in it.`;
  }

  if (bare.startsWith("shadow-")) {
    const suffix = bare.slice("shadow-".length);
    if (suffix.startsWith("[")) {
      return `hand-authors the arbitrary elevation ${JSON.stringify(bare)}. Every shadow must alias one of the six --sh-* tokens, even when the value happens to match.`;
    }
    if (!ALLOWED_SHADOW_SUFFIXES.has(suffix)) {
      return `uses the untokened shadow utility ${JSON.stringify(bare)}. The published set is shadow-1/2/3/edge/well/side/dialog/toast.`;
    }
  }

  // An arbitrary value on any colour-bearing family, inspected for its contents.
  const arbitrary = bare.match(/^[\w-]+-\[(.+)\]$/);
  if (arbitrary) {
    const inner = arbitrary[1].replace(/_/g, " ");
    for (const color of findColorLiterals(inner)) {
      if (isBlackLiteral(color)) {
        return `hides the black literal ${JSON.stringify(color.text)} inside the arbitrary value ${JSON.stringify(bare)}.`;
      }
      if (isTranslucentLiteral(color)) {
        return `hides the translucent literal ${JSON.stringify(color.text)} inside the arbitrary value ${JSON.stringify(bare)} — a raw scrim. Use bg-scrim.`;
      }
    }
  }

  return null;
}

/** Judge a whole string literal's worth of tokens, plus any bare colour literal. */
export function judgeSourceString(text: string): string[] {
  const reasons: string[] = [];

  for (const token of text.split(/\s+/)) {
    if (token === "") continue;
    const reason = judgeSourceToken(token);
    if (reason) reasons.push(reason);
  }

  // A raw CSS colour anywhere in a source string — an inline style, a chart
  // series, a `style={{ boxShadow: "..." }}`. The `black` KEYWORD is deliberately
  // not matched here: unlike CSS, a source string is as likely to be prose as a
  // value, and "never neutral grey or black" in a documentation blurb is not a
  // contract violation. Every actual authoring form (#000, rgb(0 0 0), hsl with
  // zero lightness) is still caught.
  for (const color of findColorLiterals(text)) {
    if (color.text.toLowerCase() === "black") continue;
    if (isBlackLiteral(color)) {
      reasons.push(`authors the black colour literal ${JSON.stringify(color.text)}.`);
    }
  }

  return reasons;
}

/**
 * Scan a TS/TSX source's STRING and TEMPLATE literals.
 *
 * Deliberately AST-based rather than a regex over the raw text. `/design-system`
 * is a documentation page that talks about `shadow-[…]` and `bg-black/*` in
 * prose, and a text scan cannot tell a rule being described from a rule being
 * broken. JSX text and comments are not literals, so they are never inspected;
 * a class list always is.
 */
export function scanTsSource(file: string, source: string): StyleFinding[] {
  const findings: StyleFinding[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );

  const record = (node: ts.Node, text: string) => {
    for (const reason of judgeSourceString(text)) {
      findings.push({
        file,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        snippet: text.length > 120 ? `${text.slice(0, 117)}…` : text,
        reason,
      });
    }
  };

  /**
   * A template chunk that abuts an interpolation carries a PARTIAL token:
   * `` `shadow-${name}` `` has the head text `"shadow-"`, which is not a
   * utility anyone wrote. The partial fragment is dropped, and only at a
   * boundary the fragment actually touches — a chunk ending in whitespace ends
   * on a complete token and keeps it.
   *
   * The cost is real and bounded: a class assembled as `` `bg-${x}` `` is
   * invisible to this gate. That is the runtime scanner's half of the split —
   * it judges the paint that reaches the screen, whatever built the string.
   */
  const recordChunk = (node: ts.Node, text: string, partialStart: boolean, partialEnd: boolean) => {
    let out = text;
    if (partialStart && !/^\s/.test(out)) out = out.replace(/^\S+/, "");
    if (partialEnd && !/\s$/.test(out)) out = out.replace(/\S+$/, "");
    record(node, out);
  };

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      recordChunk(node.head, node.head.text, false, true);
      const spans = node.templateSpans;
      spans.forEach((span, i) =>
        recordChunk(span.literal, span.literal.text, true, i < spans.length - 1),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return findings;
}

/** Dispatch on extension. */
export function scanSource(file: string, content: string): StyleFinding[] {
  return file.endsWith(".css") ? scanCssSource(file, content) : scanTsSource(file, content);
}

// ===========================================================================
// The owner-selected scan
// ===========================================================================

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Every presentation-bearing source in the app, `web/`-relative and POSIX. */
function allPresentationSources(): string[] {
  return [...walk(join(WEB_ROOT, "app")), ...walk(join(WEB_ROOT, "components"))]
    .map((f) => relative(WEB_ROOT, f).split(sep).join("/"))
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".css"))
    .filter((f) => !/\.(?:test|spec)\.tsx?$/.test(f))
    .sort();
}

const ALL_SOURCES = allPresentationSources();
const SELECTED_PATTERNS = selectStyleOwnerPatternsFromEnv();
const SELECTOR = activeSelector(STYLE_OWNER_ENV);
const SELECTED_FILES = ALL_SOURCES.filter((f) => matchesAnyGlob(f, SELECTED_PATTERNS));

// ===========================================================================
// Owner selection
// ===========================================================================

describe(`static owner selection — ${STYLE_OWNER_ENV}=${SELECTOR}`, () => {
  it(`enumerates exactly the frozen ${SELECTOR} presentation owners`, () => {
    // Printed on failure AND readable in a passing run's verbose output, because
    // "the selector picked the right files" is a claim the ticket's own proof
    // command needs a human to be able to check by eye.
    const claimedByOthers = SELECTED_FILES.filter((f) => {
      const owner = ownerForPath(f);
      return SELECTOR !== "all" && owner !== SELECTOR;
    });
    expect(
      claimedByOthers,
      `files selected for ${SELECTOR} but owned by someone else: ${claimedByOthers.join(", ")}`,
    ).toEqual([]);

    expect(
      SELECTED_FILES.length,
      `resolved files:\n  ${SELECTED_FILES.join("\n  ")}`,
    ).toBeGreaterThan(0);
  });

  it("every presentation source has exactly one owner", () => {
    const unowned = ALL_SOURCES.filter((f) => ownerForPath(f) === undefined);
    expect(
      unowned,
      `presentation sources with no V2_STYLE_OWNER_FILES entry — add each to exactly one owner ` +
        `before it can be migrated:\n  ${unowned.join("\n  ")}`,
    ).toEqual([]);

    const shared = ALL_SOURCES.filter(
      (f) => V2_OWNERS.filter((o) => matchesAnyGlob(f, V2_STYLE_OWNER_FILES[o])).length > 1,
    );
    expect(
      shared,
      `presentation sources claimed by more than one owner — two parallel tickets could both ` +
        `edit them:\n  ${shared.join("\n  ")}`,
    ).toEqual([]);
  });
});

// ===========================================================================
// Adversarial fixtures — the scanner's own contract
// ===========================================================================

describe("CSS scanner — provenance, not spelling", () => {
  it("accepts the canonical dark shadow declarations", () => {
    const css = `.dark {\n  --sh-1: 0 1px 2px rgba(0, 0, 0, 0.34), 0 2px 8px rgba(0, 0, 0, 0.24);\n}`;
    expect(scanCssSource("fixture.css", css)).toEqual([]);
  });

  it("rejects the SAME value authored by a consumer", () => {
    // The whole point of the split: identical bytes, different provenance.
    const css = `.card {\n  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.34), 0 2px 8px rgba(0, 0, 0, 0.24);\n}`;
    const findings = scanCssSource("fixture.css", css);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((f) => f.reason).join(" ")).toMatch(/black literal|alias one of/);
  });

  it("rejects a consumer shadow literal even with no black in it", () => {
    const css = `.card {\n  box-shadow: 0 1px 2px rgba(60, 55, 45, 0.05);\n}`;
    expect(scanCssSource("fixture.css", css).map((f) => f.reason)).toEqual([
      expect.stringContaining("alias one of"),
    ]);
  });

  it("accepts a shadow that aliases a canonical token", () => {
    expect(scanCssSource("fixture.css", `.card { box-shadow: var(--sh-1); }`)).toEqual([]);
    expect(scanCssSource("fixture.css", `.t { box-shadow: var(--sh-3) !important; }`)).toEqual([]);
  });

  it("rejects a canonical token smuggled in beside a raw layer", () => {
    const css = `.card { box-shadow: var(--sh-1), 0 0 0 2px rgba(0, 0, 0, 0.5); }`;
    expect(scanCssSource("fixture.css", css).length).toBeGreaterThan(0);
  });

  it("rejects a black --sh-1 declared in :root rather than .dark", () => {
    // Light-mode shadows are warm brown; a black one here would be off-contract
    // even though the property name is canonical.
    const css = `:root { --sh-1: 0 1px 2px rgba(0, 0, 0, 0.34); }`;
    expect(scanCssSource("fixture.css", css).length).toBeGreaterThan(0);
  });

  it("allows black as a color-mix() endpoint", () => {
    const css = `:root { --brandink: color-mix(in srgb, var(--brand) 82%, black); }`;
    expect(scanCssSource("fixture.css", css)).toEqual([]);
  });

  it.each([
    ["#000", `.a { color: #000; }`],
    ["#000000", `.a { color: #000000; }`],
    ["a four-digit black with alpha", `.a { color: #0008; }`],
    ["an eight-digit black", `.a { color: #000000cc; }`],
    ["rgb() commas", `.a { color: rgb(0, 0, 0); }`],
    ["rgb() spaces", `.a { color: rgb(0 0 0); }`],
    ["rgba() alpha", `.a { color: rgba(0, 0, 0, 0.4); }`],
    ["slash alpha", `.a { color: rgb(0 0 0 / 40%); }`],
    ["the black keyword", `.a { color: black; }`],
    ["hsl zero lightness", `.a { color: hsl(210, 80%, 0%); }`],
  ])("rejects %s", (_label, css) => {
    expect(scanCssSource("fixture.css", css).length).toBeGreaterThan(0);
  });

  it("does not reject a non-black colour that merely contains zeros", () => {
    expect(scanCssSource("fixture.css", `.a { color: #0000ff; }`)).toEqual([]);
    expect(scanCssSource("fixture.css", `.a { color: rgb(0, 0, 255); }`)).toEqual([]);
    expect(scanCssSource("fixture.css", `.a { color: hsl(0, 0%, 100%); }`)).toEqual([]);
  });

  it("rejects a raw scrim and accepts the token", () => {
    expect(
      scanCssSource("fixture.css", `.overlay { background: rgba(17, 24, 22, 0.52); }`).length,
    ).toBeGreaterThan(0);
    expect(scanCssSource("fixture.css", `.overlay { background: var(--scrim); }`)).toEqual([]);
    expect(scanCssSource("fixture.css", `:root { --scrim: rgb(17 24 22 / 0.52); }`)).toEqual([]);
  });
});

describe("source scanner — class lists, never prose", () => {
  it.each([
    "bg-black",
    "bg-black/40",
    "text-black",
    "border-black",
    "shadow-black",
    "hover:bg-black",
    "dark:text-black",
  ])("rejects the utility %s", (token) => {
    expect(judgeSourceToken(token)).not.toBeNull();
  });

  it.each([
    "shadow-1",
    "shadow-2",
    "shadow-3",
    "shadow-edge",
    "shadow-well",
    "shadow-side",
    "shadow-dialog",
    "shadow-toast",
    "shadow-none",
    "hover:shadow-2",
  ])("accepts the published utility %s", (token) => {
    expect(judgeSourceToken(token)).toBeNull();
  });

  it.each(["shadow-sm", "shadow-md", "shadow-lg", "shadow-xl", "shadow-2xl"])(
    "rejects the untokened Tailwind default %s",
    (token) => {
      expect(judgeSourceToken(token)).toMatch(/untokened/);
    },
  );

  it("rejects an arbitrary shadow even when its value is a canonical token", () => {
    expect(judgeSourceToken("shadow-[var(--sh-1)]")).toMatch(/arbitrary elevation/);
    expect(judgeSourceToken("shadow-[inset_0_2px_0_var(--color-brand)]")).toMatch(
      /arbitrary elevation/,
    );
  });

  it("rejects a black hidden inside an arbitrary value", () => {
    expect(judgeSourceToken("bg-[rgba(0,0,0,0.4)]")).toMatch(/black literal/);
    expect(judgeSourceToken("bg-[#000000]")).toMatch(/black literal/);
    expect(judgeSourceToken("bg-[rgba(17,24,22,0.52)]")).toMatch(/raw scrim/);
  });

  it("rejects a raw black literal in any source string", () => {
    expect(judgeSourceString('{ boxShadow: "0 0 4px #000" }')).not.toEqual([]);
    expect(judgeSourceString("rgba(0, 0, 0, 0.5)")).not.toEqual([]);
  });

  it("does not fire on documentation prose that NAMES the rule", () => {
    // The design-system guide says these things out loud, and must be able to.
    expect(
      judgeSourceString(
        "All are warm brown-tinted in light mode — never neutral grey or black — and all re-tint per theme.",
      ),
    ).toEqual([]);
    expect(
      judgeSourceString("Raw bg-black/* and fixed near-black RGBA overlays are off-contract."),
    ).toEqual([]);
  });

  it("reads class lists but not JSX text or comments", () => {
    const source = [
      "// shadow-[inset_0_2px_0_red] in a comment is not authored style",
      'export const A = () => <p className="text-ink">shadow-[inset_0_2px_0_red]</p>;',
    ].join("\n");
    expect(scanTsSource("fixture.tsx", source)).toEqual([]);
  });

  it("reads a template literal's static chunks", () => {
    const source = "const cls = `border ${x ? 'shadow-[inset_0_2px_0_red]' : ''} p-2`;";
    expect(scanTsSource("fixture.tsx", source).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// The real scan
// ===========================================================================

describe(`No-Black provenance — ${SELECTOR} sources`, () => {
  it("selects at least one file to scan", () => {
    // An empty selection and a clean selection produce the same empty findings
    // list, and those two outcomes must never be confused.
    expect(SELECTED_FILES, `patterns: ${SELECTED_PATTERNS.join(", ")}`).not.toEqual([]);
  });

  it("no selected source authors black, a raw scrim, or a shadow literal", () => {
    const findings = SELECTED_FILES.flatMap((file) =>
      scanSource(file, readFileSync(join(WEB_ROOT, file), "utf8")),
    );
    expect(
      findings,
      `${findings.length} provenance violation(s) in the ${SELECTOR} owner set:\n${formatFindings(findings)}`,
    ).toEqual([]);
  });
});

// ===========================================================================
// The Tailwind alias table (foundation-owned)
// ===========================================================================

const FOUNDATION_SELECTED = (SELECTOR as V2Owner | "all") === "foundation" || SELECTOR === "all";

// globals.css is a foundation-owned file, so this contract belongs to the
// foundation scan. Under `V2_STYLE_OWNER=R6` it is correctly out of scope: R6
// does not own the emitted theme and cannot break it.
//
// A plain `if`, not `describe.runIf` — same reason the browser suites filter the
// manifest before calling `test()`. `runIf` REGISTERS the block and reports it
// as skipped, and a growing skip count is the exact signal this epic refuses to
// accumulate. Out of scope means absent, not pending.
if (FOUNDATION_SELECTED) {
  describe("every shadow utility aliases a runtime --sh-* token", () => {
    const globals = readFileSync(join(WEB_ROOT, "app", "globals.css"), "utf8");

    it.each([
      ["--shadow-1", "--sh-1"],
      ["--shadow-2", "--sh-2"],
      ["--shadow-3", "--sh-3"],
      ["--shadow-edge", "--sh-edge"],
      ["--shadow-well", "--sh-well"],
      // The directional exception. The runtime and Tailwind namespace names differ
      // on purpose, so the emitted theme contains no self-reference (T7).
      ["--shadow-side", "--sh-side"],
      // Semantic aliases of the modal layer, carrying no independent value.
      ["--shadow-dialog", "--sh-3"],
      ["--shadow-toast", "--sh-3"],
    ])("%s: var(%s)", (alias, runtime) => {
      expect(globals).toContain(`${alias}: var(${runtime});`);
    });

    it("publishes no shadow alias outside that set", () => {
      const declared = [...globals.matchAll(/(--shadow-[\w-]+)\s*:/g)].map((m) => m[1]);
      expect([...new Set(declared)].sort()).toEqual([
        "--shadow-1",
        "--shadow-2",
        "--shadow-3",
        "--shadow-dialog",
        "--shadow-edge",
        "--shadow-side",
        "--shadow-toast",
        "--shadow-well",
      ]);
    });

    it("gives the ROOT element the ink colour, not the UA default black", () => {
      // DESIGN.md §2: nothing inherits the UA default black. <body> alone is not
      // enough — <html> is an element too, and it computed rgb(0, 0, 0) until F4's
      // runtime scanner read it. Pinned statically as well so the declaration
      // cannot later be dropped as "redundant with body".
      const base = globals.slice(globals.indexOf("@layer base"));
      const html = base.slice(base.indexOf("html {"), base.indexOf("body {"));
      expect(html).toContain("color: var(--ink);");
    });

    it("declares each canonical token exactly twice — one light, one dark", () => {
      for (const token of CANONICAL_SHADOW_TOKENS) {
        const authored = globals.match(new RegExp(`${token}:`, "g")) ?? [];
        expect(authored, `${token} declarations`).toHaveLength(2);
      }
    });
  });
}
