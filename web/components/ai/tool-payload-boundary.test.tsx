// @vitest-environment jsdom
//
// EVERY MODEL-VISIBLE TOOL PAYLOAD, THROUGH THE REAL PUBLIC COPILOTKIT CORE.
//
// Not by calling the handlers as typed functions -- that is the very assumption under
// test. `CopilotKitCore` receives a tool call, runs `parseToolArguments` (`JSON.parse`
// plus an object check), and calls the handler with that raw object. It never executes
// the registered Zod schema and never applies its defaults. So the only honest fixture
// drives a REAL core with a REAL scripted transport emitting real `TOOL_CALL_*` events,
// registers the shipped tools through the REAL `useFrontendTool`, and reads what the
// core put in the tool-result message.
//
// THE FOUR LIVE REPRODUCTIONS this suite pins, from the F1y closure review:
//   * `test_feasibility_candidates` -- a legal omission of `compare` arrived as
//     `undefined` and was copied into the search record's required boolean;
//   * `test_feasibility_candidates` -- `{ candidates: 42 }` threw from `.map()`;
//   * `suggest_scheduling_rule` -- `{ policy: 42 }` threw `text.toLowerCase is not a
//     function` out of `guidance.ts`;
//   * `get_schedule_section` -- a missing or wrong-typed `domain` fell through an
//     exhaustive switch and returned an EMPTY tool result, which reads as success.
//
// The malformed cases iterate `MODEL_VISIBLE_TOOL_SCHEMAS` rather than a local list, so
// a newly registered parameterized tool is covered the moment it joins the registry --
// and `model-visible-tools.test.ts` is what keeps that registry source-complete.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { Observable } from "rxjs";
import {
  AbstractAgent,
  CopilotKitProvider,
  useCopilotKit,
  type CopilotKitCore,
  type BaseEvent,
  type RunAgentInput,
} from "@copilotkit/react-core/v2";

const navigated: string[] = [];
vi.mock("next/navigation", () => ({
  usePathname: () => "/shift-requests",
  useRouter: () => ({
    push: (path: string) => navigated.push(path),
    replace: (path: string) => navigated.push(path),
  }),
}));

/**
 * The core the real provider builds, captured from inside it.
 *
 * NOTHING ABOUT COPILOTKIT IS STUBBED HERE -- not the provider, not `useCopilotKit`, not
 * `useFrontendTool`, not the tool-call path. That matters: the defect under test lives in
 * the core's own argument handling, so a fixture that replaced any part of it would be
 * testing the replacement.
 */
const realCore = { current: null as CopilotKitCore | null };

/** Captures what the diagnostic handler actually forwards, without running a solver. */
const diagnosticRuntime = vi.hoisted(() => ({
  inputs: [] as { compare: unknown; proposed: unknown }[],
}));
vi.mock("@/lib/ai/diagnostic/diagnostic-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/diagnostic/diagnostic-runtime")>();
  return {
    ...actual,
    runDiagnosticSearchForTurn: async (input: { compare: unknown; proposed: unknown }) => {
      diagnosticRuntime.inputs.push({ compare: input.compare, proposed: input.proposed });
      // A settled search with nothing to preview: enough for the handler to answer, and
      // it keeps this suite about the payload boundary rather than about the solver.
      return { search: SETTLED_SEARCH, previewCandidate: null };
    },
  };
});

/**
 * COUNTERS FOR THE THREE READS A MALFORMED CALL MUST NOT CAUSE.
 *
 * The malformed matrix used to assert navigation, durable rows, published cards and
 * scenario equality -- all true, and all still true if a READ were moved above the parse.
 * A read is the effect that leaves no trace, so it needs its own instrument: schedule
 * projection, capability context, and the diagnostic parent's scenario identity.
 *
 * Counted as a DELTA around each call rather than as an absolute, so ordinary background
 * reads by the harness cannot make a case pass or fail for the wrong reason.
 */
