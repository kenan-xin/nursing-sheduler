// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
});
