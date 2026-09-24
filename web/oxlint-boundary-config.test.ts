import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";

// THE OXLINT OVERRIDE-OVERLAP GUARD (custom-AST ticket 2).
//
// WHY THIS EXISTS. Oxlint resolves a rule for a file by taking the base config and then
// applying every override whose `files` glob matches, LAST MATCH WINNING -- and an
// override REPLACES that rule's whole configuration rather than merging into it. This
// ticket's first config got that wrong in exactly the way the mechanism invites: two
// overrides that existed to grant one narrow exception restated a shorter restriction
// list, and so silently dropped every unrelated boundary at those paths. Normal lint
// exited 0 on both, because neither file contains those imports today.
//
// Manual probes cannot catch that, and did not: a probe proves the rule at the path it is
// written in, and nobody writes a probe inside the file they are exempting.
//
// THIS FILE HAS BEEN WRONG TWICE, IN THE SAME WAY EACH TIME: it described the config
// loosely, and a widening that fitted the description walked through it.
//
//   Round 1 -- it recognised a restriction "family" by asking whether some regex string
//   CONTAINED `entity-editor`. Prefixing that regex with `TICKET2_DISABLED_` kept it
//   "containing" and made it match nothing. It also never read severity, so
//   `["error", options]` -> `["off", options]` left every entry in place and the rule
//   switched off.
//
//   Round 2 -- it compared hand-built string keys covering only the fields somebody had
//   thought of, joined with commas. Two more widenings followed: `allowImportNames` was
//   not in the key at all, so adding one to the runtime entry's repository pattern was
//   invisible; and `["a", "b"]` and `["a,b"]` produce the same comma-joined key, so
//   rewriting a `group` array across its boundary was invisible too. Both left the guard
//   green while real Oxlint emitted zero diagnostics. It also read severity for the two
//   restriction rules only in overrides, and for the targeted Vitest/import rules only in
//   the BASE -- so an existing pinned override could switch `vitest/no-focused-tests` or
//   `import/no-cycle` off beside its declared exception and nothing noticed.
//
// The lesson both times is the same, so the design now refuses to describe the config at
// all. It PINS it:
//
//   * the enforcement-bearing field list is READ FROM the installed Oxlint schema, not
//     enumerated here, so a field this file has never heard of still participates;
//   * unknown keys on an entry are rejected rather than ignored;
//   * canonicalization is structural JSON with recursively sorted keys and sorted arrays
//     -- array boundaries survive, so no two distinct entries can collide;
//   * the BASE config itself is declared as data and compared, so families are derived
//     rather than recognised;
//   * every rule any override sets must be one of the known enforced rules, at `error`,
//     with exactly two pinned `off` exceptions.
//
// WHAT THIS IS. Configuration validation. It reads `.oxlintrc.json` and the installed
// `oxlint/configuration_schema.json` as JSON -- not as source, and not through a parser of
// its own.
//
// LIMIT, STATED. `oxlint --print-config` echoes the config with its overrides intact and
// offers no per-file resolution, so there is no authoritative effective-config source to
// defer to. Glob matching here is Node's `path.matchesGlob`, not Oxlint's. This guard
// proves the config SAYS what it should, for the rules and schema of the installed Oxlint;
// it does not re-implement Oxlint. The ledger's real-diagnostic probes are what tie its
// conclusions back to Oxlint's own behaviour.

const config = JSON.parse(
  readFileSync(new URL("./.oxlintrc.json", import.meta.url), "utf8"),
) as OxlintConfig;

const SCHEMA = JSON.parse(
  readFileSync(new URL("./node_modules/oxlint/configuration_schema.json", import.meta.url), "utf8"),
) as JsonSchema;

interface JsonSchema {
  definitions: Record<
    string,
    { additionalProperties?: boolean; properties?: Record<string, { type?: string }> }
  >;
}
type RuleValue = "off" | "warn" | "error" | [string, ...unknown[]];
interface OxlintConfig {
  rules: Record<string, RuleValue>;
  overrides: { files: string[]; rules: Record<string, RuleValue> }[];
  ignorePatterns: string[];
}
type Entry = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The field model, READ FROM the installed schema
// ---------------------------------------------------------------------------
//
// Hand-listing these is what let `allowImportNames` slip through: a field nobody thought
// of is a field nobody compares. The three entry shapes are closed schemas
// (`additionalProperties: false`), so their property lists ARE the complete enforcement
// surface, and reading them here means an Oxlint upgrade that adds an option makes this
// guard start comparing it on the next run rather than the next review.

const IGNORED_FIELD = "message";

interface FieldModel {
  fields: string[];
  booleans: string[];
  arrays: string[];
}

function fieldModel(definition: string): FieldModel {
  const shape = SCHEMA.definitions[definition];
  if (!shape) throw new Error(`the installed Oxlint schema has no "${definition}" definition`);
  if (shape.additionalProperties !== false) {
    throw new Error(`"${definition}" is not a closed schema; its field list is not complete`);
  }
  const properties = shape.properties ?? {};
  const fields = Object.keys(properties).sort();
  return {
    fields,
    booleans: fields.filter((name) => properties[name]?.type === "boolean"),
    arrays: fields.filter((name) => properties[name]?.type === "array"),
  };
}

const MODEL = {
  path: fieldModel("RestrictedPath"),
  pattern: fieldModel("RestrictedPattern"),
  property: fieldModel("PropertyDetails"),
} as const;

type EntryKind = keyof typeof MODEL;

// ---------------------------------------------------------------------------
// Canonicalization -- structural, injective
// ---------------------------------------------------------------------------
//
// `JSON.stringify` over a value whose object keys are recursively sorted and whose arrays
// are sorted by their own canonical form. Arrays stay arrays, so `["a", "b"]` and
// `["a,b"]` are `["a","b"]` and `["a,b"]` -- distinct, which the previous comma join was
// not. Array ORDER is normalized away because none of these lists is order-sensitive to
// Oxlint; array BOUNDARIES are not.
//
// Absent booleans are read as `false` so an explicit `allowTypeImports: false` and its
// omission compare equal, which is what Oxlint does. Every other absent field is simply
// absent. `message` is the one excluded field, so a copy-edit is not a boundary change.

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonical)
      .sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonical(source[key])]),
    );
  }
  return value;
}

interface Normalized {
  key: string;
  unknownFields: string[];
}

function normalize(kind: EntryKind, entry: Entry): Normalized {
  const model = MODEL[kind];
  const unknownFields = Object.keys(entry).filter((field) => !model.fields.includes(field));
  const relevant: Entry = { kind };
  for (const field of model.fields) {
    if (field === IGNORED_FIELD) continue;
    if (model.booleans.includes(field)) {
      relevant[field] = entry[field] === true;
      continue;
    }
    if (entry[field] !== undefined) relevant[field] = entry[field];
  }
  // Unknown fields are carried into the key as well, so an entry that gains one cannot
  // compare equal to the base even if the dedicated assertion below were removed.
  for (const field of unknownFields) relevant[`?${field}`] = entry[field];
  return { key: JSON.stringify(canonical(relevant)), unknownFields };
}

interface KindedEntry {
  kind: EntryKind;
  entry: Entry;
}

function keysOf(entries: KindedEntry[]): string[] {
  return entries.map(({ kind, entry }) => normalize(kind, entry).key).sort();
}

