import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cn, CONTROL_SPACING_TOKENS } from "@/lib/utils";

// Unit smoke: proves the vitest toolchain runs and the `cn` merge util behaves.
describe("cn", () => {
  it("joins truthy class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("drops falsy values and later Tailwind utilities win", () => {
    const hidden: string | false = false;
    expect(cn("px-2", hidden && "hidden", "px-4")).toBe("px-4");
  });
});

// Guards the extendTailwindMerge config: the design system's custom `text-<size>`
// tokens must not be conflated with `text-<color>` tokens (the bug that silently
// stripped button text colors).
describe("cn — custom text-size vs text-color merging", () => {
  it("keeps a custom text-SIZE and a text-COLOR together (both survive)", () => {
    expect(cn("text-onbrand", "text-body")).toBe("text-onbrand text-body");
    expect(cn("text-body", "text-onbrand")).toBe("text-body text-onbrand");
    expect(cn("text-ink", "text-label")).toBe("text-ink text-label");
  });

  it("collapses two custom sizes to the last", () => {
    expect(cn("text-body", "text-meta")).toBe("text-meta");
    expect(cn("text-display", "text-cardhead", "text-title")).toBe("text-title");
  });

  it("lets a custom size override a stock size (and vice versa)", () => {
    expect(cn("text-sm", "text-body")).toBe("text-body");
    expect(cn("text-body", "text-sm")).toBe("text-sm");
  });

  it("collapses two colors to the last (color override wins)", () => {
    expect(cn("text-ink", "text-onbrand")).toBe("text-onbrand");
    expect(cn("text-success", "text-error")).toBe("text-error");
  });
});

// ---------------------------------------------------------------------------
// The v2 control/touch sizes on the `spacing` theme scale (ii7.10.1).
//
// Same bug class as the block above, found by F4's full Playwright gate: an
// unclassified utility is not merged, so BOTH classes survive and emitted CSS
// order picks the winner. `size-control` beat an explicit `size-[34px]` and the
// sidebar footer theme button rendered 36px instead of 34px — one of 33 call
// sites whose authored override was being silently ignored.
//
// These are not decorative: the previous fix for the identical bug shipped with
// no test at all, which is why this one went unnoticed for two tickets.
// ---------------------------------------------------------------------------

describe("cn — custom control/touch sizes participate in the standard groups", () => {
  it("stays in step with the --spacing-* namespace in globals.css", () => {
    // The registration is only correct while it matches what Tailwind actually
    // emits. Reading the stylesheet makes drift a failure rather than a silent
    // return of the original bug for the newly added token.
    const globals = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");
    const declared = [...globals.matchAll(/--spacing-([\w-]+):/g)].map((m) => m[1]).sort();
    expect(declared).toEqual([...CONTROL_SPACING_TOKENS].sort());
  });

  it("lets an explicit caller size beat the primitive's variant", () => {
    // The exact reported defect.
    expect(cn("size-control", "size-[34px]")).toBe("size-[34px]");
  });

  it("is plain last-wins, not a caller-always-wins special case", () => {
    // Reversing the order must reverse the winner. A rule that always favoured
    // the arbitrary value would pass the test above while being wrong.
    expect(cn("size-[34px]", "size-control")).toBe("size-control");
    expect(cn("h-11", "h-control")).toBe("h-control");
  });

  it.each([
    ["h", "h-control", "h-11"],
    ["h (small)", "h-control-sm", "h-[34px]"],
    ["h (large)", "h-control-lg", "h-8.5"],
    ["w", "w-control", "w-48"],
    ["size", "size-control", "size-[34px]"],
    ["size (touch)", "size-touch", "size-4"],
    ["min-h", "min-h-touch", "min-h-0"],
    ["min-w", "min-w-touch", "min-w-[10px]"],
    ["max-h", "max-h-control", "max-h-96"],
    ["max-w", "max-w-touch", "max-w-[220px]"],
  ])("merges the %s group", (_label, token, override) => {
    expect(cn(token, override)).toBe(override);
  });

  it("merges the other spacing-derived groups too", () => {
    // The tokens live on the `--spacing-*` namespace, so they are legal values
    // for padding, margin and gap as well. Registering only `h`/`size` would
    // have left the same trap set for whoever reached for `p-control` next.
    expect(cn("p-control", "p-4")).toBe("p-4");
    expect(cn("px-touch", "px-3")).toBe("px-3");
    expect(cn("gap-touch", "gap-2")).toBe("gap-2");
    expect(cn("m-control", "m-0")).toBe("m-0");
  });

  it("keeps independent axes independent", () => {
    expect(cn("h-control", "w-control")).toBe("h-control w-control");
    expect(cn("h-control", "w-48")).toBe("h-control w-48");
  });

  it("does not merge across a variant boundary", () => {
    expect(cn("size-4", "pointer-coarse:size-touch")).toBe("size-4 pointer-coarse:size-touch");
    expect(cn("pointer-coarse:min-h-touch", "pointer-coarse:min-h-0")).toBe(
      "pointer-coarse:min-h-0",
    );
  });

  // The safety property that makes the whole fix shippable: a caller may shrink
  // a control on a precise pointer WITHOUT being able to merge away the
  // coarse-pointer minimum, because min-h/min-w are their own groups behind
  // their own variant. If this ever collapsed, every `h-8` override in the app
  // would quietly become a sub-44px touch target.
  it("cannot merge away the coarse-pointer minimum", () => {
    expect(cn("h-control pointer-coarse:min-h-touch", "h-8")).toBe(
      "pointer-coarse:min-h-touch h-8",
    );
    expect(
      cn("size-control pointer-coarse:min-h-touch pointer-coarse:min-w-touch", "size-[34px]"),
    ).toBe("pointer-coarse:min-h-touch pointer-coarse:min-w-touch size-[34px]");
  });

  it("leaves colour and typography merging untouched", () => {
    // Regression guard on the block above: the spacing registration must not
    // disturb the font-size/colour split it shares a config with.
    expect(cn("h-control text-body", "h-10 text-onbrand")).toBe("text-body h-10 text-onbrand");
    expect(cn("text-body", "text-meta")).toBe("text-meta");
  });
});
