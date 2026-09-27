import type { Decorator } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";

// Long-text story helpers (bead w0e.3; bd memory `long-user-text-no-overflow`). Read-only for
// story authors: one definition, so every LongText story tests the same inputs.

/** 120 characters, no whitespace: word wrapping cannot contain it, only truncation or overflow-wrap can. */
export const LONG_TOKEN = "ward8-east-extended-weekend-night-cover-rotation-"
  .repeat(3)
  .slice(0, 120);

/** A long, spaced, user-entered description. */
export const LONG_PROSE =
  "Senior nurses on the east wing must not work more than three consecutive long days during the winter pressures period, except by prior agreement with the ward manager";

/**
 * A fixed 320px frame. Under the default `centered` layout a component otherwise sizes to its
 * own content, so an overflow would never be measurable.
 */
export const withNarrowFrame: Decorator = (Story) => (
  <div data-testid="narrow-frame" className="w-80">
    <Story />
  </div>
);

/** Fails when any descendant paints past `el`'s right edge (scrollWidth counts visible overflow). */
export async function expectNoHorizontalOverflow(el: HTMLElement): Promise<void> {
  await expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
}
