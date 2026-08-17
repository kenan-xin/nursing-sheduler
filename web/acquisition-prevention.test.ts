import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// THE ACQUISITION-PREVENTION FIXTURES (custom-AST ticket 6).
//
// WHY THIS EXISTS. The ticket's requirement is blunt and it is the right one: DOCUMENTATION IS
// NOT ENFORCEMENT. A restriction that is written down, reviewed and never actually exercised is
// indistinguishable from one that is misconfigured -- and ticket 2's repair round is the proof,
// because two overrides there had silently switched whole boundary families off while every
// gate stayed green and every recorded probe passed.
//
// So each named bypass family below is MATERIALISED as a real file at a real in-scope path,
// the NORMAL LINT COMMAND is run against the tree, and the intended rule is asserted to have
// fired at that file. Then the files are removed. Nothing here describes the configuration;
// it drives it.
//
// WHY `.test.mts`. The fixtures must be inside the test/support scope for the restrictions to
// apply, and outside vitest's collection so they can never be mistaken for suites of their
// own. Vitest collects `**/*.{test,spec}.{ts,tsx}`; Oxlint's test-scope override lists
// `**/*.test.mts`; ast-grep's rules scope on `**/*.test.*` and its `TypeScript` language claims
// `.mts`. All three were verified by probe before this file was written.
//
// SELF-CLEANING, AND WHY IT MATTERS. A lingering fixture would break `pnpm typecheck` and
// `pnpm lint` for everyone, so the directory is removed before the suite, after the suite, and
// its absence is asserted as a test in its own right.
//
// WHAT THIS PROVES, EXACTLY. That the declared acquisition SHAPES are rejected by the command
// developers and CI actually run. It does not prove that bytes reaching `.match()` could not
// have arrived by some route nobody enumerated -- a constructed specifier, a capability handed
// over by a helper, a path assembled at runtime. The boundary is acquisition plus an audited
// exception list, and the two negative controls at the end are there to keep even that claim
// honest by pinning what the rules deliberately do NOT flag.

const WEB_ROOT = new URL(".", import.meta.url).pathname;

/**
 * The fixture directory, named once and shared with the two guards that enumerate the source
 * tree (`oxlint-boundary-config.test.ts`, `ast-grep-substrate.test.ts`). Those two must SKIP
 * it: vitest runs test files in parallel, so while this suite has its fixtures on disk they
 * would otherwise be enumerated as ordinary source -- and the `support/` fixture below really
 * did produce a match-set class they had no representative for.
 */
export const FIXTURE_DIR_NAME = "acquisition-fixtures";
const FIXTURE_DIR = join(WEB_ROOT, FIXTURE_DIR_NAME);

interface Fixture {
  /** The bypass family, named as the ticket names it. */
  readonly family: string;
  readonly file: string;
  readonly source: string;
  /** Oxlint rule names and/or ast-grep rule ids that must fire at this file. */
  readonly expect: readonly string[];
  /** A needle from the intended diagnostic, so "fired" also means "for the right reason". */
  readonly because: string;
}

