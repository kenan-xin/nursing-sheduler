// @vitest-environment jsdom
//
// The receipt BAR (bead 3c1): one slim, collapsed-by-default bar in place of the
// old unbounded stack. Real components throughout (Badge, Button, Surface) --
// only the controller is a stub, since it is a plain data-and-callbacks
// interface, not a component.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AssistantReceiptV1, ReceiptStanding } from "@/lib/store";
import { AssistantReceipts } from "./assistant-receipts";
import type { AssistantProposalController } from "./use-assistant-proposals";

function makeReceipt(id: string, label: string): AssistantReceiptV1 {
  return {
    receiptId: id,
    schemaVersion: 1,
    proposalId: `${id}-proposal`,
    proposalRevision: 1,
    scenarioId: "scenario-1",
    commitId: `${id}-commit`,
    documentRevision: 1,
    historySessionId: "session-1",
    idempotencyKey: `${id}-key`,
    commandDigest: "sha256:digest",
    confirmationDigest: "sha256:digest",
    registryStamp: { appBuildVersion: "0.1.1", manifestSha256: "sha256:manifest" },
    summary: [
      {
        key: `${id}-entry`,
        scope: "roster-period",
        label,
        before: "April 1-30",
        after: "April 1-15",
        kind: "changed",
      },
    ],
    capabilityIds: [],
    createdAt: "2026-04-01T00:00:00.000Z",
  };
}

function standing(id: string, label: string, undo: ReceiptStanding["undo"]): ReceiptStanding {
  return {
    receipt: makeReceipt(id, label),
    undo,
    reason: undo === "available" ? null : "That step can no longer be reversed.",
  };
}

function controllerWith(receipts: ReceiptStanding[]): AssistantProposalController {
  return {
    proposal: null,
    readiness: null,
    applying: false,
    outcome: null,
    receipts,
    confirm: vi.fn(),
    withdraw: vi.fn(),
    revise: vi.fn(),
    cancel: vi.fn(),
    apply: vi.fn(),
    undo: vi.fn(),
    refresh: vi.fn(),
  };
}

afterEach(() => cleanup());

describe("AssistantReceipts", () => {
  it("collapses to a count, with no receipt bodies visible", () => {
    const controller = controllerWith([
      standing("r3", "Shortened the roster", "unavailable"),
      standing("r2", "Moved leave", "unavailable"),
      standing("r1", "Set the roster range", "unavailable"),
    ]);
    render(<AssistantReceipts controller={controller} />);

    expect(screen.getByTestId("assistant-receipts")).toHaveTextContent("3 changes applied");
    expect(screen.queryByTestId("assistant-receipt")).toBeNull();
    expect(screen.queryByTestId("assistant-receipts-list")).toBeNull();
  });

  it("uses singular wording for exactly one change", () => {
    const controller = controllerWith([standing("r1", "Set the roster range", "unavailable")]);
    render(<AssistantReceipts controller={controller} />);
    expect(screen.getByTestId("assistant-receipts")).toHaveTextContent("1 change applied");
  });

  it("shows the newest receipt's title and a working Undo inline while collapsed", async () => {
    const user = userEvent.setup();
    const controller = controllerWith([
      standing("r2", "Moved leave", "available"),
      standing("r1", "Set the roster range", "unavailable"),
    ]);
    render(<AssistantReceipts controller={controller} />);

    const bar = screen.getByTestId("assistant-receipts");
    expect(bar).toHaveTextContent("Moved leave");
    expect(screen.getByTestId("assistant-receipts-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await user.click(screen.getByTestId("receipt-undo"));
    expect(controller.undo).toHaveBeenCalledWith("r2");
  });

  it("toggles the expanded list newest first and flips aria-expanded", async () => {
    const user = userEvent.setup();
    const controller = controllerWith([
      standing("r2", "Moved leave", "unavailable"),
      standing("r1", "Set the roster range", "unavailable"),
    ]);
    render(<AssistantReceipts controller={controller} />);

    const toggle = screen.getByTestId("assistant-receipts-toggle");
    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByTestId("assistant-receipts-list");
    const rows = within(list).getAllByTestId("assistant-receipt-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-receipt-id", "r2");
    expect(rows[1]).toHaveAttribute("data-receipt-id", "r1");
  });

  it("expands an older receipt individually to show its full detail", async () => {
    const user = userEvent.setup();
    const controller = controllerWith([
      standing("r2", "Moved leave", "unavailable"),
      standing("r1", "Set the roster range", "unavailable"),
    ]);
    render(<AssistantReceipts controller={controller} />);

    await user.click(screen.getByTestId("assistant-receipts-toggle"));
    const list = screen.getByTestId("assistant-receipts-list");
    const olderRow = within(list).getAllByTestId("assistant-receipt-row")[1];
    expect(olderRow).toHaveAttribute("data-receipt-id", "r1");

    expect(within(olderRow).queryByTestId("assistant-receipt")).toBeNull();
    await user.click(within(olderRow).getByTestId("receipt-row-toggle"));

    const detail = within(olderRow).getByTestId("assistant-receipt");
    expect(detail).toHaveAttribute("data-receipt-id", "r1");
    expect(detail).toHaveTextContent("Undo no longer available");
  });

  it("renders nothing when there are no receipts", () => {
    const controller = controllerWith([]);
    const { container } = render(<AssistantReceipts controller={controller} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("caps the expanded region with a max-height and its own scroll", async () => {
    const user = userEvent.setup();
    const controller = controllerWith([standing("r1", "Set the roster range", "unavailable")]);
    render(<AssistantReceipts controller={controller} />);

    await user.click(screen.getByTestId("assistant-receipts-toggle"));
    const list = screen.getByTestId("assistant-receipts-list");
    expect(list.className).toMatch(/max-h-/);
    expect(list.className).toMatch(/overflow-y-auto/);
  });
});
