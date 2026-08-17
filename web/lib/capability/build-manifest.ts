// The generator and validator for the shipped capability manifest (T06).
//
// This is the "build step" the technical plan calls for, expressed as a pure
// function over the typed sources rather than as a codegen pass that emits a second
// copy of the content. It imports the navigation registry, the anchor manifest, the
// tool-name source, the repository command union and the help content; validates
// every cross-reference; and produces the canonical bytes whose SHA-256 is the
// manifest hash.
//
// WHY DERIVE-AND-HASH RATHER THAN EMIT-THE-ENTRIES. What the ticket needs is that the
// shipped registry is (a) derived from the typed sources, (b) immutable at runtime,
// (c) hash-bound, and (d) impossible to change without failing a gate. Deriving from
// frozen sources at module load plus a COMMITTED hash gives all four: the derivation
// is pure, the result is frozen, and `registry.generated.ts` is the recorded hash
// that `registry.generated.test.ts` recomputes on every run. Emitting the entries
// again would add a second place for the same content to go stale without adding any
// property -- and the freshness test would then be checking generated text against
// generated text.
//
// VALIDATION IS TOTAL AND FAIL-CLOSED. `validateCapabilitySources` returns EVERY
// problem it finds rather than the first, because a stale-anchor rename usually
// breaks several entries at once and fixing them one build at a time is how a drift
// gate becomes something people route around. `buildCapabilityManifest` throws if
// there is even one problem, so a broken registry cannot be a degraded registry.

import {
  findNavItemById,
  isRouteIdVisibleInMode,
  NAV_ROUTE_IDS,
  type NavRouteId,
} from "@/components/shell/nav-config";
import type { AppMode } from "@/lib/mode/mode";
import { canonicalJson } from "./canonical";
import type { ControlAnchorDeclaration } from "./anchor-contract";
import { CONTROL_ANCHOR_DECLARATIONS } from "./anchors";
import { SCENARIO_COMMAND_TYPES } from "./commands";
import { FEATURE_GATES } from "./gates";
import { CAPABILITY_ENTRIES } from "./help-content";
import { ASSISTANT_TOOL_NAMES } from "./tools";
import type { CapabilityEntryV1 } from "./types";

/** The registry's own schema version, independent of the app build. */
export const CAPABILITY_SCHEMA_VERSION = 1 as const;

const APP_MODES: readonly AppMode[] = Object.freeze(["guided", "advanced"]);

/**
 * Routes that legitimately carry no capability entry.
 *
 * `home` is a navigation overview of the other screens: every capability it surfaces
 * is described by the entry for the screen that owns it, so an entry here would be a
 * second, divergent description of the same things. Any OTHER route missing an entry
 * is a screen that shipped without help content, which is a validation failure --
 * that is the point of enumerating the exception instead of skipping the check.
 */
export const ROUTES_WITHOUT_CAPABILITY_ENTRY: readonly NavRouteId[] = Object.freeze(["home"]);

/**
 * Everything the manifest is built from. Injectable so the validator can be tested
 * against deliberately broken sources -- a duplicate id, a renamed anchor, a
 * mode-impossible entry -- without shipping any of them.
 */
export interface CapabilitySources {
  readonly routeIds: readonly NavRouteId[];
  readonly anchors: readonly ControlAnchorDeclaration[];
  readonly toolNames: readonly string[];
  readonly commandTypes: readonly string[];
  readonly featureGates: readonly string[];
  readonly entries: readonly CapabilityEntryV1[];
  /** Whether a route is reachable in a mode. Injected so tests need no nav fixture. */
  readonly routeVisibleInMode: (routeId: NavRouteId, mode: AppMode) => boolean;
  readonly routesWithoutEntry: readonly NavRouteId[];
}

