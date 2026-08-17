// NEGATIVE TYPE FIXTURES for the canonical provider wrapper.
//
// `CopilotKitProvider` registers tools supplied as PROPS -- `frontendTools`,
// `humanInTheLoop`, `renderToolCalls`, `agents__unsafe_dev_only` -- with no hook call and
// no core access, so every rule aimed at hooks and cores misses that route entirely. A
// same-name/same-agent/same-schema entry supplied this way replaces a canonical handler
// while preserving everything the mounted-registry proof inspects.
//
// WHAT THIS FILE ACTUALLY PROVES, stated narrowly:
//
//   * every listed registration prop is ABSENT from the wrapper's props type;
//   * supplying one as a direct property, through an alias, or by index is a type error;
//   * supplying one through a SPREAD of an already-typed value is NOT a type error --
//     TypeScript excess-checks object literals only, so this file cannot close that route
//     for any channel.
//
// The spread route is closed at RUNTIME, and only for the two executable channels:
// `frontendTools` and `openGenerativeUI.sandboxFunctions`, each with a raw-provider
// control in `assistant-copilot-provider.test.tsx`. The remaining channels
// (`humanInTheLoop`, `agents__unsafe_dev_only`, `selfManagedAgents` and the render
// registries) are closed by the wrapper forwarding four named props -- an argument from
// the implementation, not a case in either file.
//
// Checked by `tsc --noEmit`; `.test-d.ts` is not collected by vitest, so nothing executes.

import type { AssistantCopilotProviderProps } from "./assistant-copilot-provider";

/** True only when `K` is a member of `T`. Keeps each assertion expression-free. */
type Has<T, K extends PropertyKey> = K extends keyof T ? true : false;

/** Compile error unless the argument is exactly `false`. */
function assertAbsent(_absent: false): void {}

// --- no registration channel is a prop of the wrapper -------------------------

assertAbsent(false as Has<AssistantCopilotProviderProps, "frontendTools">);
assertAbsent(false as Has<AssistantCopilotProviderProps, "humanInTheLoop">);
assertAbsent(false as Has<AssistantCopilotProviderProps, "renderToolCalls">);
assertAbsent(false as Has<AssistantCopilotProviderProps, "renderActivityMessages">);
assertAbsent(false as Has<AssistantCopilotProviderProps, "renderCustomMessages">);
assertAbsent(false as Has<AssistantCopilotProviderProps, "openGenerativeUI">);
assertAbsent(false as Has<AssistantCopilotProviderProps, "agents__unsafe_dev_only">);
assertAbsent(false as Has<AssistantCopilotProviderProps, "selfManagedAgents">);

// --- and none can be supplied through any route -------------------------------

declare const children: AssistantCopilotProviderProps["children"];
const base = {
  runtimeUrl: "/api/copilotkit",
  headers: () => ({}),
  children,
};

// Direct prop.
// @ts-expect-error `frontendTools` is not a prop of the wrapper.
const direct: AssistantCopilotProviderProps = { ...base, frontendTools: [] };
void direct;
// @ts-expect-error nor is `humanInTheLoop`.
const hitl: AssistantCopilotProviderProps = { ...base, humanInTheLoop: [] };
void hitl;
// @ts-expect-error nor a dev-only agent registry.
const agents: AssistantCopilotProviderProps = { ...base, agents__unsafe_dev_only: {} };
void agents;

// SPREAD IS THE ONE ROUTE THE TYPE SYSTEM DOES NOT REJECT, and saying so is the point.
//
// TypeScript applies excess-property checking to object LITERALS, not to a spread of an
// already-typed value, so this compiles. It is nonetheless inert: `AssistantCopilotProvider`
// destructures exactly `runtimeUrl`, `headers`, `showDevConsole` and `children`, and
// forwards only those to `CopilotKitProvider`. An extra property rides along in the object
// and is dropped at the wrapper.
//
// That is the whole principle applied to props: the capability is removed from the
// implementation, not merely forbidden by a type. `assistant-copilot-provider.test.tsx`
// proves the runtime half -- a smuggled `frontendTools` registers nothing.
declare const smuggled: { frontendTools: unknown[] };
const viaSpread: AssistantCopilotProviderProps = { ...base, ...smuggled };
void viaSpread;

// Alias to a type that has one.
declare const props: AssistantCopilotProviderProps;
// @ts-expect-error the wrapper's props cannot be widened to a registration-bearing type.
const aliased: { frontendTools: unknown[] } = props;
void aliased;

// Indexed access.
// @ts-expect-error there is no index signature, so a computed name resolves to nothing.
const indexed: unknown = props["frontendTools"];
void indexed;

// The props it DOES accept remain usable -- the wrapper removes capability, not function.
const valid: AssistantCopilotProviderProps = { ...base, showDevConsole: false };
void valid;
