import { describe, expect, it } from "vitest";
import {
  compositeOver,
  compositeStack,
  filterAxeViolations,
  isActiveFilter,
  isBlackPaint,
  isNonSolidPaint,
  isOpaquePureBlack,
  isTranslucentBlack,
  judgeCanvasSamples,
  judgePaintRecords,
  judgeSemanticChecks,
  judgeShadow,
  normalizeShadow,
  parseCssColor,
  shadowLayerColors,
  splitShadowLayers,
  type CanvasSample,
  type PaintRecord,
  type SemanticObservation,
} from "./v2-visual-audit";
import { rowForRoute, type V2Row } from "./v2-surface-matrix";

// The browser collects; this module judges. Everything below exercises the
// judging half directly, because a rule that only runs inside `page.evaluate`
// regresses into a green suite rather than a red one.

// The exact resolved dark-mode shadows, as Chromium serializes `var(--sh-1)`
// and `var(--sh-3)`. These are the values the runtime scanner must accept even
// though they are black — the static gate is what proved they came from a token.
const DARK_SH_1 = "rgba(0, 0, 0, 0.34) 0px 1px 2px 0px, rgba(0, 0, 0, 0.24) 0px 2px 8px 0px";
const DARK_SH_3 = "rgba(0, 0, 0, 0.55) 0px 20px 50px 0px";
const LIGHT_SH_1 = "rgba(60, 55, 45, 0.05) 0px 1px 2px 0px, rgba(60, 55, 45, 0.05) 0px 2px 8px 0px";
const CANONICAL = [DARK_SH_1, DARK_SH_3, LIGHT_SH_1];

describe("parseCssColor", () => {
  it.each([
    ["rgb(51, 46, 43)", { r: 51, g: 46, b: 43, a: 1 }],
    ["rgba(0, 0, 0, 0.34)", { r: 0, g: 0, b: 0, a: 0.34 }],
    ["rgb(17 24 22 / 0.52)", { r: 17, g: 24, b: 22, a: 0.52 }],
    ["rgb(17 24 22 / 52%)", { r: 17, g: 24, b: 22, a: 0.52 }],
    ["transparent", { r: 0, g: 0, b: 0, a: 0 }],
  ])("parses %s", (value, expected) => {
    expect(parseCssColor(value)).toEqual(expected);
  });

  it("parses the color(srgb ...) form a resolved color-mix() takes", () => {
    const parsed = parseCssColor("color(srgb 0.562745 0.308706 0.289412)");
    expect(parsed).not.toBeNull();
    expect(parsed!.r).toBeCloseTo(143.5, 1);
    expect(parsed!.a).toBe(1);
  });

  it.each(["", "none", "currentcolor", "oklch(0.5 0.1 20)", "#332e2b", "nonsense"])(
    "returns null for %s rather than guessing",
    (value) => {
      // A null must be surfaced as "cannot judge", never silently as "fine" —
      // `judgePaintRecords` turns it into a diagnostic for exactly that reason.
      expect(parseCssColor(value)).toBeNull();
    },
  );
});

describe("blackness", () => {
  it("opaque pure black is the violation the rule names", () => {
    expect(isOpaquePureBlack(parseCssColor("rgb(0, 0, 0)"))).toBe(true);
    expect(isOpaquePureBlack(parseCssColor("rgba(0, 0, 0, 1)"))).toBe(true);
  });

  it("is exact, not a near-black tolerance", () => {
    // #010101 is a different, deliberate colour. Treating it as a violation
    // would make the rule about taste instead of about the UA default.
    expect(isOpaquePureBlack(parseCssColor("rgb(1, 1, 1)"))).toBe(false);
    expect(isBlackPaint(parseCssColor("rgb(0, 0, 1)"))).toBe(false);
  });

  it("fully transparent black is not paint", () => {
    expect(isTranslucentBlack(parseCssColor("rgba(0, 0, 0, 0)"))).toBe(false);
    expect(isBlackPaint(parseCssColor("transparent"))).toBe(false);
  });

  it("translucent black is separately identifiable", () => {
    expect(isTranslucentBlack(parseCssColor("rgba(0, 0, 0, 0.4)"))).toBe(true);
    expect(isOpaquePureBlack(parseCssColor("rgba(0, 0, 0, 0.4)"))).toBe(false);
  });

  it("judges nothing when it cannot parse", () => {
    expect(isBlackPaint(null)).toBe(false);
  });
});

