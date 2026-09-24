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
// loop the closed flows forbid ("never approximate a materially different rule") --
// except a single correction to a value the refusal itself lists is not that loop.

import { useModelVisibleTool } from "./register-model-visible-tool";
import { z } from "zod";
import {
  MAX_ASSISTANT_OPERATIONS,
  assistantCommandListSchema,
  type AssistantCommandV1,
} from "@/lib/proposal";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { assistantProposalCommands } from "@/lib/store";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { assertTurnAuthority, SUPERSEDED } from "./turn-authority";

/**
 * THE MODEL-VISIBLE SHAPE, and it is constrained by what the locked runtime can
 * convert as much as by what the host will accept.
 *
 * `reference` was `z.string().nullable()`, which `zod-to-json-schema` serialises with a
 * `{ "type": "null" }` branch. `@copilotkit/runtime@1.66.2`'s JSON-Schema-to-Zod
 * converter handles object/string/number/integer/boolean/array and unions of those, and
 * throws `Invalid JSON schema` on anything else -- BEFORE the provider tool loop runs.
 * A live turn therefore issued one request, got no tools, and stopped with no answer.
 *
 * Optional says the same thing to the model without the unsupported branch: supply an
 * app-owned id or leave it out. The host normalises a missing reference to the durable
 * `null` (see the handler), so nothing downstream changes shape.
 */
export const evidenceSchema = z.object({
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
    .optional()
    .describe(
      "An app-owned id when there is one (an Optimize basis id). Omit it when there is " +
        "none. Never a URL.",
    ),
});

export const prepareParameters = z.object({
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
 * `turnEpoch` is the AUTHORISED epoch. It is no longer the guard -- every handler
 * asks `assertTurnAuthority` for the whole bound identity -- but it is still what a
 * published Preview is STAMPED with, so a card produced by a turn the user has since
 * stopped renders as stopped rather than as a live Apply control.
 */
export function useProposalTools(agentId: string, turnEpoch: number): void {
  useModelVisibleTool(
    {
      name: "prepare_scenario_change",
      agentId,
      description:
        "Prepare a change to the schedule for the user to review. This does NOT change " +
        "anything: the app validates your operations, works out every knock-on effect, " +
        "and shows the user a preview with an Apply button only they can press. " +
        "Use it when the user has asked for a specific change and you know the exact " +
        "records and values. " +
        "Take every person, staff group, shift and rule id exactly from the schedule " +
        "(get_schedule_section) — never guess one. " +
        "If anything is ambiguous, ask first — never guess a date, " +
        "a number of people, or which rule they mean. " +
        `At most ${MAX_ASSISTANT_OPERATIONS} operations per change — split a larger setup ` +
        "into several changes.",
      parameters: prepareParameters,
      handler: async (args, context) => {
        // The token captured at entry, demanded again after the durable preparation below.
        //
        // `args` arrives parsed. That is what closed the live blocker: `evidence` carries
        // `.default([])`, and a model that legally omitted it used to reach `.map()` on
        // `undefined` -- which the locked core turned into an `Error: ...` tool result and
        // fed back as a second hop. The user was told the app could not prepare the
        // change, and no Preview appeared.
        const { token } = context;

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
          // NORMALISED BY TRUSTED HOST CODE. The wire shape omits an absent reference;
          // the durable record has always carried `string | null`, and every reader
          // downstream expects that. The model still cannot supply anything but an
          // app-owned id string -- omission is the only new thing it can express.
          evidence: args.evidence.map((item) => ({
            ...item,
            reference: item.reference ?? null,
          })),
          // T07 accepts typed evidence references and works without diagnostics; a
          // solver-tested outcome is T10's to supply, and claiming one here would be
          // the assistant asserting a test that never ran.
          outcome: "untested",
        });

        // RE-CHECKED AFTER THE AWAIT. Preparation is durable work with a real gap in
        // it, and a Preview published into an interrupted turn is a live Apply
        // control for a conversation the user already stopped.
        const late = assertTurnAuthority(token, context.signal);
        if (late) return late;
        // Narrowing only: `assertTurnAuthority` already refuses a null token, so this
        // cannot be reached. It is what lets the stamp below read the token instead of
        // the closure.
        if (token === null) return SUPERSEDED;

        if (!outcome.ok) {
          if (outcome.reason === "rejected") {
            // ONE CORRECTED RETRY, NOT A LOOP (2026-09-24, nursing-sheduler-912). A refusal
            // that lists the valid ids is exactly the evidence the model lacked. Retrying
            // with one of them is a correction, not an approximation. Anything else still
            // goes back to the user.
            return (
              `The app refused that change: ${outcome.rejection.message} ` +
              "If the refusal lists the valid choices or names the right format, and what the " +
              "user asked for clearly matches one of them, correct that operation and prepare " +
              "the change again, once. When the list is cut short, read the full list with " +
              "get_schedule_section. Otherwise explain this to the user in your own words and " +
              "ask for what is missing. Do not try a different operation that only " +
              "approximates what they asked for."
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

        // STAMPED FROM THE TOKEN, not from the closure `turnEpoch`.
        //
        // The closure holds the epoch this tool was REGISTERED under -- `authorizedTurnEpoch
        // ?? -1` at the last render its effect saw. The run happens on a per-turn clone that
        // snapshots the tool registry as the turn launches, i.e. after `nextTurnEpoch()`
        // cleared `authorizedTurnEpoch` and before `beginTurn` restored it, so the handler
        // that actually executes carries `-1` while the live epoch is the turn's. The card
        // compares stamp against live (`use-assistant-proposals`), so every live Preview was
        // born "stopped" with Apply permanently disabled.
        //
        // The token is the SAME authority `assertTurnAuthority` validates above and carries
        // the authorised turn's own epoch, so the stamp agrees with the live value during the
        // turn and still diverges the moment an interruption bumps it.
        assistantActions.showProposal(outcome.proposal.proposalId, token.turnEpoch);
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
