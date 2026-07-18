// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLosableDraft } from "./use-losable-draft";
import { hasLosableDrafts, useNavGuardStore } from "./nav-guard-store";

describe("useLosableDraft", () => {
  beforeEach(() => {
    useNavGuardStore.setState({ drafts: new Map(), pendingIntent: null, open: false });
  });

  it("registers immediately when active, before any further interaction", () => {
    renderHook(() => useLosableDraft("editor-a", true, "Editor A"));
    expect(hasLosableDrafts()).toBe(true);
  });

  it("does not register while inactive", () => {
    renderHook(() => useLosableDraft("editor-a", false, "Editor A"));
    expect(hasLosableDrafts()).toBe(false);
  });

  it("unregisters on unmount", () => {
    const { unmount } = renderHook(() => useLosableDraft("editor-a", true, "Editor A"));
    expect(hasLosableDrafts()).toBe(true);
    unmount();
    expect(hasLosableDrafts()).toBe(false);
  });

  it("toggling active false disarms; toggling back on re-arms", () => {
    const { rerender } = renderHook(
      ({ active }) => useLosableDraft("editor-a", active, "Editor A"),
      {
        initialProps: { active: true },
      },
    );
    expect(hasLosableDrafts()).toBe(true);

    rerender({ active: false });
    expect(hasLosableDrafts()).toBe(false);

    rerender({ active: true });
    expect(hasLosableDrafts()).toBe(true);
  });

  it("two independent owners: closing one leaves the other's guard armed", () => {
    const a = renderHook(() => useLosableDraft("editor-a", true, "Editor A"));
    renderHook(() => useLosableDraft("editor-b", true, "Editor B"));
    expect(hasLosableDrafts()).toBe(true);

    a.unmount();
    expect(hasLosableDrafts()).toBe(true); // editor-b is still open

    expect(useNavGuardStore.getState().drafts.has("editor-b")).toBe(true);
  });
});