describe("compositing", () => {
  it("an opaque layer hides everything under it", () => {
    const out = compositeOver({ r: 10, g: 20, b: 30, a: 1 }, { r: 0, g: 0, b: 0, a: 1 });
    expect(out).toEqual({ r: 10, g: 20, b: 30, a: 1 });
  });

  it("a half-alpha white over black lands halfway", () => {
    const out = compositeOver({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 });
    expect(out.r).toBeCloseTo(127.5, 5);
    expect(out.a).toBe(1);
  });

  it("composites a stack nearest-first onto white", () => {
    // White, not black: assuming a black base would manufacture the very
    // violation this scanner exists to find out of a page that has none.
    expect(compositeStack([])).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    const scrimOverSurface = compositeStack([
      { r: 17, g: 24, b: 22, a: 0.52 },
      { r: 252, g: 254, b: 253, a: 1 },
    ]);
    expect(isOpaquePureBlack(scrimOverSurface)).toBe(false);
    expect(scrimOverSurface.r).toBeCloseTo(17 * 0.52 + 252 * 0.48, 5);
  });

  it("only an all-black stack composites to black", () => {
    expect(
      isOpaquePureBlack(
        compositeStack([
          { r: 0, g: 0, b: 0, a: 0.5 },
          { r: 0, g: 0, b: 0, a: 1 },
        ]),
      ),
    ).toBe(true);
  });
});

describe("non-solid paint", () => {
  it.each([
    "linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))",
    "radial-gradient(rgb(0, 0, 0), rgb(255, 255, 255))",
    'url("/x.png")',
    "image-set(url(a.png) 1x)",
  ])("%s is outside the analytic scanner's reach", (value) => {
    expect(isNonSolidPaint(value)).toBe(true);
  });

  it("`none` and a plain colour are solid", () => {
    expect(isNonSolidPaint("none")).toBe(false);
    expect(isNonSolidPaint("rgb(0, 0, 0)")).toBe(false);
  });

  it("an active filter is flagged and an absent one is not", () => {
    expect(isActiveFilter("blur(4px)")).toBe(true);
    expect(isActiveFilter("none")).toBe(false);
    expect(isActiveFilter("")).toBe(false);
  });
});

describe("shadow parsing", () => {
  it("splits layers without tearing rgba() apart at its own commas", () => {
    expect(splitShadowLayers(DARK_SH_1)).toEqual([
      "rgba(0, 0, 0, 0.34) 0px 1px 2px 0px",
      "rgba(0, 0, 0, 0.24) 0px 2px 8px 0px",
    ]);
  });

  it("treats none and empty as no layers", () => {
    expect(splitShadowLayers("none")).toEqual([]);
    expect(splitShadowLayers("")).toEqual([]);
  });

  it("extracts every colour in a layer", () => {
    const colors = shadowLayerColors("rgba(0, 0, 0, 0.34) 0px 1px 2px 0px");
    expect(colors).toHaveLength(1);
    expect(isTranslucentBlack(colors[0])).toBe(true);
  });

  it("normalizes whitespace and comma spacing for comparison", () => {
    expect(normalizeShadow("rgba(0, 0, 0, 0.5)   0px  1px")).toBe("rgba(0, 0, 0, 0.5) 0px 1px");
  });
});

