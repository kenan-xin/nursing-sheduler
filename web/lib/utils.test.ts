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
