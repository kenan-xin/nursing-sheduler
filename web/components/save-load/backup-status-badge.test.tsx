// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioPersist,
  hydrateScenarioStore,
  pickScenario,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { BackupStatusBadge } from "./backup-status-badge";

// A ready store over a fresh empty scenario — no backup recorded yet.
async function readyEmptyStore() {
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
  await hydrateScenarioStore(useScenarioStore, useHotStore);
}

/** Read the rendered badge's status + visible label. */
function badge() {
  const el = screen.getByTestId("backup-status");
  return { status: el.getAttribute("data-status"), text: el.textContent };
}

beforeEach(async () => {
  await readyEmptyStore();
});

afterEach(() => {
  cleanup();
});

describe("BackupStatusBadge — tri-state Workspace-backup freshness", () => {
  it("shows 'No backup' when nothing has been downloaded yet", () => {
    render(<BackupStatusBadge />);
    expect(badge()).toEqual({ status: "none", text: "No backup" });
  });

  it("flips to 'Backup current' after a backup is recorded (a plain Download)", () => {
    render(<BackupStatusBadge />);
    act(() => {
      // Seed real content, then record it as the downloaded backup.
      useScenarioStore.setState(pickScenario(makeValidUiState()), false);
      useScenarioStore.getState().recordBackup();
    });
    expect(badge()).toEqual({ status: "current", text: "Backup current" });
  });

  it("flips to 'Backup out of date' once the live workspace diverges from the backup", () => {
    render(<BackupStatusBadge />);
    act(() => {
      useScenarioStore.setState(pickScenario(makeValidUiState()), false);
      useScenarioStore.getState().recordBackup();
    });
    expect(badge().status).toBe("current");

    act(() => {
      useScenarioStore.getState().mutateScenario({ rangeStart: "2099-01-01" });
    });
    expect(badge()).toEqual({ status: "stale", text: "Backup out of date" });
  });

  it("re-marks 'Backup current' when a fresh backup is recorded over a stale one", () => {
    render(<BackupStatusBadge />);
    act(() => {
      useScenarioStore.setState(pickScenario(makeValidUiState()), false);
      useScenarioStore.getState().recordBackup();
      useScenarioStore.getState().mutateScenario({ rangeStart: "2099-01-01" });
    });
    expect(badge().status).toBe("stale");

    act(() => {
      useScenarioStore.getState().recordBackup();
    });
    expect(badge().status).toBe("current");
  });

  it("is a display-only affordance: a plain span, never an interactive/guarding control", () => {
    render(<BackupStatusBadge />);
    const el = screen.getByTestId("backup-status");
    // No button/link/switch role — it cannot be actuated and cannot gate anything.
    expect(within(el.parentElement as HTMLElement).queryByRole("button")).toBeNull();
    expect(el.tagName).toBe("SPAN");
    expect(el).not.toHaveAttribute("role", "status"); // not a live region (avoids edit-time announcement spam)
  });
});