/** The shipped sources. The only argument production code ever passes. */
export const SHIPPED_CAPABILITY_SOURCES: CapabilitySources = Object.freeze({
  routeIds: NAV_ROUTE_IDS,
  anchors: CONTROL_ANCHOR_DECLARATIONS,
  toolNames: ASSISTANT_TOOL_NAMES,
  commandTypes: SCENARIO_COMMAND_TYPES,
  featureGates: FEATURE_GATES,
  entries: CAPABILITY_ENTRIES,
  routeVisibleInMode: isRouteIdVisibleInMode,
  routesWithoutEntry: ROUTES_WITHOUT_CAPABILITY_ENTRY,
});

/** Kebab-case, dot-separated segments. Keeps anchor ids safe inside a selector. */
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** A scheme or protocol-relative prefix. Nurse-facing text must never carry one. */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/|^\/\//i;

/**
 * Every problem with these sources, sorted. Empty means the manifest is valid.
 *
 * Message format is `"<subject>: <problem>"` so a failing build reads as a list of
 * things to fix rather than a stack trace.
 */
export function validateCapabilitySources(sources: CapabilitySources): readonly string[] {
  const problems: string[] = [];
  const routeIds = new Set<string>(sources.routeIds);
  const toolNames = new Set(sources.toolNames);
  const commandTypes = new Set(sources.commandTypes);
  const featureGates = new Set(sources.featureGates);

  // --- anchors ------------------------------------------------------------
  const anchorById = new Map<string, ControlAnchorDeclaration>();
  for (const anchor of sources.anchors) {
    if (!ID_PATTERN.test(anchor.anchorId)) {
      problems.push(`anchor "${anchor.anchorId}": id is not kebab-case dot-separated`);
    }
    if (anchorById.has(anchor.anchorId)) {
      // A duplicate is not a merge candidate: two components each believe they own
      // the target, so the live-DOM check would find two elements and every
      // navigation to it would be ambiguous.
      problems.push(`anchor "${anchor.anchorId}": declared more than once`);
    } else {
      anchorById.set(anchor.anchorId, anchor);
    }
    if (!routeIds.has(anchor.routeId)) {
      problems.push(`anchor "${anchor.anchorId}": route "${anchor.routeId}" is not a known route`);
    }
    if (anchor.label.trim() === "") {
      problems.push(`anchor "${anchor.anchorId}": label is empty`);
    }
  }

  // --- entries ------------------------------------------------------------
  const seenEntryIds = new Set<string>();
  const routesWithEntry = new Set<string>();
  for (const entry of sources.entries) {
    const subject = `capability "${entry.id}"`;
    if (!ID_PATTERN.test(entry.id)) problems.push(`${subject}: id is not kebab-case`);
    if (seenEntryIds.has(entry.id)) problems.push(`${subject}: declared more than once`);
    seenEntryIds.add(entry.id);

    if (entry.title.trim() === "") problems.push(`${subject}: title is empty`);
    if (entry.nurseFacingSummary.trim() === "") problems.push(`${subject}: summary is empty`);
    if (URL_PATTERN.test(entry.nurseFacingSummary)) {
      // The whole point of returning ids is that a help answer cannot carry a link
      // the app has not verified. Content that embeds one bypasses that.
      problems.push(`${subject}: summary contains a URL`);
    }
    if (entry.concepts.length === 0) problems.push(`${subject}: declares no concepts`);

    if (entry.modes.length === 0) problems.push(`${subject}: declares no modes`);
    for (const mode of entry.modes) {
      if (!APP_MODES.includes(mode)) problems.push(`${subject}: unknown mode "${mode}"`);
    }

    for (const gate of entry.featureGates) {
      if (!featureGates.has(gate)) problems.push(`${subject}: unknown feature gate "${gate}"`);
    }
    for (const tool of entry.toolAccess) {
      if (!toolNames.has(tool)) problems.push(`${subject}: unknown tool "${tool}"`);
    }
    for (const command of entry.supportedCommands) {
      if (!commandTypes.has(command)) {
        problems.push(`${subject}: unknown command type "${command}"`);
      }
    }

    if (entry.routeId !== undefined) {
      if (!routeIds.has(entry.routeId)) {
        problems.push(`${subject}: route "${entry.routeId}" is not a known route`);
      } else {
        routesWithEntry.add(entry.routeId);
        // An entry may not claim a mode in which its own screen is hidden. Without
        // this, a Guided user could be told to open a screen the Guided sidebar
        // does not list and the route-validity gate would bounce them Home.
        for (const mode of entry.modes) {
          if (!sources.routeVisibleInMode(entry.routeId, mode)) {
            problems.push(
              `${subject}: claims mode "${mode}" but route "${entry.routeId}" is hidden there`,
            );
          }
        }
      }
    }

    if (entry.controlAnchor !== undefined) {
      const anchor = anchorById.get(entry.controlAnchor);
      if (!anchor) {
        // The stale/renamed-anchor case: content still names a control no component
        // declares any more.
        problems.push(`${subject}: control anchor "${entry.controlAnchor}" is not declared`);
      } else if (entry.routeId === undefined) {
        problems.push(`${subject}: has a control anchor but no route`);
      } else if (anchor.routeId !== entry.routeId) {
        // An anchor is reachable only through the screen that renders it; letting an
        // entry point at another screen's anchor would navigate somewhere the
        // element is not, and the live-DOM check would then fail every time.
        problems.push(
          `${subject}: control anchor "${entry.controlAnchor}" belongs to route ` +
            `"${anchor.routeId}", not "${entry.routeId}"`,
        );
      }
    }
  }

  // --- coverage -----------------------------------------------------------
  const exempt = new Set<string>(sources.routesWithoutEntry);
  for (const routeId of sources.routeIds) {
    if (exempt.has(routeId) || routesWithEntry.has(routeId)) continue;
    problems.push(`route "${routeId}": no capability entry describes this screen`);
  }
  for (const routeId of sources.routesWithoutEntry) {
    if (!routeIds.has(routeId)) {
      problems.push(`route "${routeId}": listed as exempt but is not a known route`);
    }
  }

  return Object.freeze([...problems].sort());
}

