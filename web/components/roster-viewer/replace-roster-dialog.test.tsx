// @vitest-environment jsdom

// Audit C-07: "Save roster file first" downloads the viewed roster, edits
// included, and leaves the replace dialog open.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fixtureRosterDocument, withEdits } from "@/lib/roster/test-fixtures";
import { downloadBlob } from "@/lib/utils/download";
import { ReplaceRosterDialog } from "./replace-roster-dialog";

vi.mock("@/lib/utils/download", () => ({ downloadBlob: vi.fn() }));

afterEach(cleanup);

describe("ReplaceRosterDialog", () => {
  it("saves the edited roster file without closing or replacing", async () => {
    const viewed = withEdits(await fixtureRosterDocument(), [
      { personIdx: 0, dateIdx: 0, day: { kind: "off" } },
    ]);
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ReplaceRosterDialog
        open
        onOpenChange={onOpenChange}
        description="Replaced by the file."
        viewed={viewed}
        onConfirm={onConfirm}
        onSaveError={vi.fn()}
      />,
    );
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent("1 manual edit will be lost.");

    fireEvent.click(screen.getByTestId("confirm-dialog-secondary"));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toMatch(/\.json$/);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