/** The seven named bypass families, one isolated file each. */
const FIXTURES: Fixture[] = [
  {
    family: "parser-library import",
    file: "parser-import.test.mts",
    source: 'import ts from "typescript";\nexport const probe = ts;\n',
    expect: ["no-restricted-imports"],
    because: "compiler or parser library",
  },
  {
    family: "static filesystem import",
    file: "static-fs-import.test.mts",
    source: 'import { readFileSync } from "node:fs";\nexport const probe = readFileSync;\n',
    expect: ["no-restricted-imports"],
    because: "Generic filesystem capability",
  },
  {
    // OWNERSHIP CORRECTED BY THE FIXUP (cold-review P2). This fixture used to expect the
    // ast-grep rule, on the belief that Oxlint sees static specifiers only. It does not: a
    // probe on the installed 1.74 reports `await import("node:fs")` through
    // `no-restricted-imports` directly, so the syntax had two owners. ast-grep no longer
    // matches it, and the fixture now names its real single owner.
    family: "dynamic filesystem import",
    file: "dynamic-fs-import.test.mts",
    source: 'export const probe = async () => await import("node:fs");\n',
    expect: ["no-restricted-imports"],
    because: "Generic filesystem capability",
  },
  {
    family: 'require("fs")',
    file: "require-fs.test.mts",
    source: 'export const probe = require("fs");\n',
    expect: ["test-capability-acquisition"],
    because: "filesystem, module-loader or parser capability",
  },
  {
    // SPLIT FROM ONE FIXTURE BY THE FIXUP. `createRequire` reaches the tree by two distinct
    // syntaxes with two distinct owners, and a single fixture containing both could not show
    // that each owner is independently live -- nor could the exclusivity assertion below say
    // anything useful about it. Half one: the SPECIFIER, which is Oxlint's.
    family: "node:module specifier (the createRequire import)",
    file: "module-loader-specifier.test.mts",
    source: 'import { createRequire } from "node:module";\nexport const probe = createRequire;\n',
    expect: ["no-restricted-imports"],
    because: "module-loader capability",
  },
  {
    // Half two: the CALL, which is ast-grep's, and which survives when the function arrives
    // some other way. Deliberately unbound -- no import -- so the fixture isolates the call
    // shape instead of also tripping the specifier rule. Lint never runs the code.
    family: "createRequire CALL, however the function arrived",
    file: "create-require-call.test.mts",
    source: "export const probe = createRequire(import.meta.url);\n",
    expect: ["test-module-loader-call"],
    because: "builds a generic module loader",
  },
  {
    family: 'process.getBuiltinModule("fs")',
    file: "get-builtin-module.test.mts",
    source: 'export const probe = process.getBuiltinModule("fs");\n',
    expect: ["test-capability-acquisition"],
    because: "filesystem, module-loader or parser capability",
  },
  {
    family: "direct TSX read followed by regex/string structural matching",
    file: "tsx-pseudo-parser.test.mts",
    // No `fs` import on purpose. An import would ALSO trip the filesystem restriction, and
    // then this fixture would not isolate the rule it exists to prove. Lint never runs the
    // code, so an unbound `readFileSync` is exactly as good a subject as a bound one.
    source: [
      'const source = readFileSync("components/ui/surface.tsx", "utf8");',
      'export const owners = source.match(/data-surface="([^"]+)"/g);',
      "",
    ].join("\n"),
    expect: ["production-source-text-read"],
    because: "handed to a file-reading API",
  },
  // --- the three scope classes the cold review got through (P1) ---------------
  {
    // The review's exact probe. Oxlint's helper globs were TS/TSX-only, so a `.mjs` helper
    // was outside the policy entirely -- and this guard's own 20 tests were green while it
    // was, which is why the fixture lives here rather than in a review note.
    family: "static filesystem import in a NON-TS test-support helper",
    file: "helper.test-support.mjs",
    source: 'import { readFileSync } from "node:fs";\nexport const probe = readFileSync;\n',
    expect: ["no-restricted-imports"],
    because: "Generic filesystem capability",
  },
  {
    // A generic `support/` subtree outside `e2e/`. No rule's `files:` list named one before
    // the fixup, so nothing scanned it.
    family: "require(fs) in a generic support subtree",
    file: "support/helper.mjs",
    source: 'export const probe = () => require("node:fs");\n',
    expect: ["test-capability-acquisition-js"],
    because: "filesystem, module-loader or parser capability",
  },
  {
    // Not an acquisition family: the native replacement for the recursive import walk that
    // `assistant-styles.test.ts` used to run. A second CSS entry is now unavailable.
    family: "a second CopilotKit stylesheet CSS entry",
    file: "second-stylesheet-entry.tsx",
    source: 'import "@copilotkit/react-core/v2/styles.css";\nexport const P = () => null;\n',
    expect: ["no-restricted-imports"],
    because: "PRODUCTION CSS ENTRY",
  },
];

/**
 * Files that must lint CLEAN. Without these the suite would prove the rules fire and say
 * nothing about whether they fire indiscriminately -- and one of them pins the exact
 * distinction ledger requirement 7 asks for.
 */
