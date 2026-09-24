// @vitest-environment jsdom
//
// THE SHIPPED PROPOSAL TOOL BOUNDARY, driven with the arguments a model actually sends.
//
// Every other proposal suite calls `assistantProposalCommands.prepare` directly, which
// is why the live blocker survived all of them: the defect is not in the adapter, it is
// in the ONE step between the model's JSON and that call.
//
// WHAT THE LOCKED RUNTIME DOES WITH TOOL ARGUMENTS -- and it is less than the shipped
// handler assumed. `CopilotKitCore` parses a tool call's arguments with
// `parseToolArguments`, which is `JSON.parse` plus an object check. It does NOT validate
// against the registered Zod schema and it does NOT apply that schema's defaults. The
// handler receives the model's raw object.
//
// So `evidence`, declared `z.array(...).default([])`, is absent from the wire schema's
// `required` list, and the `default` the serialiser emits is dropped by the round trip
// through `convertJsonSchemaToZodSchema`. A model that omits it -- which it is entitled
// to do -- reached `args.evidence.map(...)` on `undefined`. CopilotKit caught the
// TypeError, returned `Error: Cannot read properties of undefined (reading 'map')` as
// the tool result, and drove a second hop; the model then told the user the app could
// not prepare the change. Two successful POSTs, no Preview, nothing altered.
//
// The repair is one host-side parse against the schema the tool already declares, so the
// file's stated guarantee -- that nothing but supported operations and app-owned ids
// reaches the adapter -- is enforced rather than assumed.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { proposalScenario } from "@/lib/proposal/test-support";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import { useScenarioStore } from "@/lib/store";
import { loadScenario } from "@/lib/store/lifecycle";
import {
  clearTestAuthority,
  installTestAuthority,
  type TestAuthority,
} from "@/lib/store/test-authority";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { AssistantReceipts } from "./assistant-receipts";
import { ProposalPreviewCard } from "./proposal-preview-card";
import { useAssistantProposals } from "./use-assistant-proposals";
import { bindTurnForTest, type TestTurnHandle } from "./turn-authority.test-support";

interface CapturedTool {
  name: string;
  description: string;
  parameters: unknown;
  handler: (args: unknown, context: { signal?: AbortSignal }) => Promise<unknown>;
}

const captured: CapturedTool[] = [];

vi.mock("@copilotkit/react-core/v2", () => ({
  useFrontendTool: (definition: CapturedTool) => {
    if (!captured.some((tool) => tool.name === definition.name)) captured.push(definition);
  },
  // The canonical wrapper keys its duplicate-identity ledger by the PROVIDER CORE, so it
  // needs a scope even here. A stable object stands in for one: this suite has no
  // provider, and the ledger only ever uses it as a `WeakMap` key.
  useCopilotKit: () => ({ copilotkit: SCOPE }),
}));

/** One stand-in core identity for this suite. See the mock above. */
const SCOPE = {};

const { useProposalTools } = await import("./use-proposal-tools");

/**
 * The live request, as the model sent it.
 *
 * > Prepare a preview to set the roster period to 1 September 2026 through 7 September
 * > 2026. Do not import public holidays. Do not apply it; show me the preview so I can
 * > review and apply it myself.
 *
 * `evidence` is ABSENT on purpose. That is the whole defect: the wire schema does not
 * require it, so omitting it is a well-formed tool call.
 */
const LIVE_ARGS = {
  summary: "You asked for the first week of September 2026 as the roster period.",
  operations: [
    {
      type: "set_roster_range",
      start: "2026-09-01",
      end: "2026-09-07",
      importPublicHolidays: false,
    },
  ],
};

let harness: TestAuthority;
let boundTurn: TestTurnHandle;

/**
 * The epoch the panel would pass, read from the store rather than invented.
 *
 * A Preview is STAMPED with it, and `useAssistantProposals` calls a card whose stamp
 * differs from the live epoch invalidated -- correctly, because that means the user
 * stopped the turn that produced it. A fixture that stamped an epoch the store does not
 * hold would render every Preview `stale` and prove nothing about the live path.
 */
