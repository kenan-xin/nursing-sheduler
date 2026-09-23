// THE MAINTAINED CAPABILITY INVENTORY, derived at RUNTIME from the installed package.
//
// WHY NOT FROM SOURCE. Two earlier attempts read the package's `export { … }` lines and
// both were under-inclusive, because `@copilotkit/react-core/v2` also does
// `export * from "@copilotkit/core"` and `export * from "@ag-ui/client"`. The wildcard
// carries `CopilotKitCore` and `RunHandler`, whose public `addTool`/`removeTool`/
// `setTools`/`setToolEnabled`/`runTool` are exactly the capability the boundary exists to
// contain -- and a reviewer used the base class to replace a per-turn handler while every
// name-based rule and every mounted assertion stayed green.
//
// So this file asks the MODULE what it exports, and asks the lint config (as JSON, not as
// parsed source) whether each capability-bearing name is closed. A new export in a future
// release is unclassified, and an unclassified export fails.
//
// Renderer-only APIs are listed separately and deliberately left open: they add a
// `ReactToolCallRenderer`, which receives args/status/result and cannot register, replace
// or respond with an executable result. Restricting them would be a UI-ownership policy,
// which this ticket does not adopt.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The installed package's JavaScript entry points, from its own `exports` map. */
const SPECIFIERS = [
  "@copilotkit/react-core",
  "@copilotkit/react-core/v2",
  "@copilotkit/react-core/v2/context",
  "@copilotkit/react-core/v2/headless",
] as const;

/**
 * The real export surface of each entry point, loaded the way the app loads it.
 *
 * Dynamic import rather than `require`: the package ships ESM the CJS loader rejects, and
 * the point of this file is to ask the MODULE what it exports rather than to read its
 * source.
 */
const SURFACES = new Map<string, string[]>(
  await Promise.all(
    SPECIFIERS.map(async (specifier) => {
      const module = (await import(specifier)) as Record<string, unknown>;
      return [specifier, Object.keys(module).sort()] as [string, string[]];
    }),
  ),
);

function exportsOf(specifier: string): string[] {
  return SURFACES.get(specifier) ?? [];
}

/**
 * Exports that can execute, register, replace or resume a model-callable handler, or that
 * yield an object which can. Every one must be closed.
 */
// The three dispositions are kept as ARRAYS, not `Set`s, until two exclusivity
// assertions have had a chance to fail on them: a `Set` silently erases a duplicate
// entry, and a precedence-based membership check silently accepts a name that sits in
// two categories. Both are exactly the false-green shape this guard exists to prevent.
// The derived `Set`s used for membership come after the assertion block at the bottom.
const CAPABILITY_BEARING_NAMES: readonly string[] = [
  // registrants
  "useFrontendTool",
  "useHumanInTheLoop",
  "useComponent",
  "useCopilotAction",
  "useCopilotAuthenticatedAction_c",
  "useDefaultTool",
  // human-in-the-loop resume: `resolve` calls `copilotkit.runAgent` with the result
  "useInterrupt",
  "useLangGraphInterrupt",
  // executable task runner
  "CopilotTask",
  // core access, including the wildcard-exported base class and its run handler
  "useCopilotKit",
  "CopilotKitContext",
  "CopilotKitCoreReact",
  "CopilotKitCore",
  "RunHandler",
  // legacy action registry
  "CopilotContext",
  "useCopilotContext",
  // An internal-looking name that is nonetheless a public export, and executable: its
  // body calls `host.runAgent({ agent })`. The `ɵ` prefix marks it as framework-internal
  // by convention, but convention is not a boundary and it is reachable from production.
  "ɵrunMcpFollowUp",
  // THE ACTIVITY/RENDERER FAMILY, and "renderer" in the name is why it was missed twice.
  // These are not display-only:
  //   * `MCPAppsActivityRenderer` calls `agent.runAgent({ forwardedProps: … })` and
  //     `ɵrunMcpFollowUp`;
  //   * the renderer `createA2UIMessageRenderer` returns calls `useCopilotKit()` inside
  //     its own `render`, so it holds the live core the façade exists to withhold;
  //   * `OpenGenerativeUIActivityRenderer` builds `api[fn.name] = fn.handler` from the
  //     sandbox context and hands those callbacks to sandboxed HTML, so it EXECUTES them;
  //   * `SandboxFunctionsContext` is the context carrying those callbacks, and
  //     `useSandboxFunctions` reads it — either one supplies executable behaviour.
  "MCPAppsActivityRenderer",
  "createA2UIMessageRenderer",
  "OpenGenerativeUIActivityRenderer",
  "SandboxFunctionsContext",
  "useSandboxFunctions",
  // providers, which register tools through props
  "CopilotKitProvider",
  "CopilotKit",
];

