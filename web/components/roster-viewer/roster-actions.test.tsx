// @vitest-environment jsdom
//
// Edited-XLSX export naming and failure copy (audit C-33, C-34).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AutosaveSnapshot, RosterDocument } from "@/lib/roster";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import { downloadBlob } from "@/lib/utils/download";
import { RosterActions } from "./roster-actions";

vi.mock("@/lib/utils/download", () => ({ downloadBlob: vi.fn() }));

const SAVED: AutosaveSnapshot = { status: "saved", failure: null, dirty: false };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(document: RosterDocument, onExportError = vi.fn()) {
  const view = render(
    <RosterActions
      document={document}
      save={SAVED}
      onRetrySave={vi.fn()}
      onImportFile={vi.fn()}
      onClear={vi.fn()}
      onExportError={onExportError}
    />,
  );
  fireEvent.click(view.getByTestId("roster-export-xlsx"));
  return onExportError;
}

describe("RosterActions — Export XLSX", () => {
  it("names an unedited roster without the -edited suffix", async () => {
    const document = await fixtureRosterDocument();
    mount(document);
    const first = document.context.calendar[0]!.iso;
    await waitFor(() =>
      expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), `roster-${first}.xlsx`),
    );
  });

  it("reports a failed export in plain words with a real next step", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The fixture's stand-in bytes are not a workbook, so an edit cannot be patched.
    const document: RosterDocument = {
      ...(await fixtureRosterDocument()),
      edits: [{ personIdx: 0, dateIdx: 0, day: { kind: "off" } }],
    };
    const onExportError = mount(document);
    await waitFor(() => expect(onExportError).toHaveBeenCalledOnce());
    const message = onExportError.mock.calls[0]![0] as string;
    expect(message).not.toMatch(/ExcelJS|Try again/);
    expect(message).toContain("Save roster file");
    expect(message).toContain("run Optimize again");
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
