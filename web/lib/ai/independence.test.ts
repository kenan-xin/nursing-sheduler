import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// AI INDEPENDENCE, as a source-level property rather than a hope.
//
// The product promise is that AI is optional: with the feature off, no key stored,
// or OpenRouter unreachable, every manual workflow and ordinary Optimize keeps
// working. A functional test can only ever sample that; what actually guarantees it
// is that no scheduling code DEPENDS on assistant code.
//
// So the assistant's modules may be imported from exactly three places: itself, its
// own UI, and the two shell surfaces that mount it -- both of which render nothing
// while the assistant is not Ready. Anything else importing them would create a path
// by which a broken or disabled assistant could break scheduling, which is the
// failure this test exists to prevent.

const webRoot = join(__dirname, "..", "..");

/** Directories that legitimately own or mount the assistant. */
const OWNERS = ["lib/ai/", "components/ai/", "components/settings/"];

/**
 * The files outside those directories that may reference assistant modules, each for
 * a stated reason. A new entry here is a deliberate widening of the seam, which is
 * the point of listing them rather than pattern-matching them away.
 */
const PERMITTED_REFERENCES: Record<string, string> = {
  // Both render null until AI is Ready.
  "components/shell/app-shell.tsx": "mounts the panel",
  "components/shell/top-bar.tsx": "mounts the launcher",
  // The Settings route host.
  "app/(app)/settings/page.tsx": "hosts the settings card",
  // The same-origin runtime and setup routes (T01/T04).
  "app/api/copilotkit/[[...slug]]/route.ts": "mounts the CopilotKit runtime",
  "app/api/ai/openrouter/models/route.ts": "the model catalog route",
  "app/api/ai/openrouter/test/route.ts": "the credential probe route",
  // Applies the runtime containment env at server start (T01).
  "instrumentation-node.ts": "applies the runtime containment env at boot",
  // TYPE-ONLY, and asserted as such below: the Dexie schema declares the assistant
  // tables, so it needs their row shapes at compile time and nothing at runtime.
  "lib/repository/schema.ts": "declares the assistant tables (type-only)",
};

const SKIP_DIRS = new Set(["node_modules", ".next", "public", "test-results", "playwright-report"]);

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const sources = walk(webRoot).map((file) => ({
  path: relative(webRoot, file).replaceAll("\\", "/"),
  text: readFileSync(file, "utf8"),
}));