/**
 * Renderer-only APIs. They add a `ReactToolCallRenderer`; the renderer receives args,
 * status and result, and has no responder.
 *
 * Classified from IMPLEMENTATION INSPECTION of the locked bundle, not from a runtime
 * control. `assistant-copilot-provider.test.tsx` carries raw-provider controls for the
 * two EXECUTABLE provider channels (`frontendTools`, `openGenerativeUI.sandboxFunctions`);
 * it does not mount a renderer-only tool API, so it cannot prove renderer-only inertness.
 * Renderer-only APIs are left open precisely because the locked implementation gives the
 * renderer no responder, which is what the over-reach test below enforces.
 */
const RENDERER_ONLY_NAMES: readonly string[] = [
  "useRenderTool",
  "useRenderToolCall",
  "useDefaultRenderTool",
  "useLazyToolRenderer",
  "defineToolCallRenderer",
  "useCoAgentStateRender",
];

interface RestrictedPath {
  name: string;
  importNames?: string[];
}

function restrictions(): RestrictedPath[] {
  // The lint config as DATA. Reading JSON is not source parsing: there is no grammar here
  // and no analyzer, just the same file Oxlint itself loads.
  const config = JSON.parse(readFileSync(join(process.cwd(), ".oxlintrc.json"), "utf8")) as {
    rules: { "no-restricted-imports": [string, { paths: RestrictedPath[] }] };
  };
  return config.rules["no-restricted-imports"][1].paths;
}

function closedNames(specifier: string): { whole: boolean; names: Set<string> } {
  const entry = restrictions().find((path) => path.name === specifier);
  if (!entry) return { whole: false, names: new Set() };
  if (!entry.importNames) return { whole: true, names: new Set() };
  return { whole: false, names: new Set(entry.importNames) };
}