const CONTROLS: { readonly what: string; readonly file: string; readonly source: string }[] = [
  {
    what: "loader text inside a spawned-script string is not an acquisition by this module",
    file: "spawned-script-loader-text.test.mts",
    source: [
      "export const script = `",
      "  const http = require('node:http');",
      "  const fs = require('node:fs');",
      "  const ts = await import('typescript');",
      "`;",
      "",
    ].join("\n"),
  },
  {
    what: "the builtins and dynamic imports tests legitimately use stay available",
    file: "legitimate-imports.test.mts",
    source: [
      'import { join } from "node:path";',
      'import { createHash } from "node:crypto";',
      'export const probe = async () => [join("a", "b"), createHash("sha256"), await import("vitest")];',
      "",
    ].join("\n"),
  },
  {
    what: "a non-TypeScript fixture read is not a source read",
    file: "fixture-format-read.test.mts",
    source: [
      'const css = readFileSync("app/globals.css", "utf8");',
      'const compose = readFileSync("docker-compose.yml", "utf8");',
      "export const probe = [css, compose];",
      "",
    ].join("\n"),
  },
];

interface LintRun {
  readonly status: number;
  readonly text: string;
}

function run(args: string[], json = false): LintRun {
  const result = spawnSync("pnpm", args, { cwd: WEB_ROOT, encoding: "utf8" });
  return {
    status: result.status ?? -1,
    text: `${result.stdout ?? ""}${json ? "" : (result.stderr ?? "")}`,
  };
}

function writeFixtures(): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  // Some fixtures live in a SUBDIRECTORY on purpose (`support/helper.mjs`), because the scope
  // class being proved is the directory name rather than the filename.
  mkdirSync(join(FIXTURE_DIR, "support"), { recursive: true });
  for (const fixture of FIXTURES) {
    writeFileSync(join(FIXTURE_DIR, fixture.file), fixture.source);
  }
  for (const control of CONTROLS) writeFileSync(join(FIXTURE_DIR, control.file), control.source);
}

function removeFixtures(): void {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
}

/** Diagnostics collected ONCE, with every fixture present, from the real lint commands. */
let cleanBefore: LintRun;
let normalLint: LintRun;
let oxlint: LintRun;
let astGrep: LintRun;
let astGrepFindings: { ruleId: string; file: string }[] = [];

beforeAll(() => {
  removeFixtures();

  // The tree must be GREEN first. Otherwise every assertion below could be satisfied by a
  // pre-existing violation somewhere else entirely.
  cleanBefore = run(["lint"]);

  writeFixtures();
  // The composed command developers and CI actually run, over the WHOLE tree. This is the
  // headline claim and it is made exactly once.
  normalLint = run(["lint"]);
  // Attribution. Same binaries, same config, same rules -- scoped to the fixture directory so
  // this suite spawns ONE whole-tree lint rather than four.
  //
  // ATTRIBUTION, STATED HONESTLY, because the obvious story here is only half true. A full run
  // once reported 27 failures: one was genuinely this suite's fault -- the `support/` fixture
  // below created a match-set class the config guard had no representative for, which is fixed
  // by that guard skipping this directory. The other 26 were timing-sensitive DOM suites, and
  // the likeliest cause was NOT this file: a second heavy suite was running concurrently in the
  // same shell at the time, and a clean run afterwards was green with the four spawns still in
  // place. So the reduction to one heavy spawn is prudence, not a proven fix for those 26.
  // What IS proven: vitest runs test files in parallel, this suite is the only one that spawns
  // whole-tree lint processes, and one is enough to make its claim.
  oxlint = run(["exec", "oxlint", FIXTURE_DIR_NAME]);
  astGrep = run(["exec", "ast-grep", "scan", FIXTURE_DIR_NAME]);
  const json = run(["exec", "ast-grep", "scan", "--json=compact", FIXTURE_DIR_NAME], true);
  // `--json=compact` writes the whole findings array on ONE line, and pnpm/ast-grep put their
  // own chatter on others -- including a `[warn] postinstall ...` line that starts with `[`,
  // so "slice from the first bracket" is not good enough.
  const payload = json.text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("[{") || line === "[]");
  astGrepFindings = payload
    ? (JSON.parse(payload) as { ruleId: string; file: string }[]).map(({ ruleId, file }) => ({
        ruleId,
        file,
      }))
    : [];

  removeFixtures();
}, 300_000);

