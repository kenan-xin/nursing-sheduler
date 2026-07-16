import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard for nursing-sheduler-2dn. The ink/chrome bar stays dark in
// BOTH themes (--chrome), so its foreground token --on-ink must never collapse
// to --chrome — that collision rendered chrome text/icons invisible at 1:1.
// Two revert paths are guarded deterministically (no browser, so this runs
// without the e2e webServer; the rendered contrast is measured live in the
// cold review and exercised by the app-shell e2e):
//   1) --on-ink reset to a value that no longer contrasts with --chrome;
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

describe("chrome bar contrast — --on-ink vs --chrome (nursing-sheduler-2dn)", () => {
  it.each([
    ["light", ":root {"],
    ["dark", ".dark {"],
  ])("%s theme: on-ink meets AA (>= 4.5:1) against chrome", (_name, selector) => {
    const block = themeBlock(selector);
    const ratio = contrastRatio(tokenHex(block, "on-ink"), tokenHex(block, "chrome"));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

describe("chrome shell controls use the on-ink foreground token (not text-ink)", () => {
  // If any of these is repointed back to the inverting `text-ink`, its
  // `text-on-ink` reference disappears and this trips.
  it.each(["top-bar.tsx", "mobile-nav.tsx", "undo-redo-controls.tsx"])(
    "%s references text-on-ink",
    (name) => {
      const src = readFileSync(join(shellDir, name), "utf8");
      expect(src).toContain("text-on-ink");
    },
  );
});
