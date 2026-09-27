// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ShiftTypeSingleSelect } from "./shift-type-single-select";

afterEach(cleanup);

// bd memory `long-user-text-no-overflow` / nursing-sheduler-w0e.20: an option label
// is arbitrary user input — the row must truncate it and expose the full value on
// hover.
const LONG_TOKEN = "ward8-east-extended-weekend-night-cover-rotation-".repeat(3).slice(0, 120);

describe("ShiftTypeSingleSelect — long user text (w0e.20)", () => {
  it("truncates a long option label and exposes the full value on hover", () => {
    render(
      <ShiftTypeSingleSelect
        items={[{ value: "long", label: LONG_TOKEN }]}
        groups={[]}
        selected={[]}
        onSelect={() => {}}
      />,
    );
    const label = screen.getByTitle(LONG_TOKEN);
    expect(label).toHaveTextContent(LONG_TOKEN);
    expect(screen.getByText(LONG_TOKEN)).toHaveClass("truncate");
  });
});
