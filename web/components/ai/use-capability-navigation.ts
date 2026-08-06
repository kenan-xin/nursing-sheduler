"use client";

// The HOST's navigation action for a capability (T06).
//
// The model never navigates. It names a capability id; this hook resolves that id
// against the live registry, mode and gates, performs the route change itself, and
// then — crucially — RE-RESOLVES and confirms the exact element in the live DOM before
// it reports anything as done. A URL is constructed here and nowhere else, and it is
// never returned to the model.
//
// ARRIVAL IS AWAITED, NOT ASSUMED. `router.push` starts a client transition and
// returns; the URL commits later. So the sequence is push → wait boundedly for the
// exact target pathname → re-resolve → confirm the anchor. Sampling the pathname
// straight after the push reads the screen being LEFT, which is the healthy state of
// an in-flight navigation and must never be reported as a failure to arrive.
//
// WHY RE-RESOLVE AFTER THE PUSH. Between resolving and arriving, the user may have
// switched mode (which can hide the destination outright), the assistant may have been
// turned off, or a redeploy may have changed the client. Confirming the answer once,
// at the start, would let any of those produce a success report for a screen the user
// is not looking at.
//
// EVERY FAILURE IS `capability_unavailable` WITH NO SUBSTITUTE. Not the parent screen,
// not the nearest relative, not a route-only jump when a control was asked for.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  findLiveAnchor,
  revealAnchor,
  waitForLiveAnchor,
  type LiveAnchorLookup,
} from "@/lib/capability/live-anchor";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import {
  CAPABILITY_UNAVAILABLE,
  resolveNavigationTarget,
  type CapabilityUnavailableReason,
} from "@/lib/capability/resolve";
import { isAtRoutePath, waitForRouteArrival } from "@/lib/capability/route-arrival";
import type { CapabilityRegistryStamp } from "@/lib/capability/types";
import { readCapabilityContext } from "./capability-context";

export type CapabilityNavigationOutcome =
  | {
      /** Arrived, confirmed the anchor, and moved focus to a focusable control. */
      readonly status: "focused";
      readonly capabilityId: string;
      readonly routeId: string;
      readonly screenName: string;
      readonly controlLabel: string;
      readonly registry: CapabilityRegistryStamp;
    }
  | {
      /** Arrived and confirmed the anchor, but it is a container with nothing
       *  focusable inside it, so it was scrolled into view instead. An honest
       *  weaker claim than `focused`. */
      readonly status: "revealed";
      readonly capabilityId: string;
      readonly routeId: string;
      readonly screenName: string;
      readonly controlLabel: string;
      readonly registry: CapabilityRegistryStamp;
    }
  | {
      /** Arrived at a screen that declares no anchored control. */
      readonly status: "navigated";
      readonly capabilityId: string;
      readonly routeId: string;
      readonly screenName: string;
      readonly registry: CapabilityRegistryStamp;
    }
  | {
      readonly status: typeof CAPABILITY_UNAVAILABLE;
      readonly reason: CapabilityUnavailableReason | "route_not_reached";
      readonly registry: CapabilityRegistryStamp;
    };

export interface NavigateToCapabilityOptions {
  /** The registry identity the answer being acted on was produced under. */
  readonly stamp?: CapabilityRegistryStamp;
  /** How long to wait for the client transition to commit the target pathname. */
  readonly routeTimeoutMs?: number;
  /** How long to wait for a lazily-mounted route's anchor. */
  readonly anchorTimeoutMs?: number;
}

function anchorRefusal(lookup: LiveAnchorLookup): CapabilityUnavailableReason {
  return lookup.status === "ambiguous" ? "anchor_ambiguous" : "anchor_missing";
}

export type NavigateToCapability = (
  capabilityId: string,
  options?: NavigateToCapabilityOptions,
) => Promise<CapabilityNavigationOutcome>;

export function useCapabilityNavigation(): NavigateToCapability {
  const router = useRouter();

  return useCallback(
    async (capabilityId, options = {}) => {
      const before = resolveNavigationTarget(capabilityId, readCapabilityContext(options.stamp));
      if (before.status !== "ok") {
        return { status: CAPABILITY_UNAVAILABLE, reason: before.reason, registry: before.stamp };
      }

      const target = before.value;
      if (!isAtRoutePath(window.location, target.path)) {
        router.push(target.path);
        // AWAITED, not sampled. The push starts a client transition and returns, so the
        // pathname on the next line is still the screen being left -- the normal state
        // of a healthy navigation, and previously read as failure for every route-only
        // capability invoked from anywhere else.
        const arrival = await waitForRouteArrival(window.location, target.path, {
          timeoutMs: options.routeTimeoutMs,
        });
        if (arrival.status !== "arrived") {
          // A redirect, a route that bounced, a rejected transition and one that is
          // merely still pending are one refusal here. They are NOT told apart: after a
          // bounded wait the pathname alone cannot distinguish "somewhere else" from
          // "not yet", and a guess between them would put an invented cause into a
          // refusal. Either way the user is not on the screen we would be claiming.
          return {
            status: CAPABILITY_UNAVAILABLE,
            reason: "route_not_reached",
            registry: capabilityRegistryStamp(),
          };
        }
      }

      // Re-resolve under the context that is true AFTER arrival, not the one that
      // authorized the push. A mode change, a closed gate or a redeployed build
      // mid-flight makes the destination hidden, and the refusal must reflect that
      // rather than the earlier decision.
      const after = resolveNavigationTarget(capabilityId, readCapabilityContext(options.stamp));
      if (after.status !== "ok") {
        return { status: CAPABILITY_UNAVAILABLE, reason: after.reason, registry: after.stamp };
      }
      if (after.value.path !== target.path || after.value.anchorId !== target.anchorId) {
        // The registry resolved to a different place than the one just navigated to.
        // Reporting either would be wrong, so report neither.
        return {
          status: CAPABILITY_UNAVAILABLE,
          reason: "registry_version_changed",
          registry: after.stamp,
        };
      }

      // Arrival was true a moment ago; a guard that bounces on mount can move the user
      // between then and now. Re-checked so every outcome below describes where the
      // user actually IS, never where the push was aimed.
      if (!isAtRoutePath(window.location, after.value.path)) {
        return {
          status: CAPABILITY_UNAVAILABLE,
          reason: "route_not_reached",
          registry: after.stamp,
        };
      }

      const anchorId = after.value.anchorId;
      if (anchorId === null) {
        // No control was claimed, so confirmed arrival is the whole claim.
        return {
          status: "navigated",
          capabilityId,
          routeId: after.value.routeId,
          screenName: after.value.screenName,
          registry: after.stamp,
        };
      }

      // One synchronous look first: when the user is already on the screen there is
      // nothing to wait for, and the poll's first interval would be dead latency.
      const immediate = findLiveAnchor(document, anchorId);
      const lookup =
        immediate.status === "missing"
          ? await waitForLiveAnchor(document, anchorId, {
              timeoutMs: options.anchorTimeoutMs,
            })
          : immediate;

      if (lookup.status !== "ok") {
        return {
          status: CAPABILITY_UNAVAILABLE,
          reason: anchorRefusal(lookup),
          registry: after.stamp,
        };
      }

      const reveal = revealAnchor(lookup.element);
      return {
        status: reveal,
        capabilityId,
        routeId: after.value.routeId,
        screenName: after.value.screenName,
        controlLabel: after.value.controlLabel ?? anchorId,
        registry: after.stamp,
      };
    },
    [router],
  );
}
