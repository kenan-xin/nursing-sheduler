// @vitest-environment jsdom
//
// Bug 9qr: one proposal adding 11 nurses and 3 staff groups, applied, must open
// Staff and outline every new row. Same harness as apply-navigation.integration.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { clearChangeHighlight } from "@/lib/change-highlight/store";
import { changeKeys } from "@/lib/change-highlight/keys";
import type { AssistantCommandV1 } from "@/lib/proposal";
import { proposalScenario } from "@/lib/proposal/test-support";
import { useModeStore } from "@/lib/mode/mode";
import { assistantProposalCommands } from "@/lib/store";
import { loadScenario } from "@/lib/store/lifecycle";
import { clearTestAuthority, installTestAuthority } from "@/lib/store/test-authority";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { PeopleTable } from "@/components/people/people-table";
import { ProposalPreviewCard } from "./proposal-preview-card";
import { ApplyNavigationNotice } from "./apply-navigation-notice";
import { useAssistantProposals } from "./use-assistant-proposals";

const push = vi.fn((path: string) => {
  setTimeout(() => window.history.replaceState({}, "", path), 20);
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => window.location.pathname,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function Assistant() {
  const controller = useAssistantProposals();
  return (
    <>
      <ProposalPreviewCard controller={controller} onSend={() => {}} disabled={false} />
      <ApplyNavigationNotice controller={controller} />
    </>
  );
}

const GROUPS = ["SSN", "SN", "EN"];
const NURSES = [
  ["SSN-Goh", "SSN"],
  ["SSN-Tan", "SSN"],
  ["SSN-Lee", "SSN"],
  ["SN-Lim", "SN"],
  ["SN-Ng", "SN"],
  ["SN-Ong", "SN"],
  ["SN-Koh", "SN"],
  ["EN-Chua", "EN"],
  ["EN-Teo", "EN"],
  ["EN-Yeo", "EN"],
  ["EN-Low", "EN"],
] as const;

const COMMANDS: AssistantCommandV1[] = [
  ...GROUPS.map(
    (groupId): AssistantCommandV1 => ({
      type: "add_people_group",
      groupId,
      description: "",
      members: [],
    }),
  ),
  ...NURSES.map(
    ([name, group]): AssistantCommandV1 => ({
      type: "add_person",
      name,
      groups: [group],
    }),
  ),
];

beforeEach(async () => {
  push.mockClear();
  assistantActions.resetForTest();
  await installTestAuthority();
  // A ward being set up: no staff yet, as when the assistant adds a whole team.
  await loadScenario({ ...proposalScenario(), staff: [], reqData: [] });
  useModeStore.setState({ mode: "guided", adoption: "ready" });
  window.history.replaceState({}, "", "/dates");
});

afterEach(() => {
  cleanup();
  clearTestAuthority();
  clearChangeHighlight();
  useModeStore.setState({ mode: "guided", adoption: "unhydrated" });
  window.history.replaceState({}, "", "/");
});

describe("Apply of a mixed people + staff group proposal", () => {
  it.each(["/dates", "/people"])(
    "from %s: shows Staff and outlines every added person and group",
    async (start) => {
      window.history.replaceState({}, "", start);
      const user = userEvent.setup();
      const prepared = await assistantProposalCommands.prepare({
        proposalId: crypto.randomUUID(),
        threadId: "thread-1",
        turnId: "turn-1",
        registryStamp: capabilityRegistryStamp(),
        commands: COMMANDS,
        rationale: "You asked for the new nurses.",
        evidence: [{ kind: "user_statement", label: "You said so", reference: null }],
        outcome: "untested",
      });
      if (!prepared.ok)
        throw new Error(`fixture proposal was refused: ${JSON.stringify(prepared)}`);
      assistantActions.showProposal(
        prepared.proposal.proposalId,
        useAssistantStore.getState().turnEpoch,
      );

      render(
        <>
          <Assistant />
          <PeopleTable />
        </>,
      );

      const apply = await screen.findByTestId("proposal-apply");
      await waitFor(() => expect(apply).toBeEnabled());
      await user.click(apply);

      if (start !== "/people") await waitFor(() => expect(push.mock.calls[0]?.[0]).toBe("/people"));
      await waitFor(() =>
        expect(screen.getByTestId("apply-navigation-status")).toHaveTextContent(
          /Opened Staff\. .*11 people added/,
        ),
      );
      const outlined = () =>
        new Set(
          [...document.querySelectorAll('[data-change-highlight="true"]')].map((el) =>
            el.getAttribute("data-change-key"),
          ),
        );
      await waitFor(() => {
        for (const [name] of NURSES) expect(outlined()).toContain(changeKeys.person(name));
        for (const group of GROUPS) expect(outlined()).toContain(changeKeys.peopleGroup(group));
      });
    },
  );
});
