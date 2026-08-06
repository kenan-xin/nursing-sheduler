// Resolving a capability against the LIVE mode, gates and build (T06).
//
// The registry is what the build shipped; this module is what is true right now. A
// help answer is only allowed to name a screen or a control after passing through
// here, and every failure is the same shape: `capability_unavailable` with a reason,
// no route, no anchor, no URL, and no substitute.
//
// WHY THERE IS NO "NEAREST SCREEN" FALLBACK. It is the single most tempting thing to
// add and the exact behaviour the product contract forbids: sending a nurse to a
// screen that merely looks related is worse than saying "I cannot show you that",
// because the second is recoverable and the first quietly teaches them the wrong
// place. Every branch below therefore ends in a refusal, not a downgrade.

import {
  findNavItemById,
  isRouteIdVisibleInMode,
  type NavRouteId,
} from "@/components/shell/nav-config";
import type { AppMode } from "@/lib/mode/mode";
import type { ControlAnchorId } from "./anchors";
import { routePathFor } from "./build-manifest";
import type { FeatureGate } from "./gates";
import { capabilityRegistryStamp, getCapabilityRegistry } from "./registry";
import type { CapabilityEntryV1, CapabilityRegistryStamp } from "./types";

/** The one refusal code. Stable, and the only failure detail a caller reports. */
export const CAPABILITY_UNAVAILABLE = "capability_unavailable" as const;

export type CapabilityUnavailableReason =
  /** No entry with that id in the shipped registry. */
  | "unknown_capability"
  /** The stored mode preference has not been adopted yet, so mode is not yet known. */
  | "mode_unresolved"
  /** The capability, or its screen, does not exist in the current mode. */
  | "mode_hidden"
  /** A required feature gate is closed. */
  | "gate_closed"
  /** The caller resolved under a different build/manifest than the live one. */
  | "registry_version_changed"
  /** The capability is a concept explanation with no screen to open. */
  | "no_screen"
  /** The declared control is not in the live DOM after navigation. */
  | "anchor_missing"
  /** Two elements claim the anchor, so no single target exists. */
  | "anchor_ambiguous";

export interface CapabilityContext {
  readonly mode: AppMode;
  /**
   * Whether `mode` reflects the user's stored preference yet. The mode store renders
   * the Guided default on the server and adopts the persisted value after mount, so
   * acting before adoption could hide every Advanced capability from an Advanced
   * user. Unresolved is a refusal, not a guess.
   */
  readonly modeResolved: boolean;
  readonly gates: readonly FeatureGate[];
  /**
   * The stamp the caller's answer was produced under, when re-checking a decision
   * made earlier. Omit when resolving fresh.
   */
  readonly stamp?: CapabilityRegistryStamp;
}

export interface CapabilityUnavailable {
  readonly status: typeof CAPABILITY_UNAVAILABLE;
  readonly reason: CapabilityUnavailableReason;
  readonly stamp: CapabilityRegistryStamp;
}

export interface CapabilityAvailable<T> {
  readonly status: "ok";
  readonly value: T;
  readonly stamp: CapabilityRegistryStamp;
}

export type CapabilityResult<T> = CapabilityAvailable<T> | CapabilityUnavailable;

function unavailable(reason: CapabilityUnavailableReason): CapabilityUnavailable {
  return Object.freeze({
    status: CAPABILITY_UNAVAILABLE,
    reason,
    stamp: capabilityRegistryStamp(),
  });
}

function available<T>(value: T): CapabilityAvailable<T> {
  return Object.freeze({ status: "ok", value, stamp: capabilityRegistryStamp() });
}

/**
 * The gate/build/mode preconditions every resolution shares. Returns a refusal, or
 * null when the context itself is usable.
 */
function checkContext(context: CapabilityContext): CapabilityUnavailable | null {
  if (context.stamp) {
    const live = capabilityRegistryStamp();
    if (
      context.stamp.appBuildVersion !== live.appBuildVersion ||
      context.stamp.manifestSha256 !== live.manifestSha256
    ) {
      return unavailable("registry_version_changed");
    }
  }
  if (!context.modeResolved) return unavailable("mode_unresolved");
  return null;
}

