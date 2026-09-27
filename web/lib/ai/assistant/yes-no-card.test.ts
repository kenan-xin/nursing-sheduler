// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { assistantActions, useAssistantStore } from "./store";
import { endingYesNoQuestion, offerYesNoCard } from "./yes-no-card";

afterEach(() => assistantActions.resetForTest());

describe("endingYesNoQuestion (09x8)", () => {
  it.each([
    [
      "I've prepared it; check it and press Apply. Want me to open the Rules screen?",
      "Want me to open the Rules screen?",
    ],
    ["Would you like me to prepare it?", "Would you like me to prepare it?"],
    ["Ready to run Optimize?", "Ready to run Optimize?"],
    ["Shall I take you to the Shifts screen?", "Shall I take you to the Shifts screen?"],
    ["Two RNs are on leave that day.\n\nIs that right?", "Is that right?"],
    ["Done checking. **Should I turn it off?**", "Should I turn it off?"],
  ])("finds the yes/no question ending %j", (text, question) => {
    expect(endingYesNoQuestion(text)).toBe(question);
  });

  it.each([
    "Which day should it start?",
    "How many nurses do you need on nights?",
    "Who decides leave on your ward?",
    "Should it be Ben Tan or Chloe Lim?",
    "Do you want days or nights?",
    "Want me to prepare it? I can also explain the rule first.",
    "I've prepared it; check it and press Apply.",
    "",
  ])("ignores %j", (text) => {
    expect(endingYesNoQuestion(text)).toBeNull();
  });
});

describe("offerYesNoCard (09x8)", () => {
  it("shows a Yes/No option card for a reply that ends on a yes/no question", () => {
    offerYesNoCard("Want me to prepare it?", 3);
    const card = useAssistantStore.getState().activeChoices;
    expect(card?.question).toBe("Want me to prepare it?");
    expect(card?.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(card?.multiple).toBe(false);
    expect(card?.turnEpoch).toBe(3);
  });

  it("adds nothing when the turn already offered a card", () => {
    assistantActions.showChoices({ question: "Pick one", options: [], multiple: false }, 3);
    offerYesNoCard("Want me to prepare it?", 3);
    expect(useAssistantStore.getState().activeChoices?.question).toBe("Pick one");

    assistantActions.clearChoices();
    assistantActions.showProposal("p-1", 3);
    offerYesNoCard("Want me to change anything else?", 3);
    expect(useAssistantStore.getState().activeChoices).toBeNull();
  });

  it("still offers one when the only card is a Preview carried from an earlier message", () => {
    useAssistantStore.setState({ turnEpoch: 2 });
    assistantActions.showProposal("p-1", 2);
    const epoch = assistantActions.nextTurnEpoch();
    offerYesNoCard("Want me to prepare it?", epoch);
    expect(useAssistantStore.getState().activeChoices?.question).toBe("Want me to prepare it?");
  });
});