export class CapabilityRegistryError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `capability registry is invalid (${problems.length} problem${
        problems.length === 1 ? "" : "s"
      }):\n  - ${problems.join("\n  - ")}`,
    );
    this.name = "CapabilityRegistryError";
    this.problems = problems;
  }
}

export interface CapabilityManifest {
  readonly schemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  readonly entries: readonly CapabilityEntryV1[];
  readonly anchors: readonly ControlAnchorDeclaration[];
  /** The exact bytes the manifest hash is taken over. */
  readonly canonical: string;
}

/**
 * Build and validate the manifest. Throws {@link CapabilityRegistryError} on any
 * problem: a registry that cannot be trusted must not be a registry that half works.
 *
 * Entries and anchors are sorted by id in the canonical form, so the hash depends on
 * the CONTENT and not on the order the declaration files happen to be imported in --
 * reordering an import must not look like a content change, and moving an entry
 * within the content file must not either.
 */
export function buildCapabilityManifest(
  sources: CapabilitySources = SHIPPED_CAPABILITY_SOURCES,
): CapabilityManifest {
  const problems = validateCapabilitySources(sources);
  if (problems.length > 0) throw new CapabilityRegistryError(problems);

  const entries = Object.freeze(
    [...sources.entries]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((entry) => Object.freeze({ ...entry })),
  );
  const anchors = Object.freeze(
    [...sources.anchors]
      .sort((a, b) => (a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0))
      .map((anchor) => Object.freeze({ ...anchor })),
  );

  // `canonicalJson` sorts object keys and drops `undefined`, so an optional field that
  // is absent and one that is explicitly undefined hash identically -- which is what
  // we want, since they mean the same thing to every consumer.
  const canonical = canonicalJson({
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    entries,
    anchors,
  });

  return Object.freeze({ schemaVersion: CAPABILITY_SCHEMA_VERSION, entries, anchors, canonical });
}

/** The path for a stable route id. Re-exported so consumers never build one. */
export function routePathFor(routeId: NavRouteId): string {
  return findNavItemById(routeId).path;
}
