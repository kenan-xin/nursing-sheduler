// F4 — the runtime half of the v2 visual gate.
//
// Split of responsibility, deliberately: the BROWSER only collects (computed
// paint, canvas pixels, rectangles, axe results) and NODE judges. Every rule
// worth arguing about — what counts as black, how alpha composites, which axe
// node an exception covers — is a pure function exported from this module and
// exercised directly by `v2-visual-audit.test.ts`, rather than living inside a
// `page.evaluate` string where a regression is only visible as a green suite.
//
// This is the RUNTIME side of the split No-Black enforcement. It judges resolved
// paint and makes no claim about provenance, because `getComputedStyle()`
// discards it: a shadow that resolves to the exact canonical dark value is
// accepted here precisely because `app/v2-style-contract.test.ts` has already
// proved that value came from `var(--sh-*)` and not from a hand-typed literal.
// Neither gate is sufficient alone; acceptance is their conjunction.

import type { Page } from "@playwright/test";
import type { AxeResults, Result as AxeResult } from "axe-core";
import {
  V2_RADIUS_CONTRACT,
  V2_ROLE_CONTRACT,
  type V2AxeException,
  type V2Row,
} from "./v2-surface-matrix";

// ===========================================================================
// Colour model
// ===========================================================================

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;

const RGB_FUNCTIONAL = new RegExp(
  `^rgba?\\(\\s*(${NUM})%?[\\s,]+(${NUM})%?[\\s,]+(${NUM})%?(?:\\s*[,/]\\s*(${NUM})(%?))?\\s*\\)$`,
);

const COLOR_SRGB = new RegExp(
  `^color\\(\\s*srgb\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})(?:\\s*/\\s*(${NUM})(%?))?\\s*\\)$`,
);

/**
 * Parse a COMPUTED colour into 0..255 channels plus 0..1 alpha.
 *
 * Scope is exactly what Chromium serializes for a computed value: `rgb()`,
 * `rgba()`, the space-separated slash form, `color(srgb …)` (what a resolved
 * `color-mix()` becomes), and the two keywords a computed style can still carry.
 * Author-time forms like `#332e2b` or `oklch()` are deliberately NOT parsed —
 * they never appear in a computed value, and accepting them here would let this
 * function be reused as an authoring-side check it was not designed to be.
 *
 * Returns `null` for anything unrecognized, and callers must treat `null` as
 * "cannot judge" rather than "fine".
 */
