"use client";

// The assistant's read-only help and rule-guidance tools (T06).
//
// FOUR TOOLS, NONE OF WHICH CAN CHANGE ANYTHING. Three read the versioned capability
// registry; the fourth asks the HOST to take the user somewhere. There is no proposal,
// no Apply, no diagnosis and no scenario write here, and nothing in this module can
// reach one.
//
// WHAT THE MODEL IS AND IS NOT GIVEN. It gets capability IDS, plain-language summaries,
// concept words, and the screen's own navigation label. It does not get a path, a URL,
// an href, or a DOM selector — so "link to the exact screen" is something the model
// asks the host to do, not something it can compose. `open_app_screen` returns what
// happened, again by id and label.
//
// EVERY RESULT CARRIES THE REGISTRY STAMP. `appBuildVersion` + `manifestSha256` travel
// with each answer so the panel can display them and a later action can be re-checked
// against the live build rather than trusted.
//
// TURN AUTHORIZATION IS THE CALLER'S, NOT OURS. `turnEpoch` is the authorization the
// session hook hands down; this module compares the LIVE epoch against that captured
// value and never re-reads the store to establish a baseline of its own. On
// interruption the caller passes a cleared value, so the comparison stays permanently
// closed for the abandoned turn instead of re-arming itself.

import { useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { useAssistantStore } from "@/lib/ai/assistant/store";
import { suggestRuleCandidates } from "@/lib/capability/guidance";
import {
  CAPABILITY_UNAVAILABLE,
  listCapabilities,
  resolveCapability,
} from "@/lib/capability/resolve";
import { readCapabilityContext } from "./capability-context";
import { useCapabilityNavigation } from "./use-capability-navigation";

/**
 * What a handler answers when its turn is no longer the authorized one. A refusal
 * string rather than a throw, matching the read tools next door: a thrown tool error
 * reads to the model as a failure worth retrying, while this says there is nothing to
 * say.
 */
const SUPERSEDED = "superseded: this request belongs to an interrupted turn and was not answered.";

const capabilityIdParameters = z.object({
  capabilityId: z
    .string()
    .describe(
      "The id of a capability returned by list_app_capabilities. Must be one of those " +
        "exact ids; do not guess, shorten or invent one.",
    ),
});

const policyParameters = z.object({
  policy: z
    .string()
    .describe(
      "The ward policy or goal the user described, in their own words — for example " +
        "'no day shift straight after a night shift' or 'two seniors on every night'.",
    ),
});

/**
 * Register the read-only help tools against ONE agent instance.
 *
 * @param agentId Scopes the tools to this panel's private thread-scoped agent.
 * @param turnEpoch The authorized turn epoch handed down by the session. Compared
 *   against the live epoch on every invocation; never used to derive a new baseline.
 */
export function useHelpTools(agentId: string, turnEpoch: number): void {
  const navigate = useCapabilityNavigation();

  const guard = (signal: AbortSignal | undefined): string | null => {
    if (signal?.aborted) return SUPERSEDED;
    if (useAssistantStore.getState().turnEpoch !== turnEpoch) return SUPERSEDED;
    return null;
  };

  useFrontendTool(
    {
      name: "list_app_capabilities",
      agentId,
      description:
        "List everything this app can actually do, as capability ids with plain-language " +
        "summaries, filtered to what exists in the user's current mode. Call this FIRST " +
        "before answering any question about how the app works, which screen something is " +
        "on, or what a scheduling term means. Never describe a screen, field, rule kind or " +
        "capability that is not in this list.",
      handler: async (_args, context) => {
        const refusal = guard(context.signal);
        if (refusal) return refusal;
        const listed = listCapabilities(readCapabilityContext());
        if (listed.status !== "ok") {
          return { status: CAPABILITY_UNAVAILABLE, reason: listed.reason, registry: listed.stamp };
        }
        return { capabilities: listed.value, registry: listed.stamp };
      },
    },
    [agentId, turnEpoch],
  );

  useFrontendTool(
    {
      name: "explain_app_capability",
      agentId,
      description:
        "Read one capability in full: what it does in ward language, the concepts it covers, " +
        "whether it has a screen and an exact control, and whether changes made there are " +
        "undoable. Use this to ground an explanation. It returns no link — call " +
        "open_app_screen if the user should be taken there.",
      parameters: capabilityIdParameters,
      handler: async (args, context) => {
        const refusal = guard(context.signal);
        if (refusal) return refusal;
        const resolved = resolveCapability(args.capabilityId, readCapabilityContext());
        if (resolved.status !== "ok") {
          return {
            status: CAPABILITY_UNAVAILABLE,
            reason: resolved.reason,
            registry: resolved.stamp,
          };
        }
        const entry = resolved.value;
        return {
          id: entry.id,
          title: entry.title,
          summary: entry.nurseFacingSummary,
          concepts: entry.concepts,
          availableInModes: entry.modes,
          hasScreen: entry.routeId !== undefined,
          hasExactControl: entry.controlAnchor !== undefined,
          // Stated rather than implied: the model is told, in the tool result, that
          // reading this entry grants it nothing.
          changesAreUserApplied: true,
          hostWriteKinds: entry.supportedCommands,
          registry: resolved.stamp,
        };
      },
    },
    [agentId, turnEpoch],
  );

  useFrontendTool(
    {
      name: "suggest_scheduling_rule",
      agentId,
      description:
        "Given a ward policy the user described, return the supported app rules that could " +
        "express it, best match first. An EMPTY list is a real answer and means the app " +
        "cannot express that policy — say so plainly instead of offering the closest rule. " +
        "This suggests only; it configures nothing.",
      parameters: policyParameters,
      handler: async (args, context) => {
        const refusal = guard(context.signal);
        if (refusal) return refusal;
        const suggested = suggestRuleCandidates(args.policy, readCapabilityContext());
        if (suggested.status !== "ok") {
          return {
            status: CAPABILITY_UNAVAILABLE,
            reason: suggested.reason,
            registry: suggested.stamp,
          };
        }
        return {
          candidates: suggested.value,
          // The guidance boundary, restated in the payload the model reads: the app
          // encodes a confirmed policy, it does not supply or vouch for one.
          note:
            "These are the app's supported rules only. The app cannot confirm employment, " +
            "legal or clinical-safety policy, and cannot enforce anything not written down " +
            "as a rule.",
          registry: suggested.stamp,
        };
      },
    },
    [agentId, turnEpoch],
  );

  useFrontendTool(
    {
      name: "open_app_screen",
      agentId,
      description:
        "Ask the app to take the user to the screen for a capability, and to highlight its " +
        "exact control when it has one. Supply a capability id; the app resolves the screen " +
        "itself and confirms the control is really on the page before reporting success. If " +
        "it answers capability_unavailable, tell the user you cannot show them that — do not " +
        "describe another screen instead.",
      parameters: capabilityIdParameters,
      handler: async (args, context) => {
        const refusal = guard(context.signal);
        if (refusal) return refusal;
        const outcome = await navigate(args.capabilityId);
        // Re-checked AFTER the await: navigation is the one help action with real
        // latency, so an interruption during it must not land the user on a screen and
        // then report it to a turn that no longer exists.
        const late = guard(context.signal);
        if (late) return late;
        return outcome;
      },
    },
    [agentId, turnEpoch, navigate],
  );
}