let hostTurnEpoch = 0;

/**
 * The tool registration and the two host surfaces, mounted together.
 *
 * The Preview and the receipts are the SHIPPED components the panel renders; the tool
 * is registered exactly as the panel registers it. Nothing between the model's
 * arguments and the user's Apply button is stubbed.
 */
function Host() {
  useProposalTools("scheduler:thread-1", hostTurnEpoch);
  const controller = useAssistantProposals();
  return (
    <>
      <ProposalPreviewCard controller={controller} />
      <AssistantReceipts controller={controller} />
    </>
  );
}

function proposalTool(): CapturedTool {
  const found = captured.find((tool) => tool.name === "prepare_scenario_change");
  if (!found) throw new Error("prepare_scenario_change was never registered");
  return found;
}

/** Mount the shipped registration and bind a turn that is authorised in every respect. */
async function mount(scenario = createEmptyScenarioUiState()) {
  assistantActions.resetForTest();
  harness = await installTestAuthority();
  await loadScenario(scenario);

  const { useAuthorityStore } = await import("@/lib/store/authority");
  const authority = useAuthorityStore.getState();
  hostTurnEpoch = useAssistantStore.getState().turnEpoch;
  boundTurn = bindTurnForTest({
    scenarioId: authority.scenarioId!,
    documentRevision: authority.documentRevision,
    turnEpoch: hostTurnEpoch,
  });
  // The live projection is what `authorizeBoundIdentity` samples; agree with the real
  // authority store so nothing below is refused for an unrelated reason.
  boundTurn.live.scenarioId = authority.scenarioId;
  boundTurn.live.documentRevision = authority.documentRevision;

  render(<Host />);
}

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  cleanup();
  boundTurn?.release();
  clearTestAuthority();
});