describe("judgeShadow", () => {
  it("accepts an exact canonical dark shadow, black and all", () => {
    // The whole reason the gate is split: this value IS black, and it is correct.
    expect(judgeShadow(DARK_SH_1, CANONICAL)).toBeNull();
    expect(judgeShadow(DARK_SH_3, CANONICAL)).toBeNull();
  });

  it("accepts a shadow with no black in it", () => {
    expect(judgeShadow(LIGHT_SH_1, CANONICAL)).toBeNull();
    expect(judgeShadow("rgba(60, 55, 45, 0.3) 0px 4px 4px 0px", CANONICAL)).toBeNull();
  });

  it("rejects an arbitrary black shadow", () => {
    expect(judgeShadow("rgba(0, 0, 0, 0.9) 0px 4px 4px 0px", CANONICAL)).toMatch(/paint black/);
  });

  it("accepts a stack of two canonical layers", () => {
    expect(judgeShadow(`${DARK_SH_3}, ${LIGHT_SH_1}`, CANONICAL)).toBeNull();
  });

  it("rejects a canonical layer smuggling a raw one alongside it", () => {
    expect(judgeShadow(`${DARK_SH_3}, rgba(0, 0, 0, 0.9) 0px 0px 0px 2px`, CANONICAL)).toMatch(
      /paint black/,
    );
  });

  it("treats no shadow as nothing to judge", () => {
    expect(judgeShadow("none", CANONICAL)).toBeNull();
  });
});

describe("judgePaintRecords", () => {
  const record = (over: Partial<PaintRecord>): PaintRecord => ({
    path: "div",
    pseudo: "",
    colors: {},
    nonSolid: {},
    shadows: {},
    backgroundStack: [],
    ...over,
  });

  it("reports how many values it actually judged", () => {
    // An empty findings list is also what a collector that matched nothing
    // produces. The two outcomes must never be confused.
    const clean = judgePaintRecords([record({ colors: { color: "rgb(51, 46, 43)" } })], CANONICAL);
    expect(clean.findings).toEqual([]);
    expect(clean.judged).toBe(1);
    expect(judgePaintRecords([], CANONICAL).judged).toBe(0);
  });

  it("fails an opaque black foreground", () => {
    const verdict = judgePaintRecords([record({ colors: { color: "rgb(0, 0, 0)" } })], CANONICAL);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].reason).toMatch(/opaque pure black/);
  });

  it("fails an arbitrary translucent black outside a shadow", () => {
    const verdict = judgePaintRecords(
      [record({ colors: { backgroundColor: "rgba(0, 0, 0, 0.4)" } })],
      CANONICAL,
    );
    expect(verdict.findings[0].reason).toMatch(/translucent black/);
  });

  it("accepts the theme scrim, which is translucent but not black", () => {
    const verdict = judgePaintRecords(
      [
        record({
          colors: { backgroundColor: "rgba(17, 24, 22, 0.52)" },
          backgroundStack: ["rgba(17, 24, 22, 0.52)", "rgb(252, 254, 253)"],
        }),
      ],
      CANONICAL,
    );
    expect(verdict.findings).toEqual([]);
  });

  it("resolves a translucent background through its ancestors", () => {
    const verdict = judgePaintRecords(
      [
        record({
          colors: { backgroundColor: "rgba(0, 0, 0, 0.5)" },
          backgroundStack: ["rgba(0, 0, 0, 0.5)", "rgb(0, 0, 0)"],
        }),
      ],
      CANONICAL,
    );
    // Two separately actionable facts, both reported: the literal is translucent
    // black, AND it lands on opaque black once resolved through its ancestors.
    expect(verdict.findings.map((f) => f.reason)).toEqual([
      expect.stringContaining("translucent black"),
      expect.stringContaining("composites over its ancestors"),
    ]);
  });

  it("leaves a translucent NON-black layer alone when it does not land on black", () => {
    const verdict = judgePaintRecords(
      [
        record({
          colors: { backgroundColor: "rgba(17, 24, 22, 0.52)" },
          backgroundStack: ["rgba(17, 24, 22, 0.52)", "rgb(0, 0, 0)"],
        }),
      ],
      CANONICAL,
    );
    // The scrim over a black plane is dark, but it is not pure black — and the
    // rule is about the exact value, not about darkness.
    expect(verdict.findings).toEqual([]);
  });

  it("judges ::before and ::after alongside normal styles", () => {
    const verdict = judgePaintRecords(
      [record({ pseudo: "::before", colors: { backgroundColor: "rgb(0, 0, 0)" } })],
      CANONICAL,
    );
    expect(verdict.findings[0].pseudo).toBe("::before");
  });

  it("judges SVG fill and stroke", () => {
    const verdict = judgePaintRecords(
      [record({ colors: { fill: "rgb(0, 0, 0)", stroke: "rgb(0, 0, 0)" } })],
      CANONICAL,
    );
    expect(verdict.findings.map((f) => f.property).sort()).toEqual(["fill", "stroke"]);
  });

  it("judges border and outline colours", () => {
    const verdict = judgePaintRecords(
      [record({ colors: { borderTopColor: "rgb(0, 0, 0)", outlineColor: "rgb(0, 0, 0)" } })],
      CANONICAL,
    );
    expect(verdict.findings).toHaveLength(2);
  });

  it("turns a gradient into a diagnostic rather than a guess", () => {
    const verdict = judgePaintRecords(
      [record({ nonSolid: { backgroundImage: "linear-gradient(rgb(0,0,0), rgb(255,255,255))" } })],
      CANONICAL,
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.diagnostics).toHaveLength(1);
    expect(verdict.diagnostics[0].note).toMatch(/screenshot baselines/);
  });

  it("turns an unparseable colour into a diagnostic, never a pass", () => {
    const verdict = judgePaintRecords([record({ colors: { color: "weird-value" } })], CANONICAL);
    expect(verdict.judged).toBe(0);
    expect(verdict.diagnostics[0].note).toMatch(/not judged/);
  });
});

