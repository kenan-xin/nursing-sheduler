"use client";

// THE ONLY MODULE THAT MAY MOUNT A COPILOTKIT PROVIDER.
//
// WHY A WRAPPER. Closing the registration HOOKS and the raw core still left a third door
// open: `CopilotKitProvider` accepts `frontendTools`, `humanInTheLoop`, `renderToolCalls`
// and `agents__unsafe_dev_only` as PROPS. A tool supplied that way is registered by the
// library at mount, with no hook call and no core access -- so every lint rule aimed at
// hooks and cores misses it, and a same-name/same-agent/same-schema entry replaces a
// canonical handler while preserving everything the mounted-registry proof inspects.
//
// The repair is the same shape as the core façade: remove the capability from the API the
// app can reach, rather than chase the spellings that reach it. `AssistantCopilotProvider`
// accepts exactly the configuration this app legitimately sets, and there is no prop on it
// through which a tool, a human-in-the-loop handler, a renderer or an agent can be
// injected. Oxlint restricts the raw provider to this module.
//
// Everything a model can call therefore arrives through one path: `useModelVisibleTool`.

import type { ReactNode } from "react";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";

/**
 * The configuration the assistant surface actually sets.
 *
 * Deliberately a closed list rather than a `Pick<>` of the library's props: a `Pick` would
 * silently gain any registration prop a future release adds to the names it selects, and
 * an `Omit` would silently gain any registration prop added under a NEW name. Writing the
 * three we use means a new library capability arrives switched off.
 */
export interface AssistantCopilotProviderProps {
  /** The same-origin runtime the provider handshakes with. */
  readonly runtimeUrl: string;
  /**
   * Evaluated per request, never captured at mount, so a credential replaced or removed
   * while the panel is open takes effect on the next request.
   */
  readonly headers: () => Record<string, string>;
  /** The Inspector renders conversation and tool payloads; this app's content is roster data. */
  readonly showDevConsole?: boolean;
  readonly children: ReactNode;
}

/**
 * Mount the CopilotKit provider with registration channels closed.
 *
 * The props below are the whole surface. Every registration channel the installed provider
 * accepts is dropped because it is never forwarded: `frontendTools`, `humanInTheLoop`,
 * `openGenerativeUI` (whose `sandboxFunctions` carry executable handlers),
 * `agents__unsafe_dev_only`, `selfManagedAgents`, and the render registries
 * `renderToolCalls`, `renderActivityMessages` and `renderCustomMessages`.
 *
 * HOW EACH IS PROVEN, stated exactly rather than in general:
 *
 *   * `assistant-copilot-provider.negative.test-d.ts` proves each name is absent from this
 *     props type, and that the direct, alias and indexed routes are type errors. A SPREAD
 *     of an already-typed value is NOT a type error -- TypeScript excess-checks object
 *     literals only -- so the type fixture cannot close that route.
 *   * `assistant-copilot-provider.test.tsx` closes the spread route at runtime for the two
 *     EXECUTABLE channels, `frontendTools` and `openGenerativeUI.sandboxFunctions`, each
 *     with a raw-provider control showing the library does accept the identical prop.
 *   * The remaining channels are closed by this component forwarding four named props and
 *     nothing else. That is an argument from the implementation, not a runtime case.
 */
export function AssistantCopilotProvider({
  runtimeUrl,
  headers,
  showDevConsole = false,
  children,
}: AssistantCopilotProviderProps) {
  return (
    <CopilotKitProvider runtimeUrl={runtimeUrl} headers={headers} showDevConsole={showDevConsole}>
      {children}
    </CopilotKitProvider>
  );
}
