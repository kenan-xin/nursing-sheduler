import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// THE TWIN-SCOPE EQUIVALENCE GUARD (bounded-review round 1).
//
// WHY THIS EXISTS. ast-grep resolves a rule's language from the file EXTENSION, so a
// rule that owns `.tsx` files needs a `Tsx` twin beside its `TypeScript` base -- the
// `.ts`/`.tsx` split is documented in the Ticket 3 checkpoint. The twin shares the
// base rule's body but carries its own `files:` list, and nothing in ast-grep's test
// runner checks the two lists against each other: the runner's fixtures are PATHLESS
// snippets, so a twin that quietly dropped `e2e/**` from its scope while the base kept
// it scanned green on every fixture and let a real `.tsx` helper under `e2e/**` use a
// retired name through normal lint. That is exactly how `e2e/**` went missing from
// `retired-mutate-scenario-tsx.yml` and survived a full ticket without notice.
//
// A pathless fixture cannot catch this class of drift by construction. This guard can:
// it loads every rule's `files:` list and asserts each `-tsx` twin's scope is equal to
// its base partner's, except for a single documented allow-list of paths a twin may
// drop because they hold no `.tsx` files at all. Any future divergence -- a twin that
// narrows OR widens its scope relative to its partner -- fails here and forces a
// conscious decision recorded in the allow-list.
//
// WHAT THIS IS NOT. It does not run ast-grep and it does not read production source;
// it reads the rule `.yml` files under `ast-grep/rules/` as configuration, the same way
// `oxlint-boundary-config.test.ts` reads `.oxlintrc.json`. It is not a reader-ledger
// concern (no production `.ts`/`.tsx` file is opened for its contents).

interface AstGrepRule {
  readonly id: string;
  readonly language: string;
  readonly files?: readonly string[];
  readonly ignores?: readonly string[];
}

const RULES_DIR = new URL("./ast-grep/rules/", import.meta.url);

function loadRules(): Map<string, AstGrepRule> {
  const rules = new Map<string, AstGrepRule>();
  for (const entry of readdirSync(RULES_DIR)) {
    if (!entry.endsWith(".yml")) continue;
    const text = readFileSync(new URL(entry, RULES_DIR), "utf8");
    const rule = parse(text) as AstGrepRule;
    if (rule.id) rules.set(rule.id, rule);
  }
  return rules;
}

const RULES = loadRules();

interface Pair {
  readonly base: AstGrepRule;
  readonly twin: AstGrepRule;
}

/**
 * Language suffixes a variant id may carry, LONGEST FIRST so `-tsx` is stripped before
 * `-ts` ever gets a chance at it.
 *
 * WIDENED BY TICKET 6, and the widening closed a real gap. The original version filtered
 * on `-tsx` alone, which missed two shapes:
 *
 *   • the `surface-recipe-*-visual-ts` pairs from tickets 4/5, where the naming runs the
 *     OTHER way -- the `Tsx` rule is the base and the `-ts` variant is the twin -- so no
 *     id ended in `-tsx` and those pairs were never compared at all;
 *   • ticket 6's own three-language families, whose `JavaScript` variant ends in `-js`.
 *
 * Checked when the widening landed: both `-ts` pairs were already in step, so this closed
 * an UNGUARDED gap rather than an active drift.
 */
const LANGUAGE_SUFFIXES = ["-tsx", "-ts", "-js"] as const;

/**
 * A variant's family is its id minus a language suffix, but ONLY when the remainder names
 * a real rule. Without that condition an ordinary id that happens to end in those letters
 * would be reparented to a base that does not exist.
 */
function familyOf(id: string): string {
  for (const suffix of LANGUAGE_SUFFIXES) {
    if (!id.endsWith(suffix)) continue;
    const candidate = id.slice(0, -suffix.length);
    if (RULES.has(candidate)) return candidate;
  }
  return id;
}

const PAIRS: Pair[] = [...RULES.values()]
  .filter((rule) => familyOf(rule.id) !== rule.id)
  .map((twin) => {
    const baseId = familyOf(twin.id);
    const base = RULES.get(baseId);
    if (!base) throw new Error(`twin "${twin.id}" has no base partner "${baseId}"`);
    return { base, twin };
  });

