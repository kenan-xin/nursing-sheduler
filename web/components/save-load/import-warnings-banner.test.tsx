// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportWarningsBanner } from "./import-warnings-banner";

afterEach(() => cleanup());

describe("ImportWarningsBanner", () => {
  it("uses neutral copy for guard-only warnings", () => {
    render(<ImportWarningsBanner warnings={["Count 1: warning"]} onDismiss={() => {}} />);
    expect(screen.getByTestId("import-warnings-banner")).toHaveTextContent(
      "Imported scenario warnings",
    );
    expect(screen.getByTestId("import-warnings-banner")).not.toHaveTextContent(
      "advanced backend syntax",
    );
  });

  // R7 v2 — this banner only mounts AFTER an import that produced warnings, so the
  // browser matrix's status-pairing and touch-target checks never reach it. Both
  // are asserted directly here.
  it("pairs the warn tint with its matching semantic ink, not a neutral ink", () => {
    render(<ImportWarningsBanner warnings={["Count 1: warning"]} onDismiss={() => {}} />);
    const banner = screen.getByTestId("import-warnings-banner");
    expect(banner.className).toContain("bg-warntint");
    expect(banner.className).toContain("border-warn");

    // Every text layer on the tint carries `--warnink`; nothing is left on the
    // neutral ink ramp, which would read as an unrelated grey note in dark mode.
    const title = screen.getByText("Imported scenario warnings");
    const list = banner.querySelector("ul");
    expect(title.className).toContain("text-warnink");
    expect(list?.className).toContain("text-warnink");
    expect(banner.innerHTML).not.toContain("text-ink2");
  });

  it("dismisses through the shared Button contract rather than a hand-rolled control", () => {
    const onDismiss = vi.fn();
    render(<ImportWarningsBanner warnings={["Count 1: warning"]} onDismiss={onDismiss} />);
    const dismiss = screen.getByTestId("import-warnings-dismiss");

    // `data-slot="button"` is the shared Button's marker, so this asserts the
    // control inherits the pill geometry, `--sh-1` and the coarse-pointer 44px
    // floor instead of re-authoring a 30px box locally.
    expect(dismiss).toHaveAttribute("data-slot", "button");
    expect(dismiss.className).toContain("rounded-pill");
    expect(dismiss.className).toContain("pointer-coarse:min-h-touch");

    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