/** Multiset difference, reported as human-readable lines. */
function diff(where: string, expected: string[], actual: string[]): string[] {
  const problems: string[] = [];
  const remaining = [...actual];
  for (const key of expected) {
    const at = remaining.indexOf(key);
    if (at === -1) problems.push(`${where}: MISSING entry ${key}`);
    else remaining.splice(at, 1);
  }
  for (const key of remaining) problems.push(`${where}: UNEXPECTED entry ${key}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Rules, severity and the two pinned exceptions
// ---------------------------------------------------------------------------

const IMPORTS_RULE = "no-restricted-imports";
const PROPERTIES_RULE = "no-restricted-properties";

/**
 * Every rule this ticket relies on. An override may set any of these and nothing else;
 * a rule key outside this list is a configuration change nobody declared.
 */
const ENFORCED_RULES = [
  IMPORTS_RULE,
  PROPERTIES_RULE,
  "vitest/no-disabled-tests",
  "vitest/no-focused-tests",
  "vitest/no-commented-out-tests",
  "import/no-cycle",
  "import/no-self-import",
  "import/no-absolute-path",
  "import/no-webpack-loader-syntax",
];

/**
 * The ONLY `off` values permitted anywhere, each pinned to the override that may hold it.
 * Both are documented exceptions; anything else switched off is the false-green this
 * ticket exists to prevent.
 */
const PINNED_OFF: { index: number; rule: string; why: string }[] = [
  {
    index: 15,
    rule: PROPERTIES_RULE,
    why: "the five fixture-tool suites register tools that are deliberately not model-visible",
  },
  {
    index: 21,
    rule: "vitest/no-disabled-tests",
    why: "two deliberate VISIBLE skip markers, so the subprocess suite never silently vanishes when the build artifact is missing or the platform is not Linux",
  },
];

function severityOf(rule: RuleValue | undefined): string {
  if (rule === undefined) return "absent";
  if (typeof rule === "string") return rule;
  return String(rule[0]);
}

function importEntries(rule: RuleValue | undefined): KindedEntry[] {
  if (rule === undefined || typeof rule === "string") return [];
  const options = (rule[1] ?? {}) as { paths?: Entry[]; patterns?: Entry[] };
  return [
    ...(options.paths ?? []).map((entry) => ({ kind: "path" as const, entry })),
    ...(options.patterns ?? []).map((entry) => ({ kind: "pattern" as const, entry })),
  ];
}

function propertyEntries(rule: RuleValue | undefined): KindedEntry[] {
  if (rule === undefined || typeof rule === "string") return [];
  return (rule.slice(1) as Entry[]).map((entry) => ({ kind: "property" as const, entry }));
}

// ---------------------------------------------------------------------------
// The declared BASE config, as data
// ---------------------------------------------------------------------------
//
// Families are derived from these literals rather than recognised in the config, which is
// what removes the last place a marker could stand in for the real thing. `message` is
// omitted throughout because it is the one field that does not change enforcement.

type Family =
  | "raw-copilotkit"
  | "retired-undo"
  | "retired-icon-library"
  | "copilotkit-runtime"
  | "repository"
  | "assistant"
  | "retired-shell"
  | "copilotkit-stylesheet-entry";

const RAW_COPILOTKIT_V2_NAMES = [
  "useFrontendTool",
  "useHumanInTheLoop",
  "useComponent",
  "useInterrupt",
  "useCopilotKit",
  "CopilotKitProvider",
  "CopilotKit",
  "CopilotKitCoreReact",
  "CopilotKitCore",
  "RunHandler",
  "CopilotTask",
  "CopilotContext",
  "useCopilotContext",
  "ɵrunMcpFollowUp",
  "MCPAppsActivityRenderer",
  "createA2UIMessageRenderer",
  "OpenGenerativeUIActivityRenderer",
  "SandboxFunctionsContext",
  "useSandboxFunctions",
];

const FAMILY_ENTRIES: Record<Family, KindedEntry[]> = {
  "raw-copilotkit": [
    { kind: "path", entry: { name: "@copilotkit/react-core" } },
    {
      kind: "path",
      entry: { name: "@copilotkit/react-core/v2", importNames: RAW_COPILOTKIT_V2_NAMES },
    },
    { kind: "path", entry: { name: "@copilotkit/react-core/v2/context" } },
    { kind: "path", entry: { name: "@copilotkit/react-core/v2/headless" } },
  ],
  "retired-undo": [
    { kind: "path", entry: { name: "zundo" } },
    { kind: "path", entry: { name: "zustand/middleware", importNames: ["persist"] } },
  ],
  // custom-AST ticket 3. The recursive `app/` + `components/` walk in
  // `app/design-system.test.ts` that read every source file looking for a `lucide-react`
  // import is exactly what `no-restricted-imports` does natively, so the guarantee moved
  // here. Declared AFTER the two path-only families and before the pattern families,
  // because the base config lists every `paths` entry before every `patterns` entry and
  // this contract is compared as an ordered list.
  "retired-icon-library": [{ kind: "path", entry: { name: "lucide-react" } }],
  "copilotkit-runtime": [
    {
      kind: "pattern",
      entry: {
        group: ["@copilotkit/runtime", "@copilotkit/runtime/*", "@copilotkit/runtime/**"],
      },
    },
  ],
  repository: [
    {
      kind: "pattern",
      entry: { group: ["@/lib/repository", "@/lib/repository/*", "@/lib/repository/**"] },
    },
    { kind: "pattern", entry: { regex: "^\\.{1,2}/(.*/)?repository(/|$)" } },
  ],
  assistant: [
    {
      kind: "pattern",
      entry: {
        group: [
          "@/lib/ai",
          "@/lib/ai/*",
          "@/lib/ai/**",
          "@/components/ai",
          "@/components/ai/*",
          "@/components/ai/**",
        ],
      },
    },
    { kind: "pattern", entry: { regex: "^\\.{1,2}/(.*/)?ai(/|$)" } },
  ],
  "retired-shell": [
    {
      kind: "pattern",
      entry: { regex: "(^|/)entity-editor/entity-editor(\\.[cm]?[jt]sx?)?$" },
    },
  ],
  // ADDED BY THE TICKET-6 FIXUP (cold-review P1). This is the native replacement for the
  // recursive `app/` + `components/` import walk that `assistant-styles.test.ts` used to run
  // over authored TS/TSX looking for a second CSS entry. Closing the specifier makes a second
  // entry UNAVAILABLE rather than merely unspelled, and it covers aliases, re-export chains and
  // dynamic `import()` in every directory rather than two. Exempt at `app/layout.tsx` alone.
  "copilotkit-stylesheet-entry": [
    { kind: "path", entry: { name: "@copilotkit/react-core/v2/styles.css" } },
  ],
};

const ALL_FAMILIES = Object.keys(FAMILY_ENTRIES) as Family[];

// ---------------------------------------------------------------------------
// The ACQUISITION families (custom-AST ticket 6)
// ---------------------------------------------------------------------------
//
// These are structurally different from every family above, and the difference is the whole
// reason this guard needed a new concept rather than three more entries.
//
// The families above are GLOBAL: they sit in the base config and apply everywhere, and an
// override's job is to SUBTRACT the one crossing that path legitimately makes. The
// acquisition families are the opposite. They are ADDITIVE at test/support scope only,
// because the policy they encode is scoped that way on purpose: production code may read the
// filesystem, and `scripts/start-standalone.mjs` does. Putting them in the base would
// restrict production too, which is a wider policy than the ticket declares and would turn
// that script into an "exception" the governing spec explicitly says to report rather than
// except.
//
// So the contract each override is checked against becomes
//
//     (global families - boundary exemptions) + (acquisition families - reader exemptions)
//
// and an override with `acquisition: null` is simply not in scope. `NOT_IN_BASE` below is the
// assertion that keeps this honest from the other side: if one of these ever appears in the
// base config, production silently acquires the restriction and this guard says so.

type AcquisitionFamily = "parser-library" | "filesystem" | "module-loader";

const ACQUISITION_ENTRIES: Record<AcquisitionFamily, KindedEntry[]> = {
  "parser-library": [
    {
      kind: "pattern",
      entry: {
        group: [
          "typescript",
          "typescript/*",
          "typescript/**",
          "ts-morph",
          "ts-morph/**",
          "@babel/*",
          "@babel/*/**",
          "acorn",
          "acorn/**",
          "acorn-walk",
          "acorn-walk/**",
          "esprima",
          "espree",
          "meriyah",
          "recast",
          "recast/**",
          "jscodeshift",
          "jscodeshift/**",
          "@swc/*",
          "@swc/*/**",
          "oxc-parser",
          "oxc-parser/**",
          "@typescript-eslint/*",
          "tree-sitter",
          "tree-sitter-*",
          "web-tree-sitter",
          "@ast-grep/*",
        ],
      },
    },
  ],
  filesystem: [
    {
      kind: "pattern",
      entry: {
        group: [
          "fs",
          "fs/*",
          "fs/**",
          "node:fs",
          "node:fs/*",
          "node:fs/**",
          "fs-extra",
          "fs-extra/**",
          "graceful-fs",
          "memfs",
        ],
      },
    },
  ],
  "module-loader": [{ kind: "pattern", entry: { group: ["module", "node:module"] } }],
};

const ALL_ACQUISITION = Object.keys(ACQUISITION_ENTRIES) as AcquisitionFamily[];

/**
 * The repository override does not DROP the assistant boundary, it narrows it: the Dexie
 * schema needs the assistant's row shapes at compile time, and `import type` /
 * `export type ... from` are erased whole. So the two assistant entries reappear there
 * with `allowTypeImports`, and nowhere else.
 */
const ASSISTANT_TYPE_ONLY: KindedEntry[] = FAMILY_ENTRIES.assistant.map(({ kind, entry }) => ({
  kind,
  entry: { ...entry, allowTypeImports: true },
}));

const BASE_PROPERTY_ENTRIES: KindedEntry[] = [
  { kind: "property", entry: { property: "addTool" } },
  { kind: "property", entry: { property: "temporal" } },
];

const AI_PROPERTY_ENTRIES: KindedEntry[] = [
  ...BASE_PROPERTY_ENTRIES,
  { kind: "property", entry: { object: "scenarioCommands", allowProperties: [] } },
  {
    kind: "property",
    entry: {
      object: "assistantProposalCommands",
      allowProperties: [
        "readScenarioBasis",
        "prepare",
        "confirm",
        "withdrawConfirmation",
        "cancel",
        "markStale",
        "apply",
        "undoReceipt",
        "read",
        "describeReceipts",
      ],
    },
  },
];

type PropertyContract = "base" | "ai" | "off" | "inherited";

function expectedPropertyKeys(contract: Exclude<PropertyContract, "inherited">): string[] {
  if (contract === "off") return [];
  return keysOf(contract === "ai" ? AI_PROPERTY_ENTRIES : BASE_PROPERTY_ENTRIES);
}

function expectedImportKeys(
  exempt: Family[],
  typeOnlyAssistant: boolean,
  acquisition: AcquisitionFamily[] | null,
): string[] {
  const kept: KindedEntry[] = [];
  for (const family of ALL_FAMILIES) {
    if (family === "assistant" && typeOnlyAssistant) {
      kept.push(...ASSISTANT_TYPE_ONLY);
      continue;
    }
    if (exempt.includes(family)) continue;
    kept.push(...FAMILY_ENTRIES[family]);
  }
  if (acquisition !== null) {
    for (const family of ALL_ACQUISITION) {
      if (acquisition.includes(family)) continue;
      kept.push(...ACQUISITION_ENTRIES[family]);
    }
  }
  return keysOf(kept);
}

// ---------------------------------------------------------------------------
// The declared contract, override by override, IN ORDER
// ---------------------------------------------------------------------------

interface OverrideContract {
  files: string[];
  /** `null` when the override sets no `no-restricted-imports` config at all. */
  exempt: Family[] | null;
  typeOnlyAssistant?: boolean;
  /**
   * `null` = not in test/support scope, so the acquisition families do not apply.
   * `[]` = in scope with no reader exception. A non-empty list is an exact reader exception.
   */
  acquisition: AcquisitionFamily[] | null;
  properties: PropertyContract;
  why: string;
}

/**
 * The test/support scope, spelled out over all eight extensions the ticket names.
 *
 * `.mts`/`.cts`/`.js`/`.jsx`/`.mjs`/`.cjs` variants do not exist in this tree today -- every
 * test/spec file is `.ts` or `.tsx` -- so those globs are PREVENTION, and they are recorded as
 * such rather than presented as covering current files. They are not a widening of the
 * assistant boundary either: a `foo.test.mjs` added tomorrow gets exactly what `foo.test.ts`
 * gets today.
 */
const TEST_FILE_GLOBS = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.mts",
  "**/*.test.cts",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.test.mjs",
  "**/*.test.cjs",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.mts",
  "**/*.spec.cts",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/*.spec.mjs",
  "**/*.spec.cjs",
  "**/*.test-d.ts",
  "**/*.test-d.tsx",
  "**/*.test-d.mts",
];

/**
 * The support TREES and test-only helper modules.
 *
 * THIS IS A SEPARATE OVERRIDE ON PURPOSE, and the reason is the one thing about this config
 * that is easy to get wrong. `e2e/**` and the `test-support` helpers are test/support code, so
 * they need the acquisition families -- but they are NOT on the assistant boundary's
 * permitted-reference list, and that list is encoded as the test override's `files:` array.
 * Adding these globs there would newly allow `e2e/support/v2-visual-audit.ts` and five sibling
 * helpers to import assistant code, which is a boundary widening dressed up as a lint scope
 * change. So they get their own override, EARLIER in the list, carrying every global family in
 * force plus the acquisition families.
 */
const HELPER_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];

const TEST_SUPPORT_TREES = [
  "e2e/**",
  "**/__tests__/**",
  // WIDENED BY THE FIXUP (cold-review P1). The first version named only `e2e/**`, `__tests__`
  // and the TS/TSX helper filenames. The review built `lib/ticket6-review.test-support.mjs`
  // with a static `node:fs` import and it passed Oxlint, ast-grep AND this guard's 20 tests --
  // a live hole and a guard false-green at once. A generic `support/` subtree outside `e2e`
  // was unscanned for the same reason. Both subtree names and all eight extensions now.
  "**/support/**",
  "**/test-support/**",
  ...HELPER_EXTENSIONS.map((extension) => `**/test-support.${extension}`),
  ...HELPER_EXTENSIONS.map((extension) => `**/*.test-support.${extension}`),
  "lib/store/test-authority.ts",
];

/**
 * Reader-ledger exceptions with a FILESYSTEM allowance, at ordinary-test boundary scope.
 * Each one's exact API, root/path class, extension/format and write permission is recorded in
 * the ticket-6 implementation artifact, as ledger rule 5 requires. Note what is NOT here:
 * `e2e/support/v2-owner-selection.test.ts`, `components/entity-editor/retirement.test.ts` and
 * `lib/ai/independence.test.ts`, all three of which ticket 6 migrated off the filesystem
 * rather than excepting.
 *
 * THE FOUR ADDED BY THE `main` INTEGRATION are main's own suites, reviewed and granted one by
 * one in `lint-boundary-review`. Their ledger rows, in the API / root / format / write shape
 * ledger rule 5 requires:
 *
 * | File | API | Root or path class | Format | Write |
 * | --- | --- | --- | --- | --- |
 * | `dev-launcher.test.ts` | `mkdirSync`, `mkdtempSync`, `writeFileSync`, `rmSync` | `os.tmpdir()/dev-launcher-*` | extensionless `pnpm` stub, `.sh` start shim | write + delete; NO read |
 * | `lib/roster/edited-xlsx.test.ts` | `readFileSync`, `writeFileSync`, `rmSync` | `lib/optimize/__fixtures__/c5/` | reads `manifest.json` and `.xlsx`; writes `.orig.*.tmp.xlsx` / `.patched.*.tmp.xlsx` | write + delete |
 * | `e2e/support/abort-handoff.test.ts` | `mkdtempSync`, `readFileSync`, `readdirSync`, `writeFileSync`, `rmSync` | `os.tmpdir()/ns-abort-handoff-*` | UTF-8 `.json` only | write + delete |
 * | `e2e/support/ward-journey.test.ts` | `readFileSync` | `lib/optimize/__fixtures__/c5/c5-plain-3people.xlsx` | OOXML `.xlsx` | no |
 *
 * NONE of the four opens a `.ts`/`.tsx` for its contents. The two source scans that used to
 * live in `dev-launcher.test.ts` and `abort-handoff.test.ts` were DELETED before either was
 * granted, which is what makes these reader exceptions rather than source-analyzer exceptions:
 * `production-source-text-read` still has no exception anywhere in the repository.
 */
const READER_EXCEPTIONS_FILESYSTEM = [
  "acquisition-prevention.test.ts",
  "app/design-system.test.ts",
  "app/tailwind-contract.test.ts",
  "app/v2-style-contract.test.ts",
  "ast-grep-rule-pairs.test.ts",
  "ast-grep-substrate.test.ts",
  "components/shell/chrome-contrast.test.ts",
  "dev-launcher.test.ts",
  "e2e/optimize-assembled-stream.spec.ts",
  "e2e/optimize-visual.spec.ts",
  "e2e/support/abort-handoff.test.ts",
  "e2e/support/v2-surface-matrix.test.ts",
  "e2e/support/ward-journey.test.ts",
  "e2e/v2-visual-regression.spec.ts",
  "instrumentation.subprocess.test.ts",
  "lib/capability/registry.generated.test.ts",
  "lib/optimize/basis/optimize-basis.test.ts",
  "lib/optimize/restore-people-ids-in-xlsx.browser.test.ts",
  "lib/optimize/restore-people-ids-in-xlsx.test.ts",
  "lib/query/job-response-contract.test.ts",
  "lib/roster/edited-xlsx.test.ts",
  "lib/utils.test.ts",
  "oxlint-boundary-config.test.ts",
  "playwright.workers.test.ts",
  "verify-deploy.test.ts",
];

/**
 * Reader-ledger exceptions with a FILESYSTEM allowance at NON-TEST SUPPORT scope.
 *
 * Separate from the array above, and it has to stay separate. These three are `e2e/support`
 * helpers that are not test files, so their base is the SUPPORT-TREE override, which keeps
 * every global family -- assistant, raw-CopilotKit, repository -- in force over them.
 * Appending them to the ordinary reader array would have handed all three the `assistant` and
 * `raw-copilotkit` exemptions that array carries, silently undoing ticket 6's non-widening
 * support-tree decision for a reason that has nothing to do with reading a file. Their own
 * override therefore declares `exempt: []` and removes the filesystem acquisition family
 * alone.
 *
 * | File | API | Root or path class | Format | Write |
 * | --- | --- | --- | --- | --- |
 * | `e2e/support/abort-control-reporter.ts` | `writeFileSync` | the gate-supplied `ABORT_CONTROL_REPORT` target | UTF-8 `.json` | write only; NO read, NO delete |
 * | `e2e/support/abort-handoff.ts` | `writeFileSync`, `renameSync`, `rmSync` | the gate-supplied handoff `.json` and its same-directory `.tmp-<pid>-<sequence>` sibling | UTF-8 `.json` | write, atomic rename, temp cleanup; NO read |
 * | `e2e/support/ward-journey.ts` | `readFileSync`, reached only through the format-specific `readWardYaml()` | `core/tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml` | UTF-8 YAML | no |
 */
const READER_EXCEPTIONS_SUPPORT_FILESYSTEM = [
  "e2e/support/abort-control-reporter.ts",
  "e2e/support/abort-handoff.ts",
  "e2e/support/ward-journey.ts",
];

const AI_OWNERS = [
  "lib/ai/**",
  "components/ai/**",
  "components/settings/**",
  "components/shell/app-shell.tsx",
  "components/shell/top-bar.tsx",
  "app/(app)/settings/page.tsx",
  "app/api/copilotkit/**",
  "app/api/ai/**",
  "instrumentation-node.ts",
];

const OVERRIDES: OverrideContract[] = [
  {
    files: ["app/layout.tsx"],
    exempt: ["copilotkit-stylesheet-entry"],
    acquisition: null,
    properties: "base",
    why: "FIXUP. The single production CSS entry for the CopilotKit v2 stylesheet. It is the only path exempt from that family, which is what makes a second entry unavailable rather than merely unspelled",
  },
  {
    files: AI_OWNERS,
    exempt: ["assistant"],
    acquisition: null,
    properties: "ai",
    why: "the assistant, its UI, the settings card, the two shell mount points, the AI routes and boot instrumentation ARE the seam. Mixed production/test, but the test override below wins for its tests",
  },
  {
    files: TEST_SUPPORT_TREES,
    exempt: [],
    acquisition: [],
    properties: "base",
    why: "TICKET 6. The support trees and test-only helpers: in acquisition scope, but NOT on the assistant boundary's permitted-reference list, so every global family stays in force over them",
  },
  {
    files: ["components/ai/turn-authority.test-support.ts"],
    exempt: ["assistant"],
    acquisition: [],
    properties: "ai",
    why: "TICKET 6. The one test-only helper that is itself assistant-owned: it type-imports the send gate and the writer context, so the override above would otherwise close the boundary on a module that IS inside it",
  },
  {
    files: TEST_FILE_GLOBS,
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: [],
    properties: "base",
    why: "the original source scans excluded tests from the assistant rule, and the mounted/provider suites must reach the raw client to build their controls. Widened by ticket 6 to all eight extensions",
  },
  {
    files: [
      "components/ai/assistant-copilot-provider.tsx",
      "components/ai/copilotkit-core-access.ts",
      "components/ai/register-model-visible-tool.ts",
    ],
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: null,
    properties: "ai",
    why: "the three canonical boundary modules are the only production code allowed to name the raw client",
  },
  {
    files: ["lib/repository/**"],
    exempt: ["repository"],
    typeOnlyAssistant: true,
    acquisition: null,
    properties: "base",
    why: "inside the durable boundary; the assistant family survives TYPE-ONLY. PRODUCTION half: no acquisition restriction, or the policy would reach past test/support scope",
  },
  {
    files: ["lib/repository/**/*.test.ts", "lib/repository/test-support.ts"],
    exempt: ["repository"],
    typeOnlyAssistant: true,
    acquisition: [],
    properties: "base",
    why: "TICKET 6. The TEST half of the same directory. It needs its own override because the production override above matches its tests too and would otherwise win, dropping the acquisition families at exactly the paths that need them",
  },
  {
    files: [
      "lib/store/authority.ts",
      "lib/store/dexie-storage.ts",
      "lib/store/ownership.ts",
      "lib/store/spine.ts",
    ],
    exempt: ["repository"],
    acquisition: null,
    properties: "base",
    why: "the projection adapter and the modules that wire it, plus the roster storage accessor -- which is in this set for the reason the rule's own message gives, that it OWNS its tables: it hands roster storage the single declared NurseSchedulerDb instead of declaring a second class over the same database name. PRODUCTION only: ticket 6 split the test-only helper out below",
  },
  {
    files: ["lib/store/test-authority.ts"],
    exempt: ["repository"],
    acquisition: [],
    properties: "base",
    why: "TICKET 6. A test-only helper (every one of its 35 consumers is a test file) that sits inside the durable boundary, so it keeps the repository exemption and gains the acquisition families",
  },
  {
    files: [
      "e2e/support/v2-seed.test.ts",
      "lib/ai/assistant/fence.test.ts",
      "lib/ai/assistant/writer-context.test.ts",
      // custom-AST ticket 3. The Phase-2 absence gate used to READ `lib/repository/schema.ts`
      // as text and match three table names against it -- a source scan that proved
      // something about the file's spelling. It now constructs the Dexie schema and
      // enumerates `db.tables`, which answers the actual question ("is there a roster
      // document for a repair tool to address?") and cannot pass vacuously. That import
      // crosses the repository boundary, so it is named here, one file, like every other
      // suite on this list.
      "lib/ai/phase-2-absence.test.ts",
      "lib/capability/commands.test.ts",
      "lib/store/authority.test.ts",
      "lib/store/optimize-basis-legacy.test.ts",
      "lib/store/optimize-basis-reaping.test.ts",
    ],
    exempt: ["repository", "assistant", "raw-copilotkit"],
    acquisition: [],
    properties: "base",
    why: "suites that legitimately open the database directly, named one by one. All test files, so they are in acquisition scope",
  },
  {
    files: [
      "lib/ai/assistant/clear-repo.ts",
      "lib/ai/assistant/db.ts",
      "lib/ai/assistant/fence.ts",
      "lib/ai/assistant/history-repo.ts",
      "lib/ai/assistant/records.ts",
      "lib/ai/assistant/settings-repo.ts",
      "lib/ai/assistant/writer-context.ts",
    ],
    exempt: ["repository", "assistant"],
    acquisition: null,
    properties: "ai",
    why: "the assistant modules that own their OWN tables and the write fence. PRODUCTION only: ticket 6 split `test-support.ts` out below",
  },
  {
    files: ["lib/ai/assistant/test-support.ts"],
    exempt: ["repository", "assistant"],
    acquisition: [],
    properties: "ai",
    why: "TICKET 6. The assistant's own test-only harness: it opens the assistant tables like its production siblings, and it is test/support code, so it gets both",
  },
  {
    files: ["lib/ai/runtime/copilotkit-runtime.ts"],
    exempt: ["assistant", "copilotkit-runtime"],
    acquisition: null,
    properties: "ai",
    why: "the ONE production entry to the runtime package; it crosses that boundary and no other",
  },
  {
    files: ["lib/ai/runtime/**/*.test.ts", "lib/ai/runtime/test-support.ts"],
    exempt: ["assistant", "raw-copilotkit", "copilotkit-runtime"],
    acquisition: [],
    properties: "base",
    why: "the suites that deliberately drive the locked package boundary, plus their shared harness",
  },
  {
    files: [
      "components/ai/assistant-stop-control.test.tsx",
      "components/ai/session-persistence.test.tsx",
      "components/ai/session-real-core.test.tsx",
      "components/ai/tool-loop.test.ts",
      "components/ai/visible-ownership.test.tsx",
    ],
    exempt: null,
    acquisition: null,
    properties: "off",
    why: "properties only: fixture tools that are deliberately not model-visible. Imports resolve through the general test override, acquisition families included",
  },
  {
    files: READER_EXCEPTIONS_FILESYSTEM,
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: ["filesystem"],
    properties: "base",
    why: "TICKET 6. The audited readers at ordinary-test boundary scope. Filesystem only: the parser family has no exception anywhere, and none of these builds a module loader",
  },
  {
    files: ["components/ai/assistant-styles.test.ts"],
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: ["filesystem", "module-loader"],
    properties: "base",
    why: "TICKET 6, corrected by the cold-review fixup. It resolves the installed CopilotKit stylesheet through the package's own `exports` map, so it needs both the reader and the resolver. RETAINED READS ARE: the locked `@copilotkit/react-core` package manifest and the stylesheet bytes that manifest points at, plus `app/globals.css`. It opens NO authored TS/TSX/MTS, imports no `readdirSync`, and holds no `production-source-text-read` ignore -- that rule has no exception anywhere. An earlier version of this file did read `app/layout.tsx` and was a declared deviation from ledger rule 2; those reads are deleted. `copilotkit-stylesheet-entry` now owns 'only one CSS entry' and the production-build browser suite owns 'the sheet is shipped and active'",
  },
  {
    files: ["lib/ai/runtime/deployment.test.ts", "lib/ai/runtime/registration-delegates.test.ts"],
    exempt: ["assistant", "raw-copilotkit", "copilotkit-runtime"],
    acquisition: ["filesystem"],
    properties: "base",
    why: "TICKET 6. Audited readers that are ALSO runtime-boundary suites: Compose/shell artefact contracts and the `.oxlintrc.json` delegate table. Filesystem only -- neither resolves a package",
  },
  {
    files: ["lib/ai/runtime/model-visible-tools.test.ts"],
    exempt: ["assistant", "raw-copilotkit", "copilotkit-runtime"],
    acquisition: ["module-loader"],
    properties: "base",
    why: "TICKET 6. A package-resolution exception and nothing more: it resolves `@copilotkit/*` entry points and never opens a file, so it gets the loader and NOT the filesystem",
  },
  {
    files: ["lib/ai/runtime/package-family.test.ts"],
    exempt: ["assistant", "raw-copilotkit", "copilotkit-runtime"],
    acquisition: ["filesystem", "module-loader"],
    properties: "base",
    why: "TICKET 6. The one suite that needs both: it resolves the locked `@copilotkit/runtime` manifest AND reads the root `package.json`",
  },
  {
    files: ["instrumentation.subprocess.test.ts"],
    exempt: null,
    acquisition: null,
    properties: "inherited",
    why: "vitest only: two deliberate visible skip markers. Its filesystem exception comes from the reader override above, which it is also listed in",
  },
  {
    files: READER_EXCEPTIONS_SUPPORT_FILESYSTEM,
    exempt: [],
    acquisition: ["filesystem"],
    properties: "base",
    why: "MAIN INTEGRATION. The audited readers at NON-TEST support scope: the Playwright abort-control reporter, the fail-closed authority-handoff producer, and the Ward YAML helper. `exempt: []` is the entire point -- it removes the filesystem family and NOTHING else, so all three keep the assistant, raw-CopilotKit and repository boundaries the support-tree override puts on them. It is LAST in the list because the support-tree override matches these three as well, and the later override is the one that wins",
  },
  {
    files: ["evals/**", "acquisition-fixtures/evals/**"],
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: [],
    properties: "base",
    why: "EVAL PIPELINE (2026-09-24). The live-model eval runner is a test OF the assistant, so it sits on the assistant seam like the assistant's own tests and may name CopilotKitProvider. Every acquisition family stays banned. Its helpers live in evals/lib, never evals/support, because the support-tree row keeps the assistant boundary closed",
  },
  {
    files: ["evals/eval-reporter.ts"],
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: ["filesystem"],
    properties: "base",
    why: "EVAL PIPELINE. The eval report writer. Ledger: API node:fs/promises readFile, writeFile, mkdir | root evals/runs/latest/ and evals/baseline.json | UTF-8 JSON and Markdown | write, no delete. It opens no .ts/.tsx. LAST, so it wins over the evals/** row above",
  },
];

/** Overrides that legitimately carry no `no-restricted-imports` config at all. */
const NO_IMPORTS_RULE = new Set([15, 21]);

// ---------------------------------------------------------------------------
// Invariant 1 -- the schema model and the base config
// ---------------------------------------------------------------------------

describe("the guard compares against the installed Oxlint schema, not a remembered one", () => {
  it("reads a closed field model for all three entry shapes", () => {
    // If Oxlint stops declaring these closed, the field list here stops being complete
    // and every comparison below silently narrows. `fieldModel` throws in that case; this
    // records what it found.
    expect(MODEL.path.fields).toEqual([
      "allowImportNames",
      "allowTypeImports",
      "importNames",
      "message",
      "name",
    ]);
    expect(MODEL.pattern.fields).toEqual([
      "allowImportNamePattern",
      "allowImportNames",
      "allowTypeImports",
      "caseSensitive",
      "group",
      "importNamePattern",
      "importNames",
      "message",
      "regex",
    ]);
    expect(MODEL.property.fields).toEqual([
      "allowObjects",
      "allowProperties",
      "message",
      "object",
      "property",
    ]);
  });

  it("canonicalizes injectively", () => {
    // The exact collision that defeated the previous version, asserted not to recur, plus
    // the equalities that must still hold.
    const split = normalize("pattern", { group: ["@/a", "@/b"] }).key;
    const joined = normalize("pattern", { group: ["@/a,@/b"] }).key;
    expect(split).not.toBe(joined);

    const widened = normalize("pattern", {
      group: ["@/a"],
      allowImportNames: ["escapeHatch"],
    }).key;
    expect(widened).not.toBe(normalize("pattern", { group: ["@/a"] }).key);

    // Order within a list, and an explicit `false` boolean, are not differences.
    expect(normalize("path", { name: "x", importNames: ["a", "b"] }).key).toBe(
      normalize("path", { name: "x", importNames: ["b", "a"] }).key,
    );
    expect(normalize("path", { name: "x", allowTypeImports: false }).key).toBe(
      normalize("path", { name: "x" }).key,
    );
    // Prose is not a boundary.
    expect(normalize("path", { name: "x", message: "one" }).key).toBe(
      normalize("path", { name: "x", message: "two" }).key,
    );
  });

  it("rejects an entry field the installed schema does not declare", () => {
    const violations: string[] = [];
    const inspect = (where: string, entries: KindedEntry[]): void => {
      for (const { kind, entry } of entries) {
        const { unknownFields } = normalize(kind, entry);
        for (const field of unknownFields) {
          violations.push(`${where}: unrecognised ${kind} field "${field}"`);
        }
      }
    };
    inspect("base", [
      ...importEntries(config.rules[IMPORTS_RULE]),
      ...propertyEntries(config.rules[PROPERTIES_RULE]),
    ]);
    config.overrides.forEach((override, index) => {
      inspect(`override ${index} (${override.files[0]})`, [
        ...importEntries(override.rules[IMPORTS_RULE]),
        ...propertyEntries(override.rules[PROPERTIES_RULE]),
      ]);
    });
    expect(violations).toEqual([]);
  });

  it("the base config is exactly the declared family union", () => {
    // The families are DERIVED from these literals, so nothing here recognises a family
    // in the config; the config is compared to the families. A base entry that is not
    // declared, or a declared entry that is not in the base, fails.
    const declared = ALL_FAMILIES.flatMap((family) => FAMILY_ENTRIES[family]);
    expect(new Set(keysOf(declared)).size, "a base entry is declared in two families").toBe(
      declared.length,
    );
    expect(
      diff("base imports", keysOf(declared), keysOf(importEntries(config.rules[IMPORTS_RULE]))),
    ).toEqual([]);
    expect(
      diff(
        "base properties",
        keysOf(BASE_PROPERTY_ENTRIES),
        keysOf(propertyEntries(config.rules[PROPERTIES_RULE])),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 -- severity, across every rule of every override
// ---------------------------------------------------------------------------

describe("every enforced rule is active wherever it is set", () => {
  it("the base config denies every enforced rule", () => {
    for (const rule of ENFORCED_RULES) {
      expect(severityOf(config.rules[rule]), rule).toBe("error");
    }
  });

  it("no override sets a rule outside the enforced set", () => {
    // Without this, an override could disable a rule this guard has never heard of, and
    // the loop below would have nothing to check.
    const violations: string[] = [];
    config.overrides.forEach((override, index) => {
      for (const rule of Object.keys(override.rules)) {
        if (!ENFORCED_RULES.includes(rule)) {
          violations.push(
            `override ${index} (${override.files[0]}): sets undeclared rule "${rule}"`,
          );
        }
      }
    });
    expect(violations).toEqual([]);
  });

  it("no override disables an enforced rule outside the two pinned exceptions", () => {
    // THE MUTATIONS THIS CATCHES. `["error", options]` -> `["off", options]` leaves every
    // entry in the JSON and disables the rule; adding `vitest/no-focused-tests: "off"` or
    // `import/no-cycle: "off"` beside a legitimate exception disables a targeted rule at
    // that path. Severity is read for EVERY enforced rule of EVERY override, never only
    // for the two restriction rules and never only in the base.
    const violations: string[] = [];
    config.overrides.forEach((override, index) => {
      for (const rule of ENFORCED_RULES) {
        const value = override.rules[rule];
        if (value === undefined) continue;
        const severity = severityOf(value);
        if (severity === "error") continue;
        const pinned = PINNED_OFF.some((entry) => entry.index === index && entry.rule === rule);
        if (pinned && severity === "off") continue;
        violations.push(
          `override ${index} (${override.files[0]}): "${rule}" is "${severity}", not "error"`,
        );
      }
    });
    expect(violations).toEqual([]);
  });

  it("each pinned exception exists, exactly once, at its own override", () => {
    // Both directions: an exception that quietly moved or was duplicated is a widening;
    // one that disappeared means a documented allowance is silently being enforced.
    for (const pinned of PINNED_OFF) {
      const holders = config.overrides
        .map((override, index) => ({ index, severity: severityOf(override.rules[pinned.rule]) }))
        .filter(({ severity }) => severity === "off")
        .map(({ index }) => index);
      expect(holders, `"${pinned.rule}" off at the wrong overrides`).toEqual([pinned.index]);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 -- per-override exact contract
// ---------------------------------------------------------------------------

describe("every override carries the exact base entries minus its declared exemptions", () => {
  it("the override list matches the declared contract, in order", () => {
    expect(config.overrides.length).toBe(OVERRIDES.length);
    const violations: string[] = [];
    config.overrides.forEach((override, index) => {
      const expectedFiles = OVERRIDES[index]?.files;
      if (expectedFiles === undefined) {
        violations.push(`override ${index} is not declared in this guard`);
        return;
      }
      if (JSON.stringify(override.files) !== JSON.stringify(expectedFiles)) {
        violations.push(
          `override ${index}: files are ${JSON.stringify(override.files)}, declared ${JSON.stringify(expectedFiles)}`,
        );
      }
    });
    expect(violations).toEqual([]);
  });

  it("no override's import entries differ from the base minus its exemptions", () => {
    const violations: string[] = [];
    config.overrides.forEach((override, index) => {
      const contract = OVERRIDES[index];
      if (!contract) return;
      const rule = override.rules[IMPORTS_RULE];
      if (rule === undefined) {
        if (!NO_IMPORTS_RULE.has(index) || contract.exempt !== null) {
          violations.push(`override ${index} (${override.files[0]}): no "${IMPORTS_RULE}" config`);
        }
        return;
      }
      if (contract.exempt === null) {
        violations.push(
          `override ${index} (${override.files[0]}): declares no import contract but sets one`,
        );
        return;
      }
      violations.push(
        ...diff(
          `override ${index} (${override.files[0]})`,
          expectedImportKeys(
            contract.exempt,
            contract.typeOnlyAssistant === true,
            contract.acquisition,
          ),
          keysOf(importEntries(rule)),
        ),
      );
    });
    expect(violations).toEqual([]);
  });

  it("no override's property entries differ from its declared contract", () => {
    const violations: string[] = [];
    config.overrides.forEach((override, index) => {
      const contract = OVERRIDES[index];
      if (!contract) return;
      const rule = override.rules[PROPERTIES_RULE];
      if (contract.properties === "inherited") {
        if (rule !== undefined) {
          violations.push(`override ${index}: declares no property contract but sets one`);
        }
        return;
      }
      if (rule === undefined) {
        violations.push(`override ${index} (${override.files[0]}): no "${PROPERTIES_RULE}" config`);
        return;
      }
      violations.push(
        ...diff(
          `override ${index} (${override.files[0]}) properties`,
          expectedPropertyKeys(contract.properties),
          keysOf(propertyEntries(rule)),
        ),
      );
    });
    expect(violations).toEqual([]);
  });

  it("the type-only assistant rewrite exists in exactly one override", () => {
    const typeOnlyKeys = keysOf(ASSISTANT_TYPE_ONLY);
    const rewriting = config.overrides
      .map((override, index) => ({
        index,
        keys: keysOf(importEntries(override.rules[IMPORTS_RULE])),
      }))
      .filter(({ keys }) => typeOnlyKeys.some((key) => keys.includes(key)))
      .map(({ index }) => index);
    // Two overrides now, not one: ticket 6 split `lib/repository/**` into its production and
    // test halves so the acquisition families could reach the tests without reaching
    // production, and BOTH halves are inside the durable boundary, so both carry the rewrite.
    expect(rewriting).toEqual([6, 7]);
  });
});

// ---------------------------------------------------------------------------
// Invariant 3b -- the acquisition families are ADDITIVE, never global
// ---------------------------------------------------------------------------

describe("the acquisition boundary stops at test/support scope", () => {
  it("no acquisition family appears in the BASE config", () => {
    // THE SCOPE CLAIM, asserted rather than described. If one of these reached the base it
    // would restrict `node:fs` in production too -- including `scripts/start-standalone.mjs`,
    // which the governing spec says to REPORT as production tooling rather than carry as an
    // exception. That widening would look like a stricter repository and would in fact be an
    // undeclared policy change.
    const baseKeys = keysOf(importEntries(config.rules[IMPORTS_RULE]));
    const leaked: string[] = [];
    for (const family of ALL_ACQUISITION) {
      for (const key of keysOf(ACQUISITION_ENTRIES[family])) {
        if (baseKeys.includes(key)) leaked.push(`${family} is in the base config`);
      }
    }
    expect(leaked).toEqual([]);
  });

  it("every acquisition family is actually enforced somewhere", () => {
    // The other direction: a family declared here but present in no override at all would be
    // a restriction this guard describes and nothing applies.
    const enforcing = new Map<string, number[]>();
    config.overrides.forEach((override, index) => {
      const keys = keysOf(importEntries(override.rules[IMPORTS_RULE]));
      for (const family of ALL_ACQUISITION) {
        if (keysOf(ACQUISITION_ENTRIES[family]).every((key) => keys.includes(key))) {
          enforcing.set(family, [...(enforcing.get(family) ?? []), index]);
        }
      }
    });
    for (const family of ALL_ACQUISITION) {
      expect(enforcing.get(family)?.length ?? 0, `${family} is enforced nowhere`).toBeGreaterThan(
        0,
      );
    }
    // And the parser family has NO exception anywhere: it must be present in every override
    // that is in acquisition scope at all, which is every override whose contract is not null.
    const inScope = OVERRIDES.map((contract, index) => ({ contract, index }))
      .filter(({ contract }) => contract.acquisition !== null)
      .map(({ index }) => index);
    expect(enforcing.get("parser-library")).toEqual(inScope);
  });
});

// ---------------------------------------------------------------------------
// Invariant 4 -- per-path effective config, over every match-set class in the tree
// ---------------------------------------------------------------------------

interface GovernedPath {
  path: string;
  exempt: Family[];
  typeOnlyAssistant?: boolean;
  acquisition: AcquisitionFamily[] | null;
  properties: "base" | "ai" | "off";
  /** Enforced rules that legitimately resolve to `off` at this class. */
  offRules?: string[];
  note: string;
}

// TICKET 6 REBUILT THIS TABLE. The config went from 11 overrides to 21 and the tree from 15
// match-set classes to 29, so every row was re-derived rather than amended -- and the two rows
// that matter most for this ticket's claim are the FIRST and the LAST: ordinary production code
// must have `acquisition: null` (the policy does not reach it) and the audited readers must have
// exactly the family they were granted and no more.
const GOVERNED: GovernedPath[] = [
  {
    path: "lib/optimize/use-optimize-run.ts",
    exempt: [],
    acquisition: null,
    properties: "base",
    note: "class {} -- ordinary scheduling code: every boundary applies, and NO acquisition restriction, because this policy is scoped to test/support code",
  },
  {
    path: "app/layout.tsx",
    exempt: ["copilotkit-stylesheet-entry"],
    acquisition: null,
    properties: "base",
    note: "class {0} -- FIXUP. The ONE production CSS entry for the CopilotKit v2 stylesheet, and the only path exempt from that family. It is not test/support code, so it carries no acquisition restriction; every other boundary still applies to it",
  },
  {
    path: "scripts/start-standalone.mjs",
    exempt: [],
    acquisition: null,
    properties: "base",
    note: "class {} -- THE SCOPE-BOUNDARY CASE. Production serve tooling that legitimately uses cpSync/existsSync/rmSync over .next build output. The governing spec says report it, not except it: it is unrestricted because it is not test/support code, so there is no exception here to go stale",
  },
  {
    path: "components/entity-editor/groups-section.tsx",
    exempt: [],
    acquisition: null,
    properties: "base",
    note: "class {} -- the kept substrate: the retired-shell restriction still applies to it",
  },
  {
    path: "app/api/health/route.test.ts",
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: [],
    properties: "base",
    note: "class {4} -- an ordinary test, nothing AI-owned about it. 203 files: the acquisition families apply here with no exception, which is the default this whole policy is",
  },
  {
    path: "components/ai/assistant-bridge-facts.test.tsx",
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: [],
    properties: "base",
    note: "class {1,4} -- a plain AI-owned test. The general test override must win over the AI-owner override, or these 48 files lose the raw-CopilotKit allowance and gain the AI property contract",
  },
  {
    path: "app/(app)/settings/page.tsx",
    exempt: ["assistant"],
    acquisition: null,
    properties: "ai",
    note: "class {1} -- an AI mount point",
  },
  {
    path: "components/ai/assistant-copilot-provider.tsx",
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: null,
    properties: "ai",
    note: "class {1,5} -- one of the three canonical boundary modules",
  },
  {
    path: "lib/repository/commands.ts",
    exempt: ["repository"],
    typeOnlyAssistant: true,
    acquisition: null,
    properties: "base",
    note: "class {6} -- inside the durable boundary; the assistant family survives TYPE-ONLY. Production, so no acquisition restriction",
  },
  {
    path: "lib/repository/assistant-apply.test.ts",
    exempt: ["repository"],
    typeOnlyAssistant: true,
    acquisition: [],
    properties: "base",
    note: "class {4,6,7} -- a repository TEST. The repository override must win over the general test override, and ticket 6's test-half override must then win over BOTH, or these 7 files keep the durable exemption and silently lose the acquisition families",
  },
  {
    path: "lib/repository/test-support.ts",
    exempt: ["repository"],
    typeOnlyAssistant: true,
    acquisition: [],
    properties: "base",
    note: "class {2,6,7} -- the repository's test-only harness, reached through the support-tree glob rather than a test filename",
  },
  {
    path: "lib/store/authority.ts",
    exempt: ["repository"],
    acquisition: null,
    properties: "base",
    note: "class {8} -- THE ROUND-1 P1 CASE. The projection adapter crosses the repository boundary and nothing else",
  },
  {
    path: "lib/store/test-authority.ts",
    exempt: ["repository"],
    acquisition: [],
    properties: "base",
    note: "class {2,9} -- ticket 6 split this test-only helper out of the store override so it could gain the acquisition families without them reaching authority/ownership/spine",
  },
  {
    path: "e2e/support/v2-seed.test.ts",
    exempt: ["repository", "assistant", "raw-copilotkit"],
    acquisition: [],
    properties: "base",
    note: "class {2,4,10} -- a suite admitted to the database directly",
  },
  {
    path: "e2e/support/v2-visual-audit.ts",
    exempt: [],
    acquisition: [],
    properties: "base",
    note: "class {2} -- THE NON-WIDENING CASE. An e2e support helper that is NOT a test file: it gains the acquisition families and keeps every global boundary, including the assistant one. Had ticket 6 widened the test override's globs to `e2e/**` instead of adding a separate override, these 7 helpers would have silently gained the assistant and raw-CopilotKit exemptions",
  },
  {
    path: "e2e/affinities.spec.ts",
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: [],
    properties: "base",
    note: "class {2,4} -- an ordinary Playwright spec: matched by the support tree AND the test globs, and the test override must win",
  },
  {
    path: "e2e/optimize-visual.spec.ts",
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: ["filesystem"],
    properties: "base",
    note: "class {2,4,16} -- an audited reader inside e2e: design-prototype .html artefacts only",
  },
  {
    path: "components/ai/turn-authority.test-support.ts",
    exempt: ["assistant"],
    acquisition: [],
    properties: "ai",
    note: "class {1,2,3} -- an assistant-owned test-only helper. Without ticket 6's dedicated override the support-tree override would have closed the assistant boundary on a module that is inside it",
  },
  {
    path: "lib/ai/assistant/test-support.ts",
    exempt: ["repository", "assistant"],
    acquisition: [],
    properties: "ai",
    note: "class {1,2,12} -- the assistant's harness: it opens the assistant tables like its production siblings AND is test/support code",
  },
  {
    path: "lib/ai/runtime/test-support.ts",
    exempt: ["assistant", "raw-copilotkit", "copilotkit-runtime"],
    acquisition: [],
    properties: "base",
    note: "class {1,2,14} -- the runtime suites' shared harness, on the locked package boundary",
  },
  {
    path: "lib/ai/assistant/fence.test.ts",
    exempt: ["repository", "assistant", "raw-copilotkit"],
    acquisition: [],
    properties: "base",
    note: "class {1,4,10} -- AI-owned, a test, and admitted to the database",
  },
  {
    path: "lib/store/authority.test.ts",
    exempt: ["repository", "assistant", "raw-copilotkit"],
    acquisition: [],
    properties: "base",
    note: "class {4,10} -- a database suite outside the AI tree",
  },
  {
    path: "lib/ai/assistant/clear-repo.ts",
    exempt: ["repository", "assistant"],
    acquisition: null,
    properties: "ai",
    note: "class {1,11} -- an assistant module that owns its own tables. Production: no acquisition restriction",
  },
  {
    path: "lib/ai/runtime/copilotkit-runtime.ts",
    exempt: ["assistant", "copilotkit-runtime"],
    acquisition: null,
    properties: "ai",
    note: "class {1,13} -- THE OTHER ROUND-1 P1 CASE. The single runtime entry crosses one boundary; repository, retired shell, persist/zundo and the raw client all still apply",
  },
  {
    path: "lib/ai/runtime/containment.test.ts",
    exempt: ["assistant", "raw-copilotkit", "copilotkit-runtime"],
    acquisition: [],
    properties: "base",
    note: "class {1,4,14} -- a suite that drives the locked package boundary",
  },
  {
    path: "lib/ai/runtime/deployment.test.ts",
    exempt: ["assistant", "raw-copilotkit", "copilotkit-runtime"],
    acquisition: ["filesystem"],
    properties: "base",
    note: "class {1,4,14,18} -- an audited reader that is also a runtime-boundary suite: Compose YAML and the deploy script. Filesystem only -- it resolves no package",
  },
  {
    path: "lib/ai/runtime/model-visible-tools.test.ts",
    exempt: ["assistant", "raw-copilotkit", "copilotkit-runtime"],
    acquisition: ["module-loader"],
    properties: "base",
    note: "class {1,4,14,19} -- THE EXACTNESS CASE. A package-resolution exception that gets the loader and NOT the filesystem, because it never opens a file. Granting it both would be a widening no reader asked for",
  },
  {
    path: "lib/ai/runtime/package-family.test.ts",
    exempt: ["assistant", "raw-copilotkit", "copilotkit-runtime"],
    acquisition: ["filesystem", "module-loader"],
    properties: "base",
    note: "class {1,4,14,20} -- the one suite that genuinely needs both: it resolves the locked runtime manifest and reads the root package.json",
  },
  {
    path: "components/ai/assistant-styles.test.ts",
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: ["filesystem", "module-loader"],
    properties: "base",
    note: "class {1,4,17} -- the assistant-UI CSS suite. It needs both families because it resolves a package entry point (loader) and then reads the bytes it points at (filesystem), alongside app/globals.css. It reads no authored TS/TSX and holds no source-read ignore; `production-source-text-read` has no exception anywhere in the repository",
  },
  {
    path: "components/ai/assistant-stop-control.test.tsx",
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: [],
    properties: "off",
    offRules: [PROPERTIES_RULE],
    note: "class {1,4,15} -- a fixture-tool suite: imports resolve through the test override (acquisition families included), properties are switched off",
  },
  {
    path: "app/design-system.test.ts",
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: ["filesystem"],
    properties: "base",
    note: "class {4,16} -- the audited-reader class at ordinary-test scope, 18 files: an exact filesystem allowance and nothing else. The parser family still applies, which is the point of granting families rather than switching the rule off. It was 16 until the main integration granted four more; two of those four are also support-tree files, so they land in {2,4,16} with `e2e/optimize-visual.spec.ts` rather than here",
  },
  {
    path: "e2e/support/abort-handoff.ts",
    exempt: [],
    acquisition: ["filesystem"],
    properties: "base",
    note: "class {2,22} -- MAIN INTEGRATION, and the non-widening case a second time, now for a GRANTED reader. A support helper that is not a test file: it gains its exact filesystem allowance, and the assistant, raw-CopilotKit and repository boundaries all stay closed over it. Had these three been appended to the ordinary reader array instead of getting their own override, this row would read exempt: [assistant, raw-copilotkit] and the reason would be a fixture read, which is no reason at all to open the AI boundary. All 3 files in the class are the granted support readers, so nothing else rides along",
  },
  {
    path: "instrumentation.subprocess.test.ts",
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: ["filesystem"],
    properties: "base",
    offRules: ["vitest/no-disabled-tests"],
    note: "class {4,16,21} -- the vitest skip-marker exemption AND an audited reader. Its imports come from override 15 and its vitest allowance from override 20; EVERY other targeted rule must still be active here",
  },
  {
    path: "evals/lib/reliability.ts",
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: [],
    properties: "base",
    note: "class {23} -- EVAL PIPELINE. Production-shaped eval helper code, matched only by the new evals/** override: the acquisition families apply with no exception, same as any other test/support code",
  },
  {
    path: "evals/lib/reliability.test.ts",
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: [],
    properties: "base",
    note: "class {4,23} -- EVAL PIPELINE. An ordinary test file inside evals/, matched by both the general test override and the evals/** override; the two agree so which one wins does not change the effective config",
  },
  {
    path: "evals/eval-reporter.ts",
    exempt: ["assistant", "raw-copilotkit"],
    acquisition: ["filesystem"],
    properties: "base",
    note: "class {23,24} -- EVAL PIPELINE. The ledgered report writer: the evals/** override matches it, and the later row-B override wins, removing the filesystem family and nothing else",
  },
];

function effective(path: string, rule: string): RuleValue | undefined {
  let value = config.rules[rule];
  for (const override of config.overrides) {
    if (!override.files.some((glob) => matchesGlob(path, glob))) continue;
    const candidate = override.rules[rule];
    if (candidate !== undefined) value = candidate;
  }
  return value;
}

function matchSet(path: string): string {
  return config.overrides
    .map((override, index) => (override.files.some((glob) => matchesGlob(path, glob)) ? index : -1))
    .filter((index) => index >= 0)
    .join(",");
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * `acquisition-prevention.test.ts` materialises bypass fixtures into this directory, runs the
 * real lint command against them and removes them. Vitest runs test files in PARALLEL, so
 * those fixtures can exist on disk while this guard is walking the tree -- and they are not
 * source. One of them lives in a `support/` subdirectory precisely to prove that scope class,
 * which made it a match-set class this table had no representative for.
 *
 * Skipped by NAME rather than by ignore-pattern, because Oxlint must still lint it: that is the
 * whole point of the fixtures.
 */
const TRANSIENT_FIXTURE_DIR = "acquisition-fixtures";

function walk(dir: string, skip: Set<string>, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || skip.has(entry) || entry === TRANSIENT_FIXTURE_DIR) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, skip, out);
    else if (SOURCE_EXTENSIONS.test(entry)) out.push(full);
  }
  return out;
}

const WEB_ROOT = new URL(".", import.meta.url).pathname;
const ALL_SOURCES = walk(WEB_ROOT, new Set(config.ignorePatterns)).map((file) =>
  file.slice(WEB_ROOT.length),
);

describe("the effective config at every match-set class is exactly what it should be", () => {
  it("finds the tree it is classifying", () => {
    expect(ALL_SOURCES.length).toBeGreaterThan(500);
    expect(ALL_SOURCES).toContain("lib/store/authority.ts");
    expect(ALL_SOURCES).toContain("components/ai/assistant-bridge-facts.test.tsx");
  });

  it("every match-set class in the tree has a representative in the table", () => {
    const populations = new Map<string, string[]>();
    for (const file of ALL_SOURCES) {
      const key = matchSet(file);
      const bucket = populations.get(key);
      if (bucket) bucket.push(file);
      else populations.set(key, [file]);
    }
    const represented = new Set(GOVERNED.map((governed) => matchSet(governed.path)));
    expect(
      [...populations.entries()]
        .filter(([key]) => !represented.has(key))
        .map(([key, files]) => `class {${key}} has ${files.length} files, e.g. ${files[0]}`),
    ).toEqual([]);
    // And nothing in the table names a class that no file is in, which would be a stale
    // row quietly proving nothing.
    expect([...represented].filter((key) => !populations.has(key))).toEqual([]);
  });

  it("no class resolves to the wrong import entries", () => {
    const violations: string[] = [];
    for (const governed of GOVERNED) {
      const rule = effective(governed.path, IMPORTS_RULE);
      const where = `${governed.path} {${matchSet(governed.path)}}`;
      if (severityOf(rule) !== "error") {
        violations.push(`${where}: "${IMPORTS_RULE}" resolves to "${severityOf(rule)}"`);
        continue;
      }
      violations.push(
        ...diff(
          where,
          expectedImportKeys(
            governed.exempt,
            governed.typeOnlyAssistant === true,
            governed.acquisition,
          ),
          keysOf(importEntries(rule)),
        ),
      );
    }
    expect(violations).toEqual([]);
  });

  it("no class resolves to the wrong property entries", () => {
    const violations: string[] = [];
    for (const governed of GOVERNED) {
      const rule = effective(governed.path, PROPERTIES_RULE);
      const where = `${governed.path} {${matchSet(governed.path)}} properties`;
      const severity = severityOf(rule);
      if (governed.properties === "off") {
        if (severity !== "off") violations.push(`${where}: expected "off", got "${severity}"`);
        continue;
      }
      if (severity !== "error") {
        violations.push(`${where}: resolves to "${severity}"`);
        continue;
      }
      violations.push(
        ...diff(where, expectedPropertyKeys(governed.properties), keysOf(propertyEntries(rule))),
      );
    }
    expect(violations).toEqual([]);
  });

  it("every targeted rule resolves to error at every class, bar the declared exceptions", () => {
    // The other half of the severity story. The per-override check says no override
    // disables a rule; this says no PATH ends up with one disabled, which is the question
    // a reviewer actually has. The two are not the same claim once several overrides can
    // match one file.
    const violations: string[] = [];
    for (const governed of GOVERNED) {
      const where = `${governed.path} {${matchSet(governed.path)}}`;
      for (const rule of ENFORCED_RULES) {
        const severity = severityOf(effective(governed.path, rule));
        const expectedOff = (governed.offRules ?? []).includes(rule);
        if (expectedOff) {
          if (severity !== "off")
            violations.push(`${where}: "${rule}" expected "off", got "${severity}"`);
          continue;
        }
        if (severity !== "error") violations.push(`${where}: "${rule}" resolves to "${severity}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("is not vacuous: every family is enforced somewhere and exempted only where declared", () => {
    for (const family of ALL_FAMILIES) {
      expect(
        GOVERNED.some((governed) => !governed.exempt.includes(family)),
        `"${family}" is enforced at no governed class`,
      ).toBe(true);
    }
    for (const family of [
      "raw-copilotkit",
      "copilotkit-runtime",
      "repository",
      "assistant",
    ] as const) {
      expect(
        GOVERNED.some((governed) => governed.exempt.includes(family)),
        `"${family}" is never exempt at any governed class`,
      ).toBe(true);
    }
    // The families with NO legitimate crossing anywhere.
    for (const family of ["retired-undo", "retired-shell", "retired-icon-library"] as const) {
      expect(
        GOVERNED.filter((governed) => governed.exempt.includes(family)).map((g) => g.path),
        `"${family}" must apply at every governed class`,
      ).toEqual([]);
    }
  });
});
