"use client";

// THE ONE PLACE A MODEL-VISIBLE TOOL IS REGISTERED.
//
// Every tool the model can call goes through `useModelVisibleTool`, and this module is the
// only one allowed to reach CopilotKit's registration API. Both doors are closed by the
// ordinary `pnpm lint` run, not by a bespoke analyzer (see `.oxlintrc.json`):
//
//   * `no-restricted-imports` forbids `useFrontendTool` from EVERY installed public
//     specifier that exports it -- `@copilotkit/react-core`, `.../v2` and `.../v2/headless`
//     -- with one exemption for this file. The list is taken from the package's own
//     `exports` map rather than guessed; `.../v2/context` does not export the hook.
//
//   * `no-restricted-properties` forbids `.addTool` on any object, with exact exemptions
//     for the five test files that register deliberately non-model-visible fixture tools.
//     `no-restricted-syntax` does not exist in the pinned Oxlint, so the property rule is
//     the maintained mechanism that fits; its limitation is recorded below.
//
// WHY A WRAPPER AND NOT A PROOF. Three rounds of static analysis tried to show that every
// handler checked authority, then parsed its payload, then acted -- in that order, with no
// effect in between. Each version was walked past by ordinary TypeScript: an aliased
// import, a computed member call, a deleted `return`, an effect hidden inside the very
// helper the analysis trusted. The lesson is that the ordering was a CONVENTION every
// handler had to keep, and a convention needs a proof for each site.
//
// Here it is not a convention. A handler cannot see its raw arguments at all: the wrapper
// holds them, applies the turn-authority check and the host parse, and calls the handler
// with data that is already validated. There is no order left to get wrong, because there
// is only one implementation of it.
//
// WHAT THE WRAPPER GUARANTEES, for every registered tool:
//
//   1. the bound turn's authority is demanded before anything else happens, and its
//      refusal is RETURNED -- a superseded turn says nothing at all;
//   2. the payload is parsed against the tool's own declared schema, applying its declared
//      defaults, because CopilotKit's core does neither (see `./tool-payload`);
//   3. a malformed payload is answered with the shared bounded refusal, as a tool result
//      rather than a throw, before any read, navigation, repository or UI effect;
//   4. the handler receives `parsed.data` -- never the model's raw JSON.
//
// The captured token travels with the call, because a handler with an await inside it must
// re-check the SAME turn it began under rather than whatever is bound when it resumes.

import { useEffect } from "react";
import { useFrontendTool } from "@copilotkit/react-core/v2";
import type { z } from "zod";

import { assertTurnAuthority, currentTurnToken, type TurnToken } from "./turn-authority";
import { parseToolPayload } from "./tool-payload";
import { useRegistrationScope } from "./copilotkit-core-access";

/**
 * Every `(agentId, name)` currently mounted, PER PROVIDER CORE.
 *
 * WHY THE REGISTRY CANNOT ANSWER THIS. CopilotKit resolves a tool by `{ toolName, agentId }`
 * and its `addTool` DISCARDS a second registration for a live pair before it ever reaches
 * `core.tools`. So a duplicate -- the exact shape that silently replaces a safe handler --
 * is invisible to any proof that reads the final registry: a reviewer added a second
 * `get_schedule_overview` and every mounted assertion stayed green. Counting the ATTEMPT
 * is what makes it visible, and this is the only place every attempt passes through.
 *
 * WHY IT IS KEYED BY CORE. A collision is CORE-LOCAL. Two `CopilotKitProvider` roots own
 * two independent registries, so the same identity in both is not a collision at all --
 * and a module-global ledger rejected the second root, which is a false positive a test
 * harness hits immediately. Keying by the core matches the scope CopilotKit actually
 * enforces.
 *
 * A `WeakMap` so a retired provider's ledger is collectable with it; no cleanup hook has
 * to remember to drop it, and one leaked entry cannot poison a later unrelated root.
 */
const identitiesByCore = new WeakMap<object, Map<string, number>>();

function identityOf(agentId: string, name: string): string {
  return `${agentId}::${name}`;
}

function ledgerFor(scope: object): Map<string, number> {
  const existing = identitiesByCore.get(scope);
  if (existing) return existing;
  const created = new Map<string, number>();
  identitiesByCore.set(scope, created);
  return created;
}

/**
 * Claim one `(agentId, name)` within ONE provider core, and fail fast on a collision.
 *
 * A throw rather than a warning: a duplicate is a programming error whose effect is that
 * whichever module mounted last silently owns the tool. That is exactly the failure this
 * boundary exists to prevent, and it cannot be reached by any valid arrangement of the
 * shipped code.
 *
 * Claimed and released with the mount, so a remount, a dependency change and React's
 * StrictMode effect replay all net to zero rather than accumulating.
 */