describe("judgeCanvasSamples", () => {
  const sample = (over: Partial<CanvasSample>): CanvasSample => ({
    path: "canvas",
    width: 10,
    height: 10,
    contextType: "2d",
    outcome: "readable-2d",
    pixels: [],
    ...over,
  });
  const scan = (samples: CanvasSample[], canvasCount = samples.length) => ({
    canvasCount,
    samples,
  });

  it("passes a readable canvas painted a real colour", () => {
    const verdict = judgeCanvasSamples(
      scan([sample({ pixels: [51, 46, 43, 255, 252, 254, 253, 255] })]),
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.inspected).toBe(2);
    expect(verdict.accounted).toBe(1);
    expect(verdict.byOutcome["readable-2d"]).toBe(1);
  });

  it("fails a readable canvas with an opaque black pixel", () => {
    const verdict = judgeCanvasSamples(scan([sample({ pixels: [0, 0, 0, 255] })]));
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].reason).toMatch(/opaque pure black/);
  });

  it("ignores a fully transparent pixel", () => {
    expect(judgeCanvasSamples(scan([sample({ pixels: [0, 0, 0, 0] })])).findings).toEqual([]);
  });

  it("fails a TAINTED canvas hard, rather than skipping it", () => {
    // A canvas nobody can read is a canvas nobody can verify. Skipping it would
    // shrink the scan silently, which is the one outcome worse than a failure.
    const verdict = judgeCanvasSamples(
      scan([sample({ path: "canvas#chart", outcome: "tainted", error: "SecurityError: tainted" })]),
    );
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].path).toBe("canvas#chart");
    expect(verdict.findings[0].reason).toMatch(/hard failure, not a skip/);
  });

  it("fails an UNREADABLE canvas — a renderer nobody can read back", () => {
    // The WebGL hole: `getContext("2d")` returns null once another renderer owns
    // the canvas, and the old collector turned that null into an error-free empty
    // sample, so No-Black passed without inspecting a single pixel of it.
    const verdict = judgeCanvasSamples(
      scan([
        sample({
          path: "canvas#gl",
          contextType: "webgl2",
          outcome: "unreadable",
          error: "readPixels returned an entirely zeroed buffer",
        }),
      ]),
    );
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].reason).toMatch(/hard failure, not a skip/);
    expect(verdict.findings[0].reason).toContain("webgl2");
    expect(verdict.inspected).toBe(0);
  });

  it("records a zero-sized canvas without failing it", () => {
    const verdict = judgeCanvasSamples(
      scan([sample({ width: 0, height: 0, contextType: null, outcome: "zero-size" })]),
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.byOutcome["zero-size"]).toBe(1);
    expect(verdict.accounted).toBe(1);
  });

  it("fails a canvas that CLAIMS to be readable but yielded no pixels", () => {
    // The shape a silent drop takes once the obvious arms are closed.
    const verdict = judgeCanvasSamples(scan([sample({ outcome: "readable-2d", pixels: [] })]));
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].reason).toMatch(/yielded no pixels/);
  });

  it("fails when the collector returned fewer samples than there are canvases", () => {
    const verdict = judgeCanvasSamples(scan([sample({ pixels: [1, 2, 3, 255] })], 3));
    const accounting = verdict.findings.find((f) => f.property === "canvas accounting");
    expect(accounting?.reason).toMatch(/dropped a canvas/);
    expect(verdict.accounted).toBe(1);
  });

  it("tallies every outcome so a report says what was actually established", () => {
    const verdict = judgeCanvasSamples(
      scan([
        sample({ path: "a", pixels: [1, 1, 1, 255] }),
        sample({
          path: "b",
          outcome: "readable-webgl",
          contextType: "webgl",
          pixels: [2, 2, 2, 255],
        }),
        sample({ path: "c", outcome: "zero-size", width: 0, height: 0 }),
        sample({ path: "d", outcome: "tainted", error: "SecurityError" }),
        sample({ path: "e", outcome: "unreadable", error: "no readback" }),
      ]),
    );
    expect(verdict.byOutcome).toEqual({
      "readable-2d": 1,
      "readable-webgl": 1,
      "zero-size": 1,
      tainted: 1,
      unreadable: 1,
    });
    expect(verdict.accounted).toBe(5);
    expect(verdict.findings).toHaveLength(2); // tainted + unreadable
  });
});

