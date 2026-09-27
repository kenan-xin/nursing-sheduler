// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { assistantActions, useAssistantStore } from "./store";
import { endingTextChoice, offerTextChoiceCard } from "./text-choice-card";

afterEach(() => assistantActions.resetForTest());

const YES_NO = ["Yes", "No"];

// [reply, the card's options or null for no card]. Taken from, or shaped like, eval
// transcripts (dt9, 09x8, the 7xw sg-ratio re-check, the 20wo borrow run).
const CASES: [string, string[] | null][] = [
  // yes/no (09x8)
  ["I've prepared it; check it and press Apply. Want me to open the Rules screen?", YES_NO],
  ["Would you like me to prepare it?", YES_NO],
  ["Ready to run Optimize?", YES_NO],
  ["Two RNs are on leave that day.\n\nIs that right?", YES_NO],
  ["Done checking. **Should I turn it off?**", YES_NO],
  ["MOH sets no ratio; the ward decides. Want me to help set that up?", YES_NO],
  ["Would you like me to take you to the Staffing requirements screen?", YES_NO],
  // named options (7xw)
  ["Did you mean Tan Wei or Tan Mei?", ["Tan Wei", "Tan Mei"]],
  ["Should it be Ben Tan or Chloe Lim?", ["Ben Tan", "Chloe Lim"]],
  ["Do you want days or nights?", ["Days", "Nights"]],
  ["Want me to open the Rules screen or the Staff screen?", ["Rules screen", "Staff screen"]],
  ["Is that for the day shift or the night shift?", ["Day shift", "Night shift"]],
  ["Should that be a must-never rule or a preference?", ["Must-never rule", "Preference"]],
  ["Should the cap apply to nights, weekends or both?", ["Nights", "Weekends", "Both"]],
  ["Should the cap apply to nights, weekends, or both?", ["Nights", "Weekends", "Both"]],
  ["Should the limit be 5, 6 or 7 nights?", ["5", "6", "7 nights"]],
  ["Should night shifts be 12 hours or 8 hours?", ["12 hours", "8 hours"]],
  ["Is the limit per week or per month?", ["Per week", "Per month"]],
  [
    "Would you like to keep 8-hour shifts or switch to 12-hour shifts?",
    ["Keep 8-hour shifts", "Switch to 12-hour shifts"],
  ],
  ["Got it. Which would you prefer, early shifts or late shifts?", ["Early shifts", "Late shifts"]],
  ["Which ward is lending the nurse: Ward 5 or Ward 7?", ["Ward 5", "Ward 7"]],
  ["Is that on Ward 6 or Ward 9?", ["Ward 6", "Ward 9"]],
  ["Nights or weekends?", ["Nights", "Weekends"]],
  ["Do you want to set your numbers now or later?", ["Now", "Later"]],
  // no card: open questions, statements, unclear or long shapes
  ["Which day should it start?", null],
  ["Which day?", null],
  ["How many nurses do you need on nights?", null],
  ["Who decides leave on your ward?", null],
  ["Want me to prepare it? I can also explain the rule first.", null],
  ["I've prepared it; check it and press Apply.", null],
  ["", null],
  ["Does anyone have leave or a fixed day off?", null],
  ["Do you want me to prepare it, or would you rather explain it first?", null],
  ["Is that a hard limit, or can it bend when you're short?", null],
  ["Should I prepare it now or wait until the new roster is out?", null],
  ["Should it be days or nights, or both?", null],
  ["Is either nights or weekends a problem for your team?", null],
  ["Do you know whether Ben or Chloe covers Friday?", null],
  ["Do you want me to add it or not?", null],
  ["Should it be Ben, Chloe, Dana or Eve?", null],
  ["Would you like to borrow a nurse from another ward or ask someone to swap?", null],
  ["Do you want to keep the current roster or run Optimize again?", null],
  [
    "Would you like me to move Ben to nights or leave the roster as it is and look at the weekend cover instead?",
    null,
  ],
  ["Should it apply to days and/or nights?", null],
  ["Sure, days or nights?", null],
  ["Which ward is lending the nurse, and what is their name?", null],
  ["Should it be days or days?", null],
];

describe("endingTextChoice (09x8, 7xw)", () => {
  it.each(CASES)("%j -> %j", (text, options) => {
    expect(endingTextChoice(text)?.options ?? null).toEqual(options);
  });

  it("takes the last sentence, without markdown, as the question", () => {
    expect(endingTextChoice("MOH sets no ratio. **Days** or **nights**?")?.question).toBe(
      "Days or nights?",
    );
  });
});

describe("offerTextChoiceCard (09x8, 7xw)", () => {
  it("shows a Yes/No option card for a reply that ends on a yes/no question", () => {
    offerTextChoiceCard("Want me to prepare it?", 3);
    const card = useAssistantStore.getState().activeChoices;
    expect(card?.question).toBe("Want me to prepare it?");
    expect(card?.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(card?.multiple).toBe(false);
    expect(card?.turnEpoch).toBe(3);
  });

  it("shows the named options for a reply that ends on 'A or B?'", () => {
    offerTextChoiceCard("Ratios are the ward's call. Set your numbers now or later?", 3);
    const card = useAssistantStore.getState().activeChoices;
    expect(card?.question).toBe("Set your numbers now or later?");
    expect(card?.options.map((o) => o.label)).toEqual(["Now", "Later"]);
  });

  it("adds nothing when the turn already offered a card", () => {
    assistantActions.showChoices({ question: "Pick one", options: [], multiple: false }, 3);
    offerTextChoiceCard("Do you want days or nights?", 3);
    expect(useAssistantStore.getState().activeChoices?.question).toBe("Pick one");

    assistantActions.clearChoices();
    assistantActions.showProposal("p-1", 3);
    offerTextChoiceCard("Want me to change anything else?", 3);
    expect(useAssistantStore.getState().activeChoices).toBeNull();
  });

  it("still offers one when the only card is a Preview carried from an earlier message", () => {
    useAssistantStore.setState({ turnEpoch: 2 });
    assistantActions.showProposal("p-1", 2);
    const epoch = assistantActions.nextTurnEpoch();
    offerTextChoiceCard("Want me to prepare it?", epoch);
    expect(useAssistantStore.getState().activeChoices?.question).toBe("Want me to prepare it?");
  });
});