describe("the model's arguments, at the shipped tool boundary", () => {
  it("is non-vacuous: the fixture really is an owned, selected, authorised turn", async () => {
    await mount();
    const { useAuthorityStore } = await import("@/lib/store/authority");
    const authority = useAuthorityStore.getState();

    // A selected scenario with a durable envelope behind it.
    expect(authority.scenarioId).not.toBeNull();
    const envelope = await harness.db.scenarioEnvelopes.get(authority.scenarioId!);
    expect(envelope).toBeDefined();
    // Held by THIS tab, under the current lease.
    expect(authority.ownership).toBe("owner");
    // And the tool the model would be offered actually exists.
    expect(proposalTool().name).toBe("prepare_scenario_change");
  });

  it("tells the model the operations cap, so it splits a large setup instead of guessing why it was refused", async () => {
    // The schema enforces MAX_ASSISTANT_OPERATIONS silently; the model only ever sees
    // the refusal after the fact unless the tool's own description says the number up
    // front. Referencing the real constant, not a copied digit, is what keeps this from
    // drifting the moment the cap changes.
    await mount();
    const { MAX_ASSISTANT_OPERATIONS } = await import("@/lib/proposal");
    expect(proposalTool().description).toContain(`${MAX_ASSISTANT_OPERATIONS} operations`);
  });

  it("prepares a real Preview from the exact live request, with evidence omitted", async () => {
    // THE REPRODUCTION. Before the repair this returned no proposal: the handler threw
    // `Cannot read properties of undefined (reading 'map')`, which CopilotKit turned
    // into an `Error: ...` tool result and fed back to the model as hop 2.
    await mount();

    const answer = await proposalTool().handler(LIVE_ARGS, {});

    expect(String(answer)).toContain("preview of this change is now shown");
    // One durable proposal, and a Preview published for the user.
    const proposals = await harness.db.assistantProposals.toArray();
    expect(proposals).toHaveLength(1);
    expect(useAssistantStore.getState().activeProposal?.proposalId).toBe(proposals[0].proposalId);
    // The operation survived the boundary byte-for-byte, including the explicit choice.
    expect(proposals[0].commands).toEqual(LIVE_ARGS.operations);
    // Preparing is not applying: the blank range is untouched.
    expect(useScenarioStore.getState().rangeStart).toBe("");
    expect(useScenarioStore.getState().rangeEnd).toBe("");
  });

  it("normalises omitted evidence to the durable empty list, not undefined", async () => {
    await mount();

    await proposalTool().handler(LIVE_ARGS, {});

    const [row] = await harness.db.assistantProposals.toArray();
    expect(row.evidence).toEqual([]);
  });

  it("still normalises an omitted reference inside evidence the model did send", async () => {
    // The F1w half of this boundary, kept green: `reference` is optional on the wire and
    // `string | null` in the durable row.
    await mount();

    await proposalTool().handler(
      { ...LIVE_ARGS, evidence: [{ kind: "user_statement", label: "You said so" }] },
      {},
    );

    const [row] = await harness.db.assistantProposals.toArray();
    expect(row.evidence).toEqual([
      { kind: "user_statement", label: "You said so", reference: null },
    ]);
  });

  it("refuses arguments the declared schema does not admit, without touching the scenario", async () => {
    // THE GUARANTEE THIS FILE'S HEADER CLAIMS, now actually enforced. CopilotKit hands
    // over unvalidated JSON, so without a host parse an unsupported operation shape
    // reached the adapter typed as something it is not.
    await mount(proposalScenario());

    const answer = await proposalTool().handler(
      {
        summary: "Rewrite the document.",
        operations: [{ type: "replace_everything", document: { staff: [] } }],
      },
      {},
    );

    // THE SHARED REFUSAL CLASS (see `./tool-payload`), not this tool's own wording. F1z
    // moved every parameterized handler onto one bounded, non-echoing answer, which is
    // also what keeps it distinguishable from the domain rejection asserted below.
    expect(String(answer)).toContain("not a valid call to this tool");
    expect(String(answer)).not.toContain("replace_everything");
    expect(await harness.db.assistantProposals.toArray()).toHaveLength(0);
    expect(useAssistantStore.getState().activeProposal).toBeNull();
    // Nothing was altered.
    expect(useScenarioStore.getState().rangeStart).toBe("2026-04-01");
    expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-30");
  });

  it("tells the model to take ids from the schedule before naming them", async () => {
    await mount();
    expect(proposalTool().description).toContain("get_schedule_section");
    expect(proposalTool().description).toMatch(/never guess/i);
  });

  it("hands an unknown id back with the valid choices, and allows one corrected retry", async () => {
    await mount(proposalScenario());

    const answer = String(
      await proposalTool().handler(
        { summary: "Remove Zed.", operations: [{ type: "remove_person", personId: "Zed" }] },
        {},
      ),
    );

    expect(answer).toContain("The app refused that change:");
    expect(answer).toContain('Valid choices: "ana", "bo".');
    expect(answer).toContain("prepare the change again, once");
    expect(answer).toContain("get_schedule_section");
    expect(answer).toContain(
      "If this refusal answers a call you already corrected once, do not try again",
    );
    expect(await harness.db.assistantProposals.toArray()).toHaveLength(0);
  });

  it("keeps a genuine host rejection distinct from a malformed payload", async () => {
    // A well-formed operation the document cannot take is still the adapter's answer,
    // with the host's own words -- not the schema refusal above.
    await mount(proposalScenario());

    const answer = await proposalTool().handler(
      {
        summary: "Set the period to what it already is.",
        operations: [
          {
            type: "set_roster_range",
            start: "2026-04-01",
            end: "2026-04-30",
            importPublicHolidays: false,
          },
        ],
      },
      {},
    );

    expect(String(answer)).toContain("The app refused that change:");
    expect(String(answer)).toContain("already those dates");
    // A DIFFERENT THING FROM A MALFORMED PAYLOAD, and the model must be able to tell.
    expect(String(answer)).not.toContain("not a valid call to this tool");
    expect(await harness.db.assistantProposals.toArray()).toHaveLength(0);
  });
});

