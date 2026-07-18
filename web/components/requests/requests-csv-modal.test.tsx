// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RequestsCsvModal } from "./requests-csv-modal";

afterEach(() => cleanup());

describe("RequestsCsvModal", () => {
  it("shows the Requests CSV copy for kind='requests'", () => {
    render(<RequestsCsvModal open kind="requests" onFileText={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Requests CSV")).toBeInTheDocument();
  });

  it("shows the History CSV copy for kind='history'", () => {
    render(<RequestsCsvModal open kind="history" onFileText={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("History CSV")).toBeInTheDocument();
  });

  it("reads the chosen file to text and calls onFileText", async () => {
    const onFileText = vi.fn();
    render(<RequestsCsvModal open kind="requests" onFileText={onFileText} onClose={vi.fn()} />);
    const file = new File(["a,b,c"], "data.csv", { type: "text/csv" });
    fireEvent.change(screen.getByTestId("requests-csv-file-input"), {
      target: { files: [file] },
    });
    await waitFor(() => expect(onFileText).toHaveBeenCalledWith("a,b,c"));
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<RequestsCsvModal open kind="requests" onFileText={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("requests-csv-modal-close"));
    expect(onClose).toHaveBeenCalled();
  });
});
