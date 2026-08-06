"use client";

// The ONE mutation-adjacent tool the assistant may call (T07).
//
// It PREPARES; it does not apply. The authority table in the technical plan is
// explicit that Apply is "not a model tool", and this file is where that stops being
// a policy and starts being a fact: the handler's only durable effect is a proposal
// row, and the only thing it hands back to the model is a sentence saying a Preview
// was rendered for the user to review.
//
// THE PAYLOAD IS TARGETS, NOT CONTENT. `assistantCommandListSchema` admits nothing
// but the supported operations and the ids they act on, so there is no shape of
// argument -- however the model phrases it -- that carries a document, a patch or a
// field the host has not validated. A payload that does not parse is refused with
// the host's own message rather than coerced into something nearby.
//
// A REFUSAL IS A RESULT, NOT AN ERROR. Returning the host's rejection text lets the
// model explain the limitation and ask the user for what is missing. Throwing would
// present it as a failure to retry, and retrying a rejected operation is exactly the
// loop the closed flows forbid ("never approximate a materially different rule").

import { useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { assistantCommandListSchema, type AssistantCommandV1 } from "@/lib/proposal";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { assistantProposalCommands } from "@/lib/store";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";

/** What a handler answers once its turn is no longer the current one. */
const SUPERSEDED = "superseded: this request belongs to an interrupted turn and was not answered.";

const evidenceSchema = z.object({
  kind: z
    .enum(["user_statement", "existing_scenario", "optimizer_basis", "capability"])
    .describe(
      "Where this came from. Use user_statement for something the user told you, " +
        "existing_scenario for something already in the schedule, and optimizer_basis " +
        "only when you hold a real tested run identity.",
    ),
  label: z.string().min(1).describe("One short phrase the user will recognise."),
  reference: z
    .string()
    .nullable()
    .describe("An app-owned id when there is one (an Optimize basis id). Never a URL."),
});

const prepareParameters = z.object({
  summary: z
    .string()
    .min(1)
    .describe(
      "Why you are proposing this, in one or two plain sentences a ward manager " +
        "would understand. This is shown as your reasoning, not as an instruction.",
    ),
  operations: assistantCommandListSchema.describe(
    "The supported operations that make up ONE coherent change the user asked for. " +
      "Keep unrelated work in separate changes.",
  ),
  evidence: z.array(evidenceSchema).default([]),
});

/**
 * Register the prepare-proposal tool against ONE agent instance.
 *
 * `turnEpoch` is the AUTHORISED epoch, exactly as the read tools take it: a handler
 * that finishes after an interruption must publish nothing, and a Preview is the
 * loudest possible thing to publish.
 */
export function useProposalTools(agentId: string, turnEpoch: number): void {
  useFrontendTool(
    {
      name: "prepare_scenario_change",
      agentId,
      description:
        "Prepare a change to the schedule for the user to review. This does NOT change " +
        "anything: the app validates your operations, works out every knock-on effect, " +
        "and shows the user a preview with an Apply button only they can press. " +
        "Use it when the user has asked for a specific change and you know the exact " +
        "records and values. If anything is ambiguous, ask first — never guess a date, " +
        "a number of people, or which rule they mean.",
      parameters: prepareParameters,
      handler: async (args, context) => {
        if (context.signal?.aborted) return SUPERSEDED;
        if (useAssistantStore.getState().turnEpoch !== turnEpoch) return SUPERSEDED;

        // A change prepared while one is already on screen is a REVISION of it, not a
        // second change: there is at most one live Preview, and treating the second
        // as a new identity would leave the first one's confirmations sitting behind
        // a row nothing renders. Revising moves the revision instead, which is what
        // invalidates those answers and every idempotency key derived from them.
        const live = useAssistantStore.getState().activeProposal;
        const outcome = await assistantProposalCommands.prepare({
          proposalId: crypto.randomUUID(),
          ...(live ? { previousProposalId: live.proposalId } : {}),
          threadId: null,
          turnId: useAssistantStore.getState().activeTurnId,
          registryStamp: capabilityRegistryStamp(),
          commands: args.operations as AssistantCommandV1[],
          rationale: args.summary,
          evidence: args.evidence,
          // T07 accepts typed evidence references and works without diagnostics; a
          // solver-tested outcome is T10's to supply, and claiming one here would be
          // the assistant asserting a test that never ran.
          outcome: "untested",
        });

        // RE-CHECKED AFTER THE AWAIT. Preparation is durable work with a real gap in
        // it, and a Preview published into an interrupted turn is a live Apply
        // control for a conversation the user already stopped.
        if (context.signal?.aborted) return SUPERSEDED;
        if (useAssistantStore.getState().turnEpoch !== turnEpoch) return SUPERSEDED;

        if (!outcome.ok) {
          if (outcome.reason === "rejected") {
            return (
              `The app refused that change: ${outcome.rejection.message} ` +
              "Explain this to the user in your own words and ask for what is missing. " +
              "Do not try a different operation that only approximates what they asked for."
            );
          }
          if (outcome.reason === "not-owner") {
            return "This schedule is being edited in another tab, so no change can be prepared here. Tell the user they can take over editing in this tab.";
          }
          if (outcome.reason === "fenced") {
            return SUPERSEDED;
          }
          return "The app could not prepare that change right now, and nothing was altered. Tell the user, and suggest they try again.";
        }

        assistantActions.showProposal(outcome.proposal.proposalId, turnEpoch);
        const waiting = outcome.proposal.assumptions.length;
        return (
          "A preview of this change is now shown to the user, with the exact before and " +
          "after values and every knock-on effect the app worked out. " +
          (waiting > 0
            ? `It also asks them to confirm ${waiting} real-world arrangement${waiting === 1 ? "" : "s"} before Apply becomes available. `
            : "") +
          "Nothing has changed yet, and you cannot apply it — only the user can. " +
          "Do not say the change has been made. Tell them what to look at, and wait."
        );
      },
    },
    [agentId, turnEpoch],
  );
}
