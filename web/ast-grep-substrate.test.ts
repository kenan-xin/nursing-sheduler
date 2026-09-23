import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// THE AST-GREP SUBSTRATE AUDIT (custom-AST ticket 6).
//
// WHY THIS EXISTS. Ticket 5 closed its guarantee with a rule whose authority is an EXACT
// PATH LIST, and its handoff flagged the consequence: a rename, a split or a directory move
// leaves that list pointing at nothing. The rule then scans zero files, `ast-grep scan`
// stays green because nothing matched, `ast-grep test` stays green because its fixtures are
// PATHLESS SNIPPETS that never touch the `files:` list -- and the guarantee is gone with
// every gate reporting success. That failure is silent by construction, and it is not
// specific to ticket 5: all 37 rules here are scoped by a path list.
//
// AND IT IS NOT ONLY A STALENESS PROBLEM. The ticket-6 cold review found the same class of
// hole from the other direction: `copilotkit-runtime-acquisition` declared `scripts/**` and
// could not scan it, because its language claims no JavaScript extension and `scripts/` holds
// one `.mjs` file. A declared scope that the rule's own language cannot parse is exactly as
// silent as one that points at nothing, which is why the single-language check below asks
// about APPLICABLE paths rather than merely existing ones.
//
// So this audit asks the question no other gate asks: does each rule's declared scope still
// point at real, APPLICABLE files?
//
// "Applicable" is load-bearing. ast-grep resolves a rule's language from the file EXTENSION,
// so a `files:` entry matching only `.tsx` files is as vacuous for a `TypeScript` rule as
// one matching nothing at all -- the rule cannot scan those files. A path-existence check
// would call such an entry healthy. This one does not.
//
// WHAT THIS IS NOT. It does not run ast-grep and it reads no production source. It reads the
// rule `.yml` files as CONFIGURATION through the maintained `yaml` library -- the same
// library and posture as `ast-grep-rule-pairs.test.ts`, and as `oxlint-boundary-config.test.ts`
// reading `.oxlintrc.json`. No hand-written parser was added to prove any of this: a config
// format with a maintained parser gets the maintained parser. The tree is enumerated as a
// path LISTING, never opened for its contents.
//
// LIMIT, STATED. Glob matching here is Node's `path.matchesGlob`; ast-grep matches with the
// Rust `globset`/`ignore` crate. The governed globs are deliberately plain (`dir/**`,
// `**/*.test.*`, exact paths) and the two agree on those, but this audit does not
// re-implement ast-grep's matcher and makes no claim about an exotic glob nobody has probed.
// It proves a scope is NON-VACUOUS, not that ast-grep selects precisely this set.

const RULES_DIR = new URL("./ast-grep/rules/", import.meta.url);
const TESTS_DIR = new URL("./ast-grep/tests/", import.meta.url);
const SNAPSHOTS_DIR = new URL("./ast-grep/tests/__snapshots__/", import.meta.url);
const WEB_ROOT = new URL(".", import.meta.url).pathname;

interface AstGrepRule {
  readonly id: string;
  readonly language: string;
  readonly files?: readonly string[];
  readonly ignores?: readonly string[];
}

/**
 * Which extensions each ast-grep language claims. ESTABLISHED BY PROBE, not by reading the
 * documentation: a throwaway config with one rule per language was scanned against files of
 * all eight extensions, and the findings were `TypeScript` -> `.ts`/`.mts`, `Tsx` -> `.tsx`,
 * `JavaScript` -> `.js`/`.jsx`/`.mjs`/`.cjs`. `.cts` is included with its `.mts` sibling.
 *
 * If a future ast-grep changes this mapping, the audit below reports a scope as vacuous when
 * it is not -- a LOUD failure that sends someone back to this table, which is the right
 * failure mode for an assumption this table cannot verify by itself.
 */
const LANGUAGE_EXTENSIONS: Record<string, readonly string[]> = {
  TypeScript: [".ts", ".mts", ".cts"],
  Tsx: [".tsx"],
  JavaScript: [".js", ".jsx", ".mjs", ".cjs"],
};

function loadRules(): AstGrepRule[] {
  return readdirSync(RULES_DIR)
    .filter((entry) => entry.endsWith(".yml"))
    .sort()
    .map((entry) => parse(readFileSync(new URL(entry, RULES_DIR), "utf8")) as AstGrepRule);
}

const RULES = loadRules();