export function parseCssColor(value: string): Rgba | null {
  const raw = value.trim().toLowerCase();
  if (raw === "" || raw === "none") return null;
  if (raw === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  // `currentcolor` resolves before it reaches a computed value in every property
  // this module reads, so seeing it means we are looking at something other than
  // a resolved paint.
  if (raw === "currentcolor") return null;

  const functional = raw.match(RGB_FUNCTIONAL);
  if (functional) {
    const [r, g, b] = functional.slice(1, 4).map(Number);
    const a = parseAlpha(functional[4], functional[5]);
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
  }

  const srgb = raw.match(COLOR_SRGB);
  if (srgb) {
    const [r, g, b] = srgb.slice(1, 4).map(Number);
    const a = parseAlpha(srgb[4], srgb[5]);
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return {
      r: clamp(r * 255, 0, 255),
      g: clamp(g * 255, 0, 255),
      b: clamp(b * 255, 0, 255),
      a: clamp(a, 0, 1),
    };
  }

  return null;
}

function parseAlpha(raw: string | undefined, percent: string | undefined): number {
  if (raw === undefined) return 1;
  const n = Number(raw);
  return percent === "%" ? n / 100 : n;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * True for a fully opaque `rgb(0, 0, 0)`. This is the No-Black Rule's actual
 * subject: DESIGN.md says a control that RENDERS `rgb(0,0,0)` is a bug.
 *
 * The channel test is exact, not a near-black tolerance. `#010101` is not a
 * violation — it is a different, deliberate colour, and treating it as one would
 * make the rule about taste rather than about the specific failure (a control
 * inheriting the UA default) it exists to catch.
 */
export function isOpaquePureBlack(color: Rgba | null): boolean {
  return color !== null && color.a === 1 && color.r === 0 && color.g === 0 && color.b === 0;
}

/** True for any black with an alpha strictly between 0 and 1. */
export function isTranslucentBlack(color: Rgba | null): boolean {
  return (
    color !== null && color.a > 0 && color.a < 1 && color.r === 0 && color.g === 0 && color.b === 0
  );
}

/** True for black at any alpha above zero — the union of the two above. */
export function isBlackPaint(color: Rgba | null): boolean {
  return isOpaquePureBlack(color) || isTranslucentBlack(color);
}

/** Standard source-over compositing of `fg` onto an opaque-enough `bg`. */
export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const blend = (f: number, b: number) => (f * fg.a + b * bg.a * (1 - fg.a)) / a;
  return { r: blend(fg.r, bg.r), g: blend(fg.g, bg.g), b: blend(fg.b, bg.b), a };
}

/**
 * Composite a stack of layers, nearest-first, onto an implicit white base.
 *
 * White is the base because that is what a browser paints onto below the
 * canvas background, and because assuming BLACK would manufacture the very
 * violation this scanner looks for out of a page that has none.
 */
export function compositeStack(layers: readonly Rgba[]): Rgba {
  let out: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  for (const layer of [...layers].reverse()) out = compositeOver(layer, out);
  return out;
}

export function formatRgba(c: Rgba): string {
  const round = (n: number) => Math.round(n * 100) / 100;
  return `rgba(${round(c.r)}, ${round(c.g)}, ${round(c.b)}, ${round(c.a)})`;
}

// ===========================================================================
// Non-solid paint
// ===========================================================================

/**
 * True when a value describes paint this scanner cannot reconstruct
 * analytically: a gradient, an image, an SVG paint server, a mask, or a filter.
 *
 * These are NOT failures. They are the honest boundary of an analytic composite
 * check — guessing at what a gradient resolves to per-pixel would be inventing
 * evidence. Callers surface them as owner-specific diagnostics and the
 * deterministic screenshot baselines carry the actual proof.
 */
export function isNonSolidPaint(value: string): boolean {
  const raw = value.trim().toLowerCase();
  if (raw === "" || raw === "none") return false;
  return /gradient\(|url\(|image-set\(|cross-fade\(|element\(|paint\(/.test(raw);
}

/** True when a filter / backdrop-filter is doing something other than nothing. */
export function isActiveFilter(value: string): boolean {
  const raw = value.trim().toLowerCase();
  return raw !== "" && raw !== "none";
}

// ===========================================================================
// Shadows
// ===========================================================================

/**
 * Split a computed `box-shadow` / `text-shadow` into its comma-separated layers,
 * respecting parentheses so `rgba(0, 0, 0, 0.34)` is not torn in half by its own
 * commas.
 */
export function splitShadowLayers(value: string): string[] {
  const raw = value.trim();
  if (raw === "" || raw.toLowerCase() === "none") return [];
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(raw.slice(start).trim());
  return out.filter((layer) => layer !== "");
}

/** Every colour token inside one shadow layer. */
export function shadowLayerColors(layer: string): Rgba[] {
  const matches = layer.match(new RegExp(`rgba?\\([^)]*\\)|color\\([^)]*\\)`, "g")) ?? [];
  return matches.map(parseCssColor).filter((c): c is Rgba => c !== null);
}

/** Normalize a shadow value for exact comparison against a resolved token. */
export function normalizeShadow(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ");
}

/**
 * Judge one computed shadow value against the resolved canonical set.
 *
 * A shadow whose value is EXACTLY one of the six resolved `--sh-*` tokens passes
 * even in dark mode, where those tokens are genuinely black — that is the whole
 * point of splitting the gate. Anything else containing black is rejected,
 * INCLUDING a hand-authored literal that happens to equal a canonical value in
 * the current theme, because the static scanner is what proves provenance and
 * this side deliberately refuses to infer it.
 */
export function judgeShadow(value: string, canonical: readonly string[]): string | null {
  const layers = splitShadowLayers(value);
  if (layers.length === 0) return null;

  const allowed = new Set(canonical.map(normalizeShadow));
  if (allowed.has(normalizeShadow(value))) return null;

  // A composite value (e.g. a utility plus a ring) is accepted layer by layer,
  // so a legitimate stack of two canonical shadows is not rejected for being a
  // stack. Each individual layer must still be canonical or black-free.
  const canonicalLayers = new Set(
    canonical.flatMap((c) => splitShadowLayers(c).map(normalizeShadow)),
  );
  const offenders = layers.filter(
    (layer) =>
      !canonicalLayers.has(normalizeShadow(layer)) && shadowLayerColors(layer).some(isBlackPaint),
  );
  if (offenders.length === 0) return null;

  return (
    `resolved shadow layer(s) ${offenders.map((o) => JSON.stringify(o)).join(", ")} paint black ` +
    `but do not match any resolved canonical --sh-* value`
  );
}

// ===========================================================================
// Collected records and their judgement
// ===========================================================================

/** One element's interesting computed paint, as collected in the browser. */
export interface PaintRecord {
  /** A stable, human-readable path to the element, used in diagnostics. */
  path: string;
  pseudo: "" | "::before" | "::after";
  /** Solid colour properties, already filtered to the non-transparent ones. */
  colors: Record<string, string>;
  /** `background-image`, `mask-image`, `filter`, `backdrop-filter` when active. */
  nonSolid: Record<string, string>;
  /** `box-shadow` / `text-shadow` when set. */
  shadows: Record<string, string>;
  /**
   * The element's own background plus every ancestor background, nearest-first —
   * collected ONLY when the element's own background is translucent, which is
   * the only case where the composite result is not the value itself.
   */
  backgroundStack: string[];
}

export interface PaintFinding {
  path: string;
  pseudo: string;
  property: string;
  value: string;
  reason: string;
}

export interface PaintDiagnostic {
  path: string;
  pseudo: string;
  property: string;
  value: string;
  note: string;
}

export interface PaintVerdict {
  findings: PaintFinding[];
  diagnostics: PaintDiagnostic[];
  /** How many colour values were actually parsed and judged. */
  judged: number;
}

/**
 * Judge a page's collected paint. Pure: same records in, same verdict out.
 *
 * `judged` is returned so callers can assert the scan actually looked at
 * something — an empty findings list is also what a collector that matched no
 * elements produces, and those two outcomes must not be confused.
 */
export function judgePaintRecords(
  records: readonly PaintRecord[],
  canonicalShadows: readonly string[],
): PaintVerdict {
  const findings: PaintFinding[] = [];
  const diagnostics: PaintDiagnostic[] = [];
  let judged = 0;

  for (const record of records) {
    for (const [property, value] of Object.entries(record.colors)) {
      const color = parseCssColor(value);
      if (color === null) {
        diagnostics.push({
          path: record.path,
          pseudo: record.pseudo,
          property,
          value,
          note: "unparseable computed colour — not judged",
        });
        continue;
      }
      judged++;
      if (color.a === 0) continue;

      if (isOpaquePureBlack(color)) {
        findings.push({
          path: record.path,
          pseudo: record.pseudo,
          property,
          value,
          reason: "resolves to opaque pure black (DESIGN.md No-Black Rule)",
        });
        continue;
      }
      if (isTranslucentBlack(color)) {
        findings.push({
          path: record.path,
          pseudo: record.pseudo,
          property,
          value,
          reason:
            "resolves to translucent black outside a canonical shadow — scrims use --scrim, " +
            "elevation uses --sh-*",
        });
        // Deliberately no `continue`: the composite check below is a DIFFERENT
        // fact. "you authored translucent black" and "it lands on opaque black"
        // are separately actionable, and short-circuiting here would make the
        // composite branch unreachable for the one stack that can actually
        // trigger it.
      }

      // Alpha composition, bounded to solid paint: a translucent background is
      // only meaningful once resolved through what is actually behind it.
      if (color.a < 1 && property === "backgroundColor" && record.backgroundStack.length > 0) {
        const layers = record.backgroundStack
          .map(parseCssColor)
          .filter((c): c is Rgba => c !== null);
        const composed = compositeStack(layers);
        if (isOpaquePureBlack(composed)) {
          findings.push({
            path: record.path,
            pseudo: record.pseudo,
            property,
            value,
            reason: `composites over its ancestors to ${formatRgba(composed)} — opaque pure black`,
          });
        }
      }
    }

    for (const [property, value] of Object.entries(record.shadows)) {
      const reason = judgeShadow(value, canonicalShadows);
      if (reason)
        findings.push({ path: record.path, pseudo: record.pseudo, property, value, reason });
    }

    for (const [property, value] of Object.entries(record.nonSolid)) {
      diagnostics.push({
        path: record.path,
        pseudo: record.pseudo,
        property,
        value,
        note:
          "non-solid composite (gradient / image / mask / filter) — outside the analytic " +
          "scanner's reach; covered by the deterministic screenshot baselines",
      });
    }
  }

  return { findings, diagnostics, judged };
}

// ===========================================================================
// Diagnostic reporting
// ===========================================================================

/** Who and what a diagnostic set was collected from. */
export interface DiagnosticContext {
  owner: string;
  route: string;
  theme: string;
  accent: string;
  pointer: string;
}

/**
 * The machine-readable shape attached to a Playwright test when the analytic
 * scanner hits paint it cannot reconstruct.
 *
 * `judged` travels with it on purpose: "three diagnostics" means something very
 * different against 40 judged values than against 4,000, and a reader of the
 * attachment should not have to go and find that number.
 */
export interface PaintDiagnosticReport extends DiagnosticContext {
  judged: number;
  diagnosticCount: number;
  diagnostics: PaintDiagnostic[];
}

/**
 * Build the report for a verdict's diagnostics, sorted into a stable order.
 *
 * The sort is what makes the attachment diffable: DOM traversal order is stable
 * for a given render, but the moment two runs disagree about it an unsorted
 * attachment reads as a change when nothing changed.
 */
export function buildPaintDiagnosticReport(
  context: DiagnosticContext,
  verdict: Pick<PaintVerdict, "diagnostics" | "judged">,
): PaintDiagnosticReport {
  const diagnostics = [...verdict.diagnostics].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.pseudo.localeCompare(b.pseudo) ||
      a.property.localeCompare(b.property) ||
      a.value.localeCompare(b.value),
  );
  return {
    ...context,
    judged: verdict.judged,
    diagnosticCount: diagnostics.length,
    diagnostics,
  };
}

/** Byte-stable JSON for the attachment. Pretty-printed so a reviewer can read it. */
export function serializePaintDiagnosticReport(report: PaintDiagnosticReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * A concise, owner-specific summary for the test annotation — the line a reader
 * sees in the report before deciding whether to open the JSON.
 */
export function summarizePaintDiagnostics(report: PaintDiagnosticReport): string {
  const byProperty = new Map<string, number>();
  for (const d of report.diagnostics) {
    byProperty.set(d.property, (byProperty.get(d.property) ?? 0) + 1);
  }
  const breakdown = [...byProperty.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([property, count]) => `${property}×${count}`)
    .join(", ");

  return (
    `${report.owner} ${report.route} [${report.theme}/${report.accent}/${report.pointer}]: ` +
    `${report.diagnosticCount} non-solid paint diagnostic(s) (${breakdown}) outside the analytic ` +
    `scanner's reach, of ${report.judged} colour values judged. Not a No-Black failure — the ` +
    `attached screenshot is the pixel evidence for these.`
  );
}

/** A stable, filesystem-safe slug for an attachment name. */
export function diagnosticSlug(context: DiagnosticContext): string {
  const route =
    context.route === "/" ? "home" : context.route.replace(/^\//, "").replace(/\//g, "-");
  return `${context.owner}-${route}-${context.theme}-${context.accent}-${context.pointer}`;
}

// ===========================================================================
// Canvas
// ===========================================================================

/**
 * What the collector was able to establish about one canvas. Every canvas gets
 * exactly one of these — there is deliberately no "nothing to report" arm.
 *
 *   `readable-2d`     — a 2D context yielded pixels.
 *   `readable-webgl`  — a WebGL context yielded pixels through `readPixels`.
 *   `zero-size`       — zero width or height, so the canvas paints nothing.
 *   `tainted`         — readback threw (cross-origin content).
 *   `unreadable`      — live, non-zero, and its pixels could not be obtained.
 */
export type CanvasOutcome =
  | "readable-2d"
  | "readable-webgl"
  | "zero-size"
  | "tainted"
  | "unreadable";

export interface CanvasSample {
  path: string;
  width: number;
  height: number;
  /** The renderer that owns the canvas, as far as the collector could tell. */
  contextType: string | null;
  outcome: CanvasOutcome;
  /** Why an outcome is `tainted` or `unreadable`. */
  error?: string;
  /** Flat RGBA quadruples of the sampled pixels. */
  pixels: number[];
}

/**
 * A whole-document canvas scan. `canvasCount` is counted independently of
 * `samples` so the judge can prove the collector did not drop one — a scanner
 * that silently skips a canvas produces the same empty findings list as a clean
 * page, and that was a real defect here: a WebGL canvas returned `null` from
 * `getContext("2d")` and was recorded as an error-free sample with no pixels.
 */
export interface CanvasScan {
  canvasCount: number;
  samples: CanvasSample[];
}

export interface CanvasVerdict {
  findings: PaintFinding[];
  /** Number of pixels actually inspected across every readable canvas. */
  inspected: number;
  /** Canvases that reached a definite outcome. Must equal `canvasCount`. */
  accounted: number;
  /** Per-outcome tally, so a report says what was actually established. */
  byOutcome: Record<CanvasOutcome, number>;
}

/**
 * Judge a canvas scan. Fail-closed at every step.
 *
 * A canvas nobody can read is a canvas nobody can verify: if the app ever draws
 * roster data through a renderer this scanner cannot read back, that surface
 * leaves the No-Black gate's reach entirely, and the right outcome is a loud
 * failure naming the element rather than a quietly shrinking scan. So `tainted`
 * and `unreadable` are findings, a canvas the collector forgot is a finding, and
 * a canvas that CLAIMS to be readable while yielding no pixels is a finding too
 * — that last one is the shape a silent drop takes once the obvious arms are
 * closed.
 */
export function judgeCanvasSamples(scan: CanvasScan): CanvasVerdict {
  const findings: PaintFinding[] = [];
  const byOutcome: Record<CanvasOutcome, number> = {
    "readable-2d": 0,
    "readable-webgl": 0,
    "zero-size": 0,
    tainted: 0,
    unreadable: 0,
  };
  let inspected = 0;

  const describe = (s: CanvasSample) =>
    `${s.path} (${s.width}×${s.height}, context ${s.contextType ?? "unknown"})`;

  for (const sample of scan.samples) {
    byOutcome[sample.outcome]++;

    if (sample.outcome === "tainted" || sample.outcome === "unreadable") {
      findings.push({
        path: sample.path,
        pseudo: "",
        property: "canvas",
        value: sample.error ?? sample.outcome,
        reason:
          `${describe(sample)} could not be inspected, so its paint cannot be verified against ` +
          `the No-Black Rule — a hard failure, not a skip`,
      });
      continue;
    }

    // A zero-sized canvas paints nothing. It is recorded rather than skipped so
    // the accounting below still balances.
    if (sample.outcome === "zero-size") continue;

    if (sample.pixels.length === 0) {
      findings.push({
        path: sample.path,
        pseudo: "",
        property: "canvas",
        value: sample.outcome,
        reason:
          `${describe(sample)} reported outcome "${sample.outcome}" but yielded no pixels — a ` +
          `readable canvas that inspected nothing is not evidence of anything`,
      });
      continue;
    }

    for (let i = 0; i + 3 < sample.pixels.length; i += 4) {
      const [r, g, b, a] = sample.pixels.slice(i, i + 4);
      inspected++;
      if (a === 255 && r === 0 && g === 0 && b === 0) {
        findings.push({
          path: sample.path,
          pseudo: "",
          property: "canvas pixel",
          value: `rgba(0, 0, 0, 1) at sample ${i / 4}`,
          reason: `${describe(sample)} has an opaque pure black pixel`,
        });
        break; // One finding per canvas is enough to fail it and read cleanly.
      }
    }
  }

  if (scan.samples.length !== scan.canvasCount) {
    findings.push({
      path: "document",
      pseudo: "",
      property: "canvas accounting",
      value: `${scan.samples.length} sample(s) for ${scan.canvasCount} canvas element(s)`,
      reason:
        "the collector dropped a canvas. An unaccounted canvas is indistinguishable from a clean " +
        "one in the findings list, which is exactly why the count is checked separately",
    });
  }

  return { findings, inspected, accounted: scan.samples.length, byOutcome };
}

// ===========================================================================
// Axe
// ===========================================================================

export interface AxeVerdict {
  violations: AxeResult[];
  /** Exceptions that matched nothing — stale entries G1 should retire. */
  unusedExceptions: V2AxeException[];
}

/**
 * Apply a row's exceptions to a full axe run.
 *
 * Exceptions filter NODES, never rules. A row that excepts `color-contrast` on
 * one element still fails if any OTHER element breaks `color-contrast`, which is
 * the property that makes a blanket disable impossible to express: there is no
 * argument here that removes a rule from the run.
 */
export function filterAxeViolations(
  results: Pick<AxeResults, "violations">,
  exceptions: readonly V2AxeException[],
): AxeVerdict {
  const used = new Set<V2AxeException>();

  const violations = results.violations
    .map((violation) => {
      const nodes = violation.nodes.filter((node) => {
        const targets = node.target.map((t) => (Array.isArray(t) ? t.join(" ") : String(t)));
        const exception = exceptions.find(
          (e) => e.rule === violation.id && targets.includes(e.selector),
        );
        if (exception) used.add(exception);
        return exception === undefined;
      });
      return { ...violation, nodes };
    })
    .filter((violation) => violation.nodes.length > 0);

  return { violations, unusedExceptions: exceptions.filter((e) => !used.has(e)) };
}

/** A readable, actionable rendering of axe violations for an assertion message. */
export function formatAxeViolations(violations: readonly AxeResult[]): string {
  return violations
    .map((v) => {
      const nodes = v.nodes
        .map(
          (n) =>
            `      • ${n.target.join(" ")}\n        ${n.failureSummary?.split("\n").join("\n        ") ?? ""}`,
        )
        .join("\n");
      return `  [${v.impact ?? "unknown"}] ${v.id} — ${v.help}\n    ${v.helpUrl}\n${nodes}`;
    })
    .join("\n");
}

// ===========================================================================
// Browser-side collection
// ===========================================================================

/** WCAG 2.0/2.1/2.2 A + AA. The scan is never narrowed below this. */
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

/** The six canonical elevation tokens, in declaration order. */
export const CANONICAL_SHADOW_TOKENS = [
  "--sh-1",
  "--sh-2",
  "--sh-3",
  "--sh-edge",
  "--sh-well",
  "--sh-side",
] as const;

/**
 * Resolve CSS custom properties to their COMPUTED paint through a probe element,
 * rather than reading the declaration text.
 *
 * The difference matters: the production minifier is free to rewrite `#ffffff`
 * as `#fff`, so comparing declaration strings compares serializations. Both
 * sides of every comparison in this module are computed values.
 */
export async function resolveTokenColors(
  page: Page,
  tokens: readonly string[],
): Promise<Record<string, string>> {
  return page.evaluate((names) => {
    const probe = document.createElement("div");
    probe.style.position = "fixed";
    probe.style.pointerEvents = "none";
    document.body.appendChild(probe);
    const out: Record<string, string> = {};
    for (const name of names) {
      probe.style.backgroundColor = "";
      probe.style.backgroundColor = `var(${name})`;
      out[name] = getComputedStyle(probe).backgroundColor;
    }
    probe.remove();
    return out;
  }, tokens);
}

/** Resolve the canonical `--sh-*` tokens to their computed `box-shadow` values. */
export async function resolveCanonicalShadows(page: Page): Promise<string[]> {
  return page.evaluate(
    (names) => {
      const probe = document.createElement("div");
      probe.style.position = "fixed";
      probe.style.pointerEvents = "none";
      document.body.appendChild(probe);
      const out: string[] = [];
      for (const name of names) {
        probe.style.boxShadow = "";
        probe.style.boxShadow = `var(${name})`;
        const resolved = getComputedStyle(probe).boxShadow;
        if (resolved && resolved !== "none") out.push(resolved);
      }
      probe.remove();
      return out;
    },
    CANONICAL_SHADOW_TOKENS as unknown as string[],
  );
}

/**
 * Walk the whole document — including portalled overlays, which live in
 * `document.body` — and collect every interesting computed value, for normal
 * styles and for `::before` / `::after`.
 *
 * Filtering happens HERE rather than in node so the payload stays proportional
 * to what is actually painted rather than to the element count.
 */
export async function collectResolvedPaint(page: Page): Promise<PaintRecord[]> {
  return page.evaluate(() => {
    // `caret-color` is absent on purpose: its computed value is the keyword
    // `auto` on almost everything, which is not a colour and cannot be judged.
    const COLOR_PROPS = [
      "color",
      "backgroundColor",
      "outlineColor",
      "textDecorationColor",
    ] as const;

    // `fill` and `stroke` INHERIT and their initial value is black, so every
    // plain <div> in the document computes `fill: rgb(0, 0, 0)` while painting
    // nothing of the sort. They are read only inside the SVG namespace, where
    // they are actual paint — and a genuinely black icon is still caught there.
    const SVG_PAINT_PROPS = ["fill", "stroke"] as const;
    const SVG_NS = "http://www.w3.org/2000/svg";
    const BORDER_SIDES = ["Top", "Right", "Bottom", "Left"] as const;

    function describe(el: Element): string {
      const parts: string[] = [];
      let node: Element | null = el;
      let depth = 0;
      while (node && depth < 4) {
        const id = node.id ? `#${node.id}` : "";
        const testId = node.getAttribute("data-testid");
        const slot = node.getAttribute("data-slot");
        const marker = testId ? `[data-testid="${testId}"]` : slot ? `[data-slot="${slot}"]` : "";
        parts.unshift(`${node.tagName.toLowerCase()}${id}${marker}`);
        if (id || testId) break;
        node = node.parentElement;
        depth++;
      }
      return parts.join(" > ");
    }

    function isInvisible(style: CSSStyleDeclaration): boolean {
      return (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0"
      );
    }

    /** The alpha of a computed colour, or 1 when there is no alpha component. */
    function browserAlpha(value: string): number {
      const slash = value.match(/\/\s*([\d.]+)(%?)\s*\)/);
      if (slash) return slash[2] === "%" ? Number(slash[1]) / 100 : Number(slash[1]);
      const rgba = value.match(/^rgba\(([^)]*)\)$/);
      if (rgba) {
        const parts = rgba[1].split(",").map((p) => p.trim());
        if (parts.length === 4) return Number(parts[3]);
      }
      return 1;
    }

    function backgroundStack(el: Element): string[] {
      const stack: string[] = [];
      let node: Element | null = el;
      while (node) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)") stack.push(bg);
        node = node.parentElement;
      }
      return stack;
    }

    const records: {
      path: string;
      pseudo: "" | "::before" | "::after";
      colors: Record<string, string>;
      nonSolid: Record<string, string>;
      shadows: Record<string, string>;
      backgroundStack: string[];
    }[] = [];

    for (const el of Array.from(document.querySelectorAll("*"))) {
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "head" || tag === "meta") continue;

      for (const pseudo of ["", "::before", "::after"] as const) {
        const style = getComputedStyle(el, pseudo || undefined);
        if (isInvisible(style)) continue;
        // A pseudo-element with no `content` is not generated at all, so its
        // computed style describes paint nobody can see.
        if (pseudo && (style.content === "none" || style.content === "normal")) continue;

        const colors: Record<string, string> = {};
        const nonSolid: Record<string, string> = {};
        const shadows: Record<string, string> = {};

        for (const prop of COLOR_PROPS) {
          const value = style[prop];
          if (!value || value === "none" || value === "rgba(0, 0, 0, 0)") continue;
          colors[prop] = value;
        }

        if (el.namespaceURI === SVG_NS) {
          for (const prop of SVG_PAINT_PROPS) {
            const value = style[prop];
            if (!value || value === "none" || value === "rgba(0, 0, 0, 0)") continue;
            colors[prop] = value;
          }
        }

        // A border/outline colour is only paint when the edge is actually drawn.
        // Chromium reports a used colour regardless of width, so reading it
        // unconditionally invents violations on every zero-width edge.
        for (const side of BORDER_SIDES) {
          const width = parseFloat(style[`border${side}Width` as "borderTopWidth"] || "0");
          const styleName = style[`border${side}Style` as "borderTopStyle"];
          if (width > 0 && styleName !== "none" && styleName !== "hidden") {
            colors[`border${side}Color`] = style[`border${side}Color` as "borderTopColor"];
          }
        }
        if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth || "0") > 0) {
          colors.outlineColor = style.outlineColor;
        } else {
          delete colors.outlineColor;
        }

        for (const [prop, value] of [
          ["backgroundImage", style.backgroundImage],
          ["maskImage", style.maskImage],
          ["filter", style.filter],
          ["backdropFilter", style.backdropFilter],
        ] as const) {
          if (value && value !== "none") nonSolid[prop] = value;
        }

        if (style.boxShadow && style.boxShadow !== "none") shadows.boxShadow = style.boxShadow;
        if (style.textShadow && style.textShadow !== "none") shadows.textShadow = style.textShadow;

        if (
          Object.keys(colors).length === 0 &&
          Object.keys(nonSolid).length === 0 &&
          Object.keys(shadows).length === 0
        ) {
          continue;
        }

        // The ancestor chain is only collected when the element's OWN background
        // is partially transparent, because that is the only case where the
        // composite result differs from the value itself. Collecting it for every
        // element would multiply the payload by the tree depth for no new fact.
        const bg = colors.backgroundColor;
        const alpha = bg ? browserAlpha(bg) : 1;
        const translucent = alpha > 0 && alpha < 1;

        records.push({
          path: describe(el),
          pseudo,
          colors,
          nonSolid,
          shadows,
          backgroundStack: translucent && !pseudo ? backgroundStack(el) : [],
        });
      }
    }

    return records;
  });
}

/**
 * Scan every canvas in the document, using the readback appropriate to whoever
 * owns it, and give each one a definite outcome.
 *
 * The rule this enforces is that a live canvas is either INSPECTED or an
 * explicit failure. Nothing returns an error-free empty sample — that was a real
 * hole: `getContext("2d")` returns `null` once another renderer owns the canvas,
 * so a WebGL surface was recorded as "fine, no pixels" and No-Black passed
 * without looking at a single pixel of it.
 *
 * `canvasCount` is counted from the DOM independently of the samples, so the
 * judge can prove nothing was dropped on the way out.
 *
 * Sampling is a fixed 5x5 lattice rather than every pixel: a full read of a
 * large canvas is megabytes over the CDP boundary, and a lattice is enough to
 * catch a surface painted black.
 */
export async function collectCanvasSamples(page: Page): Promise<CanvasScan> {
  return page.evaluate(() => {
    type Outcome = "readable-2d" | "readable-webgl" | "zero-size" | "tainted" | "unreadable";
    const samples: {
      path: string;
      width: number;
      height: number;
      contextType: string | null;
      outcome: Outcome;
      error?: string;
      pixels: number[];
    }[] = [];

    const canvases = Array.from(document.querySelectorAll("canvas"));

    /** The 25 lattice coordinates for a canvas of this size. */
    const lattice = (width: number, height: number) => {
      const points: [number, number][] = [];
      for (let ix = 0; ix < 5; ix++) {
        for (let iy = 0; iy < 5; iy++) {
          points.push([
            Math.min(width - 1, Math.floor((width - 1) * (ix / 4))),
            Math.min(height - 1, Math.floor((height - 1) * (iy / 4))),
          ]);
        }
      }
      return points;
    };

    const message = (err: unknown) =>
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);

    for (const canvas of canvases) {
      const testId = canvas.getAttribute("data-testid");
      const id = canvas.id ? `#${canvas.id}` : "";
      const path = `canvas${id}${testId ? `[data-testid="${testId}"]` : ""}`;
      const { width, height } = canvas;

      if (width === 0 || height === 0) {
        samples.push({ path, width, height, contextType: null, outcome: "zero-size", pixels: [] });
        continue;
      }

      // `getContext` is idempotent for a matching type and returns null once a
      // DIFFERENT renderer owns the canvas, so this both identifies the owner and
      // hands back a usable handle.
      const ctx2d = (() => {
        try {
          return canvas.getContext("2d");
        } catch {
          return null;
        }
      })();

      if (ctx2d) {
        const pixels: number[] = [];
        try {
          for (const [x, y] of lattice(width, height)) {
            const data = ctx2d.getImageData(x, y, 1, 1).data;
            pixels.push(data[0], data[1], data[2], data[3]);
          }
        } catch (err) {
          samples.push({
            path,
            width,
            height,
            contextType: "2d",
            outcome: "tainted",
            error: message(err),
            pixels: [],
          });
          continue;
        }
        samples.push({ path, width, height, contextType: "2d", outcome: "readable-2d", pixels });
        continue;
      }

      // Not a 2D canvas. Identify the renderer that does own it.
      let contextType: string | null = null;
      let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
      for (const type of ["webgl2", "webgl", "experimental-webgl"] as const) {
        try {
          const candidate = canvas.getContext(type) as WebGLRenderingContext | null;
          if (candidate) {
            contextType = type;
            gl = candidate;
            break;
          }
        } catch {
          // fall through to the next candidate
        }
      }
      if (!contextType) {
        for (const type of ["bitmaprenderer", "webgpu"] as const) {
          try {
            if (canvas.getContext(type as "bitmaprenderer")) {
              contextType = type;
              break;
            }
          } catch {
            // fall through
          }
        }
      }

      if (gl) {
        try {
          const buffer = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
          const pixels: number[] = [];
          for (const [x, y] of lattice(width, height)) {
            // readPixels origin is bottom-left; flip to match the 2D lattice.
            const offset = ((height - 1 - y) * width + x) * 4;
            pixels.push(buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]);
          }

          // An all-zero readback is ambiguous: it is what a genuinely transparent
          // frame looks like AND what a discarded drawing buffer looks like when
          // the context was created without `preserveDrawingBuffer`. Proving
          // nothing is not the same as proving no black, so it fails closed
          // rather than being counted as an inspection.
          const allZero = pixels.every((channel) => channel === 0);
          if (allZero) {
            samples.push({
              path,
              width,
              height,
              contextType,
              outcome: "unreadable",
              error:
                "readPixels returned an entirely zeroed buffer; without preserveDrawingBuffer " +
                "the frame may already have been discarded, so this is not a proven inspection",
              pixels: [],
            });
            continue;
          }

          samples.push({
            path,
            width,
            height,
            contextType,
            outcome: "readable-webgl",
            pixels,
          });
          continue;
        } catch (err) {
          samples.push({
            path,
            width,
            height,
            contextType,
            outcome: "unreadable",
            error: `readPixels failed: ${message(err)}`,
            pixels: [],
          });
          continue;
        }
      }

      samples.push({
        path,
        width,
        height,
        contextType,
        outcome: "unreadable",
        error:
          `no readback is available for context type "${contextType ?? "unknown"}" — the scanner ` +
          `will not guess at what this canvas paints`,
        pixels: [],
      });
    }

    return { canvasCount: canvases.length, samples };
  });
}

