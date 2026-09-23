// Matching a described ward policy to the app's supported rules (T06).
//
// This is the "what rule should I use for this?" half of the help contract, and it is
// deliberately dumb: a keyword overlap against the registry's own concepts and prose,
// returning RANKED CANDIDATE IDS for the model to explain. It does not decide, does
// not score confidence, and does not synthesise a rule.
//
// WHY MATCHING LIVES IN THE HOST AT ALL. The model is perfectly capable of picking a
// rule from a list; what it must not do is pick one that is not in the list. Running
// the shortlist through the registry means every candidate is a capability that exists
// in the current mode with its gates open -- so "reject near-miss rules" is enforced
// by construction rather than by asking the model nicely.
//
// AN EMPTY RESULT IS A REAL ANSWER. When nothing matches, the honest response is that
// the app cannot express the policy. Returning the closest unrelated rule is the
// approximation the guided-setup flow explicitly forbids.

import { listCapabilities, type CapabilityContext, type CapabilityResult } from "./resolve";
import { getCapabilityRegistry } from "./registry";

export interface RuleCandidate {
  readonly capabilityId: string;
  readonly title: string;
  readonly summary: string;
  /** The words from the request that matched, so the model can explain the fit. */
  readonly matchedTerms: readonly string[];
}

/** Words too common to carry meaning in a one-line ward policy description. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "do",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "should",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "they",
  "this",
  "to",
  "want",
  "we",
  "what",
  "when",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

/**
 * Fold a word to the form matching compares.
 *
 * Only a plural `s` is stripped, and only from words long enough for it to be a
 * plural. Deliberately NOT prefix matching: an earlier attempt let "everyone" match
 * "every", which pulled unrelated rules into an answer purely because their summaries
 * happened to contain a common word. A near-miss suggestion is worse than none.
 */
function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

/** Distinct meaningful stems in a piece of text, minus stop words. */
function terms(text: string): readonly string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
        .map(stem),
    ),
  ];
}

/** The tool that may serve a guidance answer; entries opt in via `toolAccess`. */
const GUIDANCE_TOOL = "suggest_scheduling_rule";

/**
 * Rank the rule-shaped capabilities that match a described policy, best first.
 *
 * Ranking is by how many distinct request terms an entry matches, tie-broken by id so
 * the same request always produces the same order -- a help answer that reshuffled
 * between identical questions would be impossible to review.
 */
export function suggestRuleCandidates(
  goal: string,
  context: CapabilityContext,
  limit = 4,
): CapabilityResult<readonly RuleCandidate[]> {
  const listed = listCapabilities(context);
  if (listed.status !== "ok") return listed;

  const requestTerms = terms(goal);
  if (requestTerms.length === 0) return { ...listed, value: Object.freeze([]) };

  const registry = getCapabilityRegistry();
  const guidanceIds = new Set(
    registry.entries
      .filter((entry) => entry.toolAccess.includes(GUIDANCE_TOOL))
      .map((entry) => entry.id),
  );

  const scored = listed.value
    .filter((summary) => guidanceIds.has(summary.id))
    .map((summary) => {
      const haystack = new Set(
        terms(`${summary.title} ${summary.summary} ${summary.concepts.join(" ")}`),
      );
      const matchedTerms = requestTerms.filter((term) => haystack.has(term));
      return { summary, matchedTerms };
    })
    .filter((row) => row.matchedTerms.length > 0)
    .sort((a, b) =>
      b.matchedTerms.length !== a.matchedTerms.length
        ? b.matchedTerms.length - a.matchedTerms.length
        : a.summary.id < b.summary.id
          ? -1
          : 1,
    )
    .slice(0, limit)
    .map((row) =>
      Object.freeze({
        capabilityId: row.summary.id,
        title: row.summary.title,
        summary: row.summary.summary,
        matchedTerms: Object.freeze(row.matchedTerms),
      }),
    );

  return { ...listed, value: Object.freeze(scored) };
}