/**
 * Directories that hold no authored source ast-grep would ever scan.
 *
 * `acquisition-fixtures` is transient rather than absent: `acquisition-prevention.test.ts`
 * writes bypass fixtures there, lints them and removes them, and vitest runs test files in
 * PARALLEL -- so they can be on disk while this audit is enumerating paths. Counting them would
 * make a declared prevention-only glob look live for the length of one run.
 */
const SKIP = new Set([
  "node_modules",
  ".next",
  "coverage",
  "playwright-report",
  "test-results",
  "public",
  "acquisition-fixtures",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full.slice(WEB_ROOT.length));
  }
  return out;
}

const ALL_PATHS = walk(WEB_ROOT);

/**
 * Scope entries that legitimately select nothing today, each with a durable reason.
 *
 * An entry here is a DECLARED PREVENTION-ONLY glob: it exists so a file added tomorrow is
 * covered from its first commit, and it is recorded rather than silently counted as
 * coverage. Adding an entry is the conscious decision this audit exists to force; the
 * assertions below also fail if an entry here STARTS matching, because a prevention-only
 * glob that has become real is coverage the table is now understating.
 */
const DECLARED_EMPTY: { rule: string; entry: string; why: string }[] = [
  ...[
    "test-capability-acquisition",
    "test-capability-acquisition-tsx",
    "test-capability-acquisition-js",
    "test-module-loader-call",
    "test-module-loader-call-tsx",
    "test-module-loader-call-js",
    "production-source-text-read",
    "production-source-text-read-tsx",
    "production-source-text-read-js",
  ].map((rule) => ({
    rule,
    entry: "**/__tests__/**",
    why: "the classification artifact's test/support scope names __tests__ subtrees; this repository has none, so the glob is prevention for a convention it does not currently use",
  })),
  // INHERITED from tickets 3/4/5, and found by this audit rather than known before it. Nine
  // visual-provenance rules excuse `**/*.spec.tsx`, and the repository has no `.spec.tsx`
  // file at all -- every Playwright spec is a `.spec.ts`. The entries are prevention beside
  // the `**/*.test.tsx` exception that does bite, so they are recorded rather than deleted:
  // deleting them would mean a `.spec.tsx` added later is suddenly governed by nine rules
  // that were never meant to reach it, which is a worse surprise than an entry that waits.
  ...[
    "authored-color-literal",
    "authored-color-literal-tsx",
    "surface-consumer-classname",
    "surface-recipe-combiner-visual",
    "surface-recipe-combiner-visual-ts",
    "surface-recipe-option-visual",
    "surface-recipe-option-visual-ts",
    "tailwind-default-palette-utility",
    "tailwind-default-palette-utility-tsx",
    "untokened-shadow-utility",
    "untokened-shadow-utility-tsx",
  ].map((rule) => ({
    rule,
    entry: "**/*.spec.tsx",
    why: "inherited prevention: the repository has no .spec.tsx file -- every Playwright spec is a .spec.ts -- so this exception waits beside the **/*.test.tsx one that is live",
  })),
  // ADDED BY THE FIXUP. The cold review required the acquisition scope to name the generic
  // `support` and `test-support` SUBTREES, not just helper filenames. `**/support/**` is live
  // (it selects `e2e/support/`); `**/test-support/**` selects nothing today, because this
  // repository names helpers `test-support.ts` rather than putting them in a `test-support/`
  // directory. Both conventions are now covered, and the one that is prevention says so.
  ...[
    "test-capability-acquisition",
    "test-capability-acquisition-tsx",
    "test-capability-acquisition-js",
    "test-module-loader-call",
    "test-module-loader-call-tsx",
    "test-module-loader-call-js",
    "production-source-text-read",
    "production-source-text-read-tsx",
    "production-source-text-read-js",
  ].map((rule) => ({
    rule,
    entry: "**/test-support/**",
    why: "prevention: the declared test/support scope names a test-support SUBTREE, and this repository uses the test-support.ts FILENAME convention instead. Covered so a directory-style helper tree is governed from its first commit",
  })),
];

function declaredReason(rule: string, entry: string): string | undefined {
  return DECLARED_EMPTY.find((row) => row.rule === rule && row.entry === entry)?.why;
}

/** Paths this rule's language can actually parse, among those its glob selects. */
function applicableMatches(rule: AstGrepRule, glob: string): string[] {
  const extensions = LANGUAGE_EXTENSIONS[rule.language];
  if (!extensions)
    throw new Error(`rule "${rule.id}" declares unknown language "${rule.language}"`);
  return ALL_PATHS.filter(
    (path) => extensions.some((ext) => path.endsWith(ext)) && matchesGlob(path, glob),
  );
}

