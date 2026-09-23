// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  computeScenarioFingerprint,
  pickScenario,
  scenarioCommands,
  useScenarioStore,
} from "@/lib/store";
import { BackupStatusBadge } from "./backup-status-badge";
import { resetScenarioForTest, drainScenarioCommands } from "@/lib/store/test-authority";

// A ready store over a fresh empty scenario — no backup recorded yet. Bring-up is
// the harness's job now: it migrates, selects, acquires the lease, and publishes.
async function readyEmptyStore() {
  await resetScenarioForTest();
  await drainScenarioCommands();
}

/**
 * Seed real authored content through the product's own write path, then record it
 * as the downloaded backup — the two durable commits a plain Download produces.
 *
 * T03: this used to poke the projection with `setState`. It cannot any more, and
 * should not: the badge compares the live content's fingerprint against the
 * PERSISTED one, so a projection-only seed would compare a committed fingerprint
 * against uncommitted content and pass for the wrong reason.
 */
async function seedAndRecordBackup() {
  await act(async () => {
    const seeded = pickScenario(makeValidUiState());
    await scenarioCommands.mutate(seeded);
    // The fingerprint is bound to the exact snapshot a Download would have emitted.
    await scenarioCommands.recordBackup(computeScenarioFingerprint(seeded));
  });
}

/** Commit one durable edit and let the badge re-render. */
async function commit(patch: Parameters<typeof scenarioCommands.mutate>[0]) {
  await act(async () => {
    await scenarioCommands.mutate(patch);
  });
}

/** Read the rendered badge's status + visible label. */
function badge() {
  const el = screen.getByTestId("backup-status");
  return { status: el.getAttribute("data-status"), text: el.textContent };
}

beforeEach(async () => {
  await readyEmptyStore();
});

afterEach(async () => {
  cleanup();
});

describe("BackupStatusBadge — tri-state Workspace-backup freshness", () => {
  it("shows 'No backup' when nothing has been downloaded yet", async () => {
    render(<BackupStatusBadge />);
    expect(badge()).toEqual({ status: "none", text: "No backup" });
  });

  it("flips to 'Backup current' after a backup is recorded (a plain Download)", async () => {
    render(<BackupStatusBadge />);
    await seedAndRecordBackup();
    expect(badge()).toEqual({ status: "current", text: "Backup current" });
  });

  it("flips to 'Backup out of date' once the live workspace diverges from the backup", async () => {
    render(<BackupStatusBadge />);
    await seedAndRecordBackup();
    expect(badge().status).toBe("current");

    await commit({ rangeStart: "2099-01-01" });
    expect(badge()).toEqual({ status: "stale", text: "Backup out of date" });
  });

  it("re-marks 'Backup current' when a fresh backup is recorded over a stale one", async () => {
    render(<BackupStatusBadge />);
    await seedAndRecordBackup();
    await commit({ rangeStart: "2099-01-01" });
    expect(badge().status).toBe("stale");

    await act(async () => {
      await scenarioCommands.recordBackup(
        computeScenarioFingerprint(pickScenario(useScenarioStore.getState())),
      );
    });
    expect(badge().status).toBe("current");
  });

  // R7 v2 — the badge is one of the route's CONDITIONAL surfaces: the browser
  // matrix only ever loads the default state, so `current` and `stale` never reach
  // its status-pairing check. These assert the pairing here instead.
  it("carries the matching semantic tier for each state, so status never rests on colour alone", async () => {
    render(<BackupStatusBadge />);
    expect(screen.getByTestId("backup-status")).toHaveAttribute("data-variant", "neutral");

    await seedAndRecordBackup();
    expect(screen.getByTestId("backup-status")).toHaveAttribute("data-variant", "success");

    await commit({ rangeStart: "2099-01-01" });
    expect(screen.getByTestId("backup-status")).toHaveAttribute("data-variant", "warn");
  });

  it("carries no decorative status glyph — the label is the whole signal (DESIGN.md §5)", async () => {
    render(<BackupStatusBadge />);
    const el = screen.getByTestId("backup-status");
    expect(el.querySelector("svg")).toBeNull();
    expect(el.textContent).toBe("No backup");
  });

  it("is a display-only affordance: a plain span, never an interactive/guarding control", async () => {
    render(<BackupStatusBadge />);
    const el = screen.getByTestId("backup-status");
    // No button/link/switch role — it cannot be actuated and cannot gate anything.
    expect(within(el.parentElement as HTMLElement).queryByRole("button")).toBeNull();
    expect(el.tagName).toBe("SPAN");
    expect(el).not.toHaveAttribute("role", "status"); // not a live region (avoids edit-time announcement spam)
  });
});
