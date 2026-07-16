import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

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
