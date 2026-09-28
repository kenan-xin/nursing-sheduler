"use client";

// `offer_choices`: the model asks the user to pick, and the user clicks instead of
// typing. Like `request_optimize_run` it only shows a host card and returns at once.
// A click on the card sends an ordinary user message; it never changes the schedule.

import { z } from "zod";
import { useModelVisibleTool } from "./register-model-visible-tool";
import { assistantActions } from "@/lib/ai/assistant/store";
import { CHOICE_OPTION_RULES } from "@/lib/ai/assistant/playbook";
import { SUPERSEDED } from "./turn-authority";

const questionFields = {
  question: z.string().describe("The question, short and in the nurse's words."),
  options: z
    .array(
      z.object({
        label: z
          .string()
          .describe(
            "The answer as the user would say it, e.g. 'Ben Tan' or '2 seniors every " +
              "night'. A complete answer, never a placeholder like 'Set a number'.",
          ),
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
};

export const choiceParameters = z.object({
  ...questionFields,
  moreQuestions: z
    .array(z.object(questionFields))
    .max(3)
    .optional()
    .describe(
      "Up to three more related questions, shown one at a time on the same card " +
        "(for example the next set-up questions). All answers come back in one message. " +
        "Omit for a single question.",
    ),
});

/** The offer shape the handler receives, after the host parses it. */
export type ChoiceOffer = z.infer<typeof choiceParameters>;

/**
 * Where an option may come from (bead 1450). A model read the ward-flavoured examples in
 * these instructions -- a shift-code list and a long-day time range -- and offered a
 * fabricated "am/pm" shift set as if the user had named it. The examples are illustrations,
 * never a source of answers, so the rule is stated in the tool description and pinned by a
 * test (`choice-card.test.tsx`).
 */
export const CHOICE_OPTION_SOURCE_RULE =
  "Options come only from the user's own words or the current schedule, never from " +
  "examples in these instructions.";

/**
 * Option labels that name an action rather than an answer (bead tpt2). A FIXED list,
 * matched exactly after trimming and lower-casing: no fuzzy matching, no synonyms beyond
 * these phrases. Widened only from real transcripts, never guessed.
 */
export const PLACEHOLDER_OPTION_LABELS: readonly string[] = [
  "set a number",
  "set a value",
  "set the number",
  "set the value",
  "choose a number",
  "choose a value",
  "pick a number",
  "pick a value",
  "select a number",
  "select a value",
  "enter a number",
  "enter a value",
  "type a number",
  "type a value",
  "custom",
  "custom value",
  "custom amount",
  "custom number",
  "other",
  "other value",
  "other amount",
  "other number",
];

/** True when an option label is a bare placeholder, not a concrete answer. */
export function isPlaceholderOptionLabel(label: string): boolean {
  return PLACEHOLDER_OPTION_LABELS.includes(label.trim().toLowerCase());
}

/** The first placeholder label in an offer (its questions and any moreQuestions), or null. */
export function firstPlaceholderLabel(offer: ChoiceOffer): string | null {
  const questions = [offer, ...(offer.moreQuestions ?? [])];
  for (const question of questions) {
    for (const option of question.options) {
      if (isPlaceholderOptionLabel(option.label)) return option.label;
    }
  }
  return null;
}

/**
 * The refusal for a card whose options are placeholders. A tool result, never a throw, so
 * the model sees it in the same JSON shape as every other answer and can correct itself
 * once. Tells the model the concrete-value rule rather than just naming the bad label.
 */
const PLACEHOLDER_OPTION_REFUSAL =
  "An option label must be the answer itself, not an action or a prompt for more, so " +
  "'Set a number' and similar placeholders are not answers and the card was not shown. " +
  "When the question needs a number, offer the concrete numbers with their unit as the " +
  "options, for example '1 senior every night' and '2 seniors every night'; the card's " +
  "free-text box already carries any other answer. Call this tool again once with " +
  "concrete option labels.";

export function useChoiceTools(agentId: string, turnEpoch: number): void {
  useModelVisibleTool(
    {
      name: "offer_choices",
      agentId,
      description:
        "ALWAYS call this instead of writing a question with options in text. " +
        "Show the user clickable options whenever you ask them to pick, for example between " +
        "repair options after a failed run, or 'did you mean Ana, Ben Tan or Chloe Lim?' " +
        "whenever a name the user gave fits more than one person: never pick one yourself. " +
        "A yes/no offer is a pick too: instead of ending a reply on 'Would you like me to " +
        "prepare that?', offer 'Prepare it' and 'Not now' here. " +
        CHOICE_OPTION_RULES.join(" ") +
        " " +
        CHOICE_OPTION_SOURCE_RULE +
        " The card also lets them type another answer. Their answer arrives as their next " +
        "message. Keep the question in this tool rather than repeating it at length in text. " +
        "You may batch up to four related questions in one card with moreQuestions, for " +
        "example a few set-up questions in a row; the user answers them one at a time and " +
        "all answers arrive together. It changes nothing in the schedule.",
      parameters: choiceParameters,
      handler: async (offer, { token }) => {
        // Narrowing only; the wrapper already refused a null token.
        if (token === null) return SUPERSEDED;
        // A placeholder label names an action, not an answer (bead tpt2). Refuse before the
        // card is shown, so the model corrects itself instead of the user reading "Set a number".
        if (firstPlaceholderLabel(offer) !== null) return PLACEHOLDER_OPTION_REFUSAL;
        assistantActions.showChoices(offer, token.turnEpoch);
        return (
          "The user now sees the options. Their answer will come as their next message; " +
          "do not answer for them. End your turn now without repeating the question."
        );
      },
    },
    [agentId, turnEpoch],
  );
}
