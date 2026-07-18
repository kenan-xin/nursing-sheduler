// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
