// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UploadModal } from "./upload-modal";

function renderModal(onFile = vi.fn(), onLoadSample = vi.fn()) {
  render(<UploadModal open onOpenChange={() => {}} onFile={onFile} onLoadSample={onLoadSample} />);
  return { onFile, onLoadSample };
}

function dropFile(name: string, content = "content") {
  const file = new File([content], name, { type: "text/plain" });
  fireEvent.drop(screen.getByTestId("upload-dropzone"), {
    dataTransfer: { files: [file] },
  });
}

describe("UploadModal — extension validation (FR-SL-10 / V1)", () => {
  let alertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
    cleanup();
  });

  it("accepts a dropped .yaml file", async () => {
    const { onFile } = renderModal();
    dropFile("scenario.yaml");
    await waitFor(() => expect(onFile).toHaveBeenCalledTimes(1));
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("rejects a dropped file with a disallowed extension — same guard as the file picker", () => {
    const { onFile } = renderModal();
    dropFile("scenario.txt");

    expect(alertSpy).toHaveBeenCalledWith(
      "Please upload a file with one of these extensions: .yaml, .yml",
    );
    expect(onFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The shared-overlay half (F3). This modal is a dumb file picker: it delegates
// exactly once per action and never decides anything about the load. The
// version confirmation that may follow is a separate overlay owned by
// `save-load-workspace.tsx`, and this modal unmounts before it appears — a
// sequential handover between two base-layer overlays, not a stack. What is
// pinned here is this modal's own contract: base layer, one close signal per
// dismissal, no extra trigger DOM.
// ---------------------------------------------------------------------------

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

function renderOverlay() {
  const onFile = vi.fn();
  const onLoadSample = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <UploadModal open onOpenChange={onOpenChange} onFile={onFile} onLoadSample={onLoadSample} />,
  );
  return { onFile, onLoadSample, onOpenChange };
}

describe("UploadModal — shared overlay contract", () => {
  afterEach(() => cleanup());

  it("is an L2 raised card in the shared portal behind bg-scrim", () => {
    renderOverlay();
    const popup = screen.getByTestId("upload-modal");
    const overlay = document.querySelector("[data-slot='dialog-overlay']");
    expect(popup.closest("[data-slot='dialog-portal']")).not.toBeNull();
    expect(classesOf(popup)).toContain("bg-surface2");
    expect(classesOf(popup)).toContain("rounded-card");
    expect(classesOf(popup)).toContain("shadow-3");
    expect(classesOf(overlay)).toContain("bg-scrim");
    expect(classesOf(overlay)).not.toContain("bg-black");
  });

  it("exposes a real title and a visually-hidden description", () => {
    renderOverlay();
    const popup = screen.getByTestId("upload-modal");
    expect(popup).toHaveAccessibleName("Upload scenario");
    expect(popup).toHaveAccessibleDescription(/scenario file/);
    expect(classesOf(document.querySelector("[data-slot='dialog-description']"))).toContain(
      "sr-only",
    );
  });

  it("is a base-layer overlay", () => {
    renderOverlay();
    expect(screen.getByTestId("upload-modal")).toHaveAttribute("data-layer", "base");
  });

  it("adds no wrapper-only trigger DOM — the workspace owns the Upload trigger", () => {
    renderOverlay();
    expect(document.querySelector("[data-slot='dialog-trigger']")).toBeNull();
  });
});

describe("UploadModal — each action delegates exactly once", () => {
  afterEach(() => cleanup());

  it("a selected file is read and handed on once", async () => {
    const { onFile } = renderOverlay();
    const file = new File(["meta: {}"], "scenario.yaml", { type: "text/yaml" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve("meta: {}") });
    await userEvent.upload(screen.getByTestId("upload-file-input"), file);
    await waitFor(() => expect(onFile).toHaveBeenCalledExactlyOnceWith("meta: {}"));
  });

  it("the sample affordance delegates once and reads no file", async () => {
    const { onFile, onLoadSample } = renderOverlay();
    await userEvent.click(screen.getByTestId("upload-load-sample-button"));
    expect(onLoadSample).toHaveBeenCalledOnce();
    expect(onFile).not.toHaveBeenCalled();
  });

  it("Escape, a backdrop press and the close control each emit one close", async () => {
    const escape = renderOverlay();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(escape.onOpenChange).toHaveBeenCalledOnce());
    expect(escape.onOpenChange.mock.calls[0][0]).toBe(false);
    cleanup();

    const backdrop = renderOverlay();
    await userEvent.click(document.querySelector("[data-slot='dialog-overlay']") as HTMLElement);
    await waitFor(() => expect(backdrop.onOpenChange).toHaveBeenCalledOnce());
    cleanup();

    const closed = renderOverlay();
    await userEvent.click(screen.getByTestId("upload-modal-close"));
    expect(closed.onOpenChange).toHaveBeenCalledOnce();
    expect(closed.onOpenChange.mock.calls[0][0]).toBe(false);
  });
});
