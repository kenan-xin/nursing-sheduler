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
    versionMismatch: false,
    unavailableReason: null,
    recheck: vi.fn(),
    ...over,
  };
}

describe("ServerIdentity", () => {
  it("shows the online pill and the version identity line", () => {
    render(<ServerIdentity info={info()} />);
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByTestId("optimize-server-identity")).toHaveTextContent(
      "API version: alpha · Frontend version: 1.2.3 · Backend version: 1.2.3",
    );
    expect(screen.queryByTestId("optimize-version-mismatch")).not.toBeInTheDocument();
  });

  it("warns on a version mismatch", () => {
    render(<ServerIdentity info={info({ versionMismatch: true, backendVersion: "9.9.9" })} />);
    expect(screen.getByTestId("optimize-version-mismatch")).toHaveTextContent(
      "Frontend and backend versions do not match.",
    );
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
