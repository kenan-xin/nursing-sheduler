import { describe, expect, it } from "vitest";

// Bead w0e.2. `@storybook/nextjs-vite` loads next.config while Vitest resolves a config that
// uses the storybook plugin, writing NODE_ENV=development and `__NEXT_*` vars into the main
// process that every worker inherits (8 unit tests failed when stories were a `test.projects`
// entry). So stories live in vitest.storybook.config.ts and this unit suite must never see
// Storybook's env.
describe("the unit suite's process env", () => {
  it("is not polluted by Storybook or its next.config load", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(Object.keys(process.env).filter((key) => /^(__NEXT_|__STORYBOOK_)/.test(key))).toEqual(
      [],
    );
  });
});
