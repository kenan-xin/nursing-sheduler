// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { makeTemporaryCover, makeValidUiState } from "@/lib/scenario/test-fixtures";
import { pickScenario, scenarioCommands } from "@/lib/store";
import { drainScenarioCommands, resetScenarioForTest } from "@/lib/store/test-authority";
import { CoverPreflight } from "./cover-preflight";

// GuardedLink reads the router; a lightweight stub keeps this a focused render test.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/optimize-and-export",
}));

// A name long enough that it cannot share one line with the reason at any realistic
// width: the two slots must wrap rather than fight for a single row.
const LONG_COVER_NAME =
  "ward8-east-extended-weekend-night-cover-rotation-ward8-east-extended-weekend-night-cover-rotation";

// The valid fixture runs 14-20 May 2026, so a June date is outside the period and the
// cover is flagged. Seeded through the product's own write path (the projection has no
// setter), matching the story's `withCover` fixture.
async function seedFlaggedCover() {
  await act(async () => {
    await scenarioCommands.mutate(pickScenario(makeValidUiState()));
    await scenarioCommands.mutate({
      temporaryCover: [makeTemporaryCover({ name: LONG_COVER_NAME, date: "2026-06-01" })],
    });
  });
}

beforeEach(async () => {
  await resetScenarioForTest();
  await drainScenarioCommands();
  await seedFlaggedCover();
});

afterEach(() => cleanup());

describe("CoverPreflight — narrow-width wrapping (w0e.26)", () => {
  // Each flagged item is a flex row: a truncating name plus a prose reason. The
  // reason used to carry `shrink-0`, pinning it to its max-content width, which
  // painted the callout past a 320px container with ANY cover name. The name stays a
  // single-line slot (truncate + `title`); the reason must be free to wrap.
  it("keeps the name truncating and lets the reason wrap instead of overflowing", () => {
    render(<CoverPreflight />);

    const item = screen.getAllByRole("listitem")[0];
    const row = item.firstElementChild as HTMLElement;
    const [name, reason] = Array.from(row.children) as HTMLElement[];

    expect(name).toHaveClass("truncate");
    expect(name.getAttribute("title")).toMatch(new RegExp(`^${LONG_COVER_NAME}, `));

    // `shrink-0` was the overflow cause; the row wraps so the slots never compete for
    // one line, and the reason is a shrinkable, wrapping flex item.
    expect(row).toHaveClass("flex-wrap");
    expect(reason).not.toHaveClass("shrink-0");
    expect(reason).toHaveClass("min-w-0");
  });
});
