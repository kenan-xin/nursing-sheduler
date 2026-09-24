"use client";

// `offer_choices`: the model asks the user to pick, and the user clicks instead of
// typing. Like `request_optimize_run` it only shows a host card and returns at once.
// A click on the card sends an ordinary user message; it never changes the schedule.

import { z } from "zod";
import { useModelVisibleTool } from "./register-model-visible-tool";
import { assistantActions } from "@/lib/ai/assistant/store";

export const choiceParameters = z.object({
  question: z.string().describe("The question, short and in the nurse's words."),
  options: z
    .array(
      z.object({
        label: z.string().describe("The answer as the user would say it, e.g. 'Ben Tan'."),
        detail: z.string().describe("One short line that tells options apart, or ''."),
      }),
    )
    .min(2)
    .max(5)
    .describe("Two to five options."),
  multiple: z
    .boolean()
    .describe(
      "True ONLY when several answers can be true together (e.g. which shifts a rule " +
        "covers, which nurses are senior). False for alternatives where one excludes the " +
        "other: repair options, yes/no, did-you-mean.",
    ),
});

export function useChoiceTools(agentId: string, turnEpoch: number): void {
  useModelVisibleTool(
    {
      name: "offer_choices",
      agentId,
      description:
        "Show the user clickable options whenever you ask them to pick, for example between " +
        "repair options after a failed run, or 'did you mean Ana, Ben Tan or Chloe Lim?'. " +
        "The card also lets them type another answer. Their answer arrives as their next " +
        "message. Keep the question in this tool rather than repeating it at length in text. " +
        "It changes nothing in the schedule.",
      parameters: choiceParameters,
      handler: async (offer) => {
        assistantActions.showChoices(offer);
        return (
          "The user now sees the options. Their answer will come as their next message; " +
          "do not answer for them."
        );
      },
    },
    [agentId, turnEpoch],
  );
}