/** Real paths a glob selects, whatever their extension. */
function anyMatches(glob: string): string[] {
  return ALL_PATHS.filter((path) => matchesGlob(path, glob));
}

/**
 * Rules with a language PARTNER share one scope list across two or three languages, because
 * `ast-grep-rule-pairs.test.ts` requires that equality -- the language, not the glob, is what
 * splits them. In a shared list a `.ts`-only path is inherently inapplicable to the `Tsx`
 * variant, and that is correct rather than stale, so per-entry APPLICABILITY is the wrong
 * question to ask there; entry EXISTENCE is the right one, and rule-level applicability is
 * asserted separately below.
 *
 * A rule with no partner owns its list alone. There, an entry the rule's own language cannot
 * parse is dead weight with no equality obligation to justify it -- and these are exactly the
 * exact-path rules from tickets 4 and 5 whose staleness-after-rename risk prompted this
 * audit. They get the strict check.
 */
const PARTNERED = new Set(
  RULES.filter((rule) =>
    RULES.some(
      (other) =>
        other.id !== rule.id &&
        (other.id.startsWith(`${rule.id}-`) || rule.id.startsWith(`${other.id}-`)),
    ),
  ).map((rule) => rule.id),
);

describe("the audit finds the substrate and the tree it is auditing", () => {
  it("loaded every rule, each with an id and a known language", () => {
    expect(RULES.length).toBe(37);
    expect(RULES.every((rule) => typeof rule.id === "string" && rule.id.length > 0)).toBe(true);
    expect(new Set(RULES.map((rule) => rule.id)).size).toBe(RULES.length);
    for (const rule of RULES) {
      expect(Object.keys(LANGUAGE_EXTENSIONS), `${rule.id} language`).toContain(rule.language);
    }
  });

  it("enumerated a real tree, with a representative of every language", () => {
    // Without this the vacuity assertions below would pass by finding nothing anywhere.
    expect(ALL_PATHS.length).toBeGreaterThan(500);
    expect(ALL_PATHS.some((path) => path.endsWith(".ts"))).toBe(true);
    expect(ALL_PATHS.some((path) => path.endsWith(".tsx"))).toBe(true);
    expect(ALL_PATHS.some((path) => path.endsWith(".mjs"))).toBe(true);
    expect(ALL_PATHS).toContain("lib/store/authority.ts");
    expect(ALL_PATHS).toContain("components/ui/surface.tsx");
  });

  it("every rule declares a files: scope at all", () => {
    // A rule with no `files:` runs repository-wide. That may be someone's intent one day,
    // but it has never been anyone's intent here, and it would make the audit below vacuous
    // for that rule.
    expect(RULES.filter((rule) => !rule.files?.length).map((rule) => rule.id)).toEqual([]);
  });
});

