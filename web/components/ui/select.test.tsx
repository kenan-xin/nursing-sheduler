// @vitest-environment jsdom
//
// Contract tests for the shared native-select primitive. The subject is narrow on
// purpose: the reserved right padding that keeps a value clear of the caret. It is
// the one property a routine, reasonable-looking caller edit can silently undo
// (`className="px-3"`), and its failure mode is cosmetic — no other test would go
// red, which is how the crowded caret shipped in the first place.

import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { Select } from "./select";

afterEach(() => {
  cleanup();
});

function renderSelect(props: React.ComponentProps<typeof Select> = {}) {
  render(
    <Select aria-label="Pick one" {...props}>
      <option value="a">A</option>
    </Select>,
  );
  return screen.getByLabelText("Pick one");
}

const GUTTER = "calc(var(--spacing) * 7)";

describe("Select — reserved caret padding is an invariant", () => {
  it("reserves right padding and suppresses the platform arrow", () => {
    const select = renderSelect();
    expect(select.style.paddingRight).toBe(GUTTER);
    expect(select.className).toContain("appearance-none");
  });

  it("survives a caller passing px-*", () => {
    // The regression guard. A utility class cannot express this: cn() drops an
    // earlier pr-7 when it sees px-3, and merging pr-7 last leaves "px-3 pr-7"
    // for the cascade to settle. Inline style outranks both.
    const select = renderSelect({ className: "px-3" });
    expect(select.style.paddingRight).toBe(GUTTER);
  });

  it("survives a caller passing their own style object", () => {
    const select = renderSelect({ style: { paddingRight: 0, paddingLeft: "20px" } });
    expect(select.style.paddingRight).toBe(GUTTER);
    // Everything else the caller sets is still honoured.
    expect(select.style.paddingLeft).toBe("20px");
  });

  it("lets a caller set the left padding by class", () => {
    const select = renderSelect({ className: "pl-3" });
    expect(select.className).toContain("pl-3");
    expect(select.className).not.toContain("pl-2");
    expect(select.style.paddingRight).toBe(GUTTER);
  });
});

describe("Select — the caret is decorative and tracks the control", () => {
  it("hides the caret from the accessible tree and from pointer events", () => {
    const select = renderSelect();
    const caret = select.parentElement?.querySelector("span[aria-hidden]");
    expect(caret).not.toBeNull();
    expect(caret?.className).toContain("pointer-events-none");
    // A decorative sibling must not add a second name for the same control.
    expect(screen.getAllByLabelText("Pick one")).toHaveLength(1);
  });

  it("fades the caret with the control when disabled", () => {
    const select = renderSelect({ disabled: true });
    const caret = select.parentElement?.querySelector("span[aria-hidden]");
    expect(select.className).toContain("disabled:opacity-60");
    expect(select.className).toContain("peer");
    expect(caret?.className).toContain("peer-disabled:opacity-60");
  });
});

describe("Select — fullWidth", () => {
  it("stretches both the wrapper and the control", () => {
    const select = renderSelect({ fullWidth: true });
    expect(select.className).toContain("w-full");
    expect(select.parentElement?.className).toContain("w-full");
  });

  it("leaves both auto-width by default, so time fields size to their content", () => {
    const select = renderSelect();
    expect(select.className).not.toContain("w-full");
    expect(select.parentElement?.className).not.toContain("w-full");
  });
});