describe("filterAxeViolations", () => {
  const violation = (id: string, targets: string[]) => ({
    id,
    impact: "serious" as const,
    tags: [],
    description: "",
    help: id,
    helpUrl: "",
    nodes: targets.map((t) => ({
      target: [t],
      html: "",
      any: [],
      all: [],
      none: [],
    })),
  });

  it("passes every violation through when there are no exceptions", () => {
    const results = { violations: [violation("color-contrast", ["#a", "#b"])] };
    expect(filterAxeViolations(results as never, []).violations).toHaveLength(1);
  });

  it("removes exactly the excepted NODE", () => {
    const results = { violations: [violation("color-contrast", ["#a", "#b"])] };
    const verdict = filterAxeViolations(results as never, [
      { rule: "color-contrast", selector: "#a", reason: "documented" },
    ]);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0].nodes.map((n) => String(n.target[0]))).toEqual(["#b"]);
  });

  it("drops a violation only once its last node is excepted", () => {
    const results = { violations: [violation("color-contrast", ["#a"])] };
    const verdict = filterAxeViolations(results as never, [
      { rule: "color-contrast", selector: "#a", reason: "documented" },
    ]);
    expect(verdict.violations).toEqual([]);
  });

  it("cannot be used to disable a rule", () => {
    // The shape admits one rule AND one selector, so an exception on one element
    // leaves every other element breaking the same rule still failing.
    const results = { violations: [violation("color-contrast", ["#a", "#b", "#c"])] };
    const verdict = filterAxeViolations(results as never, [
      { rule: "color-contrast", selector: "#a", reason: "documented" },
    ]);
    expect(verdict.violations[0].nodes).toHaveLength(2);
  });

  it("does not let an exception cross rules", () => {
    const results = { violations: [violation("label", ["#a"])] };
    const verdict = filterAxeViolations(results as never, [
      { rule: "color-contrast", selector: "#a", reason: "documented" },
    ]);
    expect(verdict.violations).toHaveLength(1);
  });

  it("reports an exception that matched nothing, so G1 can retire it", () => {
    const results = { violations: [] };
    const stale = { rule: "color-contrast", selector: "#gone", reason: "documented" };
    expect(filterAxeViolations(results as never, [stale]).unusedExceptions).toEqual([stale]);
  });
});

