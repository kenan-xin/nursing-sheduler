import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Icons from "@/components/icons";
import { FaDiagramProject } from "react-icons/fa6";

// Static half of the v2 token contract (F1). Everything here is verifiable by
// parsing globals.css: the canonical light/dark literals, the four accent pairs
// and their unsupported-color-mix() fallbacks, cascade order, radius/control/
// shadow namespaces, and the absence of every retired v1 token. The rendered
// half — theme/accent lifecycle, the supported color-mix() computed path,
// hydration — lives in e2e/design-system.spec.ts; the emitted-utility half lives
// in app/tailwind-contract.test.ts.
//
// WHAT CHANGED (custom-AST ticket 3). This file is now a CSS reader and nothing else. It
// used to also walk `app/` and `components/` recursively and read TS/TSX bytes for four
// separate things; each moved to the layer that owns it:
//
//   • the `/design-system` guide's own CONTENT is rendered and read as text in
//     `app/design-system-guide.test.tsx`, because what the guide says is a rendered fact;
//   • `lucide-react` is an exact forbidden module specifier, so it is an Oxlint
//     `no-restricted-imports` entry -- enforced on every file on every lint run, not only
//     on the two directories this walk happened to cover;
//   • "icons come from react-icons/fa6 via the barrel" is asserted below by IDENTITY
//     against the package itself, which a text match on an import line could not do;
//   • the `components/ui/**` hex / rgb() / palette-utility sweep is the
//     `authored-color-literal(-tsx)` and `tailwind-default-palette-utility(-tsx)` ast-grep
//     rules, which cover all of `app/**` and `components/**` rather than one directory.
//
// The retained read is `app/globals.css`, which is the audited exact CSS reader for this
// file: one path, one format, never a byte of TypeScript.

const globals = readFileSync(join(__dirname, "globals.css"), "utf8");

// --- canonical runtime values (v2 technical plan, "Canonical emitted token and
// alias contract"). These are the authority; DESIGN.md's longer frontmatter
// labels are documentation keys, not CSS variables.
const LIGHT_TOKENS: Record<string, string> = {
  ink: "#332e2b",
  ink2: "#57504b",
  ink3: "#665d57",
  faint: "#9d938c",
  "on-ink": "#fbf9f7",
  bg: "#f3f6f4",
  surface: "#fcfefd",
  surface2: "#ffffff",
  panel: "#eef3f0",
  "panel-alt": "#f9fbfa",
  line: "#e0e3da",
  line2: "#ecefe9",
  rule: "#d1cec5",
  sidebar: "#f7faf8",
  success: "#1f6b52",
  successtint: "#e2f1ea",
  successink: "#1f6b52",
  warn: "#8c5f1c",
  warntint: "#f8efdd",
  warnink: "#8c5f1c",
  error: "#bd4a28",
  errortint: "#fae7df",
  errorink: "#9e3d1c",
  "fill-error": "#bd4a28",
  "on-error": "#ffffff",
  "fill-warn": "#8c5f1c",
  "on-warn": "#ffffff",
  onbrand: "#ffffff",
};

const DARK_TOKENS: Record<string, string> = {
  ink: "#f0ece7",
  ink2: "#b3aca6",
  ink3: "#a09892",
  faint: "#6a635e",
  "on-ink": "#1d1a18",
  bg: "#111816",
  surface: "#1a2220",
  surface2: "#222b28",
  panel: "#151d1b",
  "panel-alt": "#1f2826",
  line: "#2f3936",
  line2: "#27302e",
  rule: "#404b47",
  sidebar: "#141b19",
  success: "#63c79e",
  successtint: "#1a3129",
  successink: "#7fd7b2",
  warn: "#d9a85c",
  warntint: "#33280f",
  warnink: "#e8bd7c",
  error: "#e58164",
  errortint: "#38201a",
  errorink: "#f09b80",
  "fill-error": "#e58164",
  "on-error": "#1d1a18",
  "fill-warn": "#d9a85c",
  "on-warn": "#1d1a18",
  onbrand: "#111816",
};

const SCRIM = { light: "rgb(17 24 22 / 0.52)", dark: "rgb(17 24 22 / 0.72)" };

// The four accents, their theme-specific --brand, and the exact static
// --brandink / --brandtint fallback pairs published in the technical plan. Each
// fallback is asserted twice below: literally (it is the contract) and against
// the color-mix() formula it stands in for (it must remain the nearest 8-bit
// sRGB rendering of that formula).
const ACCENTS = ["teal", "sage", "rose", "plum"] as const;