/** Whether an entry exists for this mode and has every gate it needs open. */
function entryAvailability(
  entry: CapabilityEntryV1,
  context: CapabilityContext,
): CapabilityUnavailableReason | null {
  if (!entry.modes.includes(context.mode)) return "mode_hidden";
  for (const gate of entry.featureGates) {
    if (!context.gates.includes(gate)) return "gate_closed";
  }
  // Re-derived from the navigation registry rather than trusted from the manifest:
  // the manifest was validated at build time, but this is the check that a route
  // hidden by the LIVE mode filter is never offered, and it reads the same projection
  // the sidebar renders.
  if (entry.routeId !== undefined && !isRouteIdVisibleInMode(entry.routeId, context.mode)) {
    return "mode_hidden";
  }
  return null;
}

/** A capability as the model is allowed to see it: ids and prose, never a URL. */
export interface CapabilitySummary {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly concepts: readonly string[];
  /** Whether opening a screen is possible for this entry in this context. */
  readonly hasScreen: boolean;
  /** Whether an exact control is anchored (still confirmed live before use). */
  readonly hasControl: boolean;
}

function toSummary(entry: CapabilityEntryV1): CapabilitySummary {
  return Object.freeze({
    id: entry.id,
    title: entry.title,
    summary: entry.nurseFacingSummary,
    concepts: entry.concepts,
    hasScreen: entry.routeId !== undefined,
    hasControl: entry.controlAnchor !== undefined,
  });
}

/** Every capability available in this context. Never partial: refuse or answer. */
export function listCapabilities(
  context: CapabilityContext,
): CapabilityResult<readonly CapabilitySummary[]> {
  const refusal = checkContext(context);
  if (refusal) return refusal;
  const summaries = getCapabilityRegistry()
    .entries.filter((entry) => entryAvailability(entry, context) === null)
    .map(toSummary);
  return available(Object.freeze(summaries));
}

/** One capability, resolved against the live context. */
export function resolveCapability(
  capabilityId: string,
  context: CapabilityContext,
): CapabilityResult<CapabilityEntryV1> {
  const refusal = checkContext(context);
  if (refusal) return refusal;
  const entry = getCapabilityRegistry().entries.find((candidate) => candidate.id === capabilityId);
  if (!entry) return unavailable("unknown_capability");
  const reason = entryAvailability(entry, context);
  if (reason) return unavailable(reason);
  return available(entry);
}

/**
 * Where a capability lives. `path` is derived from the navigation registry at the
 * moment of use, which is why the registry itself stores no path: a route rename is
 * a nav-config change and nothing else.
 */
export interface NavigationTarget {
  readonly capabilityId: string;
  readonly routeId: NavRouteId;
  /** The screen's own navigation label — what the sidebar calls it. Not a URL. */
  readonly screenName: string;
  readonly path: string;
  readonly anchorId: ControlAnchorId | null;
  /** Plain-language name of the anchored control, when there is one. */
  readonly controlLabel: string | null;
}

/**
 * Resolve a navigation target. Refuses with `no_screen` for a concept-only entry
 * rather than sending the user to a plausible screen.
 */
export function resolveNavigationTarget(
  capabilityId: string,
  context: CapabilityContext,
): CapabilityResult<NavigationTarget> {
  const resolved = resolveCapability(capabilityId, context);
  if (resolved.status !== "ok") return resolved;
  const entry = resolved.value;
  if (entry.routeId === undefined) return unavailable("no_screen");

  const anchorId = entry.controlAnchor ?? null;
  const declaration = anchorId
    ? getCapabilityRegistry().anchors.find((candidate) => candidate.anchorId === anchorId)
    : undefined;
  // Validated at build time, so a miss here means the running registry disagrees with
  // the content it was hashed from. Refuse rather than navigate anchor-less: silently
  // dropping to a route-only jump would report success for a control question.
  if (anchorId && !declaration) return unavailable("anchor_missing");

  return available(
    Object.freeze({
      capabilityId: entry.id,
      routeId: entry.routeId,
      screenName: findNavItemById(entry.routeId).label,
      path: routePathFor(entry.routeId),
      anchorId,
      controlLabel: declaration?.label ?? null,
    }),
  );
}
