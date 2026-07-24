// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { deriveOptimizeReadiness } from "@/lib/optimize";
import { ReadinessBanner } from "./readiness-banner";

// GuardedLink reads the router; a lightweight stub keeps this a focused render test.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/optimize-and-export",
}));

afterEach(() => cleanup());

describe("ReadinessBanner", () => {
  it("renders nothing when ready", () => {
    const { container } = render(<ReadinessBanner issues={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders required-data issues with tab links", () => {
    const { issues } = deriveOptimizeReadiness({
      rangeStart: "",
      rangeEnd: "",
      staff: [],
      shifts: [],
      shiftGroups: [],
    });
    render(<ReadinessBanner issues={issues} />);
    const banner = screen.getByTestId("optimize-readiness");
    expect(banner).toHaveTextContent("Please set up your dates first by visiting the");
    expect(screen.getByRole("link", { name: "Dates" })).toHaveAttribute("href", "/dates");
    expect(screen.getByRole("link", { name: "Staff" })).toHaveAttribute("href", "/people");
    expect(screen.getByRole("link", { name: "Shifts" })).toHaveAttribute("href", "/shift-types");
  });
});