const ACCENT_CONTRACT: Record<
  (typeof ACCENTS)[number],
  { light: [string, string, string]; dark: [string, string, string] }
> = {
  // [--brand, --brandink fallback, --brandtint fallback]
  teal: { light: ["#0b7d68", "#096755", "#e4f1ee"], dark: ["#12a389", "#71c8b8", "#18443b"] },
  sage: { light: ["#3f7f6b", "#346858", "#e9f1ee"], dark: ["#72aa94", "#aaccbf", "#31453e"] },
  // Light rose is #af605a, not the originally published #b0605a: white on the
  // latter computes to 4.49985:1, under the unrounded AA bar (decision D4c).
  // The retune leaves both derived fallbacks unchanged at 8-bit, which the
  // formula checks below re-prove rather than assume.
  rose: { light: ["#af605a", "#904f4a", "#f4eeed"], dark: ["#d1847e", "#e3b5b2", "#4a3b38"] },
  plum: { light: ["#6b5f8c", "#584e73", "#eeeef2"], dark: ["#9e91c2", "#c5bdda", "#3c3f4a"] },
};

const SHADOWS_LIGHT: Record<string, string> = {
  "sh-1": "0 1px 2px rgba(60, 55, 45, 0.05), 0 2px 8px rgba(60, 55, 45, 0.05)",
  "sh-2": "0 2px 4px rgba(60, 55, 45, 0.06), 0 10px 24px rgba(60, 55, 45, 0.09)",
  "sh-3": "0 20px 50px rgba(60, 55, 45, 0.22)",
  "sh-edge": "6px 0 8px -6px rgba(60, 55, 45, 0.16)",
  "sh-well": "inset 0 1px 2px rgba(60, 55, 45, 0.05)",
  "sh-side": "-16px 0 50px rgba(60, 55, 45, 0.2)",
};

const SHADOWS_DARK: Record<string, string> = {
  "sh-1": "0 1px 2px rgba(0, 0, 0, 0.34), 0 2px 8px rgba(0, 0, 0, 0.24)",
  "sh-2": "0 2px 4px rgba(0, 0, 0, 0.36), 0 10px 24px rgba(0, 0, 0, 0.34)",
  "sh-3": "0 20px 50px rgba(0, 0, 0, 0.55)",
  "sh-edge": "6px 0 10px -6px rgba(0, 0, 0, 0.5)",
  "sh-well": "inset 0 1px 2px rgba(0, 0, 0, 0.3)",
  "sh-side": "-16px 0 50px rgba(0, 0, 0, 0.5)",
};

function sliceBlock(source: string, selector: string): string {
  const start = source.indexOf(selector);
  expect(start, `expected selector ${selector} in globals.css`).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open, close);
}