// ===========================================================================
// Overflow, target size, semantic roles
// ===========================================================================

export interface OverflowReport {
  documentScrollWidth: number;
  documentClientWidth: number;
  offenders: { path: string; right: number }[];
}

/**
 * Horizontal page overflow, with the elements responsible for it.
 *
 * The 1px slack absorbs sub-pixel layout rounding, which is real and is not a
 * design defect. The offender list exists because `scrollWidth > clientWidth`
 * alone tells nobody which element to fix.
 */
export async function measureHorizontalOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const clientWidth = doc.clientWidth;
    const offenders: { path: string; right: number }[] = [];

    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      // An element inside its own scroll container is doing exactly what it
      // should; only paint that escapes to the PAGE is overflow.
      let scrollable = false;
      let node = el.parentElement;
      while (node && node !== document.body) {
        const s = getComputedStyle(node);
        if (s.overflowX === "auto" || s.overflowX === "scroll" || s.overflowX === "hidden") {
          scrollable = true;
          break;
        }
        node = node.parentElement;
      }
      if (scrollable) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > clientWidth + 1) {
        const testId = el.getAttribute("data-testid");
        offenders.push({
          path: `${el.tagName.toLowerCase()}${testId ? `[data-testid="${testId}"]` : ""}`,
          right: Math.round(rect.right * 100) / 100,
        });
      }
    }

    return {
      documentScrollWidth: doc.scrollWidth,
      documentClientWidth: clientWidth,
      offenders: offenders.slice(0, 20),
    };
  });
}

