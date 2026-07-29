// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { peopleDescriptor } from "./people-descriptor";
import { UploadDialog } from "./upload-dialog";

// The People upload dialog is the ONE overlay in the app that ignores Escape.
// These tests pin both halves of that: the exception itself, and the fact that
// every other dismissal route still closes, so the exception cannot silently
// widen into "this dialog cannot be dismissed".

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

function seedState(): ScenarioUiState {
  return {
    ...createEmptyScenarioUiState(),
    staff: [{ id: "Kevin Ong", history: [] }],
  } as ScenarioUiState;
}

function renderDialog() {
  const commit = vi.fn();
  const onClose = vi.fn();
  const state = seedState();
  render(
    <UploadDialog
      descriptor={peopleDescriptor}
      commit={commit}
      currentState={() => state}
      onClose={onClose}
    />,
  );
  return { commit, onClose };
}

/** A real `File` whose `.text()` resolves in jsdom. */
function textFile(content: string, name = "people.txt") {
  const file = new File([content], name, { type: "text/plain" });
  // jsdom's File does not implement `.text()` in every version; pin it.
  Object.defineProperty(file, "text", { value: () => Promise.resolve(content) });
  return file;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("UploadDialog — shared overlay contract", () => {
  it("renders through the shared portal, not inside the caller's tree", () => {
    const { container } = render(
      <UploadDialog
        descriptor={peopleDescriptor}
        commit={vi.fn()}
        currentState={seedState}
        onClose={vi.fn()}
      />,
    );
    const popup = screen.getByTestId("upload-dialog");
    expect(container).not.toContainElement(popup);
    expect(document.body).toContainElement(popup);
    expect(popup.closest("[data-slot='dialog-portal']")).not.toBeNull();
  });

  it("is an L2 raised card behind the semantic scrim — no raw RGBA overlay", () => {
    renderDialog();
    const popup = screen.getByTestId("upload-dialog");
    const overlay = document.querySelector("[data-slot='dialog-overlay']");
    expect(classesOf(popup)).toContain("bg-surface2");
    expect(classesOf(popup)).toContain("rounded-card");
    expect(classesOf(popup)).toContain("shadow-3");
    expect(classesOf(overlay)).toContain("bg-scrim");
    expect(classesOf(overlay)).not.toContain("bg-black");
  });

  it("exposes a real accessible title and description, not an aria-label", () => {
    renderDialog();
    const popup = screen.getByTestId("upload-dialog");
    expect(popup).toHaveAccessibleName("Upload people list");
    expect(popup).toHaveAccessibleDescription(/One name per line/);
    expect(document.querySelector("[data-slot='dialog-title']")).not.toBeNull();
    expect(document.querySelector("[data-slot='dialog-description']")).not.toBeNull();
  });

  it("contains focus inside the dialog while it is open", async () => {
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId("upload-dialog")).toContainElement(
        document.activeElement as HTMLElement,
      ),
    );
  });
});

describe("UploadDialog — dismissal (Escape is ignored, everything else closes)", () => {
  it("ignores Escape: the dialog stays open and onClose never fires", async () => {
    const { onClose } = renderDialog();
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("upload-dialog")).toBeInTheDocument();

    // Not a one-shot suppression — a second Escape is ignored too.
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on the close button, exactly once", async () => {
    const { onClose } = renderDialog();
    await userEvent.click(screen.getByTestId("upload-dialog-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a backdrop press", async () => {
    const { onClose } = renderDialog();
    const overlay = document.querySelector("[data-slot='dialog-overlay']") as HTMLElement;
    await userEvent.click(overlay);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("UploadDialog — import outcomes are untouched by the migration", () => {
  it("commits and closes on a successful upload", async () => {
    const { commit, onClose } = renderDialog();
    await userEvent.upload(screen.getByTestId("upload-file-input"), textFile("Aisha\nKevin Ong"));
    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(toast.success).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the dialog open on a validation error — no commit, no close", async () => {
    const { commit, onClose } = renderDialog();
    await userEvent.upload(screen.getByTestId("upload-file-input"), textFile("Aisha\nAisha"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(commit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("upload-dialog")).toBeInTheDocument();
  });

  it("rejects an empty file with the verbatim guard", async () => {
    const { commit } = renderDialog();
    await userEvent.upload(screen.getByTestId("upload-file-input"), textFile("   \n  "));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("No content found in the uploaded file."),
    );
    expect(commit).not.toHaveBeenCalled();
  });
});