// --- color-mix(in srgb, …) reference implementation.
// CSS Color 4 interpolates the `srgb` space on the GAMMA-ENCODED coordinates, so
// this is a straight linear blend of the 8-bit channels, rounded half-up to the
// nearest 8-bit value. That is precisely what the published fallback literals
// are, and re-deriving them here is what makes "nearest 8-bit" a testable claim
// rather than a comment.
function toRgb(hex: string): [number, number, number] {
  const raw = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(channels: number[]): string {
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function colorMixSrgb(a: string, percentOfA: number, b: string): string {
  const [ar, ag, ab] = toRgb(a);
  const [br, bg, bb] = toRgb(b);
  const t = percentOfA / 100;
  return toHex(
    [
      [ar, br],
      [ag, bg],
      [ab, bb],
    ].map(([x, y]) => Math.round(x * t + y * (1 - t))),
  );
}

describe("core token contract — light theme", () => {
  const root = sliceBlock(globals, ":root {");
  for (const [token, value] of Object.entries(LIGHT_TOKENS)) {
    it(`--${token} = ${value}`, () => {
      expect(root).toContain(`--${token}: ${value};`);
    });
  }
  it(`--scrim = ${SCRIM.light}`, () => {
    expect(root).toContain(`--scrim: ${SCRIM.light};`);
  });
  it("keeps the 280px sidebar width", () => {
    expect(root).toContain("--sidebar-w: 280px;");
  });
  // G8: the ratified desktop collapse pair. 280 stays the expanded production
  // width — narrowing it would have been a separate shell re-layout — and 60 is
  // the prototype's literal icon-rail width.
  it("adds the 60px compact sidebar width", () => {
    expect(root).toContain("--sidebar-w-compact: 60px;");
  });
  it("--chrome aliases the live accent rather than restating a hex", () => {
    expect(root).toContain("--chrome: var(--brand);");
  });
});

describe("core token contract — dark theme", () => {
  const dark = sliceBlock(globals, ".dark {");
  for (const [token, value] of Object.entries(DARK_TOKENS)) {
    it(`--${token} = ${value}`, () => {
      expect(dark).toContain(`--${token}: ${value};`);
    });
  }
  it(`--scrim = ${SCRIM.dark}`, () => {
    expect(dark).toContain(`--scrim: ${SCRIM.dark};`);
  });
  it("does not restate --chrome (it inherits the :root alias)", () => {
    expect(dark).not.toContain("--chrome:");
  });
});

describe("accent selection — four pairs keyed by data-accent", () => {
  const root = sliceBlock(globals, ":root {");
  const dark = sliceBlock(globals, ".dark {");

  it(":root carries the light teal fallback before data-accent exists", () => {
    const [brand, ink, tint] = ACCENT_CONTRACT.teal.light;
    expect(root).toContain(`--brand: ${brand};`);
    expect(root).toContain(`--brandink: ${ink};`);
    expect(root).toContain(`--brandtint: ${tint};`);
  });

  it(".dark carries the dark teal fallback before data-accent exists", () => {
    const [brand, ink, tint] = ACCENT_CONTRACT.teal.dark;
    expect(dark).toContain(`--brand: ${brand};`);
    expect(dark).toContain(`--brandink: ${ink};`);
    expect(dark).toContain(`--brandtint: ${tint};`);
  });

  it.each(ACCENTS)("html[data-accent=%s] owns the light pair", (accent) => {
    const block = sliceBlock(globals, `html[data-accent="${accent}"] {`);
    const [brand, ink, tint] = ACCENT_CONTRACT[accent].light;
    expect(block).toContain(`--brand: ${brand};`);
    expect(block).toContain(`--brandink: ${ink};`);
    expect(block).toContain(`--brandtint: ${tint};`);
  });

  it.each(ACCENTS)("html.dark[data-accent=%s] owns the dark pair", (accent) => {
    const block = sliceBlock(globals, `html.dark[data-accent="${accent}"] {`);
    const [brand, ink, tint] = ACCENT_CONTRACT[accent].dark;
    expect(block).toContain(`--brand: ${brand};`);
    expect(block).toContain(`--brandink: ${ink};`);
    expect(block).toContain(`--brandtint: ${tint};`);
  });

  // The dark accent selectors must be BOTH more specific and later, or a light
  // accent block (0,1,1) silently outranks `.dark` (0,1,0) in dark mode.
  it("orders :root → .dark → light accent blocks → dark accent blocks", () => {
    const positions = [
      globals.indexOf(":root {"),
      globals.indexOf(".dark {"),
      ...ACCENTS.map((a) => globals.indexOf(`html[data-accent="${a}"] {`)),
      ...ACCENTS.map((a) => globals.indexOf(`html.dark[data-accent="${a}"] {`)),
    ];
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("carries no superseded light-rose literal (D4c)", () => {
    expect(globals).not.toContain("#b0605a");
  });

  it("has no selector for a retired v1 accent", () => {
    for (const retired of ["blue", "magenta", "slate"]) {
      expect(globals).not.toContain(`data-accent="${retired}"`);
    }
  });

  it("never resolves an accent name into a hex in JS — the CSS owns the pairs", () => {
    // Each accent's two --brand literals appear only inside its own selectors,
    // so a theme toggle re-resolves the colour with no scripted write.
    expect(globals).not.toContain("--accent-color");
  });
});

describe("unsupported color-mix() fallback contract", () => {
  const supportsIndex = globals.indexOf("@supports (color: color-mix(in srgb, black, white))");

  it("guards the derivation with an @supports query", () => {
    expect(supportsIndex).toBeGreaterThan(-1);
  });

  // Every static pair must be declared BEFORE the guarded block that replaces
  // it, otherwise an engine without color-mix() paints an invalid value.
  it.each(ACCENTS)("the %s pairs are declared before the @supports override", (accent) => {
    expect(globals.indexOf(`html[data-accent="${accent}"] {`)).toBeLessThan(supportsIndex);
    expect(globals.indexOf(`html.dark[data-accent="${accent}"] {`)).toBeLessThan(supportsIndex);
  });

  it("the :root and .dark teal fallbacks precede the @supports override too", () => {
    expect(globals.indexOf(":root {")).toBeLessThan(supportsIndex);
    expect(globals.indexOf(".dark {")).toBeLessThan(supportsIndex);
  });

  it("the guarded block restates every selector it must outrank", () => {
    const block = globals.slice(supportsIndex);
    expect(block).toContain("--brandink: color-mix(in srgb, var(--brand) 82%, black);");
    expect(block).toContain("--brandtint: color-mix(in srgb, var(--brand) 10%, var(--surface));");
    expect(block).toContain("--brandink: color-mix(in srgb, var(--brand) 60%, white);");
    expect(block).toContain("--brandtint: color-mix(in srgb, var(--brand) 26%, var(--surface));");
    for (const accent of ACCENTS) {
      expect(block).toContain(`html[data-accent="${accent}"]`);
      expect(block).toContain(`html.dark[data-accent="${accent}"]`);
    }
  });

  // The literals are not decorative: each is the nearest 8-bit sRGB rendering of
  // the formula it stands in for. Re-rounding or borrowing a prototype-era value
  // is a contract change and fails here.
  it.each(ACCENTS)("%s light fallbacks equal the published formulas at 8-bit", (accent) => {
    const [brand, ink, tint] = ACCENT_CONTRACT[accent].light;
    expect(ink).toBe(colorMixSrgb(brand, 82, "#000000"));
    expect(tint).toBe(colorMixSrgb(brand, 10, LIGHT_TOKENS.surface));
  });

  it.each(ACCENTS)("%s dark fallbacks equal the published formulas at 8-bit", (accent) => {
    const [brand, ink, tint] = ACCENT_CONTRACT[accent].dark;
    expect(ink).toBe(colorMixSrgb(brand, 60, "#ffffff"));
    expect(tint).toBe(colorMixSrgb(brand, 26, DARK_TOKENS.surface));
  });
});

describe("radius — roles are absolute, the generic scale stays square", () => {
  const root = sliceBlock(globals, ":root {");

  it.each([
    ["r-card", "16px"],
    ["r-ctl", "12px"],
    ["r-chip", "9px"],
    ["r-pill", "999px"],
  ])("--%s = %s", (token, value) => {
    expect(root).toContain(`--${token}: ${value};`);
  });

  it.each([
    ["radius-card", "r-card"],
    ["radius-control", "r-ctl"],
    ["radius-chip", "r-chip"],
    ["radius-pill", "r-pill"],
  ])("registers --%s from the runtime --%s", (alias, runtime) => {
    expect(globals).toContain(`--${alias}: var(--${runtime});`);
  });

  // Role radius is not multiplied by the 0.9 density baseline (adoption D3a).
  it("does not fold the density multiplier into a radius", () => {
    for (const token of ["r-card", "r-ctl", "r-chip", "r-pill"]) {
      expect(root).not.toMatch(new RegExp(`--${token}:\\s*calc\\(`));
    }
  });

  it("keeps the generic shadcn radius scale at 0 as the square fallback", () => {
    for (const key of ["", "-sm", "-md", "-lg", "-xl", "-2xl", "-3xl", "-4xl"]) {
      expect(globals).toContain(`--radius${key}: 0px;`);
    }
  });
});

describe("absolute control and touch sizes", () => {
  const root = sliceBlock(globals, ":root {");

  it.each([
    ["ctl-sm", "32px"],
    ["ctl", "36px"],
    ["ctl-lg", "44px"],
    ["touch-min", "44px"],
  ])("--%s = %s", (token, value) => {
    expect(root).toContain(`--${token}: ${value};`);
  });

  it.each([
    ["spacing-control-sm", "ctl-sm"],
    ["spacing-control", "ctl"],
    ["spacing-control-lg", "ctl-lg"],
    ["spacing-touch", "touch-min"],
  ])("registers --%s from the runtime --%s", (alias, runtime) => {
    expect(globals).toContain(`--${alias}: var(--${runtime});`);
  });

  // The whole point of the absolute tokens: the 0.9 baseline must not be able to
  // shrink a hit target below the coarse-pointer minimum.
  it("does not derive a control size from --spacing", () => {
    for (const token of ["ctl-sm", "ctl", "ctl-lg", "touch-min"]) {
      expect(root).not.toMatch(new RegExp(`--${token}:[^;]*var\\(--spacing`));
      expect(root).not.toMatch(new RegExp(`--${token}:\\s*calc\\(`));
    }
  });
});

describe("elevation — five general tokens plus one directional exception", () => {
  const root = sliceBlock(globals, ":root {");
  const dark = sliceBlock(globals, ".dark {");

  for (const [token, value] of Object.entries(SHADOWS_LIGHT)) {
    it(`light --${token}`, () => expect(root).toContain(`--${token}: ${value};`));
  }
  for (const [token, value] of Object.entries(SHADOWS_DARK)) {
    it(`dark --${token}`, () => expect(dark).toContain(`--${token}: ${value};`));
  }

  it("declares no --shadow-* runtime value (that namespace is Tailwind's)", () => {
    expect(root).not.toContain("--shadow-");
    expect(dark).not.toContain("--shadow-");
  });

  it.each([
    ["shadow-1", "sh-1"],
    ["shadow-2", "sh-2"],
    ["shadow-3", "sh-3"],
    ["shadow-edge", "sh-edge"],
    ["shadow-well", "sh-well"],
    ["shadow-side", "sh-side"],
  ])("registers --%s from the runtime --%s", (alias, runtime) => {
    expect(globals).toContain(`--${alias}: var(--${runtime});`);
  });

  it("carries no dead --shadow-* alias a reader would mistake for a live choice", () => {
    // --shadow-toast and --shadow-dialog were each a second name for the same
    // --sh-3 value that nothing reached for (callers take --sh-3 directly). Each
    // was removed rather than left as a dead alias a reader would trust as live.
    expect(globals).not.toContain("--shadow-toast");
    expect(globals).not.toContain("--shadow-dialog");
  });

  it("the side shadow is authored once, as the runtime --sh-side", () => {
    // Exactly one authored declaration (the light one) plus its dark override;
    // every consumer goes through the Tailwind alias.
    const authored = globals.match(/--sh-side:/g) ?? [];
    expect(authored).toHaveLength(2);
  });

  it("keeps the warm brown tint in light mode — no neutral grey or black", () => {
    for (const value of Object.values(SHADOWS_LIGHT)) {
      expect(value).toContain("rgba(60, 55, 45");
      expect(value).not.toContain("rgba(0, 0, 0");
    }
  });
});

describe("shadcn semantic aliases map straight onto the runtime variables", () => {
  it.each([
    ["background", "bg"],
    ["foreground", "ink"],
    ["card", "surface"],
    ["card-foreground", "ink"],
    ["popover", "surface2"],
    ["popover-foreground", "ink"],
    ["primary", "brand"],
    ["primary-foreground", "onbrand"],
    ["secondary", "surface"],
    ["secondary-foreground", "ink"],
    ["muted", "panel"],
    ["muted-foreground", "ink2"],
    ["accent", "panel-alt"],
    ["accent-foreground", "ink"],
    ["destructive", "fill-error"],
    ["destructive-foreground", "on-error"],
    ["border", "line"],
    ["input", "line"],
    ["ring", "brand"],
    ["chart-1", "brand"],
    ["chart-2", "success"],
    ["chart-3", "warn"],
    ["chart-4", "error"],
    ["chart-5", "ink3"],
    ["sidebar", "sidebar"],
    ["sidebar-foreground", "ink"],
    ["sidebar-primary", "brand"],
    ["sidebar-primary-foreground", "onbrand"],
    ["sidebar-accent", "brandtint"],
    ["sidebar-accent-foreground", "brandink"],
    ["sidebar-border", "line"],
    ["sidebar-ring", "brand"],
  ])("--color-%s = var(--%s)", (alias, runtime) => {
    expect(globals).toContain(`--color-${alias}: var(--${runtime});`);
  });

  it("emits no second long-form value layer", () => {
    for (const longForm of [
      "--ink-secondary",
      "--ink-tertiary",
      "--surface-raised",
      "--line-hairline",
    ]) {
      expect(globals).not.toContain(longForm);
    }
  });

  it("registers the scrim so overlays never reach for a raw black", () => {
    expect(globals).toContain("--color-scrim: var(--scrim);");
  });
});

describe("retired v1 tokens are gone", () => {
  it.each(["--accent-color", "--error-strong", "--color-error-strong", "ns-accent-migrated"])(
    "%s is absent",
    (needle) => {
      expect(globals).not.toContain(needle);
    },
  );

  it("no v1 cold-ink or cold-canvas literal survives", () => {
    for (const retired of ["#14161b", "#fbfcfd", "#0e7490", "#2360c4", "#b0357a", "#3f4a63"]) {
      expect(globals).not.toContain(retired);
    }
  });

  it("no prototype attribute-substring compatibility selector", () => {
    expect(globals).not.toMatch(/\[style\*=/);
  });
});

describe("breakpoint ladder", () => {
  for (const bp of ["480px", "768px", "1024px", "1280px", "1440px", "1920px"]) {
    it(`type scale steps at ${bp}`, () => {
      expect(globals).toContain(`(min-width: ${bp})`);
    });
  }
});

// G8 — the desktop rail's collapse contract, in the one place that decides the
// rendered width. The React store owns the rail's CONTENT; the attribute below
// owns its WIDTH, so a reload paints the compact rail directly instead of
// rendering 280px and snapping. If these two ever drift apart, the pre-paint
// script becomes a no-op and the flash comes back silently.
describe("desktop sidebar collapse", () => {
  it("maps the pre-paint attribute onto the compact width", () => {
    expect(globals).toContain('html[data-side-collapsed="1"]');
    expect(globals).toContain("--sidebar-w: var(--sidebar-w-compact);");
  });

  it("holds a collapsed rail's interior until React marks the preference adopted", () => {
    // `visibility`, never `display:none`: hiding the interior must not reflow
    // the rail it is inside.
    expect(globals).toContain(
      'html[data-side-collapsed="1"]:not([data-side-ready="1"]) [data-side-nav] > *',
    );
    expect(globals).toContain("visibility: hidden;");
  });
});

describe("density is gone, 0.9 baseline preserved", () => {
  // Density was unreachable in the product (the control lived only on
  // /design-system and a dev fixture), so it was removed (bmw.8). What shipped
  // to the user's browser was the Compact (0.9) scale — `ns-density=compact`
  // was what they had persisted — so removing the knob and flattening to 1.0
  // would have inflated every space and every line an extra ~11% past what
  // they were looking at. v2 keeps this baseline rather than adopting the
  // redesign's live density knob (adoption record D3).
  it("has no density selector or density token", () => {
    expect(globals).not.toContain('[data-density="');
    expect(globals).not.toContain("var(--density)");
    expect(globals).not.toContain("var(--sp)");
    expect(globals).not.toContain("var(--dens)");
  });

  it("bakes the 0.9 baseline into the spacing scale", () => {
    expect(globals).toContain("--space-1: calc(4px * 0.9);");
    expect(globals).toContain("--space-4: calc(16px * 0.9);");
    expect(globals).toContain("--space-12: calc(48px * 0.9);");
    expect(globals).toContain("--spacing: calc(0.25rem * 0.9);");
  });

  it("bakes the 0.9 baseline into the fluid type scale", () => {
    expect(globals).toContain("--fs-xl: calc(var(--base-h) * 0.9);");
    expect(globals).toContain("--fs-card: calc(var(--base-h) * 0.78 * 0.9);");
    expect(globals).toContain("--fs-lbl: calc(var(--base-l) * 0.9);");
  });
});

describe("toast — the v2 treatment, with v1's stripe and square corner retired", () => {
  const toast = sliceBlock(globals, ".ns-toast {");

  it("is an --ink fill with --on-ink text", () => {
    expect(toast).toContain("background: var(--ink) !important;");
    expect(toast).toContain("color: var(--on-ink) !important;");
    expect(toast).toContain("border: 1px solid var(--ink) !important;");
  });

  it("rounds at the card role like every other L2 surface", () => {
    expect(toast).toContain("border-radius: var(--r-card) !important;");
    expect(toast).not.toContain("border-radius: 0");
  });

  it("sits on the modal layer via --sh-3, not the directional drawer shadow", () => {
    expect(toast).toContain("box-shadow: var(--sh-3) !important;");
    expect(toast).not.toContain("--sh-side");
  });

  // The green side stripe is retired along with the no-side-stripe exception that
  // justified it, and the ✓ mark goes with it: --success on the --ink fill computes
  // to ~1.4:1, so it was never a legible colour signal.
  it("carries no side stripe and no status hue", () => {
    expect(toast).not.toContain("border-left");
    expect(toast).not.toContain("var(--success)");
    expect(globals).toContain(".ns-toast [data-icon] {\n  color: var(--on-ink) !important;\n}");
  });
});

describe("accent preview swatches are a preview, never a second source of truth", () => {
  it.each(ACCENTS)("the %s swatch equals that accent's own light --brand", (accent) => {
    const [brand] = ACCENT_CONTRACT[accent].light;
    const block = sliceBlock(globals, `[data-accent-swatch="${accent}"] {`);
    expect(block).toContain(`background: ${brand};`);
  });

  it("declares a swatch for every accent and nothing else", () => {
    const declared = [...globals.matchAll(/\[data-accent-swatch="([\w-]+)"\]/g)].map((m) => m[1]);
    expect([...new Set(declared)].sort()).toEqual([...ACCENTS].sort());
  });

  // The third assertion here read `components/theme/theme-toggle.tsx` for a hex literal and
  // for the `data-accent-swatch` hook. Both moved: the literal is the
  // `authored-color-literal-tsx` rule, and that the control really emits one
  // `[data-accent-swatch]` per allowlisted accent, in order, is a RENDER assertion in
  // `components/theme/theme-toggle.test.tsx` -- which also proves the element carries no
  // inline background, i.e. that the paint is genuinely still CSS's.
});

describe("motion + skeleton", () => {
  it("defines the shimmer animation token", () => {
    expect(globals).toContain("--animate-shimmer");
    expect(globals).toContain("@keyframes ns-shimmer");
  });
  it("suppresses motion under prefers-reduced-motion", () => {
    expect(globals).toContain("prefers-reduced-motion: reduce");
  });
});

describe("icon convention (react-icons fa6, no Lucide)", () => {
  it("the barrel re-exports react-icons/fa6 ITSELF, not a look-alike", () => {
    // This used to read `components/icons.tsx` and check that the text
    // `from "react-icons/fa6"` appeared in it, which a re-export chain, a local
    // shim or a stale comment could all satisfy. Reference identity cannot be
    // satisfied by anything except the barrel actually re-exporting the package.
    expect(Icons.FaDiagramProject).toBe(FaDiagramProject);

    // Sensitivity: an empty or side-effect-only barrel would make the equality above
    // `undefined === undefined` and pass for the wrong reason.
    expect(typeof Icons.FaDiagramProject).not.toBe("undefined");
  });

  // The other half -- "no source file imports lucide-react" -- is an Oxlint
  // `no-restricted-imports` entry (the `retired-icon-library` family in
  // `oxlint-boundary-config.test.ts`), which is what that rule is for and which covers the
  // whole repository rather than the two directories the retired walk visited.
});

// The fixed eight-entry shift ramp (DESIGN.md §2 "Shift colour palette"). Its contract is
// NEGATIVE: it stays literal data-mark colour in whatever screen eventually draws roster
// chips, never becomes a theme-token family, and never varies by theme.
//
// custom-AST ticket 3 moved this here from `components/shift-types/shift-types-v2-roles.test.tsx`,
// which was granted no filesystem exception. The five production-SOURCE scans that sat
// beside it are now the `authored-color-literal(-tsx)` rule, which rejects any authored
// colour anywhere under `app/**` and `components/**` -- a superset of "these 24 hexes in
// these 5 named files". What could not move to a syntax rule is the CSS half, because
// `globals.css` is where a data colour would become a token, and that is this file's
// audited read.
const SHIFT_PALETTE = [
  "#f8e2b8",
  "#7a5310",
  "#d4a038",
  "#f6dbcd",
  "#9a4726",
  "#cf7049",
  "#e4ecd0",
  "#586a22",
  "#8fa243",
  "#d8e0f2",
  "#374777",
  "#6274ad",
  "#e9dbf0",
  "#653f8e",
  "#9670bd",
  "#d3e9e3",
  "#1b6a5d",
  "#3d9587",
  "#f7dae2",
  "#9a3153",
  "#c66184",
  "#2b2733",
  "#ece6f2",
  "#5c5468",
];

describe("the fixed shift data palette stays out of the token authority", () => {
  it("registers none of the eight entries as a CSS custom property", () => {
    const css = globals.toLowerCase();
    // Guard the premise: a path that silently read the wrong file would report a clean
    // palette for exactly the wrong reason.
    expect(css).toContain("--r-card");
    const leaked = SHIFT_PALETTE.filter((hex) => css.includes(hex));
    expect(leaked, "a shift data-mark colour has become a theme token").toEqual([]);
  });
});
