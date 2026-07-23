// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DateRange } from "@/lib/dates";
import type { UiDateGroup } from "@/lib/scenario";
import { DateGroupsCard } from "./date-groups-card";

afterEach(() => {
  cleanup();
});

const AUG: DateRange = { start: "2026-08-01", end: "2026-08-31" };
const SEP: DateRange = { start: "2026-09-01", end: "2026-09-30" };

// A single editable group with in-range members (same-month ids are `DD`).
const GROUPS: UiDateGroup[] = [{ id: "SummerRun", members: ["01", "02", "03"] }];

interface Handlers {
  onCreateGroup: (name: string, memberIds: string[]) => void;
  onSaveGroup: (oldId: string, name: string, memberIds: string[]) => void;
  onDeleteGroup: (id: string) => void;
}

function renderCard(range: DateRange, handlers: Partial<Handlers> = {}) {
  const props: Handlers = {
    onCreateGroup: vi.fn(),
    onSaveGroup: vi.fn(),
    onDeleteGroup: vi.fn(),
    ...handlers,
  };
  const view = render(
    <DateGroupsCard
      range={range}
      editableGroups={GROUPS}
      onCreateGroup={props.onCreateGroup}
      onSaveGroup={props.onSaveGroup}
      onDeleteGroup={props.onDeleteGroup}
    />,
  );
  const rerender = (next: DateRange) =>
    view.rerender(
      <DateGroupsCard
        range={next}
        editableGroups={GROUPS}
        onCreateGroup={props.onCreateGroup}
        onSaveGroup={props.onSaveGroup}
        onDeleteGroup={props.onDeleteGroup}
      />,
    );
  return { ...props, rerender };
}

describe("DateGroupsCard — transient state resets on a range change (VR-DC)", () => {
  it("clears the stale Selected preview panel when the range changes underneath it", () => {
    const { rerender } = renderCard(AUG);

    fireEvent.click(screen.getByTestId("editable-group-preview-SummerRun"));
    expect(screen.getByTestId("date-group-preview")).toBeTruthy();

    // Range changes (undo/redo, external cascade): the stale panel must clear.
    rerender(SEP);
    expect(screen.queryByTestId("date-group-preview")).toBeNull();
  });

  it("keeps the preview open on an unrelated re-render (no reset without a range change)", () => {
    const { rerender } = renderCard(AUG);

    fireEvent.click(screen.getByTestId("editable-group-preview-SummerRun"));
    expect(screen.getByTestId("date-group-preview")).toBeTruthy();

    // Same range → the guard must not wipe transient state on every render.
    rerender(AUG);
    expect(screen.getByTestId("date-group-preview")).toBeTruthy();
  });

  it("closes an open edit draft so a stale draft can never be saved after a range change", () => {
    const onSaveGroup = vi.fn();
    const { rerender } = renderCard(AUG, { onSaveGroup });

    // Open the existing group's editor — seeds draftSelected from its members.
    fireEvent.click(screen.getByTestId("editable-group-edit-SummerRun"));
    expect(screen.getByTestId("date-group-editor-SummerRun")).toBeTruthy();

    // The range cascade re-keys/purges ids underneath the open editor.
    rerender(SEP);

    // Editor is closed: no Save affordance remains, so buildMembers can never run
    // against the stale, re-keyed selection.
    expect(screen.queryByTestId("date-group-editor-SummerRun")).toBeNull();
    expect(screen.queryByTestId("date-group-save")).toBeNull();
    expect(onSaveGroup).not.toHaveBeenCalled();
  });

  it("closes the new-group draft editor on a range change", () => {
    const onCreateGroup = vi.fn();
    const { rerender } = renderCard(AUG, { onCreateGroup });

    fireEvent.click(screen.getByTestId("date-group-add"));
    expect(screen.getByTestId("date-group-editor-new")).toBeTruthy();

    rerender(SEP);
    expect(screen.queryByTestId("date-group-editor-new")).toBeNull();
    expect(screen.queryByTestId("date-group-save")).toBeNull();
    expect(onCreateGroup).not.toHaveBeenCalled();
  });
});
