// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// ---------------------------------------------------------------------------
// The shared-overlay half (F3). This modal reads a file to TEXT and hands it on;
// all parsing and store decisions stay with the container, so the callback must
// fire exactly once per selection and every dismissal must be a plain close.
// ---------------------------------------------------------------------------

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

function renderModal() {
  const onFileText = vi.fn();
  const onClose = vi.fn();
  render(<RequestsCsvModal open kind="requests" onFileText={onFileText} onClose={onClose} />);
  return { onFileText, onClose };
}

describe("RequestsCsvModal — shared overlay contract", () => {
  it("is an L2 raised card in the shared portal behind bg-scrim", () => {
    renderModal();
    const popup = screen.getByTestId("requests-csv-modal");
    const overlay = document.querySelector("[data-slot='dialog-overlay']");
    expect(popup.closest("[data-slot='dialog-portal']")).not.toBeNull();
    expect(classesOf(popup)).toContain("bg-surface2");
    expect(classesOf(popup)).toContain("rounded-card");
    expect(classesOf(popup)).toContain("shadow-3");
    expect(classesOf(overlay)).toContain("bg-scrim");
    expect(classesOf(overlay)).not.toContain("bg-black");
  });

  it("carries the kind's copy as a real title and description", () => {
    renderModal();
    const popup = screen.getByTestId("requests-csv-modal");
    expect(popup).toHaveAccessibleName("Requests CSV");
    expect(popup).toHaveAccessibleDescription(/One row per person/);
  });

  it("adds no wrapper-only trigger DOM — the container owns the trigger", () => {
    renderModal();
    expect(document.querySelector("[data-slot='dialog-trigger']")).toBeNull();
  });
});

describe("RequestsCsvModal — exactly-once callbacks", () => {
  it("hands the file text on exactly once per selection", async () => {
    const { onFileText, onClose } = renderModal();
    const file = new File(["a,b,c"], "data.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve("a,b,c") });
    await userEvent.upload(screen.getByTestId("requests-csv-file-input"), file);
    await waitFor(() => expect(onFileText).toHaveBeenCalledExactlyOnceWith("a,b,c"));
    // Closing is the container's decision after it parses, not this modal's.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the close control emits exactly ONE onClose", async () => {
    const { onFileText, onClose } = renderModal();
    await userEvent.click(screen.getByTestId("requests-csv-modal-close"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onFileText).not.toHaveBeenCalled();
  });

  it("Escape and a backdrop press each close once", async () => {
    const escape = renderModal();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(escape.onClose).toHaveBeenCalledOnce());
    cleanup();

    const backdrop = renderModal();
    const overlay = document.querySelector("[data-slot='dialog-overlay']") as HTMLElement;
    await userEvent.click(overlay);
    await waitFor(() => expect(backdrop.onClose).toHaveBeenCalledOnce());
  });
});
