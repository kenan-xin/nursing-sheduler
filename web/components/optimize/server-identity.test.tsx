// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OptimizeServerInfo } from "@/lib/optimize";
import { ServerIdentity } from "./server-identity";

afterEach(() => cleanup());

function info(over: Partial<OptimizeServerInfo> = {}): OptimizeServerInfo {
  return {
    status: "online",
    apiVersion: "alpha",
    backendVersion: "1.2.3",
    clientVersion: "1.2.3",
    versionTier: "identical",
    unavailableReason: null,
    recheck: vi.fn(),
    ...over,
  };
}

describe("ServerIdentity", () => {
  it("shows the online pill and the version identity line, silent on an identical tier", () => {
    render(<ServerIdentity info={info()} />);
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByTestId("optimize-server-identity")).toHaveTextContent(
      "API version: alpha · Frontend version: 1.2.3 · Backend version: 1.2.3",
    );
    expect(screen.queryByTestId("optimize-version-mismatch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-version-note")).not.toBeInTheDocument();
  });

  it("warns on an incompatible tier", () => {
    render(
      <ServerIdentity info={info({ versionTier: "incompatible", backendVersion: "9.9.9" })} />,
    );
    expect(screen.getByTestId("optimize-version-mismatch")).toHaveTextContent(
      "Frontend and backend versions do not match.",
    );
    expect(screen.queryByTestId("optimize-version-note")).not.toBeInTheDocument();
  });

  it("shows a passive note (not a warning) on a compatible tier", () => {
    render(<ServerIdentity info={info({ versionTier: "compatible" })} />);
    expect(screen.getByTestId("optimize-version-note")).toHaveTextContent("same version line");
    expect(screen.queryByTestId("optimize-version-mismatch")).not.toBeInTheDocument();
  });

  it("shows the dev-build note on a dirty tier", () => {
    render(<ServerIdentity info={info({ versionTier: "dirty" })} />);
    expect(screen.getByTestId("optimize-version-note")).toHaveTextContent("uncommitted changes");
  });

  it("shows a note on indeterminate and missing tiers", () => {
    const { rerender } = render(<ServerIdentity info={info({ versionTier: "indeterminate" })} />);
    expect(screen.getByTestId("optimize-version-note")).toHaveTextContent("No tagged version");
    rerender(<ServerIdentity info={info({ versionTier: "missing" })} />);
    expect(screen.getByTestId("optimize-version-note")).toHaveTextContent(
      "Version information is missing",
    );
  });

  it("renders no version banner when the tier is not-applicable (backend null)", () => {
    render(
      <ServerIdentity info={info({ status: "online", versionTier: null, backendVersion: null })} />,
    );
    expect(screen.queryByTestId("optimize-version-mismatch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-version-note")).not.toBeInTheDocument();
  });

  it("shows the offline warning with its reason", () => {
    render(
      <ServerIdentity
        info={info({ status: "offline", unavailableReason: "backend_unreachable" })}
      />,
    );
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByTestId("optimize-server-offline")).toHaveTextContent(
      "Backend is not responding at the configured endpoint.",
    );
    expect(screen.getByTestId("optimize-server-offline")).toHaveTextContent("backend_unreachable");
  });

  it("shows the checking state", () => {
    render(<ServerIdentity info={info({ status: "checking" })} />);
    expect(screen.getByText("Checking")).toBeInTheDocument();
  });

  it("re-checks on demand", async () => {
    const recheck = vi.fn();
    render(<ServerIdentity info={info({ recheck })} />);
    await userEvent.click(screen.getByTestId("optimize-recheck"));
    expect(recheck).toHaveBeenCalled();
  });
});
