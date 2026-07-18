// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClearDataPanel } from "./clear-data-panel";

afterEach(() => cleanup());

describe("ClearDataPanel", () => {
  it("renders one button per entry and wires its onClick", () => {
    const onClickAll = vi.fn();
    const onClickHistory = vi.fn();
    render(
      <ClearDataPanel
        buttons={[
          { label: "All requests", onClick: onClickAll },
          { label: "All history", onClick: onClickHistory },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("clear-data-button-All requests"));
    fireEvent.click(screen.getByTestId("clear-data-button-All history"));
    expect(onClickAll).toHaveBeenCalledOnce();
    expect(onClickHistory).toHaveBeenCalledOnce();
  });
});