const reads = vi.hoisted(() => ({ schedule: 0, capability: 0, diagnosticParent: 0 }));

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    pickScenario: (...args: Parameters<typeof actual.pickScenario>) => {
      reads.schedule += 1;
      return actual.pickScenario(...args);
    },
    readAuthoritativeScenarioIdentity: (
      ...args: Parameters<typeof actual.readAuthoritativeScenarioIdentity>
    ) => {
      reads.diagnosticParent += 1;
      return actual.readAuthoritativeScenarioIdentity(...args);
    },
  };
});

vi.mock("./capability-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capability-context")>();
  return {
    ...actual,
    readCapabilityContext: (...args: Parameters<typeof actual.readCapabilityContext>) => {
      reads.capability += 1;
      return actual.readCapabilityContext(...args);
    },
  };
});

import { createEmptyScenarioUiState } from "@/lib/scenario";
import { useScenarioStore } from "@/lib/store";
import { loadScenario } from "@/lib/store/lifecycle";
import {
  clearTestAuthority,
  installTestAuthority,
  type TestAuthority,
} from "@/lib/store/test-authority";
import { useAuthorityStore } from "@/lib/store/authority";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { useModeStore } from "@/lib/mode/mode";
import { openDiagnosticSearch, closeSearch } from "@/lib/ai/diagnostic";
import {
  MODEL_VISIBLE_TOOL_SCHEMAS,
  PARAMETERLESS_MODEL_VISIBLE_TOOLS,
} from "./model-visible-tools";
import { useModelVisibleTools } from "./use-context-tools";
import { bindTurnForTest, type TestTurnHandle } from "./turn-authority.test-support";

const AGENT_ID = "scheduler:thread-1";

/**
 * THE CANONICAL REGISTRY, not a source scan.
 *
 * This suite once carried a hard-coded file list, then consumed a custom TypeScript
 * inventory. Both were machinery for a question the production code now answers itself:
 * `MODEL_VISIBLE_TOOL_SCHEMAS` holds the same schema objects the registrations declare,
 * and that the shipped session actually mounts them is proven by the provider-backed
 * real-session proof in `session-real-core.test.tsx`.
 */
const PARAMETERIZED_NAMES = Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS).sort();
const PARAMETERLESS_NAMES = [...PARAMETERLESS_MODEL_VISIBLE_TOOLS].sort();

const SETTLED_SEARCH = closeSearch(
  openDiagnosticSearch({
    searchId: "search-1",
    scenarioId: "scenario-1",
    threadId: null,
    turnId: "turn-1",
    parent: {
      basisId: "b".repeat(64),
      jobId: "job_parent",
      scenarioId: "scenario-1",
      documentRevision: 1,
    },
    turnEpoch: 0,
    leaseEpoch: 1,
    globalGeneration: 0,
    scenarioGeneration: 0,
    compare: false,
    parentExpiresAt: null,
    now: new Date("2026-08-11T00:00:00Z"),
  }),
  "exhausted",
  null,
  new Date("2026-08-11T00:01:00Z"),
);

/**
 * A transport that makes ONE tool call, with arguments given as a raw JSON string.
 *
 * The string matters: the core's own `JSON.parse` is part of the boundary under test, so
 * handing it an already-parsed object would skip the first half of it.
 */
class ToolCallAgent extends AbstractAgent {
  toolName = "get_schedule_section";
  rawArguments = "{}";
  /** Every run input this agent saw. Hop 2 carries the tool result. */
  readonly hopInputs: RunAgentInput[] = [];
  private hop = 0;

