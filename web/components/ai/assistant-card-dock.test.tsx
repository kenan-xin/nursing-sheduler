// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DockedComposer } from "./assistant-card-dock";

// The library's composer, unstubbed: its icon-only buttons need names we supply.
afterEach(() => {
  cleanup();
});

describe("DockedComposer", () => {
  it("names the icon-only add and send buttons", () => {
    render(<DockedComposer onSubmitMessage={vi.fn()} onStop={vi.fn()} onAddFile={vi.fn()} />);
    expect(screen.getByTestId("copilot-add-menu-button")).toHaveAccessibleName("Add attachment");
    expect(screen.getByTestId("copilot-send-button")).toHaveAccessibleName("Send message");
  });

  it("names the send button Stop while a turn runs", () => {
    render(<DockedComposer onSubmitMessage={vi.fn()} onStop={vi.fn()} isRunning />);
    expect(screen.getByTestId("copilot-send-button")).toHaveAccessibleName("Stop");
  });
});
