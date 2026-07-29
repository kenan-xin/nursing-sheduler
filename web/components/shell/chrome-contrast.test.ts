import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Contrast guard for the chrome plane, carried forward from nursing-sheduler-2dn.
//
// In v2 the chrome bar is no longer a fixed near-black: `--chrome` aliases the
// LIVE accent (`var(--brand)`), so the pair that has to clear AA is the accent's
// own `--onbrand` against each of the eight accent/theme `--brand` values. That
// makes this a guard over the accent contract itself — adding or re-tuning an
// accent without checking its on-colour fails here, deterministically and
// without a browser.
//
// The original collision guard is kept in spirit: a foreground token must never
// collapse toward the plane it sits on. Two revert paths stay covered:
//   1) an accent or --onbrand value retuned until the pair no longer clears AA;
//   2) a chrome shell control repointed from `text-on-ink` back to `text-ink`.

const shellDir = __dirname;
const webRoot = join(shellDir, "..", "..");
const globals = readFileSync(join(webRoot, "app", "globals.css"), "utf8");

function themeBlock(selector: string): string {
  const start = globals.indexOf(selector);
  expect(start, `expected ${selector} in globals.css`).toBeGreaterThan(-1);
  const open = globals.indexOf("{", start);
  const close = globals.indexOf("}", open);
  return globals.slice(open, close);
}

function tokenHex(block: string, token: string): string {
  // The token contract uses OPAQUE hex only (3- or 6-digit). Restrict to those
  // and require a non-hex boundary after, so an 8-digit alpha hex (e.g. a
  // transparent #ffffff00) is NOT silently truncated to its opaque prefix and
  // waved through — it fails to match and trips the guard instead.
  const match = block.match(
    new RegExp(`--${token}:\\s*(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))(?![0-9a-fA-F])`),
  );
  if (!match) throw new Error(`--${token} not found as an opaque 3-/6-digit hex in theme block`);
  return match[1];
}

function toRgb(hex: string): [number, number, number] {
  const raw = hex.replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channels = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(toRgb(fg));
  const l2 = relativeLuminance(toRgb(bg));
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const ACCENTS = ["teal", "sage", "rose", "plum"] as const;

// Thresholds are compared UNROUNDED. W3C is explicit that a computed 4.4999:1
// does not meet 4.5:1 (Understanding SC 1.4.3), so nothing here may round, floor
// or format a ratio before the assertion — the raw value goes straight into the
// comparison, and the full-precision number appears only in the failure message.
//
// Measured ratios (--onbrand on --brand): light teal 5.0632, sage 4.7091,
// rose 4.5224, plum 5.7681; dark teal 5.6822, sage 6.7689, rose 6.2713,
// plum 6.2457. Light rose is the tightest pair in the system and is the one
// decision D4c retuned from #b0605a — which computed to 4.49985:1, a fail that
// only ever looked like a pass because a helper rounded it first.

describe("chrome plane contrast — --onbrand vs the live --brand (nursing-sheduler-2dn)", () => {
  it("--chrome aliases --brand rather than declaring its own value", () => {
    // If chrome ever re-acquires an independent hex, the pairs asserted below
    // stop describing what the app-mark tile actually paints.
    expect(themeBlock(":root {")).toContain("--chrome: var(--brand);");
  });

  it.each(ACCENTS)("light theme: onbrand meets AA (>= 4.5:1) on the %s chrome", (accent) => {
    const onbrand = tokenHex(themeBlock(":root {"), "onbrand");
    const brand = tokenHex(themeBlock(`html[data-accent="${accent}"] {`), "brand");
    const ratio = contrastRatio(onbrand, brand);
    expect(ratio, `${onbrand} on ${brand} = ${ratio}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ACCENTS)("dark theme: onbrand meets AA (>= 4.5:1) on the %s chrome", (accent) => {
    const onbrand = tokenHex(themeBlock(".dark {"), "onbrand");
    const brand = tokenHex(themeBlock(`html.dark[data-accent="${accent}"] {`), "brand");
    const ratio = contrastRatio(onbrand, brand);
    expect(ratio, `${onbrand} on ${brand} = ${ratio}:1`).toBeGreaterThanOrEqual(4.5);
  });

  // The regression this fixup exists for. If the tightest pair drifts back, or a
  // helper starts rounding again, one of these two trips.
  it("the superseded light rose #b0605a is gone and would not have passed", () => {
    expect(contrastRatio("#ffffff", "#b0605a")).toBeLessThan(4.5);
    expect(themeBlock('html[data-accent="rose"] {')).not.toContain("#b0605a");
  });

  // The teal fallback that holds before data-accent exists must clear the same
  // bar as the explicit selectors — it is what an unsupported stored value paints.
  it.each([
    ["light", ":root {"],
    ["dark", ".dark {"],
  ])("%s theme: the pre-attribute teal fallback also clears AA", (_name, selector) => {
    const block = themeBlock(selector);
    const onbrand = tokenHex(block, "onbrand");
    const brand = tokenHex(block, "brand");
    const ratio = contrastRatio(onbrand, brand);
    expect(ratio, `${onbrand} on ${brand} = ${ratio}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("ink surfaces — --on-ink vs --ink", () => {
  it.each([
    ["light", ":root {"],
    ["dark", ".dark {"],
  ])("%s theme: on-ink meets AA (>= 4.5:1) against ink", (_name, selector) => {
    const block = themeBlock(selector);
    const onInk = tokenHex(block, "on-ink");
    const ink = tokenHex(block, "ink");
    const ratio = contrastRatio(onInk, ink);
    expect(ratio, `${onInk} on ${ink} = ${ratio}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("on-ink surfaces use the on-ink foreground token (not text-ink)", () => {
  // After the T08 shell rebuild the top bar is `bg-surface` (not dark chrome), so
  // the on-ink foreground now lives on the genuinely dark tiles/segments: the
  // top-bar product tile (bg-chrome), the SideNav brand tile (bg-chrome), and the
  // active mode segment (bg-ink). If any is repointed back to the inverting
  // `text-ink`, its `text-on-ink` reference disappears and this trips.
  it.each(["top-bar.tsx", "app-side-nav.tsx", "mode-toggle.tsx"])(
    "%s references text-on-ink",
    (name) => {
      const src = readFileSync(join(shellDir, name), "utf8");
      expect(src).toContain("text-on-ink");
    },
  );
});