  constructor() {
    super({ agentId: AGENT_ID, threadId: "thread-1" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.hopInputs.push(input);
    const nth = (this.hop += 1);
    const callId = `${input.runId}-call`;
    const { toolName, rawArguments } = this;
    return new Observable<BaseEvent>((subscriber) => {
      const emit = (event: unknown) => subscriber.next(event as BaseEvent);
      emit({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
      if (nth === 1) {
        emit({
          type: "TOOL_CALL_START",
          parentMessageId: `msg-${callId}`,
          toolCallId: callId,
          toolCallName: toolName,
        });
        emit({ type: "TOOL_CALL_ARGS", toolCallId: callId, delta: rawArguments });
        emit({ type: "TOOL_CALL_END", toolCallId: callId });
      } else {
        const messageId = `${input.runId}-answer`;
        emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
        emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: "done" });
        emit({ type: "TEXT_MESSAGE_END", messageId });
      }
      emit({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
      subscriber.complete();
    });
  }
}

let harness: TestAuthority;
let boundTurn: TestTurnHandle;
let agent: ToolCallAgent;
let hostTurnEpoch = 0;
/** Makes every run id unique across a test, so nothing is mistaken for a replay. */
let calls = 0;

function Host() {
  // The shipped registration ROOT: reads, help, proposal, diagnostics. Mounted directly
  // here because this suite is about handler BEHAVIOUR -- that the shipped session mounts
  // this same root is `session-real-core.test.tsx`'s proof, not this one's.
  useModelVisibleTools(AGENT_ID, hostTurnEpoch);
  realCore.current = useCopilotKit().copilotkit;
  return null;
}

function Mounted() {
  return (
    <CopilotKitProvider agents__unsafe_dev_only={{ [AGENT_ID]: agent }}>
      <Host />
    </CopilotKitProvider>
  );
}

/**
 * Make one tool call through the real core and return the tool result the core recorded.
 *
 * The result is read from hop 2's messages -- the follow-up the core drives once the
 * handler answers -- so it is literally what would be sent back to the provider.
 */
async function callTool(toolName: string, rawArguments: string): Promise<string> {
  // A FRESH AGENT PER CALL, so each call is its own two-hop run with its own message
  // history. Reusing one agent let the second call's follow-up be suppressed by the
  // accumulated transcript, and "the last tool message" then silently returned the
  // PREVIOUS call's result -- a fixture that would have passed while proving nothing.
  const runner = new ToolCallAgent();
  runner.toolName = toolName;
  runner.rawArguments = rawArguments;
  const runId = `run-${toolName}-${calls++}`;
  const core = realCore.current!;
  await core.runAgent({ agent: runner, runId });
  await waitFor(() => expect(runner.hopInputs.length).toBeGreaterThanOrEqual(2));
  const followUp = runner.hopInputs.at(-1)!;
  const toolMessage = [...followUp.messages]
    .reverse()
    .find(
      (message) =>
        (message as { role?: string }).role === "tool" &&
        (message as { toolCallId?: string }).toolCallId === `${runId}-call`,
    );
  if (!toolMessage) throw new Error(`no tool result for ${toolName}`);
  return String((toolMessage as { content?: unknown }).content ?? "");
}

/**
 * The failed ordinary Optimize run the diagnostic tool is allowed to diagnose.
 *
 * Seeded as a real durable row rather than mocked: `readDiagnosticParent` deliberately
 * derives the parent from this browser's own basis rows for the CURRENT revision, and
 * stubbing that away would remove the binding the tool's safety rests on.
 */
async function seedDiagnosticParent(): Promise<void> {
  const authority = useAuthorityStore.getState();
  await harness.db.optimizeBases.put({
    basisId: "b".repeat(64),
    schemaVersion: 2,
    scenarioId: authority.scenarioId!,
    documentRevision: authority.documentRevision,
    submissionDigest: "d".repeat(64),
    basis: {
      schemaVersion: 2,
      submissionContractVersion: "1",
      workspaceSchemaVersion: "1",
      serializerVersion: "1",
      anonymizationMode: "none",
      inputSha256: "e".repeat(64),
      solverSemanticVersion: "1.0.0",
      backendCapabilityVersion: "1",
      normalizedOptions: { solver: "cbc", prettify: false, timeoutSeconds: 30 },
    },
    ownerKind: "ordinary",
    attemptId: "attempt-1",
    jobId: "job_parent",
    parentBasisId: null,
    transformDigest: null,
    submittedYaml: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    expiresAt: null,
  } as never);
}

beforeEach(async () => {
  navigated.length = 0;
  diagnosticRuntime.inputs.length = 0;
  assistantActions.resetForTest();
  // A RESOLVED MODE, so the capability registry actually answers. Without it every help
  // tool short-circuits to `mode_unresolved` before touching its arguments -- and the
  // malformed-policy case would then "pass" without ever reaching the text processing
  // the reviewer reproduced a throw in.
  useModeStore.setState({ mode: "advanced", adoption: "ready" });
  harness = await installTestAuthority();
  await loadScenario({
    ...createEmptyScenarioUiState(),
    rangeStart: "2026-09-01",
    rangeEnd: "2026-09-30",
  });

  const authority = useAuthorityStore.getState();
  hostTurnEpoch = useAssistantStore.getState().turnEpoch;
  boundTurn = bindTurnForTest({
    scenarioId: authority.scenarioId!,
    documentRevision: authority.documentRevision,
    turnEpoch: hostTurnEpoch,
  });
  boundTurn.live.scenarioId = authority.scenarioId;
  boundTurn.live.documentRevision = authority.documentRevision;
  // A REAL DIAGNOSABLE PARENT, for the same reason. The parent read sits AFTER the parse
  // in the repaired handler, so without one the malformed-candidates case would be
  // refused by "there is no retained Optimize run" under the mutation and prove nothing
  // about `.map()`.
  await seedDiagnosticParent();

  agent = new ToolCallAgent();
  calls = 0;
  realCore.current = null;
  render(<Mounted />);
  // Registration happens in an effect; nothing below is meaningful until it has run.
  await waitFor(() => {
    const core = realCore.current;
    expect(core?.getTool({ toolName: "prepare_scenario_change", agentId: AGENT_ID })).toBeDefined();
  });
});

afterEach(() => {
  cleanup();
  boundTurn?.release();
  clearTestAuthority();
  useModeStore.setState({ mode: "guided", adoption: "unhydrated" });
  vi.restoreAllMocks();
});

/** Every tool the shipped registration actually put on the core, by name. */
function registeredNames(): string[] {
  const core = realCore.current!;
  return [...PARAMETERIZED_NAMES, ...PARAMETERLESS_NAMES]
    .filter((name) => core.getTool({ toolName: name, agentId: AGENT_ID }) !== undefined)
    .sort();
}

/** The one refusal every handler gives a payload it cannot read. */
function expectBoundedRefusal(result: string, forbidden: readonly string[] = []): void {
  expect(result).toContain("not a valid call to this tool");
  expect(result).toContain("Nothing was read, changed or opened");
  // NOT an exception. The core prefixes a thrown handler's message with `Error: `, so
  // this is what tells a refusal apart from the throw it replaced.
  expect(result).not.toContain("Error:");
  expect(result).not.toContain("TypeError");
  // Non-echoing: nothing the model sent comes back, and no internal detail leaks.
  for (const value of [...forbidden, "sk-or-", "openrouter", "toLowerCase", "undefined"]) {
    expect(result.toLowerCase()).not.toContain(value.toLowerCase());
  }
}

describe("the registered surface, through the real core", () => {
  it("is non-vacuous: the shipped registration really put all eight tools on the core", () => {
    // If this ever shrinks, every malformed case below would pass by never running.
    expect(registeredNames()).toEqual(
      [...Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS), ...PARAMETERLESS_MODEL_VISIBLE_TOOLS].sort(),
    );
    // And the canonical registry is itself the inventory's view of the tree.
    expect(PARAMETERIZED_NAMES).toEqual(Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS).sort());
    expect(PARAMETERLESS_NAMES).toEqual([...PARAMETERLESS_MODEL_VISIBLE_TOOLS].sort());
  });

  it("proves the core does NOT validate arguments, which is the premise of all of this", async () => {
    // Asserted rather than assumed. `get_schedule_section` declares a required enum; the
    // core still called its handler with `{}`, and the handler -- not the core -- is what
    // refused. If a future version started validating, this test says so first.
    const result = await callTool("get_schedule_section", "{}");
    expectBoundedRefusal(result);
  });

  it("drives the whole registry the root mounts, enumerated not looked up", () => {
    // ENUMERATED FROM THE CORE, so the matrix below cannot silently stop covering a tool.
    // Whether the SHIPPED SESSION mounts this root is a different question, and it belongs
    // to `session-real-core.test.tsx` -- which renders `useAssistantSession` itself.
    const live = ((realCore.current?.tools ?? []) as { name: string }[])
      .map((tool) => tool.name)
      .sort();
    expect(live).toEqual([...PARAMETERIZED_NAMES, ...PARAMETERLESS_NAMES].sort());
  });

  it("the parameterless tools ignore arguments entirely", async () => {
    // They take no `parameters`, read no `args`, and so have nothing to parse. Proven by
    // handing them a hostile payload and getting the ordinary answer.
    const overview = await callTool("get_schedule_overview", '{"domain":42,"junk":true}');
    expect(overview).toContain("2026-09-01");
    // Its own answer, whatever the registry resolves to here -- the point is that a
    // hostile payload changed nothing about it.
    const capabilities = await callTool("list_app_capabilities", '{"capabilityId":99}');
    expect(capabilities).toContain("registry");
    expect(capabilities).not.toContain("not a valid call to this tool");
  });
});

describe("malformed payloads, for every parameterized tool in the registry", () => {
  const MALFORMED: Record<string, readonly [string, string][]> = {
    // [label, raw JSON arguments]
    get_schedule_section: [
      ["missing domain", "{}"],
      ["wrong-typed domain", '{"domain":42}'],
      ["unknown domain", '{"domain":"payroll"}'],
    ],
    test_feasibility_candidates: [
      ["missing candidates", "{}"],
      ["wrong-typed candidates", '{"candidates":42}'],
      [
        "malformed nested operation",
        '{"candidates":[{"summary":"s","operations":[{"type":"drop_everything"}]}]}',
      ],
      // The model is now shown the arm NAMES, so the two ways it can misuse a name it
      // recognises get their own cases at this boundary rather than only in the parser's
      // own unit test: an extra key beside the targets, and one family's fields under
      // another family's name.
      [
        "nested operation carrying an unknown key",
        '{"candidates":[{"summary":"s","operations":[{"type":"set_rule_enabled","ruleKind":"counts","ruleId":"c1","enabled":true,"card":{}}]}]}',
      ],
    ],
    // WIDENED DELIBERATELY (2026-09-24, plan assistant-guided-setup-and-repair).
    suggest_feasibility_options: [
      ["missing afterInfeasibleRun", "{}"],
      ["wrong-typed afterInfeasibleRun", '{"afterInfeasibleRun":"yes"}'],
    ],
    explain_app_capability: [
      ["missing capabilityId", "{}"],
      ["wrong-typed capabilityId", '{"capabilityId":42}'],
    ],
    suggest_scheduling_rule: [
      ["missing policy", "{}"],
      ["wrong-typed policy", '{"policy":42}'],
    ],
    open_app_screen: [
      ["missing capabilityId", "{}"],
      ["wrong-typed capabilityId", '{"capabilityId":["a"]}'],
    ],
    prepare_scenario_change: [
      ["missing operations", '{"summary":"s"}'],
      ["wrong-typed operations", '{"summary":"s","operations":42}'],
      [
        "malformed nested operation",
        '{"summary":"s","operations":[{"type":"replace_everything"}]}',
      ],
      [
        "operation carrying an unknown key alongside its targets",
        '{"summary":"s","operations":[{"type":"set_staffing_requirement_people","ruleId":"r1","requiredNumPeople":2,"scenario":{}}]}',
      ],
      [
        "one family's fields under another family's name",
        '{"summary":"s","operations":[{"type":"move_leave","ruleId":"r1","requiredNumPeople":2}]}',
      ],
    ],
  };

  it("the malformed table covers every parameterized tool, with no strays", () => {
    // The INVENTORY is the source of truth, so a tool mounted anywhere in production
    // without a case here is a failure rather than a silent gap.
    expect(Object.keys(MALFORMED).sort()).toEqual(PARAMETERIZED_NAMES);
  });

  for (const [toolName, cases] of Object.entries(MALFORMED)) {
    for (const [label, rawArguments] of cases) {
      it(`${toolName}: ${label} is refused, and nothing happens`, async () => {
        const before = structuredClone(useScenarioStore.getState());
        const readsBefore = { ...reads };

        const result = await callTool(toolName, rawArguments);

        expectBoundedRefusal(result);
        // NOT EVEN A READ. This is the assertion the previous matrix was missing: moving
        // a read above the parse would have left every check below green.
        expect(reads.schedule - readsBefore.schedule).toBe(0);
        expect(reads.capability - readsBefore.capability).toBe(0);
        expect(reads.diagnosticParent - readsBefore.diagnosticParent).toBe(0);
        // NO EFFECT OF ANY KIND. Not a navigation, not a durable row, not a published
        // card, and not a read that quietly succeeded with nothing in it.
        expect(navigated).toEqual([]);
        expect(await harness.db.assistantProposals.count()).toBe(0);
        expect(await harness.db.diagnosticSearches.count()).toBe(0);
        expect(useAssistantStore.getState().activeProposal).toBeNull();
        expect(useScenarioStore.getState()).toEqual(before);
        // And specifically not the empty success that used to look like an answer.
        expect(result.trim()).not.toBe("");
      });
    }
  }
});

describe("declared defaults: a legal omission behaves exactly like the explicit value", () => {
  it("diagnostic compare arrives as false, never undefined", async () => {
    // THE F1Y REVIEW REPRODUCTION. `compare` is `.default(false)`, the wire schema does
    // not require it, and the runtime round trip drops the default -- so an omission
    // reached the search record's REQUIRED boolean as `undefined`.
    const candidates =
      '[{"summary":"fewer people on days","operations":[{"type":"set_roster_range","start":"2026-09-01","end":"2026-09-07","importPublicHolidays":false}]}]';
    await callTool("test_feasibility_candidates", `{"candidates":${candidates}}`);
    await callTool("test_feasibility_candidates", `{"candidates":${candidates},"compare":false}`);

    // Both reached the runtime, and with the SAME normalized input.
    expect(diagnosticRuntime.inputs).toHaveLength(2);
    const [omitted, explicit] = diagnosticRuntime.inputs;
    expect(omitted.compare).toBe(false);
    expect(omitted.compare).not.toBeUndefined();
    expect(omitted.compare).toEqual(explicit.compare);
    // Same normalized candidate work either way. `candidateId` is a fresh uuid per call
    // by design, so it is excluded rather than asserted equal.
    const shape = (proposed: unknown) =>
      (proposed as { commands: unknown; rationale: unknown }[]).map(({ commands, rationale }) => ({
        commands,
        rationale,
      }));
    expect(shape(omitted.proposed)).toEqual(shape(explicit.proposed));
  });

  it("omitted proposal evidence equals an explicit empty list, durably and in effect", async () => {
    // The TWIN of the diagnostic case above, stated directly rather than inferred from
    // Zod's behaviour: the ticket's equivalence is about what the HOST ends up with, so
    // both calls are made and their durable rows compared.
    const operations =
      '[{"type":"set_roster_range","start":"2026-10-01","end":"2026-10-07","importPublicHolidays":false}]';
    const summary = '"summary":"first week of October"';

    const omitted = await callTool(
      "prepare_scenario_change",
      `{${summary},"operations":${operations}}`,
    );
    expect(omitted).toContain("preview of this change is now shown");
    const afterOmitted = await harness.db.assistantProposals.toArray();
    expect(afterOmitted).toHaveLength(1);

    const explicit = await callTool(
      "prepare_scenario_change",
      `{${summary},"operations":${operations},"evidence":[]}`,
    );
    expect(explicit).toContain("preview of this change is now shown");

    // Same durable evidence, same commands, same effect on the Preview -- one row, since
    // a second prepare REVISES the live proposal rather than creating a rival.
    const rows = await harness.db.assistantProposals.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].evidence).toEqual([]);
    expect(rows[0].evidence).toEqual(afterOmitted[0].evidence);
    expect(rows[0].commands).toEqual(afterOmitted[0].commands);
    // And the change is still only ever a Preview.
    expect(useScenarioStore.getState().rangeStart).toBe("2026-09-01");
  });
});

