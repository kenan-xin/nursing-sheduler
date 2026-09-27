// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { useComposerAttachments } from "./use-composer-attachments";
import { useModelImageInput } from "./use-model-image-input";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function Probe({ imageInput }: { imageInput: boolean }) {
  const a = useComposerAttachments(imageInput);
  return (
    <div ref={a.containerRef}>
      <input
        type="file"
        multiple
        data-testid="file"
        ref={a.fileInputRef}
        accept={a.accept}
        onChange={a.handleFileUpload}
      />
      <p data-testid="error">{a.error ?? ""}</p>
      <p data-testid="ready">
        {JSON.stringify(a.ready().map((r) => [r.kind, r.filename, r.mimeType]))}
      </p>
      <button type="button" onClick={a.consume}>
        consume
      </button>
    </div>
  );
}

const upload = (files: File[]) =>
  userEvent.upload(screen.getByTestId("file"), files, { applyAccept: false });
const ready = () => screen.getByTestId("ready").textContent;
const error = () => screen.getByTestId("error").textContent;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("composer attachments (2by.10)", () => {
  it("queues a text file for any model and an image for a vision model", async () => {
    render(<Probe imageInput />);
    await upload([
      new File(["# notes"], "notes.md", { type: "" }),
      new File([PNG], "ward.png", { type: "image/png" }),
    ]);
    await waitFor(() =>
      expect(ready()).toBe(
        JSON.stringify([
          ["text", "notes.md", "text/markdown"],
          ["image", "ward.png", "image/png"],
        ]),
      ),
    );
    expect(error()).toBe("");
  });

  it("refuses an image for a model that cannot read one, and queues nothing", async () => {
    render(<Probe imageInput={false} />);
    await upload([new File([PNG], "ward.png", { type: "image/png" })]);
    await waitFor(() => expect(error()).toMatch(/^This model cannot read images\./));
    expect(ready()).toBe("[]");
  });

  it("refuses a fifth file and an oversized text file", async () => {
    render(<Probe imageInput />);
    await upload([1, 2, 3, 4, 5].map((n) => new File(["x"], `f${n}.txt`, { type: "text/plain" })));
    await waitFor(() => expect(error()).toBe("You can attach up to 4 files to one message."));
    expect(JSON.parse(ready()!)).toHaveLength(4);

    await userEvent.click(screen.getByText("consume"));
    await upload([new File(["x".repeat(200 * 1024 + 1)], "big.txt", { type: "text/plain" })]);
    await waitFor(() => expect(error()).toBe('"big.txt" is larger than 200 KB.'));
  });

  it("checks the bytes, not the name: a renamed file is refused", async () => {
    render(<Probe imageInput />);
    await upload([new File(["MZ\u0090"], "ward.png", { type: "image/png" })]);
    await waitFor(() => expect(error()).toMatch(/^"ward.png" cannot be attached\./));
    await upload([
      new File([new Uint8Array([0x50, 0x4b, 3, 4, 0])], "leave.csv", { type: "text/csv" }),
    ]);
    await waitFor(() => expect(error()).toMatch(/^"leave.csv" cannot be attached\./));
    expect(ready()).toBe("[]");
  });
});

describe("whether the selected model reads images (2by.10)", () => {
  it("reads it from the catalog, and treats an unlisted model as no", async () => {
    const catalog = {
      source: "catalog",
      fallbackVersion: 2,
      recommendedId: "a/vision",
      models: [
        { id: "a/vision", name: "V", contextLength: null, imageInput: true },
        { id: "b/text", name: "T", contextLength: null, imageInput: false },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(catalog), { status: 200 }),
    );
    const select = (modelId: string | null) =>
      useAssistantStore.setState((state) => ({ settings: { ...state.settings, modelId } }));

    select("a/vision");
    const { result } = renderHook(() => useModelImageInput());
    await waitFor(() => expect(result.current).toBe(true));

    select("b/text");
    await waitFor(() => expect(result.current).toBe(false));
    select("custom/slug");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toBe(false);
    assistantActions.resetForTest();
  });
});
