// The two places that know what "assistant-owned content" means, compared.
//
// WHY THIS EXISTS. There are two deletion surfaces: the main repository's
// `clearAssistantContent`, and the Clear controller's own `ASSISTANT_CLEAR_TABLES` plus
// its deletion pass. They were written months apart and drifted -- the repository knew
// `diagnosticSearches` was assistant-owned and deleted it; the shipped Clear path did
// not, and neither did the test that claimed to check "every content table". A user's
// completed infeasibility search survived a Clear all that promised to remove every
// local AI record.
//
// The tables are declared in different modules for good reasons -- one is a Dexie
// transaction scope, the other a repository concern -- so rather than force a shared
// constant this test fails closed when they disagree. Adding an assistant-owned table
// to one and not the other is now a red suite, not a silent gap.

import { describe, expect, it } from "vitest";

import { ASSISTANT_TABLES } from "@/components/ai/assistant-test-bridge";
import { ASSISTANT_CLEAR_TABLES } from "./clear-repo";

/**
 * Every table that holds assistant-owned content, as the product defines it.
 *
 * This list is the contract. A new assistant-owned table must appear here AND in the
 * Clear scope; a table that is NOT assistant-owned must appear in neither.
 */
const ASSISTANT_OWNED = [
  "assistantThreads",
  "assistantTurns",
  "assistantMessages",
  "assistantGenerations",
  "assistantSettings",
  "assistantProposals",
  "assistantReceipts",
  "diagnosticSearches",
  "assistantClearOperations",
] as const;

/**
 * Tables that must NEVER be in the assistant Clear scope.
 *
 * `optimizeBases` is the one that matters: ordinary Optimize is explicitly unaffected
 * by assistant Clear, so a nurse's feasibility evidence must survive it.
 */
const NOT_ASSISTANT_OWNED = ["optimizeBases", "scenarios", "commits"] as const;

describe("the Clear scope and the assistant-content contract agree", () => {
  it("covers every assistant-owned table", () => {
    expect([...ASSISTANT_CLEAR_TABLES].sort()).toEqual([...ASSISTANT_OWNED].sort());
  });

  it("is the same set the browser journey counts", () => {
    // The bridge's list drives the Clear-all assertions in Playwright. If it drifts
    // from the Clear scope, the browser journey keeps passing while checking less --
    // which is exactly how the missing diagnostic-search deletion survived.
    const counted = [...ASSISTANT_TABLES, "assistantGenerations"].sort();
    expect(counted).toEqual([...ASSISTANT_CLEAR_TABLES].sort());
  });

  it("covers nothing that belongs to ordinary scheduling", () => {
    for (const table of NOT_ASSISTANT_OWNED) {
      expect(ASSISTANT_CLEAR_TABLES as readonly string[]).not.toContain(table);
    }
  });
});