describe("valid controls still work, so none of the above passes by refusing everything", () => {
  it("get_schedule_section reads the section it was asked for, and the counter sees it", async () => {
    // NON-VACUITY FOR THE READ COUNTERS. Every malformed case asserts a delta of zero,
    // which a mock that never applied would also satisfy. This proves the instrument
    // works: a valid call moves the counter the malformed ones require to stay still.
    const before = { ...reads };
    const result = await callTool("get_schedule_section", '{"domain":"dates"}');
    expect(result).toContain("2026-09-01");
    expect(result).toContain("rangeEnd");
    expect(reads.schedule - before.schedule).toBeGreaterThan(0);
  });

  it("a valid capability call moves the capability-context counter", async () => {
    const before = { ...reads };
    await callTool("explain_app_capability", '{"capabilityId":"shift-counts"}');
    expect(reads.capability - before.capability).toBeGreaterThan(0);
  });

  it("a valid diagnostic call moves the parent-read counter", async () => {
    const before = { ...reads };
    await callTool(
      "test_feasibility_candidates",
      '{"candidates":[{"summary":"s","operations":[{"type":"set_roster_range","start":"2026-09-01","end":"2026-09-07","importPublicHolidays":false}]}]}',
    );
    expect(reads.diagnosticParent - before.diagnosticParent).toBeGreaterThan(0);
  });

  // THE STAMP AND THE GUARD MUST READ THE SAME AUTHORITY.
  //
  // Every other case in this suite binds the turn at exactly `hostTurnEpoch`, so the
  // registration epoch and the live epoch agree and a handler that stamps the WRONG one
  // still looks right. Production never guarantees that: the per-turn run clone snapshots
  // the tool registry between `nextTurnEpoch()` clearing the authorised epoch and
  // `beginTurn` restoring it, so the handler that actually executes can carry a stale
  // registration epoch while running under a perfectly live turn.
  //
  // When it did, `showProposal` stamped the Preview with the stale value,
  // `use-assistant-proposals` compared stamp against live, and every live Preview was born
  // "stopped" with Apply permanently disabled -- the whole Preview -> Apply -> receipt ->
  // Undo journey was unreachable, with the full unit suite green.
  it("stamps a published Preview with the BOUND turn's epoch, not the registration epoch", async () => {
    // Remount the registration under a STALE epoch, leaving the bound turn untouched.
    cleanup();
    realCore.current = null;
    const liveTurnEpoch = useAssistantStore.getState().turnEpoch;
    hostTurnEpoch = liveTurnEpoch - 1;
    render(<Mounted />);
    await waitFor(() => {
      expect(
        realCore.current?.getTool({ toolName: "prepare_scenario_change", agentId: AGENT_ID }),
      ).toBeDefined();
    });

    const result = await callTool(
      "prepare_scenario_change",
      '{"summary":"first week of October","operations":[{"type":"set_roster_range","start":"2026-10-01","end":"2026-10-07","importPublicHolidays":false}]}',
    );
    expect(result).toContain("preview of this change is now shown");

    const active = useAssistantStore.getState().activeProposal;
    expect(active).not.toBeNull();
    // The exact comparison `use-assistant-proposals` makes to decide `invalidated`.
    expect(active!.turnEpoch).toBe(useAssistantStore.getState().turnEpoch);
    expect(active!.turnEpoch).not.toBe(hostTurnEpoch);
  });

  it("suggest_scheduling_rule answers a real policy string", async () => {
    const result = await callTool(
      "suggest_scheduling_rule",
      '{"policy":"no day shift straight after a night shift"}',
    );
    expect(result).toContain("registry");
    expect(result).not.toContain("not a valid call");
  });

  it("explain_app_capability still fails closed on an unknown id, in its own words", async () => {
    // DOMAIN BEHAVIOUR PRESERVED. A well-formed id that does not exist is not a schema
    // failure, and must keep answering `capability_unavailable` rather than the shared
    // refusal -- the two mean different things to the model.
    const result = await callTool("explain_app_capability", '{"capabilityId":"no-such-thing"}');
    expect(result).toContain("capability_unavailable");
    expect(result).not.toContain("not a valid call to this tool");
  });
});