/**
 * Paths a `Tsx` twin may omit from its base partner's `files:` list, each with a
 * durable reason. A path appears here only when it cannot hold `.tsx` files, so its
 * presence in the base is itself vacuous; dropping it from the twin changes nothing.
 *
 * Adding an entry is the conscious decision the guard exists to force. An entry
 * without a checked-in reason, or a twin divergence not listed here, fails the guard.
 */
const ALLOWED_TWIN_SCOPE_DROPS: Record<string, Record<string, string>> = {
  "copilotkit-runtime-acquisition": {
    "scripts/**": "scripts/ holds shell scripts only; no .ts/.tsx source exists there",
  },
};

describe("every language variant's scope matches its base partner's", () => {
  it("found every variant pair this guard knows about", () => {
    // Pinned so a new twin (good) or a renamed pair (needs a human eye) both surface here
    // rather than silently widening what the loops below cover. A base appears once per
    // variant, so ticket 6's three-language families appear twice each.
    expect(PAIRS.map((pair) => `${pair.base.id} / ${pair.twin.id}`).sort()).toEqual(
      [
        "assistant-scenario-table-authorship / assistant-scenario-table-authorship-tsx",
        "authored-color-literal / authored-color-literal-tsx",
        "copilotkit-runtime-acquisition / copilotkit-runtime-acquisition-js",
        "copilotkit-runtime-acquisition / copilotkit-runtime-acquisition-tsx",
        "openrouter-host-literal / openrouter-host-literal-tsx",
        "production-source-text-read / production-source-text-read-js",
        "production-source-text-read / production-source-text-read-tsx",
        "retired-mutate-scenario / retired-mutate-scenario-tsx",
        "surface-module-acquisition / surface-module-acquisition-tsx",
        "surface-recipe-combiner-visual / surface-recipe-combiner-visual-ts",
        "surface-recipe-option-visual / surface-recipe-option-visual-ts",
        "tailwind-default-palette-utility / tailwind-default-palette-utility-tsx",
        "test-capability-acquisition / test-capability-acquisition-js",
        "test-capability-acquisition / test-capability-acquisition-tsx",
        "test-module-loader-call / test-module-loader-call-js",
        "test-module-loader-call / test-module-loader-call-tsx",
        "untokened-shadow-utility / untokened-shadow-utility-tsx",
      ].sort(),
    );
  });

  for (const { base, twin } of PAIRS) {
    describe(`${base.id} / ${twin.id}`, () => {
      it("the twin's files: scope is equal to the base's, bar documented drops", () => {
        const baseFiles = new Set(base.files ?? []);
        const twinFiles = new Set(twin.files ?? []);
        const allowed = ALLOWED_TWIN_SCOPE_DROPS[base.id] ?? {};

        const missing = [...baseFiles]
          .filter((path) => !twinFiles.has(path))
          .filter((path) => !allowed[path]);
        expect(missing, `paths in the base but not the twin, and not in the allow-list`).toEqual(
          [],
        );

        const extra = [...twinFiles].filter((path) => !baseFiles.has(path));
        expect(extra, `paths in the twin but not the base`).toEqual([]);

        // Every allow-list entry must correspond to a real base path, or it is stale
        // and silently stops protecting what it was added for.
        const staleAllowList = Object.keys(allowed).filter((path) => !baseFiles.has(path));
        expect(staleAllowList, `stale allow-list entries for ${base.id}`).toEqual([]);
      });

      // NO ignores: EQUALITY ASSERTION, AND THE REASON IS WORTH RECORDING. Ticket 6 tried to
      // add one -- an `ignores` entry is an EXCEPTION, so a twin carrying one its base does
      // not looked like a widening worth catching. Six inherited pairs failed it immediately,
      // and they were right and the assertion was wrong: those families spell the SAME logical
      // exception per language (`**/*.test.ts` in the base, `**/*.test.tsx` in the twin),
      // which is a better design than a shared list, not drift.
      //
      // The strictest non-blanket version was considered too -- "an exact-path exception must
      // appear in every variant whose language can parse that extension" -- and it is
      // VACUOUS: only one variant per family has a given language, so a `.ts` path has
      // exactly one variant obliged to carry it, and that obligation is always met by the
      // rule that wrote it.
      //
      // Exception-list health is therefore owned by `ast-grep-substrate.test.ts`, which
      // asserts no `ignores` entry names a path that has ceased to exist -- the failure mode
      // that actually bites, since a stale exception reads as a live allowance forever.
    });
  }
});
