import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { beforeAll, describe, expect, it } from "vitest";

// Compile-contract half of F1. The static test next door proves what globals.css
// SAYS; this proves what the installed Tailwind/PostCSS toolchain actually EMITS
// from it. A token that parses but never reaches a utility is not a contract.
//
// `postcss` is imported as a DIRECT dev dependency on purpose (v2 technical plan,
// "Static and component gates"): resolving it transitively through
// @tailwindcss/postcss, or relying on plugin-relative resolution, would make this
// gate silently dependent on another package's hoisting.

const CSS_PATH = join(__dirname, "globals.css");

// Every utility the contract must be able to emit, one per namespace group.
const UTILITIES = [
  // core ink / surface ladder / lines
  "text-ink",
  "text-ink2",
  "text-ink3",
  "text-faint",
  "text-on-ink",
  "bg-bg",
  "bg-surface",
  "bg-surface2",
  "bg-panel",
  "bg-panel-alt",
  "bg-sidebar",
  "bg-scrim",
  "bg-chrome",
  "border-line",
  "border-line2",
  "border-rule",
  // brand / accent-derived
  "bg-brand",
  "text-brandink",
  "bg-brandtint",
  "text-onbrand",
  // status tiers and their paired solid actions
  "bg-success",
  "bg-successtint",
  "text-successink",
  "bg-warn",
  "bg-warntint",
  "text-warnink",
  "bg-error",
  "bg-errortint",
  "text-errorink",
  "bg-fill-error",
  "text-on-error",
  "bg-fill-warn",
  "text-on-warn",
  // shadcn semantics
  "bg-background",
  "text-foreground",
  "bg-card",
  "bg-popover",
  "bg-primary",
  "text-primary-foreground",
  "bg-secondary",
  "text-secondary-foreground",
  "bg-muted",
  "text-muted-foreground",
  "bg-accent",
  "text-accent-foreground",
  "bg-destructive",
  "text-destructive-foreground",
  "border-border",
  "ring-ring",
  "bg-chart-1",
  "bg-chart-5",
  "bg-sidebar",
  "bg-sidebar-accent",
  "text-sidebar-accent-foreground",
  "border-sidebar-border",
  // radius — roles plus the generic square fallbacks
  "rounded-card",
  "rounded-control",
  "rounded-chip",
  "rounded-pill",
  "rounded-lg",
  "rounded-none",
  // absolute control / touch sizing
  "h-control-sm",
  "h-control",
  "size-control",
  "h-control-lg",
  "min-h-touch",
  "min-w-touch",
  "pointer-coarse:min-h-touch",
  // elevation
  "shadow-1",
  "shadow-2",
  "shadow-3",
  "shadow-edge",
  "shadow-well",
  "shadow-dialog",
  "shadow-toast",
  "shadow-side",
] as const;

let css = "";

beforeAll(async () => {
  // The EXACT production theme block is compiled: the only edit is disabling
  // Tailwind's automatic source scan, so the utilities under test come from the
  // explicit `@source inline` list below rather than from whatever happens to be
  // on disk. Nothing in `@theme` / `@theme inline` / the runtime cascade is
  // touched.
  const production = readFileSync(CSS_PATH, "utf8");
  expect(production).toContain('@import "tailwindcss";');

  const input = [
    production.replace('@import "tailwindcss";', '@import "tailwindcss" source(none);'),
    ...UTILITIES.map((u) => `@source inline("${u}");`),
  ].join("\n");

  const result = await postcss([tailwind()]).process(input, { from: CSS_PATH });
  css = result.css;
}, 120_000);