function useExclusiveIdentity(agentId: string, name: string): void {
  // The core's IDENTITY only -- see `./copilotkit-core-access`. Not the core: this module
  // needs a key, and holding a mutable core here would reopen the door it closes.
  const scope = useRegistrationScope();
  useEffect(() => {
    const ledger = ledgerFor(scope);
    const key = identityOf(agentId, name);
    const held = ledger.get(key) ?? 0;
    if (held > 0) {
      throw new Error(
        `Duplicate model-visible tool registration for ${key}. CopilotKit resolves tools by ` +
          `(agentId, name) and silently keeps only one, so a second registration would ` +
          `replace the first without any surface showing it.`,
      );
    }
    ledger.set(key, held + 1);
    return () => {
      const current = ledger.get(key) ?? 0;
      if (current <= 1) ledger.delete(key);
      else ledger.set(key, current - 1);
    };
  }, [scope, agentId, name]);
}

/** What CopilotKit hands a tool handler. Narrowed to what our handlers may use. */
interface CopilotToolContext {
  readonly signal?: AbortSignal;
}

/** What a model-visible handler receives instead of the raw invocation context. */
export interface ModelVisibleToolContext {
  readonly signal?: AbortSignal;
  /**
   * The turn token captured at ENTRY, before any await.
   *
   * A handler that suspends must demand this same token afterwards: a callback resuming
   * under a newer turn would otherwise act with that turn's authority.
   */
  readonly token: TurnToken | null;
}

export interface ModelVisibleTool<S extends z.ZodTypeAny> {
  readonly name: string;
  readonly agentId: string;
  readonly description: string;
  /** The model-visible schema. Also the schema the host parses against. */
  readonly parameters: S;
  readonly handler: (args: z.infer<S>, context: ModelVisibleToolContext) => Promise<unknown>;
}

export interface ParameterlessModelVisibleTool {
  readonly name: string;
  readonly agentId: string;
  readonly description: string;
  /** No arguments at all: there is nothing to validate, so none are offered. */
  readonly handler: (context: ModelVisibleToolContext) => Promise<unknown>;
}

/**
 * Register one parameterized model-visible tool.
 *
 * `parameters` is used twice on purpose -- once as the shape offered to the model, once as
 * the shape the host enforces. They cannot drift apart, because they are the same value.
 */
export function useModelVisibleTool<S extends z.ZodTypeAny>(
  tool: ModelVisibleTool<S>,
  deps: readonly unknown[],
): void {
  useExclusiveIdentity(tool.agentId, tool.name);
  useFrontendTool(
    {
      name: tool.name,
      agentId: tool.agentId,
      description: tool.description,
      // THE ONE CAST IN THIS FILE, and it is a variance narrowing rather than a claim.
      // CopilotKit types `parameters` as a schema whose OUTPUT is `Record<string, unknown>`;
      // `S` is any Zod schema, so it is wider and TypeScript rejects the assignment. The
      // value is unchanged and every tool schema here is an object schema, so the runtime
      // shape already satisfies it -- and `parseToolPayload` below uses the SAME `S`,
      // uncast, which is what actually types the data the handler receives.
      parameters: tool.parameters as unknown as Parameters<typeof useFrontendTool>[0]["parameters"],
      handler: async (rawArgs: unknown, context: CopilotToolContext) => {
        // 1. AUTHORITY, and its refusal returned.
        const token = currentTurnToken();
        const refusal = assertTurnAuthority(token, context.signal);
        if (refusal) return refusal;

        // 2. THE HOST PARSE, against this tool's own schema. CopilotKit's core hands over
        //    `JSON.parse` output with no validation and no defaults applied.
        const payload = parseToolPayload(tool.parameters, rawArgs);
        if (!payload.ok) return payload.refusal;

        // 3. Only now does the tool's own code run, and only on validated data.
        return tool.handler(payload.data, { signal: context.signal, token });
      },
    },
    deps,
  );
}

/**
 * Register one model-visible tool that takes no arguments.
 *
 * Safe because there is nothing to validate: the handler is never offered the payload, so
 * it cannot read one. The authority check still applies -- a read is still an answer, and
 * an answer computed for a turn the user has replaced is a stale fact quoted as current.
 */
export function useParameterlessModelVisibleTool(
  tool: ParameterlessModelVisibleTool,
  deps: readonly unknown[],
): void {
  useExclusiveIdentity(tool.agentId, tool.name);
  useFrontendTool(
    {
      name: tool.name,
      agentId: tool.agentId,
      description: tool.description,
      handler: async (_rawArgs: unknown, context: CopilotToolContext) => {
        const token = currentTurnToken();
        const refusal = assertTurnAuthority(token, context.signal);
        if (refusal) return refusal;
        return tool.handler({ signal: context.signal, token });
      },
    },
    deps,
  );
}
