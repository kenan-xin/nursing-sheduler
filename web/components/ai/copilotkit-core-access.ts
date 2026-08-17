"use client";

// THE ONLY MODULE THAT MAY HOLD THE PROVIDER'S COPILOTKIT CORE.
//
// WHY THIS EXISTS. Restricting `useFrontendTool` and `.addTool` closed the registration
// APIs by name, but the session still received the whole mutable core from
// `useCopilotKit()`. A reviewer replaced a live handler with:
//
//   copilotkit.setTools(copilotkit.tools.map((tool) =>
//     tool.name === "get_schedule_overview" && tool.agentId === agentId
//       ? { ...tool, handler: async () => "unsafe replacement" }
//       : tool))
//
// That passed lint and typecheck and left every mounted-registry assertion green: the
// name multiset, the agent id and the schema object were all preserved, and only the
// handler -- the thing that performs the authority check and the host parse -- was
// swapped. The mounted proof cannot see that, and should not be asked to: it proves what
// is registered, not who wrote it.
//
// Chasing this with more lint rules is the wrong shape of fix. `setTools`, `removeTool`,
// `Reflect.get(core, "addTool")` and a computed property name are all different spellings
// of the same capability, and the governing spec is explicit that spelling-only rules do
// not own a data-flow boundary.
//
// SO THE CAPABILITY IS REMOVED INSTEAD OF FORBIDDEN. Ordinary production modules never
// receive a core. They consume exactly two EXPORTS from this module:
//
//   * `useAssistantTurnRunner()` -- a factory returning a frozen `{ run, errored, dispose }`
//     runner. It builds the per-turn core INTERNALLY; the caller never sees a core, a
//     tool, a mutator, or anything that yields one.
//   * `useRegistrationScope()` -- the provider core's IDENTITY, as an inert, frozen,
//     null-prototype token. A `WeakMap` key and nothing else: the token has no members,
//     so no property, index, destructuring or alias route recovers a mutator.
//
// `useAssistantTurnBasis()` is PRIVATE on purpose: it returns the configuration data the
// runner needs, and handing configuration to ordinary code was one step from handing it a
// core. Only `useAssistantTurnRunner` calls it.
//
// `copilotkit-core-access.negative.test-d.ts` proves the RUNNER surface (not the basis)
// carries no mutator against the compiler, and `copilotkit-core-access.test.tsx` proves the
// scope token exposes nothing at runtime.
//
// Oxlint restricts `useCopilotKit` to this module (see `.oxlintrc.json`), which is what
// makes "ordinary modules cannot get a core" true rather than conventional.

import { useCallback } from "react";
import { CopilotKitCore, useCopilotKit } from "@copilotkit/react-core/v2";
import type { AbstractAgent } from "@ag-ui/client";

type CoreConfig = NonNullable<ConstructorParameters<typeof CopilotKitCore>[0]>;

/**
 * The public configuration of the panel's core, as data.
 *
 * Exactly the fields `useAssistantSession` passes to its per-turn core, plus the
 * runtime-disable overrides it has to carry across. Deliberately a value type: a method
 * here would be a capability, and the point of this module is that ordinary code holds
 * none.
 */
interface AssistantTurnBasis {
  readonly runtimeUrl: CoreConfig["runtimeUrl"];
  readonly runtimeTransport: CoreConfig["runtimeTransport"];
  readonly headers: CoreConfig["headers"];
  readonly credentials: CoreConfig["credentials"];
  readonly properties: CoreConfig["properties"];
  readonly debug: CoreConfig["debug"];
  /**
   * An immutable snapshot of the registered tools.
   *
   * Frozen shallow copies, not the live objects: handing over the parent's own entries
   * would let a change to `available` reach a run already in flight, which is the
   * opposite of "the tools this turn was authorised with".
   */
  readonly tools: CoreConfig["tools"];
  /**
   * Tools an operator has turned off, resolved from the parent's run handler.
   *
   * Carried separately because the disable lives there rather than in `tools`, so a turn
   * built from the list alone would silently re-enable them.
   */
  readonly disabledTools: readonly {
    readonly name: string;
    readonly agentId: string | undefined;
  }[];
}

/**
 * ONE TURN'S RUNTIME CAPABILITY, and nothing more.
 *
 * WHY THIS EXISTS. The session used to construct its own per-turn `CopilotKitCore`. That
 * is legitimate work -- a turn needs its own core so Stop cannot abort a later turn -- but
 * it meant ordinary session code held a mutable core again, one step further along. A
 * reviewer called `turnCore.setTools(...)` on it, replaced a canonical handler with the
 * same name, agent and exact schema object, and passed lint, typecheck and every mounted
 * assertion: the parent provider's registry was untouched, and the mounted proof reads the
 * parent.
 *
 * `CopilotKitCore` reaches the app through the package's `export * from "@copilotkit/core"`
 * wildcard, so restricting the React subclass by name never closed it. The base class and
 * `RunHandler` are now restricted outside this module, and what a turn receives is this:
 * run, ask whether the core errored, dispose. No tools, no registry, no mutator, and no
 * route back to the core -- not through a return value, a closure, an error or a
 * subscription.
 */
