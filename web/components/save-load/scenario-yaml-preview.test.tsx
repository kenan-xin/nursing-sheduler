// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScenarioYamlPreview, type ScenarioYamlPreviewProps } from "./scenario-yaml-preview";

// Presentational coverage — the store-integrated Edit flows (seed / Apply /
// Cancel / version gate) are exercised against the real store in
// `save-load-workspace.test.tsx`, since the workspace container now owns the
// editing state and the import pipeline.

const EXPORT_YAML = "apiVersion: alpha\ndescription: Ward\n";

function renderPreview(overrides: Partial<ScenarioYamlPreviewProps> = {}) {
  const props: ScenarioYamlPreviewProps = {
    exportResult: { ok: true, yaml: EXPORT_YAML },
    schema: "alpha",
    editing: false,
    draft: "",
    issues: null,
    onDraftChange: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<ScenarioYamlPreview {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
});

describe("ScenarioYamlPreview — read-only mode", () => {
  it("renders the export YAML, the version footer, and the auto-save badge", () => {
    renderPreview();
    expect(screen.getByTestId("scenario-yaml-content").textContent).toBe(EXPORT_YAML);
    expect(screen.getByTestId("scenario-version-footer")).toHaveTextContent("SCHEMA alpha");
    expect(screen.getByTestId("persistence-badge")).toBeInTheDocument();
    expect(screen.queryByTestId("scenario-yaml-textarea")).not.toBeInTheDocument();
  });

  it("renders the V-issues instead of YAML when the export is invalid", () => {
    renderPreview({
      exportResult: {
        ok: false,
        issues: [{ path: "dates.range.startDate", message: "Invalid ISO date" }],
      },
    });
    expect(screen.getByTestId("scenario-export-issues")).toHaveTextContent("Invalid ISO date");
    expect(screen.queryByTestId("scenario-yaml-content")).not.toBeInTheDocument();
  });
});

describe("ScenarioYamlPreview — editing mode", () => {
  it("renders the workspace-owned draft and hides the badge", () => {
    renderPreview({ editing: true, draft: "draft text" });
    expect(screen.getByTestId("scenario-yaml-textarea")).toHaveValue("draft text");
    expect(screen.queryByTestId("scenario-yaml-content")).not.toBeInTheDocument();
    expect(screen.queryByTestId("persistence-badge")).not.toBeInTheDocument();
  });

  it("routes textarea edits, Apply, and Cancel to the container callbacks", () => {
    const props = renderPreview({ editing: true, draft: "draft text" });

    fireEvent.change(screen.getByTestId("scenario-yaml-textarea"), {
      target: { value: "edited" },
    });
    expect(props.onDraftChange).toHaveBeenCalledWith("edited");

    fireEvent.click(screen.getByTestId("yaml-apply-button"));
    expect(props.onApply).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("yaml-cancel-button"));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows a failed Apply's V-issues inside the editor", () => {
    renderPreview({
      editing: true,
      draft: "::bad::",
      issues: [{ path: "", message: "bad indentation of a mapping entry" }],
    });
    expect(screen.getByTestId("scenario-export-issues")).toHaveTextContent(
      "bad indentation of a mapping entry",
    );
  });
});

// R7 v2 — the editing branch and the invalid-export branch are CONDITIONAL, so the
// browser matrix (which only loads the route's default read-only state) never
// measures either. These assert the two v2 rules that apply to them.
describe("ScenarioYamlPreview — v2 surface roles on the conditional branches", () => {
  it("puts the editor textarea on the canonical field contract, not the L0 page plane", () => {
    renderPreview({ editing: true, draft: "text" });
    const textarea = screen.getByTestId("scenario-yaml-textarea");

    // DESIGN.md §5: textareas take `--r-ctl` and the `--surface` field fill. The
    // prototype's `background:var(--bg)` is the L0 plane, which §4 gives no role as
    // a child of an L1 card — see the component header for the recorded deviation.
    expect(textarea.className).toContain("rounded-control");
    expect(textarea.className).toContain("bg-surface");
    expect(textarea.className).toContain("border-line");
    expect(textarea.className).not.toContain("bg-bg");
  });

  it("renders the invalid-export issue list as a rounded inset island on paired error tokens", () => {
    renderPreview({
      exportResult: { ok: false, issues: [{ path: "dates", message: "Invalid ISO date" }] },
    });
    const issues = screen.getByTestId("scenario-export-issues");

    // An inner bordered box inside an L1 card → `--r-ctl` (§5), with the errortint
    // paired to `--errorink` so the tier never rests on colour alone (§2).
    expect(issues.className).toContain("rounded-control");
    expect(issues.className).toContain("bg-errortint");
    expect(issues.className).toContain("border-error");
    expect(issues.className).toContain("text-errorink");
  });
});
