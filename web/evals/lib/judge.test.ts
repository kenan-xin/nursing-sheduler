import { describe, expect, it } from "vitest";
import { SCENARIOS } from "@/lib/rules/ward-fixtures.test-support";
import {
  entityNames,
  judgePrompt,
  trialEntities,
  normalizeJudgeItems,
  renderTranscript,
  STANDARD_ITEMS,
} from "./judge";
import type { TrialRecord } from "./trial";

const seed = SCENARIOS.onlyRnOnLeave();
const r: TrialRecord = {
  caseId: "c",
  trial: 0,
  transcript: [
    { role: "user", text: "Why did it fail?", toolCalls: [] },
    {
      role: "assistant",
      text: "",
      toolCalls: [
        {
          toolCallId: "1",
          name: "offer_choices",
          args: { question: "Which fix?", options: [{ label: "Borrow a nurse", detail: "" }] },
          result: "shown",
        },
      ],
    },
    { role: "tool", text: "shown", toolCalls: [] },
    { role: "assistant", text: "Pick a fix.", toolCalls: [] },
  ],
  choices: [{ question: "Which fix?", options: ["Borrow a nurse"] }],
  proposals: [],
  appliedByHarness: 0,
  navigations: [],
  seed,
  final: seed,
  usage: { inputTokens: 0, outputTokens: 0, usd: 0, estimated: false },
  hops: 2,
  ms: 1,
  error: null,
};

describe("judge", () => {
  it("renders user text, assistant text and cards, never tool payloads", () => {
    const text = renderTranscript(r);
    expect(text).toContain("User: Why did it fail?");
    expect(text).toContain("Card: Which fix? [Borrow a nurse]");
    expect(text).toContain("Assistant: Pick a fix.");
    expect(text).not.toContain("offer_choices");
  });

  it("lists the scenario's people, shifts and rules for the grounding item", () => {
    expect(entityNames(seed)).toEqual(
      expect.arrayContaining(["rn1", "en1", "N", "1 RN every night"]),
    );
  });

  it("knows the seed, the final state and the names the user typed", () => {
    const final = {
      ...seed,
      staff: [...seed.staff, { ...seed.staff[0]!, id: "Borrowed nurse 1" }],
    };
    const said = {
      ...r,
      final,
      transcript: [
        { role: "user" as const, text: "Call her Rina Lim, from the float pool.", toolCalls: [] },
      ],
    };
    const names = trialEntities(said);
    expect(names).toEqual(
      expect.arrayContaining(["rn1", "Borrowed nurse 1", "Rina Lim", "Rina", "Lim"]),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("asks every standard item plus the case claims", () => {
    const { ids, prompt } = judgePrompt(r, entityNames(seed), ["Names the RN on leave"]);
    expect(ids).toEqual([...Object.keys(STANDARD_ITEMS), "case_1"]);
    expect(prompt).toContain("Names the RN on leave");
  });

  it("allows the app's own button and card labels", () => {
    const { prompt } = judgePrompt(r, entityNames(seed), []);
    for (const label of ["Apply", "Preview", "Change something", "Cancel", "Run"])
      expect(prompt).toContain(label);
    expect(prompt).toMatch(/option card/i);
  });

  it("fails an item the judge left out", () => {
    const items = normalizeJudgeItems(
      ["short", "plain"],
      [{ id: "short", reasoning: "fine", pass: true }],
    );
    expect(items).toEqual([
      { id: "short", reasoning: "fine", pass: true },
      { id: "plain", reasoning: "judge omitted this item", pass: false },
    ]);
  });
});