describe("the installed CopilotKit capability inventory", () => {
  it("is non-vacuous: every specifier resolves and exports something", () => {
    for (const specifier of SPECIFIERS) {
      expect(exportsOf(specifier).length, specifier).toBeGreaterThan(0);
    }
    // And the wildcard really is in play: `CopilotKitCore` is re-exported from
    // `@copilotkit/core`, not declared by the React package's own `export { … }` line.
    // Reading that line is exactly how two earlier inventories missed it.
    expect(exportsOf("@copilotkit/react-core/v2")).toContain("CopilotKitCore");
  });

  it("admits no DUPLICATE within a single category", () => {
    // THE FIRST FACE OF THE ROUND-8 HOLE. All three dispositions used to be `Set`s, which
    // silently erased a repeated entry. A future edit that listed `CopilotKitCore` twice
    // in CAPABILITY_BEARING would have passed every other test in this file.
    const duplicates: string[] = [];
    for (const category of CATEGORIES) {
      const seen = new Set<string>();
      for (const name of category.names) {
        if (seen.has(name)) duplicates.push(`${name} (duplicate in ${category.label})`);
        else seen.add(name);
      }
    }
    // The message argument names every duplicate and the category it sits in, so a failure
    // reads as an actionable instruction rather than a bare array diff.
    expect(duplicates, duplicates.join("; ")).toEqual([]);
  });

  it("assigns each classified name to EXACTLY ONE category (no cross-category overlap)", () => {
    // THE SECOND FACE OF THE SAME HOLE. `Set`-based membership with precedence accepted a
    // name as soon as the FIRST category matched, so a name in two categories was never
    // noticed. The round-8 review reproduced exactly this: `CopilotKitCore` in both
    // CAPABILITY_BEARING and INERT left all five inventory cases green.
    const overlap: string[] = [];
    const classified = new Set<string>([
      ...CAPABILITY_BEARING_NAMES,
      ...RENDERER_ONLY_NAMES,
      ...INERT_NAMES,
    ]);
    for (const name of classified) {
      const cats = dispositions(name);
      if (cats.length !== 1) overlap.push(`${name} → [${cats.join(", ")}]`);
    }
    expect(overlap, overlap.join("; ")).toEqual([]);
  });

  it("closes every capability-bearing export the package actually has", () => {
    const open: string[] = [];
    for (const specifier of SPECIFIERS) {
      const closed = closedNames(specifier);
      if (closed.whole) continue;
      for (const name of exportsOf(specifier)) {
        if (CAPABILITY_BEARING_NAMES.includes(name) && !closed.names.has(name)) {
          open.push(`${specifier} :: ${name}`);
        }
      }
    }
    expect(open).toEqual([]);
  });

  it("restricts nothing that is renderer-only", () => {
    // The other direction, and it matters: an over-broad rule is an unjustified production
    // API restriction. `useDefaultRenderTool` was restricted for one round on the mistaken
    // basis that it was executable.
    const overreach: string[] = [];
    for (const specifier of SPECIFIERS) {
      const closed = closedNames(specifier);
      for (const name of closed.names) {
        if (RENDERER_ONLY_NAMES.includes(name)) overreach.push(`${specifier} :: ${name}`);
      }
    }
    expect(overreach).toEqual([]);
  });

  it("CLASSIFIES every export with exactly ONE disposition, so an unclassified or ambiguous capability cannot pass", () => {
    // THE HOLE THIS CLOSES. The previous guard checked two things: that every name in the
    // capability list was restricted, and that the export surface digest was unchanged.
    // Both were green while `ɵrunMcpFollowUp` -- a public export whose body calls
    // `host.runAgent({ agent })` -- sat unrestricted, because it was in NEITHER list. The
    // digest proved the surface had not changed since it was blessed; it could not prove
    // the surface had been read.
    //
    // So every export of a name-restricted specifier must now be classified explicitly,
    // AND with exactly one disposition. The separate overlap test covers the whole union
    // of classified names; this one covers the runtime surface specifically, so a future
    // export that is both capability-bearing and inert is caught here even if the overlap
    // test were removed.
    const unclassified: string[] = [];
    const multi: string[] = [];
    for (const specifier of SPECIFIERS) {
      if (closedNames(specifier).whole) continue;
      for (const name of exportsOf(specifier)) {
        const cats = dispositions(name);
        if (cats.length === 0) unclassified.push(name);
        else if (cats.length !== 1) multi.push(`${name} → [${cats.join(", ")}]`);
      }
    }
    expect({ unclassified, multi }, JSON.stringify({ unclassified, multi })).toEqual({
      unclassified: [],
      multi: [],
    });
  });

  it("pins the export SURFACE, so a renamed or removed export is noticed too", () => {
    // The digest is retained as a SECOND signal, not the primary one: it catches a
    // removal or rename that the classification check cannot see, because a name that
    // disappears is trivially classified.
    const digests = Object.fromEntries(
      SPECIFIERS.filter((specifier) => !closedNames(specifier).whole).map((specifier) => [
        specifier,
        createHash("sha256").update(exportsOf(specifier).join("\n")).digest("hex").slice(0, 16),
      ]),
    );
    expect(digests).toEqual({
      "@copilotkit/react-core/v2": V2_EXPORT_SURFACE,
    });
  });
});

/**
 * Digest of `@copilotkit/react-core/v2`'s sorted export names at 1.66.2.
 *
 * Only the specifiers restricted by NAME need one: root, `v2/context` and `v2/headless`
 * are closed whole, so nothing they add can reach production regardless.
 */
const V2_EXPORT_SURFACE = "b3f746c70962e3b5";

/**
 * Exports of `…/v2` reviewed and found to carry no registration, execution or core
 * capability: chat UI components and their props, configuration/state/message hooks,
 * renderers' supporting types, schemas and constants.
 *
 * ENUMERATED, not pattern-matched. A regular expression over names would have waved
 * `ɵrunMcpFollowUp` through on its prefix, which is exactly the failure this list exists
 * to prevent: classification has to be a decision someone made, recorded by name.
 */
