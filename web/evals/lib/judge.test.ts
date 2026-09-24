import { describe, expect, it } from "vitest";
import { SCENARIOS } from "@/lib/rules/ward-fixtures.test-support";
import {
  calibrationRecord,
  entityNames,
  judgePrompt,
  trialEntities,
  normalizeJudgeItems,
  renderTranscript,
  RUBRIC_VERSION,
  STANDARD_ITEMS,
  type LabelledTrial,
} from "./judge";
import type { TrialRecord } from "./trial";
import { ALL_CASES } from "../cases";
import labelledJson from "../fixtures/judge-calibration.json";

const seed = SCENARIOS.onlyRnOnLeave();
const labelled = labelledJson as LabelledTrial[];
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

  it("renders an assistant's text before the card it leads into", () => {
    const leadIn: TrialRecord = {
      ...r,
      transcript: [{ ...r.transcript[1]!, text: "Here are your options." }],
    };
    expect(renderTranscript(leadIn)).toBe(
      "Assistant: Here are your options.\nCard: Which fix? [Borrow a nurse]",
    );
  });

  it("lets a lead-in or open question pass the card item, and a typed name, date or screen pass grounding", () => {
    expect(STANDARD_ITEMS.no_text_choice).toMatch(
      /Card\s+line holding its answers is in the same turn/,
    );
    expect(STANDARD_ITEMS.no_text_choice).toMatch(/open question/);
    expect(STANDARD_ITEMS.no_invented_entities).toMatch(/the user typed/);
    expect(STANDARD_ITEMS.no_invented_entities).toMatch(/dates/i);
    expect(STANDARD_ITEMS.plain).toMatch(/screen names/);
    expect(STANDARD_ITEMS.no_false_claim).toMatch(/added/);
  });

  it("keeps short and suggests_default from failing a reply that follows the app (rubric .3)", () => {
    expect(RUBRIC_VERSION).toBe("2026-09-24.5");
    expect(STANDARD_ITEMS.short).toMatch(/the app tells/);
    expect(STANDARD_ITEMS.suggests_default).toMatch(/legal or regulatory/);
    expect(STANDARD_ITEMS.suggests_default).toMatch(/choice between repair/);
  });

  it("allows the Employment Act, but no MOH rest number and no clock-span hours (rubric .4)", () => {
    const item = STANDARD_ITEMS.no_legal_claim;
    expect(item).toMatch(/MOH minimum rest/);
    expect(item).toMatch(/Employment Act/);
    expect(item).toMatch(/1 rest day a week/);
    expect(item).toMatch(/72 hours of overtime a month/);
    expect(item).toMatch(/unpaid break/);
  });

  it("passes the fixed prepared wording and proposed names, keeps jargon and yes/no text failing (rubric .5)", () => {
    expect(STANDARD_ITEMS.no_false_claim).toMatch(/I've prepared X; check it and press Apply/);
    expect(STANDARD_ITEMS.no_false_claim).toMatch(/Run card or option card is ready/);
    expect(STANDARD_ITEMS.no_invented_entities).toMatch(/proposes for a new shift/);
    expect(STANDARD_ITEMS.no_invented_entities).toMatch(/nursing supervisor/);
    expect(STANDARD_ITEMS.plain).toMatch(/Jargon that fails: solver, infeasible/);
    expect(STANDARD_ITEMS.plain).toMatch(/weight 10/);
    expect(STANDARD_ITEMS.plain).toMatch(/Shift successions/);
    expect(STANDARD_ITEMS.no_text_choice).toMatch(/yes\/no offer .* is a pick-one question/);
    expect(STANDARD_ITEMS.no_text_choice).toMatch(
      /only when a Card line holding its answers is in the same turn/,
    );
    expect(STANDARD_ITEMS.no_text_choice).toMatch(
      /earlier turn, with no Card line in this turn, fails/,
    );
    expect(STANDARD_ITEMS.no_text_choice).not.toMatch(/already shown/);
    expect(STANDARD_ITEMS.suggests_default).toMatch(/A card of options passes/);
  });

  it("can label the transcript from the simulated user's side", () => {
    const text = renderTranscript(r, { user: "You", assistant: "Scheduling app" });
    expect(text).toContain("You: Why did it fail?");
    expect(text).toContain("Scheduling app: Pick a fix.");
    expect(text).not.toMatch(/^(User|Assistant):/m);
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

  it("keeps a mixed calibration set of at least 20 labelled transcripts of known cases", () => {
    expect(labelled.length).toBeGreaterThanOrEqual(20);
    expect(new Set(labelled.map((l) => l.label))).toEqual(new Set(["pass", "fail"]));
    expect(new Set(labelled.map((l) => l.id)).size).toBe(labelled.length);
    const ids = new Set(ALL_CASES.map((c) => c.id));
    for (const l of labelled) {
      expect(ids.has(l.caseId), l.id).toBe(true);
      expect(l.reason.length, l.id).toBeGreaterThan(10);
    }
  });

  it("renders a labelled transcript as the judge sees it", () => {
    const l = labelled.find((x) => x.id === "deep:exact-vs-preferred:0")!;
    const text = renderTranscript(calibrationRecord(l, seed));
    expect(text).toContain("User: Mornings need at least 2 nurses, ideally 3.");
    expect(text).toContain("Preview shown to the user.");
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
