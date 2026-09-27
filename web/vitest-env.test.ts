import { describe, expect, it } from "vitest";

// Bead w0e.2. The storybook project's framework (`@storybook/nextjs-vite`) loads next.config
// while Vitest resolves projects, writing NODE_ENV=development and `__NEXT_*` vars into the
// shared main process. vitest.config.ts undoes that; this pins it for every unit worker.
describe("the unit project's process env", () => {
  it("is not polluted by the storybook project's next.config load", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(Object.keys(process.env).filter((key) => key.startsWith("__NEXT_"))).toEqual([]);
  });
});