/** The interactive controls whose real rectangle is a touch-target claim. */
export const TOUCH_TARGET_SELECTOR = [
  "[data-slot='button']",
  "[data-slot='input']",
  "[data-slot='toggle-group-item']",
  "[data-slot='switch']",
  "button",
  "select",
  "input:not([type='hidden'])",
  "a[href]",
].join(", ");

export interface TouchTargetReport {
  measured: number;
  offenders: { path: string; text: string; width: number; height: number }[];
}

/**
 * Measure REAL control rectangles under a coarse pointer.
 *
 * Fields and links are height-only claims: a text input stretches to its row and
 * an inline link is as wide as its text, so demanding 44px on both axes would be
 * demanding something the design never promised. Buttons and icon controls own
 * both axes, which is where the pseudo-element-hitbox shortcut would have hidden.
 */
export async function measureTouchTargets(page: Page, minPx: number): Promise<TouchTargetReport> {
  return page.evaluate(
    ([selector, min]) => {
      const elements = Array.from(document.querySelectorAll(selector as string)).filter((el) => {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (style.pointerEvents === "none") return false;

        // Base UI keeps a 1x1 clipped `<input>` beside a Switch or ToggleGroup
        // purely so the control participates in form submission. It carries
        // `aria-hidden="true"` and `tabindex="-1"`: it is not in the
        // accessibility tree, not in the tab order, and not something anyone
        // aims at — the sibling button is the target, and it is measured.
        // Excluding on the ARIA contract rather than on size keeps a genuinely
        // undersized control failing.
        if (el.getAttribute("aria-hidden") === "true") return false;
        if (el.closest("[aria-hidden='true']")) return false;

        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      const offenders = elements
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const slot = el.getAttribute("data-slot") ?? "";
          const tag = el.tagName.toLowerCase();
          return {
            path: `${tag}${slot ? `[data-slot="${slot}"]` : ""}`,
            text: (el.textContent ?? "").trim().slice(0, 32),
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
            heightOnly: slot === "input" || tag === "select" || tag === "input" || tag === "a",
          };
        })
        .filter((m) =>
          m.heightOnly
            ? m.height < (min as number)
            : m.height < (min as number) || m.width < (min as number),
        )
        .map(({ heightOnly: _heightOnly, ...rest }) => rest);

      return { measured: elements.length, offenders };
    },
    [TOUCH_TARGET_SELECTOR, minPx] as const,
  );
}