describe("judgeSemanticChecks", () => {
  const TOKENS = {
    "--bg": "rgb(243, 246, 244)",
    "--surface": "rgb(252, 254, 253)",
    "--surface2": "rgb(255, 255, 255)",
    "--panel": "rgb(238, 243, 240)",
    "--panel-alt": "rgb(249, 251, 250)",
    "--sidebar": "rgb(247, 250, 248)",
  };

  const rowWith = (checks: V2Row["semanticChecks"]): V2Row => ({
    ...rowForRoute("/design-system")!,
    semanticChecks: checks,
  });

  const observed = (over: Partial<SemanticObservation>): SemanticObservation => ({
    label: "probe",
    selector: "#probe",
    count: 1,
    backgroundColor: "rgb(252, 254, 253)",
    borderRadius: "16px",
    boxShadow: "rgba(60, 55, 45, 0.05) 0px 1px 2px 0px",
    ...over,
  });

  it("passes a role whose tone and elevation both match", () => {
    const row = rowWith([{ label: "probe", selector: "#probe", role: "surface", radius: "card" }]);
    expect(judgeSemanticChecks(row, [observed({})], TOKENS)).toEqual([]);
  });

  it("fails a role painted with the wrong tone", () => {
    const row = rowWith([{ label: "probe", selector: "#probe", role: "raised" }]);
    const failures = judgeSemanticChecks(row, [observed({})], TOKENS);
    expect(failures[0].detail).toMatch(/--surface2/);
  });

  it("fails a well that took an OUTER shadow", () => {
    // DESIGN.md §4 rule 1 — direction of light is fixed.
    const row = rowWith([{ label: "probe", selector: "#probe", role: "well" }]);
    const failures = judgeSemanticChecks(
      row,
      [
        observed({
          backgroundColor: TOKENS["--panel"],
          boxShadow: "rgba(60,55,45,0.05) 0px 1px 2px 0px",
        }),
      ],
      TOKENS,
    );
    expect(failures.map((f) => f.detail).join(" ")).toMatch(/needs an INSET shadow/);
  });

  it("fails a raised surface that took an inset shadow", () => {
    const row = rowWith([{ label: "probe", selector: "#probe", role: "raised" }]);
    const failures = judgeSemanticChecks(
      row,
      [
        observed({
          backgroundColor: TOKENS["--surface2"],
          boxShadow: "rgba(0,0,0,0.3) 0px 1px 2px 0px inset",
        }),
      ],
      TOKENS,
    );
    expect(failures.map((f) => f.detail).join(" ")).toMatch(/needs an OUTER shadow/);
  });

  it("fails a flat role that grew a shadow", () => {
    const row = rowWith([{ label: "probe", selector: "#probe", role: "band" }]);
    const failures = judgeSemanticChecks(
      row,
      [observed({ backgroundColor: TOKENS["--panel"] })],
      TOKENS,
    );
    expect(failures.map((f) => f.detail).join(" ")).toMatch(/flat by contract/);
  });

  it("fails a radius that drifted from its role", () => {
    const row = rowWith([{ label: "probe", selector: "#probe", radius: "square" }]);
    const failures = judgeSemanticChecks(row, [observed({})], TOKENS);
    expect(failures[0].detail).toMatch(/expects 0px, got 16px/);
  });

  it("fails when a check matched nothing", () => {
    const row = rowWith([{ label: "probe", selector: "#probe", role: "surface" }]);
    const failures = judgeSemanticChecks(row, [observed({ count: 0 })], TOKENS);
    expect(failures[0].detail).toMatch(/matched 0 element/);
  });

  it("honours minCount", () => {
    const row = rowWith([{ label: "probe", selector: "#probe", radius: "card", minCount: 20 }]);
    expect(judgeSemanticChecks(row, [observed({ count: 19 })], TOKENS)[0].detail).toMatch(
      /at least 20/,
    );
    expect(judgeSemanticChecks(row, [observed({ count: 20 })], TOKENS)).toEqual([]);
  });

  it("fails when no observation was collected at all", () => {
    const row = rowWith([{ label: "probe", selector: "#probe", role: "surface" }]);
    expect(judgeSemanticChecks(row, [], TOKENS)[0].detail).toMatch(/no observation/);
  });

  it("fails loudly when a role's token could not be resolved", () => {
    const row = rowWith([{ label: "probe", selector: "#probe", role: "drawer" }]);
    expect(judgeSemanticChecks(row, [observed({})], {})[0].detail).toMatch(/was not resolved/);
  });
});
