// THE ONE PRODUCTION ENTRY to `@copilotkit/runtime` (custom-AST ticket 2).
//
// WHAT THIS REPLACES. Every runtime module used to carry a `LOAD-BEARING: must precede
// the @copilotkit/runtime import` comment, and a source scan walked the directory
// checking that each one really did put `./containment` first. That was a convention
// enforced by reading text: correct today, silently wrong the first time somebody adds a
// fourth module and sorts its imports.
//
// The ordering is now a property of ONE file. `./containment` applies the telemetry and
// analytics opt-out as an import-time side effect, and ES modules evaluate imports in
// declaration order, so the opt-out is in place before `@copilotkit/runtime`'s telemetry
// client — a module singleton that snapshots the env when it is first evaluated — is
// constructed. Consumers cannot get this wrong because consumers no longer participate:
// importing this module is the only way to reach the runtime at all, and Oxlint
// `no-restricted-imports` closes the direct route from everywhere else.
//
// Only what production actually uses is re-exported. A symbol that is not here is not
// reachable, which keeps the surface reviewable rather than transitive.

import "./containment";

export {
  AgentRunner,
  BuiltInAgent,
  CopilotRuntime,
  convertMessagesToVercelAISDKMessages,
  convertToolsToVercelAITools,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";

export type {
  AgentRunnerConnectRequest,
  AgentRunnerIsRunningRequest,
  AgentRunnerRunRequest,
  AgentRunnerStopRequest,
  AgentsFactory,
  CopilotRuntimeFetchHandler,
  RouteInfo,
} from "@copilotkit/runtime/v2";
