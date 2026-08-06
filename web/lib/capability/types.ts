// The versioned capability/help registry's shapes (T06, tech-plan "Versioned help
// and capability registry").
//
// Every cross-reference is a TYPED id, never a duplicated string: `NavRouteId` comes
// from the navigation registry, `ControlAnchorId` from the owner-local anchor
// declarations, `AssistantToolName` from the tool name source, `ScenarioCommandType`
// from the repository's command union, `FeatureGate` from the shipped gate list.
// There is no `url`, `href` or `path` field anywhere in this file, and that is a
// contract rather than an omission: a help answer that could carry a raw URL is a
// help answer that can invent one.

import type { AppMode } from "@/lib/mode/mode";
import type { NavRouteId } from "@/components/shell/nav-config";
import type { ControlAnchorDeclaration } from "./anchor-contract";
import type { ControlAnchorId } from "./anchors";
import type { ScenarioCommandType } from "./commands";
import type { FeatureGate } from "./gates";
import type { AssistantToolName } from "./tools";

export interface CapabilityEntryV1 {
  /** Stable, unique, kebab-case. The only handle the model is ever given. */
  readonly id: string;
  /** Short display title. */
  readonly title: string;
  /**
   * One or two plain sentences a ward manager would recognise. This is the text a
   * help answer is grounded in, so it must describe what the app ACTUALLY does --
   * no aspirational behaviour, no solver guarantees, no URLs.
   */
  readonly nurseFacingSummary: string;
  /** Domain words this entry answers to, for concept lookup. */
  readonly concepts: readonly string[];
  /** The app modes in which this capability exists. Never empty. */
  readonly modes: readonly AppMode[];
  /** Gates that must ALL be open. Empty means ungated. */
  readonly featureGates: readonly FeatureGate[];
  /** The screen it lives on, if it has one. Concept-only entries have none. */
  readonly routeId?: NavRouteId;
  /** The exact control, if one is anchored. Requires `routeId`. */
  readonly controlAnchor?: ControlAnchorId;
  /** Read-only tools allowed to serve this entry. */
  readonly toolAccess: readonly AssistantToolName[];
  /** Durable command types the HOST's manual path commits here. Not model authority. */
  readonly supportedCommands: readonly ScenarioCommandType[];
}

/**
 * The immutable shipped registry.
 *
 * `appBuildVersion` is the deployed client's `APP_VERSION` stamp and `manifestSha256`
 * is the generated content hash. Together they are the identity a help answer or
 * receipt retains: the pair says "this answer was produced by this content, in this
 * build", which is what makes a later action against a redeployed client detectable
 * rather than plausible.
 */
export interface CapabilityRegistryV1 {
  readonly schemaVersion: 1;
  readonly appBuildVersion: string;
  readonly manifestSha256: string;
  readonly entries: readonly CapabilityEntryV1[];
  readonly anchors: readonly ControlAnchorDeclaration[];
}

/** The version identity carried on every help display, tool result and receipt. */
export interface CapabilityRegistryStamp {
  readonly appBuildVersion: string;
  readonly manifestSha256: string;
}