describe("the live journey: tool call to Preview to user Apply to Undo", () => {
  it("renders the real Preview, applies only on the user's press, and reverses exactly", async () => {
    const user = userEvent.setup();
    await mount();

    // Capture the blank document as it stands, so Undo can be checked against the
    // BYTES rather than against the two fields this change happens to touch.
    const before = structuredClone(useScenarioStore.getState());

    // --- the model's tool call -------------------------------------------
    await proposalTool().handler(LIVE_ARGS, {});

    // --- the shipped Preview ---------------------------------------------
    const card = await screen.findByTestId("assistant-proposal");
    expect(card).toHaveAttribute("data-status", "preview_ready");

    // HOST-DERIVED VALUES, both sides stated. A tool result or a promise in prose is
    // not a Preview; this is the app's own reading of the persisted document.
    const direct = await screen.findByTestId("proposal-direct");
    expect(direct).toHaveTextContent("Not set");
    expect(direct).toHaveTextContent("2026-09-01 to 2026-09-07");

    // The explicit choice the user made is visible as a fact of the change, not an
    // assumption: no holiday groups are imported.
    expect(direct.textContent ?? "").not.toMatch(/holiday/i);
    expect(useScenarioStore.getState().dateGroups).toEqual(before.dateGroups);

    // NOTHING HAS BEEN APPLIED. The Preview exists, the document does not move.
    expect(useScenarioStore.getState().rangeStart).toBe("");
    expect(useScenarioStore.getState().rangeEnd).toBe("");
    expect(await harness.db.assistantReceipts.count()).toBe(0);
    expect(screen.queryByTestId("assistant-receipts")).toBeNull();

    // --- the user's Apply, which is a host control and only theirs -------
    const apply = await screen.findByTestId("proposal-apply");
    expect(apply).toBeEnabled();
    await user.click(apply);

    // Collapsed by default: a slim bar with the newest change's Undo one click away.
    expect(await screen.findByTestId("assistant-receipts")).toHaveTextContent("1 change applied");
    expect(await screen.findByTestId("receipt-undo")).toBeInTheDocument();
    expect(await harness.db.assistantReceipts.count()).toBe(1);
    // The Preview is gone: a settled change is not a live one.
    expect(screen.queryByTestId("assistant-proposal")).toBeNull();

    // EXACTLY the roster range moved, and nothing else in the document did.
    const applied = useScenarioStore.getState();
    expect(applied.rangeStart).toBe("2026-09-01");
    expect(applied.rangeEnd).toBe("2026-09-07");
    expect(applied.staff).toEqual(before.staff);
    expect(applied.shifts).toEqual(before.shifts);
    expect(applied.reqData).toEqual(before.reqData);
    expect(applied.cardsByKind).toEqual(before.cardsByKind);
    // `importPublicHolidays: false` was honoured: no holiday groups were created.
    expect(applied.dateGroups).toEqual(before.dateGroups);

    // --- Undo, through the shipped receipt control ------------------------
    await user.click(await screen.findByTestId("receipt-undo"));
    await waitFor(() => expect(useScenarioStore.getState().rangeStart).toBe(""));

    // BYTE-IDENTICAL to the document that existed before Apply.
    const reversed = useScenarioStore.getState();
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      if (typeof before[key] === "function") continue;
      expect({ [key]: reversed[key] }).toEqual({ [key]: before[key] });
    }

    // The receipt is kept, honestly, with no Undo affordance left -- the bar's
    // inline shortcut disappears once Undo is no longer available.
    await waitFor(() => expect(screen.queryByTestId("receipt-undo")).toBeNull());

    // Expanding the bar and opening the receipt shows the honest detail.
    await user.click(await screen.findByTestId("assistant-receipts-toggle"));
    await user.click(await screen.findByTestId("receipt-row-toggle"));
    const detail = await screen.findByTestId("assistant-receipt");
    expect(detail).not.toHaveAttribute("data-undo", "available");
  });
});