// Pulls one emitted rule body out by brace matching, so a nested variant rule
// (`@media (pointer: coarse) { … }`) is returned whole rather than truncated.
function ruleBody(className: string): string {
  const selector = `.${className.replace(/:/g, "\\:")}`;
  const start = css.indexOf(`${selector} {`);
  expect(start, `expected an emitted rule for .${className}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

describe("every contract utility compiles with the installed toolchain", () => {
  it.each(UTILITIES)("emits a rule for %s", (utility) => {
    expect(ruleBody(utility).length).toBeGreaterThan(0);
  });
});

describe("colour utilities resolve to the canonical runtime variables", () => {
  it.each([
    ["text-ink", "--ink"],
    ["text-ink2", "--ink2"],
    ["text-ink3", "--ink3"],
    ["text-faint", "--faint"],
    ["text-on-ink", "--on-ink"],
    ["bg-bg", "--bg"],
    ["bg-surface", "--surface"],
    ["bg-surface2", "--surface2"],
    ["bg-panel", "--panel"],
    ["bg-panel-alt", "--panel-alt"],
    ["bg-sidebar", "--sidebar"],
    ["bg-scrim", "--scrim"],
    ["bg-chrome", "--chrome"],
    ["border-line", "--line"],
    ["border-line2", "--line2"],
    ["border-rule", "--rule"],
    ["bg-brand", "--brand"],
    ["text-brandink", "--brandink"],
    ["bg-brandtint", "--brandtint"],
    ["text-onbrand", "--onbrand"],
    ["bg-success", "--success"],
    ["bg-successtint", "--successtint"],
    ["text-successink", "--successink"],
    ["bg-warn", "--warn"],
    ["bg-warntint", "--warntint"],
    ["text-warnink", "--warnink"],
    ["bg-error", "--error"],
    ["bg-errortint", "--errortint"],
    ["text-errorink", "--errorink"],
    ["bg-fill-error", "--fill-error"],
    ["text-on-error", "--on-error"],
    ["bg-fill-warn", "--fill-warn"],
    ["text-on-warn", "--on-warn"],
  ])("%s → var(%s)", (utility, variable) => {
    expect(ruleBody(utility)).toContain(`var(${variable})`);
  });
});

describe("shadcn semantics point at the same runtime variables — no second layer", () => {
  it.each([
    ["bg-background", "--bg"],
    ["text-foreground", "--ink"],
    ["bg-card", "--surface"],
    ["bg-popover", "--surface2"],
    ["bg-primary", "--brand"],
    ["text-primary-foreground", "--onbrand"],
    ["bg-secondary", "--surface"],
    ["text-secondary-foreground", "--ink"],
    ["bg-muted", "--panel"],
    ["text-muted-foreground", "--ink2"],
    ["bg-accent", "--panel-alt"],
    ["text-accent-foreground", "--ink"],
    ["bg-destructive", "--fill-error"],
    ["text-destructive-foreground", "--on-error"],
    ["border-border", "--line"],
    ["ring-ring", "--brand"],
    ["bg-chart-1", "--brand"],
    ["bg-chart-5", "--ink3"],
    ["bg-sidebar", "--sidebar"],
    ["bg-sidebar-accent", "--brandtint"],
    ["text-sidebar-accent-foreground", "--brandink"],
    ["border-sidebar-border", "--line"],
  ])("%s → var(%s)", (utility, variable) => {
    expect(ruleBody(utility)).toContain(`var(${variable})`);
  });

  // `@theme inline` must not also publish a parallel `--color-*` / `--shadow-*`
  // value layer into the emitted `:root`.
  it.each([
    "--color-brand:",
    "--color-background:",
    "--color-destructive:",
    "--shadow-side:",
    "--radius-card:",
  ])("%s is inlined, not re-emitted as a variable", (declaration) => {
    expect(css).not.toContain(declaration);
  });
});

describe("radius — role utilities plus the generic square fallbacks", () => {
  it.each([
    ["rounded-card", "--r-card"],
    ["rounded-control", "--r-ctl"],
    ["rounded-chip", "--r-chip"],
    ["rounded-pill", "--r-pill"],
  ])("%s → var(%s)", (utility, variable) => {
    expect(ruleBody(utility)).toContain(`border-radius: var(${variable})`);
  });

  it("rounded-none is still an explicit square", () => {
    expect(ruleBody("rounded-none")).toContain("border-radius: 0");
  });

  it("the generic shadcn scale resolves to 0px", () => {
    expect(ruleBody("rounded-lg")).toContain("var(--radius-lg)");
    expect(css).toContain("--radius-lg: 0px;");
  });
});

describe("absolute control sizing survives the 0.9 density baseline", () => {
  it.each([
    ["h-control-sm", "height: var(--ctl-sm)"],
    ["h-control", "height: var(--ctl)"],
    ["h-control-lg", "height: var(--ctl-lg)"],
    ["min-h-touch", "min-height: var(--touch-min)"],
    ["min-w-touch", "min-width: var(--touch-min)"],
  ])("%s → %s", (utility, declaration) => {
    expect(ruleBody(utility)).toContain(declaration);
  });

  it("size-control drives both axes off the same absolute token", () => {
    const body = ruleBody("size-control");
    expect(body).toContain("width: var(--ctl)");
    expect(body).toContain("height: var(--ctl)");
  });

  // T8: the actual control reaches the coarse-pointer minimum — no pseudo-element
  // hitbox, and no chance for `--spacing` to shrink it.
  it("pointer-coarse gates the touch minimum on the real control", () => {
    const body = ruleBody("pointer-coarse:min-h-touch");
    expect(body).toContain("@media (pointer: coarse)");
    expect(body).toContain("min-height: var(--touch-min)");
  });

  it("no control size is derived from the spacing scale", () => {
    for (const utility of ["h-control", "min-h-touch", "size-control"]) {
      expect(ruleBody(utility)).not.toContain("var(--spacing)");
    }
  });
});

describe("elevation aliases", () => {
  it.each([
    ["shadow-1", "--sh-1"],
    ["shadow-2", "--sh-2"],
    ["shadow-3", "--sh-3"],
    ["shadow-edge", "--sh-edge"],
    ["shadow-well", "--sh-well"],
    ["shadow-side", "--sh-side"],
  ])("%s → var(%s)", (utility, variable) => {
    expect(ruleBody(utility)).toContain(`--tw-shadow: var(${variable})`);
  });

  it("shadow-dialog and shadow-toast are aliases of --sh-3, not new values", () => {
    expect(ruleBody("shadow-dialog")).toContain("--tw-shadow: var(--sh-3)");
    expect(ruleBody("shadow-toast")).toContain("--tw-shadow: var(--sh-3)");
  });

  it("shadow-side reads the specialized runtime value, not a Tailwind namespace name", () => {
    const body = ruleBody("shadow-side");
    expect(body).toContain("var(--sh-side)");
    expect(body).not.toContain("var(--shadow-side)");
  });

  it("shadow-well stays an inset shadow at the source", () => {
    // The utility indirects through --tw-shadow, so the `inset` keyword lives on
    // the runtime token; assert the token the utility points at is the inset one.
    expect(readFileSync(CSS_PATH, "utf8")).toContain("--sh-well: inset ");
  });
});

describe("the emitted theme contains no self-referential variable", () => {
  it("has no --x: var(--x) declaration anywhere in the output", () => {
    const offenders = [...css.matchAll(/--([\w-]+):\s*var\(--([\w-]+)\)/g)]
      .filter((m) => m[1] === m[2])
      .map((m) => m[0]);
    expect(offenders, `self-referential declarations: ${offenders.join(", ")}`).toEqual([]);
  });
});