export interface SemanticObservation {
  label: string;
  selector: string;
  count: number;
  backgroundColor: string;
  borderRadius: string;
  boxShadow: string;
}

/** Read the computed state of each declared semantic check's first match. */
export async function observeSemanticChecks(
  page: Page,
  row: V2Row,
): Promise<SemanticObservation[]> {
  return page.evaluate(
    (checks) =>
      checks.map((check) => {
        const matches = Array.from(document.querySelectorAll(check.selector));
        const first = matches[0];
        if (!first) {
          return {
            label: check.label,
            selector: check.selector,
            count: 0,
            backgroundColor: "",
            borderRadius: "",
            boxShadow: "",
          };
        }
        const style = getComputedStyle(first);
        return {
          label: check.label,
          selector: check.selector,
          count: matches.length,
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderTopLeftRadius,
          boxShadow: style.boxShadow,
        };
      }),
    row.semanticChecks.map((c) => ({ label: c.label, selector: c.selector })),
  );
}

export interface SemanticFailure {
  label: string;
  selector: string;
  detail: string;
}

/**
 * Judge semantic observations against the row's declarations and the shared role
 * / radius contracts. Pure, so the role table itself is testable without a
 * browser.
 */
export function judgeSemanticChecks(
  row: V2Row,
  observations: readonly SemanticObservation[],
  tokenColors: Readonly<Record<string, string>>,
): SemanticFailure[] {
  const failures: SemanticFailure[] = [];

  for (const check of row.semanticChecks) {
    const observed = observations.find((o) => o.label === check.label);
    if (!observed) {
      failures.push({
        label: check.label,
        selector: check.selector,
        detail: "no observation was collected for this check",
      });
      continue;
    }

    const required = check.minCount ?? 1;
    if (observed.count < required) {
      failures.push({
        label: check.label,
        selector: check.selector,
        detail: `matched ${observed.count} element(s), expected at least ${required}`,
      });
      continue;
    }

    if (check.role) {
      const contract = V2_ROLE_CONTRACT[check.role];
      const expected = tokenColors[contract.tone];
      if (expected === undefined) {
        failures.push({
          label: check.label,
          selector: check.selector,
          detail: `role "${check.role}" needs token ${contract.tone}, which was not resolved`,
        });
      } else if (normalizeShadow(observed.backgroundColor) !== normalizeShadow(expected)) {
        failures.push({
          label: check.label,
          selector: check.selector,
          detail:
            `role "${check.role}" expects background ${contract.tone} (${expected}), ` +
            `got ${observed.backgroundColor}`,
        });
      }

      const shadow = observed.boxShadow;
      const hasShadow = shadow !== "" && shadow !== "none";
      const isInset = /(^|\s)inset(\s|$)/.test(shadow);
      if (contract.elevation === "none" && hasShadow) {
        failures.push({
          label: check.label,
          selector: check.selector,
          detail: `role "${check.role}" is flat by contract, got box-shadow ${shadow}`,
        });
      }
      if (contract.elevation === "outer" && (!hasShadow || isInset)) {
        failures.push({
          label: check.label,
          selector: check.selector,
          detail: `role "${check.role}" needs an OUTER shadow, got ${shadow || "none"}`,
        });
      }
      if (contract.elevation === "inset" && (!hasShadow || !isInset)) {
        failures.push({
          label: check.label,
          selector: check.selector,
          detail: `role "${check.role}" needs an INSET shadow, got ${shadow || "none"}`,
        });
      }
    }

    if (check.radius) {
      const expected = V2_RADIUS_CONTRACT[check.radius];
      if (observed.borderRadius !== expected) {
        failures.push({
          label: check.label,
          selector: check.selector,
          detail: `radius role "${check.radius}" expects ${expected}, got ${observed.borderRadius}`,
        });
      }
    }
  }

  return failures;
}

/**
 * Run axe against the loaded page with the fixed AA tag set. The builder is
 * imported lazily so the pure half of this module stays cheap to import from a
 * node unit test.
 */
export async function runAxe(page: Page): Promise<AxeResults> {
  const { AxeBuilder } = await import("@axe-core/playwright");
  return new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
}