describe("the assistant is a leaf, not a dependency", () => {
  it("finds the sources it is guarding", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((s) => s.path === "lib/ai/assistant/store.ts")).toBe(true);
  });

  it("is referenced only by itself, its UI, and an explicit list of mount points", () => {
    const offenders = sources
      .filter(({ path }) => !/\.(test|spec)\.tsx?$/.test(path))
      .filter(({ path }) => !OWNERS.some((owner) => path.startsWith(owner)))
      .filter(({ path }) => PERMITTED_REFERENCES[path] === undefined)
      .filter(({ text }) => /"@\/(lib\/ai|components\/ai)\//.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("lets the Dexie schema know the assistant's row shapes WITHOUT a runtime edge", () => {
    const schema = sources.find(({ path }) => path === "lib/repository/schema.ts");
    expect(schema).toBeDefined();

    const imports = (schema?.text ?? "").split("\n").filter((line) => line.includes("@/lib/ai/"));
    expect(imports.length).toBeGreaterThan(0);
    // `import type` is erased by the compiler, so the scenario repository carries no
    // runtime dependency on assistant code -- which is what keeps a broken or
    // disabled assistant from being able to break the durable store.
    for (const line of imports) {
      expect(line, `${line} is not type-only`).toMatch(/^import type|^} from|^\s*\w/);
    }
    expect(schema?.text).toContain("import type {");
  });

  it("keeps assistant modules out of the scheduling and optimize surfaces entirely", () => {
    const schedulingDirs = [
      "lib/store/",
      "lib/scenario/",
      "lib/optimize/",
      "lib/bff/",
      "lib/cascade/",
      "lib/rules/",
      "components/optimize/",
    ];

    const offenders = sources
      .filter(({ path }) => schedulingDirs.some((dir) => path.startsWith(dir)))
      .filter(({ text }) => /@\/(lib\/ai|components\/ai)\//.test(text))
      .map(({ path }) => path);

    // The dependency runs the other way ONLY: the assistant reads the scenario
    // authority, never the reverse.
    expect(offenders).toEqual([]);
  });

  // The counterpart to the assistant's entry in `authority-boundary.test.ts`'s
  // repository allow-list. That gate admits the assistant into the repository's
  // module graph; these two rules are what make the admission narrow, by pinning
  // exactly what the assistant is allowed to do once inside it.
  it("writes only assistant tables -- never a scenario-authority table", () => {
    // AUTHORSHIP is forbidden everywhere on this list: the assistant may never create
    // or modify a row in any of these tables. A read is fine and necessary (the lease
    // and the envelope).
    const scenarioTables = [
      "scenarioEnvelopes",
      "scenarioCommits",
      "historyLinks",
      "tabSelections",
      "writerLeases",
      "assistantProposals",
      "assistantReceipts",
      "optimizeBases",
    ];

    // DELETION is forbidden only for the scenario authority's OWN records. The two
    // assistant-owned tables are excluded because the retention contract requires the
    // clear paths to remove them: "delete local messages, tool displays, receipts, and
    // diagnostic UI state after detachment". Deleting an AI record the user asked to
    // have deleted is the opposite of authoring scenario state, and no scenario,
    // commit, lease or history row is reachable this way.
    const undeletableTables = scenarioTables.filter(
      (table) => table !== "assistantProposals" && table !== "assistantReceipts",
    );

    const offenders: string[] = [];
    for (const { path, text } of sources) {
      if (!path.startsWith("lib/ai/") && !path.startsWith("components/ai/")) continue;
      if (/\.(test|spec)\.tsx?$/.test(path)) continue;
      for (const table of scenarioTables) {
        if (new RegExp(`\\.${table}\\.(put|add|update|bulk\\w+)\\b`).test(text)) {
          offenders.push(`${path} writes ${table}`);
        }
      }
      for (const table of undeletableTables) {
        if (new RegExp(`\\.${table}\\.(delete|clear)\\b`).test(text)) {
          offenders.push(`${path} deletes ${table}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("holds no scenario commit path of its own", () => {
    const offenders = sources
      .filter(({ path }) => path.startsWith("lib/ai/") || path.startsWith("components/ai/"))
      .filter(({ path }) => !/\.(test|spec)\.tsx?$/.test(path))
      .filter(({ text }) =>
        /createScenarioRepository|commitAssistantProposal|scenarioCommands\.(mutate|setReqData|undo|redo)/.test(
          text,
        ),
      )
      .map(({ path }) => path);

    // T07 gave the assistant a durable path, and this rule is what keeps it NARROW.
    // The generic mutation primitives -- an arbitrary patch, a whole-matrix write,
    // a bare Undo/Redo -- stay unreachable from assistant code, as does the Apply
    // transaction itself. What the assistant may name instead is
    // `assistantProposalCommands`, whose every member is a typed, host-validated,
    // fenced operation (see the rule below).
    expect(offenders).toEqual([]);
  });

  it("reaches durable state only through the named assistant proposal commands", () => {
    // The positive half of the rule above. Preparing, confirming, applying, undoing
    // and reading a proposal all go through the projection adapter's serial queue and
    // its fences; nothing in the assistant opens a Dexie transaction on a scenario
    // table or derives its own commit.
    const permitted = new Set([
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
    ]);

    const offenders: string[] = [];
    for (const { path, text } of sources) {
      if (!path.startsWith("lib/ai/") && !path.startsWith("components/ai/")) continue;
      if (/\.(test|spec)\.tsx?$/.test(path)) continue;
      for (const [, member] of text.matchAll(/assistantProposalCommands\.(\w+)/g)) {
        if (!permitted.has(member)) offenders.push(`${path} calls ${member}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("registers no tool that could apply a change", () => {
    // Apply is a HOST action on a rendered card. A tool named for it -- however it
    // were implemented -- would let the model announce that it can make the change
    // itself, which is the one thing the whole Preview contract exists to prevent.
    const toolNames = sources
      .filter(({ path }) => path.startsWith("components/ai/") || path.startsWith("lib/ai/"))
      .filter(({ path }) => !/\.(test|spec)\.tsx?$/.test(path))
      .flatMap(({ text }) => [...text.matchAll(/name:\s*"([a-z_]+)"/g)].map((match) => match[1]));

    const applyish = toolNames.filter((name) => /apply|commit|save|write|undo|delete/.test(name));
    expect(applyish).toEqual([]);
    // The one write-adjacent tool there IS prepares a proposal and nothing else.
    expect(toolNames).toContain("prepare_scenario_change");
  });

  it("reaches OpenRouter from exactly one place -- the same-origin server modules", () => {
    const offenders = sources
      .filter(({ path }) => !/\.(test|spec)\.tsx?$/.test(path))
      .filter(({ text }) => text.includes("openrouter.ai"))
      .map(({ path }) => path);

    // The host appears as a literal in exactly two places -- the browser-safe
    // protocol module and the runtime's own containment constants, which
    // `protocol.test.ts` pins to each other. Every caller reads it from there, so no
    // component or route can name a third-party host directly.
    expect(offenders.sort()).toEqual(["lib/ai/protocol.ts", "lib/ai/runtime/containment.ts"]);
  });
});