afterAll(removeFixtures);

function oxlintFiredAt(file: string, rule: string): boolean {
  return oxlint.text
    .split("\n")
    .some((line) => line.includes(`acquisition-fixtures/${file}`) && line.includes(`(${rule})`));
}

function astGrepFiredAt(file: string, ruleId: string): boolean {
  return astGrepFindings.some(
    (finding) => finding.ruleId === ruleId && finding.file.endsWith(`acquisition-fixtures/${file}`),
  );
}

describe("the premise: the tree is clean before any fixture exists", () => {
  it("passes the normal lint command with no fixtures present", () => {
    expect(cleanBefore.status, cleanBefore.text.slice(-2000)).toBe(0);
  });
});

describe("every named bypass family fails the NORMAL lint command", () => {
  it("the normal lint command exits non-zero with the fixtures present", () => {
    // The headline claim, stated against `pnpm lint` itself rather than against a rule name.
    expect(normalLint.status).not.toBe(0);
  });

  for (const fixture of FIXTURES) {
    it(`rejects ${fixture.family}`, () => {
      const missing = fixture.expect.filter((rule) =>
        rule === "no-restricted-imports"
          ? !oxlintFiredAt(fixture.file, rule)
          : !astGrepFiredAt(fixture.file, rule),
      );
      expect(missing, `${fixture.file}: expected rules that did not fire`).toEqual([]);
    });

    it(`gives ${fixture.family} EXACTLY ONE OWNING MECHANISM`, () => {
      // ADDED BY THE FIXUP (cold-review P2). Ticket 6's own acceptance forbids duplication, and
      // the first version claimed it without checking: dynamic `import()` was matched by
      // Oxlint AND by ast-grep. Asserting the count rather than the presence is what makes
      // "one owner" a gate instead of a sentence in a report.
      const owners = [
        ...new Set([
          ...(oxlintFiredAt(fixture.file, "no-restricted-imports")
            ? ["oxlint:no-restricted-imports"]
            : []),
          ...astGrepFindings
            .filter((finding) => finding.file.endsWith(`acquisition-fixtures/${fixture.file}`))
            .map((finding) => `ast-grep:${finding.ruleId}`),
        ]),
      ].sort();
      expect(owners, `${fixture.file} must have one owning mechanism`).toEqual(
        [...fixture.expect]
          .map((rule) =>
            rule === "no-restricted-imports" ? "oxlint:no-restricted-imports" : `ast-grep:${rule}`,
          )
          .sort(),
      );
    });

    it(`rejects ${fixture.family} FOR THE INTENDED REASON`, () => {
      // "Lint went red" is not the claim. The diagnostic that names this fixture's file must
      // also carry the intended explanation, so a fixture cannot pass on an unrelated rule
      // that happens to dislike the same file.
      const combined = `${oxlint.text}\n${astGrep.text}`;
      expect(combined).toContain(fixture.because);
    });
  }
});

describe("the rules do not fire indiscriminately", () => {
  for (const control of CONTROLS) {
    it(control.what, () => {
      const oxlintHits = oxlint.text
        .split("\n")
        .filter((line) => line.includes(`acquisition-fixtures/${control.file}`));
      const astGrepHits = astGrepFindings.filter((finding) =>
        finding.file.endsWith(`acquisition-fixtures/${control.file}`),
      );
      expect(oxlintHits, `${control.file} should lint clean`).toEqual([]);
      expect(
        astGrepHits.map((hit) => hit.ruleId),
        `${control.file} should scan clean`,
      ).toEqual([]);
    });
  }
});

describe("the harness leaves nothing behind", () => {
  it("has removed the fixture directory", () => {
    // A lingering fixture would break `pnpm typecheck` and `pnpm lint` for everyone, so its
    // absence is a test rather than a convention.
    expect(existsSync(FIXTURE_DIR)).toBe(false);
  });
});
