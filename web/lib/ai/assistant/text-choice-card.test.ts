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
  ['Want me to open "Rules"?', YES_NO],
  ["He asked 'Is it ok?' Want me to check it?", YES_NO],
  // named options (7xw): (a) a lead-in ending in ":" or " - "
  ["Which ward is lending the nurse: Ward 5 or Ward 7?", ["Ward 5", "Ward 7"]],
  [
    "Where should I take you - the Rules screen or the Staff screen?",
    ["Rules screen", "Staff screen"],
  ],
  ["One question: nights, weekends or both?", ["Nights", "Weekends", "Both"]],
  // (b) the whole sentence is one-word options
  ["Nights or weekends?", ["Nights", "Weekends"]],
  ["Got it. Now or later?", ["Now", "Later"]],
  ["Ben, Chloe or Dana?", ["Ben", "Chloe", "Dana"]],
  // (c) one-token options of one kind right before the "?"
  ["Did you mean Ben or Chloe?", ["Ben", "Chloe"]],
  ["Want him on AM or PM?", ["AM", "PM"]],
  ["Which shift did you mean: AM or PM?", ["AM", "PM"]],
  ["Which ratio do you want: 1:4, 1:5 or 1:6?", ["1:4", "1:5", "1:6"]],
  ["Did you say 5 or 6?", ["5", "6"]],
  ["Did you say 2026-11-05 or 2026-11-12?", ["2026-11-05", "2026-11-12"]],
  ["Did you mean Monday or Tuesday?", ["Monday", "Tuesday"]],
  // no card (re-review): comma before a 2-option "or", weekday mixed with a name, a title
  // abbreviation, a yes/no opener with one-word options
  ["Do you want to swap Ben with Chloe on Monday, or Dana?", null],
  ["Which shift is that on Ward 5, N or PM?", null],
  ["Got it, Ben or Chloe?", null],
  ["Did you mean Monday or Dana?", null],
  ["Ask Dr. Lim or Ben?", null],
  ["Ask Dr Lim or Ben?", null],
  ["Is that OK for Chloe or Dana?", null],
  ["Does Ben have leave on Monday or Tuesday?", null],
  ["Is Ben on leave Monday or Tuesday?", null],
  ["Should Ben work AM or PM?", null],
  ["Should the ratio be 1:4, 1:5 or 1:6?", null],
  ["Should the limit be 5 or 6?", null],
  ["Should it start on 2026-11-05 or 2026-11-12?", null],
  ["Should it start on Monday or Tuesday?", null],
  // no card: shapes where the options are not clearly delimited (adversarial review)
  ["Should I move Ben or Chloe to nights?", null],
  ["Should Ben work AM or PM on Monday?", null],
  ["Should I go to Requests & Leave or Save & Load?", null],
  ["Do you want to borrow one or two nurses?", null],
  ["Did you mean Nur Aisyah binti Omar or Nur Aini?", null],
  ["Is that Nur Aisyah or Aini?", null],
  ["Did you mean Tan Wei or Tan Mei?", null],
  ["Should it be Ben Tan or Chloe Lim?", null],
  ["Should the limit be 5, 6 or 7 nights?", null],
  ["Should night shifts be 12 hours or 8 hours?", null],
  ["Do you want days or nights?", null],
  ["Want me to open the Rules screen or the Staff screen?", null],
  ["Is that for the day shift or the night shift?", null],
  ["Should that be a must-never rule or a preference?", null],
  ["Should the cap apply to nights, weekends or both?", null],
  ["Is the limit per week or per month?", null],
  ["Would you like to keep 8-hour shifts or switch to 12-hour shifts?", null],
  ["Which would you prefer, early shifts or late shifts?", null],
  ["Do you want to set your numbers now or later?", null],
  ["Should I name it 'Night 2' or 'N2'?", null],
  ['Do you want the "Night" shift or the "Late" shift?', null],
  ["Would you like a cap rather than a ban, or neither?", null],
  ["Neither AM or PM?", null],
  ["Which ward: Ward 5 or 7?", null],
  ["Quick check: do you want days or nights?", null],
  ["Should it be Ben, Chloe, Dana or Eve?", null],
  ["Sure, Ben or Chloe?", null],
  ["Really or not?", null],
  ["Is that AM or Ben?", null],
  ["Should Ben or Chloe cover it?", null],
];

describe("endingTextChoice (09x8, 7xw)", () => {
  it.each(CASES)("%j -> %j", (text, options) => {
    expect(endingTextChoice(text)?.options ?? null).toEqual(options);
  });

  it("takes the last sentence, without markdown, as the question", () => {
    expect(endingTextChoice("MOH sets no ratio. **AM** or **PM**?")?.question).toBe("AM or PM?");
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
    offerTextChoiceCard("Ratios are the ward's call. Now or later?", 3);
    const card = useAssistantStore.getState().activeChoices;
    expect(card?.question).toBe("Now or later?");
    expect(card?.options.map((o) => o.label)).toEqual(["Now", "Later"]);
  });

  it("adds nothing when the turn already offered a card", () => {
    assistantActions.showChoices({ question: "Pick one", options: [], multiple: false }, 3);
    offerTextChoiceCard("Want him on AM or PM?", 3);
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