describe("every rule's declared scope resolves to real applicable paths", () => {
  it("no files: entry points at a location that does not exist", () => {
    // THE MOTIVATING CHECK. A rename, a split or a directory move leaves an entry naming
    // nothing, and no other gate notices: the rule quietly scans less, `scan` is green
    // because nothing matched, and `test` is green because its fixtures are pathless.
    const vacuous: string[] = [];
    for (const rule of RULES) {
      for (const glob of rule.files ?? []) {
        if (anyMatches(glob).length > 0) continue;
        if (declaredReason(rule.id, glob)) continue;
        vacuous.push(`${rule.id} (${rule.language}): files entry "${glob}" matches no file at all`);
      }
    }
    expect(vacuous).toEqual([]);
  });

  it("no single-language rule declares a files: entry its own language cannot parse", () => {
    // The strict half, applied where there is no scope-equality obligation to justify a
    // cross-language entry. These are the exact-path rules from tickets 4 and 5.
    const vacuous: string[] = [];
    for (const rule of RULES) {
      if (PARTNERED.has(rule.id)) continue;
      for (const glob of rule.files ?? []) {
        if (applicableMatches(rule, glob).length > 0) continue;
        if (declaredReason(rule.id, glob)) continue;
        vacuous.push(
          `${rule.id} (${rule.language}): files entry "${glob}" selects no ${LANGUAGE_EXTENSIONS[rule.language]?.join("/")} file`,
        );
      }
    }
    expect(vacuous).toEqual([]);
  });

  it("no ignores: entry excuses a location that does not exist", () => {
    // A stale `ignores` entry is worse than a stale `files` entry: it is an EXCEPTION, so it
    // reads as "this file is allowed to do the forbidden thing" long after the file is gone,
    // and the next reader has to work out whether it is still needed. Existence, not
    // applicability: a `.ts` path on a `Tsx` variant excuses nothing and is kept on purpose,
    // because the partner guard requires the exception lists to be equal.
    const vacuous: string[] = [];
    for (const rule of RULES) {
      for (const glob of rule.ignores ?? []) {
        if (anyMatches(glob).length > 0) continue;
        if (declaredReason(rule.id, glob)) continue;
        vacuous.push(`${rule.id} (${rule.language}): ignores entry "${glob}" names no file`);
      }
    }
    expect(vacuous).toEqual([]);
  });

  it("every rule as a whole selects at least one applicable file", () => {
    // The union check. A rule whose every entry is individually declared-empty is a rule
    // that scans nothing, which the per-entry assertions above would each excuse.
    const dead: string[] = [];
    for (const rule of RULES) {
      const selected = new Set((rule.files ?? []).flatMap((glob) => applicableMatches(rule, glob)));
      for (const glob of rule.ignores ?? []) {
        for (const path of applicableMatches(rule, glob)) selected.delete(path);
      }
      if (selected.size === 0) dead.push(`${rule.id} (${rule.language})`);
    }
    // The three JavaScript variants are the declared exception, and the ONLY one: every
    // other rule must really scan something. They are prevention for extensions this tree
    // does not use yet, which is a decision recorded in each rule's own note.
    expect(dead.sort()).toEqual([
      "production-source-text-read-js (JavaScript)",
      "test-capability-acquisition-js (JavaScript)",
      "test-module-loader-call-js (JavaScript)",
    ]);
  });

  it("no DECLARED_EMPTY row has started matching, or names a scope entry that is gone", () => {
    // Both directions. A prevention-only glob that has become real is coverage this table
    // now understates; a row naming an entry no rule declares any more is a reason nobody
    // will ever read, sitting in a table a reviewer trusts.
    const problems: string[] = [];
    for (const row of DECLARED_EMPTY) {
      const rule = RULES.find((candidate) => candidate.id === row.rule);
      if (!rule) {
        problems.push(`DECLARED_EMPTY names rule "${row.rule}", which does not exist`);
        continue;
      }
      const declared = [...(rule.files ?? []), ...(rule.ignores ?? [])];
      if (!declared.includes(row.entry)) {
        problems.push(
          `${row.rule}: DECLARED_EMPTY names "${row.entry}", which the rule no longer declares`,
        );
        continue;
      }
      if (anyMatches(row.entry).length > 0) {
        problems.push(
          `${row.rule}: "${row.entry}" is declared empty but now matches real files -- promote it to real coverage`,
        );
      }
      if (!row.why.trim()) problems.push(`${row.rule}: "${row.entry}" has no recorded reason`);
    }
    expect(problems).toEqual([]);
  });
});

describe("every rule carries its own fixtures", () => {
  it("has a test file and a snapshot per rule", () => {
    // `ast-grep test` reports on the rules it FINDS tests for, so a rule shipped without a
    // test file is not a failure there -- it is simply absent from the count. That is how a
    // rule with no causal proof gets in.
    const tests = new Set(readdirSync(TESTS_DIR).filter((entry) => entry.endsWith(".yml")));
    const snapshots = new Set(readdirSync(SNAPSHOTS_DIR));
    const missing: string[] = [];
    for (const rule of RULES) {
      if (!tests.has(`${rule.id}-test.yml`)) missing.push(`${rule.id}: no test file`);
      if (!snapshots.has(`${rule.id}-snapshot.yml`)) missing.push(`${rule.id}: no snapshot`);
    }
    expect(missing).toEqual([]);
  });

  it("has no orphan test file or snapshot", () => {
    const ids = new Set(RULES.map((rule) => rule.id));
    const orphans = [
      ...readdirSync(TESTS_DIR)
        .filter((entry) => entry.endsWith("-test.yml"))
        .filter((entry) => !ids.has(entry.slice(0, -"-test.yml".length)))
        .map((entry) => `orphan test file ${entry}`),
      ...readdirSync(SNAPSHOTS_DIR)
        .filter((entry) => entry.endsWith("-snapshot.yml"))
        .filter((entry) => !ids.has(entry.slice(0, -"-snapshot.yml".length)))
        .map((entry) => `orphan snapshot ${entry}`),
    ];
    expect(orphans).toEqual([]);
  });
});