const INERT_NAMES: readonly string[] = [
  "AGUIConnectNotImplementedError",
  "AGUIError",
  "AbstractAgent",
  "ActivityDeltaEventSchema",
  "ActivityMessageSchema",
  "ActivitySnapshotEventSchema",
  "AgentCapabilitiesSchema",
  "AgentRegistry",
  "AgentThreadLockedError",
  "AssistantMessageSchema",
  "AudioInputContentSchema",
  "AudioInputPartSchema",
  "AudioRecorderError",
  "BackwardCompatibility_0_0_39",
  "BackwardCompatibility_0_0_45",
  "BackwardCompatibility_0_0_47",
  "BaseEventSchema",
  "BaseMessageSchema",
  "BinaryInputContentSchema",
  "ContextSchema",
  "ContextStore",
  "CopilotChat",
  "CopilotChatAssistantMessage",
  "CopilotChatAttachmentQueue",
  "CopilotChatAttachmentRenderer",
  "CopilotChatAudioRecorder",
  "CopilotChatConfigurationProvider",
  "CopilotChatInput",
  "CopilotChatMessageView",
  "CopilotChatReasoningMessage",
  "CopilotChatSuggestionPill",
  "CopilotChatSuggestionView",
  "CopilotChatToggleButton",
  "CopilotChatToggleButtonCloseIcon",
  "CopilotChatToggleButtonOpenIcon",
  "CopilotChatToolCallsView",
  "CopilotChatUserMessage",
  "CopilotChatView",
  "CopilotKitCoreErrorCode",
  "CopilotKitCoreRuntimeConnectionStatus",
  "CopilotKitInspector",
  "CopilotModalHeader",
  "CopilotPopup",
  "CopilotPopupView",
  "CopilotSidebar",
  "CopilotSidebarView",
  "CopilotThreadsDrawer",
  "CustomEventSchema",
  "DebugLogger",
  "DeveloperMessageSchema",
  "DocumentInputContentSchema",
  "DocumentInputPartSchema",
  "EventSchemas",
  "EventType",
  "ExecutionCapabilitiesSchema",
  "FilterToolCallsMiddleware",
  "FunctionCallSchema",
  "FunctionMiddleware",
  "GenerateSandboxedUiArgsSchema",
  "HttpAgent",
  "HumanInTheLoopCapabilitiesSchema",
  "INTELLIGENCE_TURN_HEAD",
  "IdentityCapabilitiesSchema",
  "ImageInputContentSchema",
  "ImageInputPartSchema",
  "InputContentDataSourceSchema",
  "InputContentSchema",
  "InputContentSourceSchema",
  "InputContentUrlSourceSchema",
  "IntelligenceAgent",
  "IntelligenceIndicator",
  "IntelligenceIndicatorView",
  "InterruptSchema",
  "MCPAppsActivityContentSchema",
  "MCPAppsActivityType",
  "MEMORY_ERROR_REGISTRY",
  "MemoryError",
  "MessageSchema",
  "MessagesSnapshotEventSchema",
  "Middleware",
  "MultiAgentCapabilitiesSchema",
  "MultimodalCapabilitiesSchema",
  "MultimodalInputCapabilitiesSchema",
  "MultimodalOutputCapabilitiesSchema",
  "OpenGenerativeUIActivityType",
  "OpenGenerativeUIContentSchema",
  "OpenGenerativeUIToolRenderer",
  "OutputCapabilitiesSchema",
  "ProxiedCopilotRuntimeAgent",
  "RawEventSchema",
  "ReasoningCapabilitiesSchema",
  "ReasoningEncryptedValueEventSchema",
  "ReasoningEncryptedValueSubtypeSchema",
  "ReasoningEndEventSchema",
  "ReasoningMessageChunkEventSchema",
  "ReasoningMessageContentEventSchema",
  "ReasoningMessageEndEventSchema",
  "ReasoningMessageSchema",
  "ReasoningMessageStartEventSchema",
  "ReasoningStartEventSchema",
  "ResumeEntrySchema",
  "RoleSchema",
  "RunAgentInputSchema",
  "RunErrorEventSchema",
  "RunFinishedEventSchema",
  "RunFinishedInterruptOutcomeSchema",
  "RunFinishedOutcomeSchema",
  "RunFinishedSuccessOutcomeSchema",
  "RunStartedEventSchema",
  "StateCapabilitiesSchema",
  "StateDeltaEventSchema",
  "StateManager",
  "StateSchema",
  "StateSnapshotEventSchema",
  "StepFinishedEventSchema",
  "StepStartedEventSchema",
  "SubAgentInfoSchema",
  "SuggestionEngine",
  "SystemMessageSchema",
  "TextInputContentSchema",
  "TextMessageChunkEventSchema",
  "TextMessageContentEventSchema",
  "TextMessageEndEventSchema",
  "TextMessageStartEventSchema",
  "ThinkingEndEventSchema",
  "ThinkingStartEventSchema",
  "ThinkingTextMessageContentEventSchema",
  "ThinkingTextMessageEndEventSchema",
  "ThinkingTextMessageStartEventSchema",
  "ToolCallArgsEventSchema",
  "ToolCallChunkEventSchema",
  "ToolCallEndEventSchema",
  "ToolCallResultEventSchema",
  "ToolCallSchema",
  "ToolCallStartEventSchema",
  "ToolCallStatus",
  "ToolMessageSchema",
  "ToolSchema",
  "ToolsCapabilitiesSchema",
  "TransportCapabilitiesSchema",
  "UseAgentUpdate",
  "UserMessageSchema",
  "VideoInputContentSchema",
  "VideoInputPartSchema",
  "WildcardToolCallRender",
  "a2uiDefaultTheme",
  "buildResumeArray",
  "compactEvents",
  "completePartialMarkdown",
  "convertToLegacyEvents",
  "createActionGroup",
  "createDebugLogger",
  "createEffect",
  "createReducer",
  "createSelector",
  "createStore",
  "defaultApplyEvents",
  "empty",
  "ensureObjectArgs",
  "getIntelligenceTurnAnchors",
  "getRunOutcome",
  "isAbortError",
  "isInterruptExpired",
  "isRunCompletionAware",
  "ofType",
  "on",
  "parseProtoStream",
  "parseSSEStream",
  "parseToolArguments",
  "props",
  "randomUUID",
  "resolveAgentDebugConfig",
  "resolveDebugLogger",
  "runHttpRequest",
  "select",
  "structuredClone_",
  "transformChunks",
  "transformHttpEventStream",
  "useAgent",
  "useAgentContext",
  "useAttachments",
  "useCapabilities",
  "useConfigureSuggestions",
  "useCopilotChatConfiguration",
  "useLearnFromUserAction",
  "useLearnFromUserActionInCurrentThread",
  "useLearningContainers",
  "useLearningContainersInCurrentThread",
  "useMemories",
  "useRenderActivityMessage",
  "useRenderCustomMessages",
  "useSuggestions",
  "useThreads",
  "verifyEvents",
  "ɵCOPILOTKIT_FEATURES",
  "ɵInterruptState",
  "ɵMAX_SOCKET_RETRIES",
  "ɵcreateMemoryStore",
  "ɵcreateThreadSelectors",
  "ɵcreateThreadStore",
  "ɵisCopilotKitFeature",
  "ɵisRetryableMemoryStatus",
  "ɵmapMemoryMetadataEvent",
  "ɵmemoryAdapterEvents",
  "ɵmemoryDomainEvents",
  "ɵmemoryReducer",
  "ɵmemoryRestEvents",
  "ɵselectFetchMoreError",
  "ɵselectHasNextPage",
  "ɵselectIsFetchingNextPage",
  "ɵselectIsMutating",
  "ɵselectMemories",
  "ɵselectMemoriesAvailable",
  "ɵselectMemoriesError",
  "ɵselectMemoriesIsLoading",
  "ɵselectMemoriesIsMutating",
  "ɵselectMemoriesRealtimeStatus",
  "ɵselectThreads",
  "ɵselectThreadsError",
  "ɵselectThreadsIsLoading",
  "ɵthreadAdapterEvents",
  // The Phoenix websocket transport, exported with the SAME `ɵ` prefix as
  // `ɵrunMcpFollowUp` -- which is precisely why the prefix cannot serve as a
  // classification rule. These build and observe a socket/channel; none of them
  // references `runAgent`, `addTool`, `setTools` or `removeTool`, verified against
  // `@copilotkit/core/dist/index.mjs`.
  "ɵjoinPhoenixChannel$",
  "ɵobservePhoenixEvent$",
  "ɵobservePhoenixJoinOutcome$",
  "ɵobservePhoenixSocketHealth$",
  "ɵobservePhoenixSocketSignals$",
  "ɵphoenixChannel$",
  "ɵphoenixSocket$",
];

// ── Derived membership sets and exclusivity helpers ─────────────────────────────
//
// Built ONLY after the three `_NAMES` arrays have been declared, so the assertions
// below can fail on a duplicate or an overlap before any membership query succeeds.

interface Category {
  readonly label: string;
  readonly names: readonly string[];
}

const CATEGORIES: readonly Category[] = [
  { label: "capability-bearing", names: CAPABILITY_BEARING_NAMES },
  { label: "renderer-only", names: RENDERER_ONLY_NAMES },
  { label: "inert", names: INERT_NAMES },
];

/**
 * Every category `name` currently belongs to. The exclusivity invariants below require
 * this to return exactly one entry for every classified name, so a duplicate within a
 * category or an overlap across categories is caught rather than silently accepted.
 */
function dispositions(name: string): readonly string[] {
  return CATEGORIES.filter((c) => c.names.includes(name)).map((c) => c.label);
}