export interface AssistantTurnRunner {
  /**
   * Drive one turn through CopilotKit's own public run loop.
   *
   * The library attaches the registered tools, executes their handlers, inserts the
   * tool-result messages and drives its bounded follow-up hops. Nothing about that is
   * reimplemented here.
   */
  run(input: { agent: AbstractAgent; runId: string }): Promise<void>;
  /**
   * Whether this turn's core reported ANY error.
   *
   * A boolean, deliberately: a core error object can carry request content, and the
   * panel's message is the same in every case, so the turn needs the class and nothing
   * else.
   */
  errored(): boolean;
  /** Release the error subscription. Idempotent. */
  dispose(): void;
}

/**
 * Build one isolated per-turn runner from the panel core's public configuration.
 *
 * Every behaviour the session had inline is preserved exactly: the immutable frozen tool
 * snapshot, the runtime-disable overrides re-applied through the public pair, the same
 * runtime URL, transport, headers, credentials, properties and debug settings, and
 * `deferInitialConnection` so a per-turn core does not repeat the panel's `/info`
 * handshake.
 */
export function useAssistantTurnRunner(): () => AssistantTurnRunner {
  const readBasis = useAssistantTurnBasis();
  return useCallback((): AssistantTurnRunner => {
    const basis = readBasis();
    // ISOLATED PER TURN. One core for the whole panel meant Stop's abort controller was
    // shared, so stopping turn A suppressed turn B's follow-up hop.
    const core = new CopilotKitCore({
      runtimeUrl: basis.runtimeUrl,
      runtimeTransport: basis.runtimeTransport,
      headers: basis.headers,
      credentials: basis.credentials,
      properties: basis.properties,
      // The frozen snapshot from the basis: the turn runs the tools it was authorised
      // with, not whatever the parent registry holds by the time a hop lands.
      tools: basis.tools,
      debug: basis.debug,
      deferInitialConnection: true,
    });

    // Runtime disable overrides live in the parent's run handler, NOT in `tools`, so
    // constructing from the tool list alone would silently re-enable anything an
    // operator turned off. Carried across through the public pair.
    for (const disabled of basis.disabledTools) {
      core.setToolEnabled(disabled.name, false, disabled.agentId);
    }

    // The parent's error subscribers do not transfer to a core we constructed, so this
    // turn owns its own.
    let errored = false;
    const errors = core.subscribe({
      onError: () => {
        errored = true;
      },
    });

    // Frozen, and every member is a function: there is no property on the returned object
    // that is or yields the core, so nothing here can be walked back to a mutator.
    return Object.freeze({
      run: async (input: { agent: AbstractAgent; runId: string }) => {
        await core.runAgent({ agent: input.agent, runId: input.runId });
      },
      errored: () => errored,
      dispose: () => errors.unsubscribe(),
    });
  }, [readBasis]);
}

/**
 * Read the panel core's public configuration at the moment of a send.
 *
 * A reader rather than a value: sampled inside the send callback, after every authority
 * check, so the turn is built from what is registered then. Not exported: the only thing
 * that needs it is {@link useAssistantTurnRunner}, and handing configuration to ordinary
 * code was one step away from handing it a core.
 */
function useAssistantTurnBasis(): () => AssistantTurnBasis {
  const { copilotkit } = useCopilotKit();
  return useCallback((): AssistantTurnBasis => {
    const tools = copilotkit.tools.map((tool) => Object.freeze({ ...tool }));
    const disabledTools = copilotkit.tools
      .filter((tool) => !copilotkit.isToolEnabled(tool.name, tool.agentId))
      .map((tool) => Object.freeze({ name: tool.name, agentId: tool.agentId }));
    return Object.freeze({
      runtimeUrl: copilotkit.runtimeUrl,
      runtimeTransport: copilotkit.runtimeTransport,
      headers: { ...copilotkit.headers },
      credentials: copilotkit.credentials,
      properties: { ...copilotkit.properties },
      debug: copilotkit.debug,
      tools,
      disabledTools,
    });
  }, [copilotkit]);
}

/**
 * One inert token per provider core.
 *
 * WHY A TOKEN AND NOT THE CORE. This used to return `copilotkit` itself, typed `object`.
 * TypeScript erases that annotation, so at runtime the value still carried `setTools`,
 * `addTool`, `tools` and every other member on its prototype -- and a reviewer recovered
 * all of them with `Reflect.get`, then replaced every handler while preserving name, agent
 * and schema. Normal lint and typecheck both passed. A type annotation is not a boundary.
 *
 * The token is what the ledger actually needs: per-core IDENTITY, with no capability
 * attached. `Object.create(null)` gives it no prototype -- not even `Object.prototype` --
 * and `Object.freeze` stops anything being added later, so there is nothing for a property
 * read, a cast or `Reflect.get` to find. The mapping is private to this module, and a
 * `WeakMap` keeps it collectable with the provider it describes.
 */
const scopeTokens = new WeakMap<object, object>();

export function useRegistrationScope(): object {
  const { copilotkit } = useCopilotKit();
  const existing = scopeTokens.get(copilotkit);
  if (existing) return existing;
  // Null-prototype AND frozen: no inherited members, no added ones. Stable per core, so
  // the ledger sees one scope for one provider across every render and remount.
  const token = Object.freeze(Object.create(null) as object);
  scopeTokens.set(copilotkit, token);
  return token;
}
