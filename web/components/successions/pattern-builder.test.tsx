// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PatternBuilder } from "./pattern-builder";

afterEach(cleanup);

// bd memory `long-user-text-no-overflow` / nursing-sheduler-w0e.19: an unknown shift
// id is arbitrary user input — the pattern chip must truncate it to a single line
// and expose the full value on hover.
const LONG_TOKEN = "ward8-east-extended-weekend-night-cover-rotation-".repeat(3).slice(0, 120);

describe("PatternBuilder — long user text (w0e.19)", () => {
  it("truncates a long unknown shift id and exposes the full value on hover", () => {
    render(<PatternBuilder items={[]} groups={[]} value={[LONG_TOKEN]} onChange={() => {}} />);
    const label = screen.getByTitle(LONG_TOKEN);
    expect(label).toHaveTextContent(LONG_TOKEN);
    expect(label).toHaveClass("truncate");
  });
});
