import { describe, expect, it } from "vitest";
import type { AppMode } from "@/lib/mode/mode";
import type { NavRouteId } from "@/components/shell/nav-config";
import type { ControlAnchorDeclaration } from "./anchor-contract";
import {
  buildCapabilityManifest,
  CapabilityRegistryError,
  ROUTES_WITHOUT_CAPABILITY_ENTRY,
  SHIPPED_CAPABILITY_SOURCES,
  validateCapabilitySources,
  type CapabilitySources,
} from "./build-manifest";
import type { CapabilityEntryV1 } from "./types";

// The validator is exercised against deliberately BROKEN sources, which is the only
// way to prove a gate closes. Every fixture below is a mistake that has a plausible
// route into a real diff -- a renamed anchor, a moved control, a screen that shipped
// without help, a Guided answer pointing at an Advanced screen.

const ROUTES = ["home", "dates", "rules", "shift-counts"] as unknown as readonly NavRouteId[];

const ANCHORS: readonly ControlAnchorDeclaration[] = [
  { anchorId: "dates.roster-period", routeId: "dates" as NavRouteId, label: "Roster period" },
  { anchorId: "rules.rule-library", routeId: "rules" as NavRouteId, label: "Rule library" },
];

/** `shift-counts` stands in for the Advanced-only route in these fixtures. */
function visibleInMode(routeId: NavRouteId, mode: AppMode): boolean {
  if (routeId === ("shift-counts" as NavRouteId)) return mode === "advanced";
  return true;
}

function entry(overrides: Partial<CapabilityEntryV1> = {}): CapabilityEntryV1 {
  return {
    id: "roster-period",
    title: "Roster period",
    nurseFacingSummary: "Set the first and last day of the roster.",
    concepts: ["roster period"],
    modes: ["guided", "advanced"],
    featureGates: [],
    routeId: "dates" as NavRouteId,
    controlAnchor: "dates.roster-period" as CapabilityEntryV1["controlAnchor"],
    toolAccess: ["explain_app_capability"],
    supportedCommands: ["patch_scenario"],
    ...overrides,
  };
}

/** Sources that validate cleanly, so each case below changes exactly one thing. */
function sources(overrides: Partial<CapabilitySources> = {}): CapabilitySources {
  return {
    routeIds: ROUTES,
    anchors: ANCHORS,
    toolNames: ["explain_app_capability", "list_app_capabilities"],
    commandTypes: ["patch_scenario", "set_req_data"],
    featureGates: ["aiAssistant"],
    entries: [
      entry(),
      entry({
        id: "rule-library",
        title: "Rules",
        nurseFacingSummary: "Every rule in plain English.",
        concepts: ["rule"],
        routeId: "rules" as NavRouteId,
        controlAnchor: "rules.rule-library" as CapabilityEntryV1["controlAnchor"],
      }),
      entry({
        id: "shift-counts",
        title: "Shift counts",
        nurseFacingSummary: "Rest days and night caps.",
        concepts: ["rest days"],
        modes: ["advanced"],
        routeId: "shift-counts" as NavRouteId,
        controlAnchor: undefined,
      }),
    ],
    routeVisibleInMode: visibleInMode,
    routesWithoutEntry: ["home" as NavRouteId],
    ...overrides,
  };
}

describe("capability source validation", () => {
  it("accepts a consistent set of sources", () => {
    expect(validateCapabilitySources(sources())).toEqual([]);
  });

  it("rejects a duplicate capability id", () => {
    const problems = validateCapabilitySources(
      sources({ entries: [entry(), entry()] as readonly CapabilityEntryV1[] }),
    );
    expect(problems).toContain('capability "roster-period": declared more than once');
  });

  it("rejects a duplicate anchor declaration", () => {
    // Two components each believing they own the target: the live-DOM check would
    // find two elements and every navigation to it would be a coin flip.
    const problems = validateCapabilitySources(sources({ anchors: [ANCHORS[0], ANCHORS[0]] }));
    expect(problems).toContain('anchor "dates.roster-period": declared more than once');
  });

  it("rejects a stale control anchor that no component declares any more", () => {
    const problems = validateCapabilitySources(sources({ anchors: [ANCHORS[1]] }));
    expect(problems).toContain(
      'capability "roster-period": control anchor "dates.roster-period" is not declared',
    );
  });

  it("rejects an anchor reached through the wrong screen", () => {
    const problems = validateCapabilitySources(
      sources({
        entries: [
          entry({ controlAnchor: "rules.rule-library" as CapabilityEntryV1["controlAnchor"] }),
          entry({ id: "rule-library", routeId: "rules" as NavRouteId, controlAnchor: undefined }),
          entry({
            id: "shift-counts",
            modes: ["advanced"],
            routeId: "shift-counts" as NavRouteId,
            controlAnchor: undefined,
          }),
        ],
      }),
    );
    expect(problems).toContain(
      'capability "roster-period": control anchor "rules.rule-library" belongs to route "rules", not "dates"',
    );
  });

  it("rejects a control anchor with no screen to find it on", () => {
    const problems = validateCapabilitySources(
      sources({ entries: [entry({ routeId: undefined })] as readonly CapabilityEntryV1[] }),
    );
    expect(problems).toContain('capability "roster-period": has a control anchor but no route');
  });

  it("rejects an unknown route, tool, command type, gate and mode", () => {
    const problems = validateCapabilitySources(
      sources({
        entries: [
          entry({
            routeId: "nowhere" as NavRouteId,
            controlAnchor: undefined,
            toolAccess: ["apply_everything"] as unknown as CapabilityEntryV1["toolAccess"],
            supportedCommands: [
              "rewrite_world",
            ] as unknown as CapabilityEntryV1["supportedCommands"],
            featureGates: ["timeTravel"] as unknown as CapabilityEntryV1["featureGates"],
            modes: ["expert"] as unknown as CapabilityEntryV1["modes"],
          }),
        ],
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'capability "roster-period": route "nowhere" is not a known route',
        'capability "roster-period": unknown tool "apply_everything"',
        'capability "roster-period": unknown command type "rewrite_world"',
        'capability "roster-period": unknown feature gate "timeTravel"',
        'capability "roster-period": unknown mode "expert"',
      ]),
    );
  });

  it("rejects an entry claiming a mode in which its own screen is hidden", () => {
    // Without this a Guided user would be told to open an Advanced-only screen, and
    // the route-validity gate would bounce them straight back to Home.
    const problems = validateCapabilitySources(
      sources({
        entries: [
          entry({
            id: "shift-counts",
            routeId: "shift-counts" as NavRouteId,
            controlAnchor: undefined,
          }),
        ],
      }),
    );
    expect(problems).toContain(
      'capability "shift-counts": claims mode "guided" but route "shift-counts" is hidden there',
    );
  });

  it("rejects a screen that shipped with no help content", () => {
    const problems = validateCapabilitySources(sources({ routesWithoutEntry: [] }));
    expect(problems).toContain('route "home": no capability entry describes this screen');
  });

  it("rejects an exemption for a route that does not exist", () => {
    const problems = validateCapabilitySources(
      sources({ routesWithoutEntry: ["home", "ghost"] as unknown as readonly NavRouteId[] }),
    );
    expect(problems).toContain('route "ghost": listed as exempt but is not a known route');
  });

  it("rejects nurse-facing text carrying a URL", () => {
    // The registry returns ids precisely so an answer cannot carry an unverified link.
    // Content that embeds one walks straight around that.
    const problems = validateCapabilitySources(
      sources({
        entries: [
          entry({ nurseFacingSummary: "See https://example.test/help for the roster period." }),
        ],
      }),
    );
    expect(problems).toContain('capability "roster-period": summary contains a URL');
  });

  it("rejects empty required text and a modeless or conceptless entry", () => {
    const problems = validateCapabilitySources(
      sources({
        entries: [entry({ title: "  ", nurseFacingSummary: " ", concepts: [], modes: [] })],
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'capability "roster-period": title is empty',
        'capability "roster-period": summary is empty',
        'capability "roster-period": declares no concepts',
        'capability "roster-period": declares no modes',
      ]),
    );
  });

  it("reports EVERY problem, not the first", () => {
    // A renamed anchor usually breaks several entries at once; fixing them one build
    // at a time is how a drift gate becomes something people route around.
    const problems = validateCapabilitySources(sources({ anchors: [], routesWithoutEntry: [] }));
    expect(problems.length).toBeGreaterThan(2);
    expect([...problems]).toEqual([...problems].sort());
  });
});

describe("buildCapabilityManifest", () => {
  it("throws with every problem attached rather than degrading", () => {
    let caught: unknown;
    try {
      buildCapabilityManifest(sources({ anchors: [] }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CapabilityRegistryError);
    expect((caught as CapabilityRegistryError).problems.length).toBeGreaterThan(0);
  });

  it("sorts entries and anchors by id so the hash tracks content, not import order", () => {
    const forward = buildCapabilityManifest(sources());
    const reversed = buildCapabilityManifest(
      sources({
        entries: [...sources().entries].reverse(),
        anchors: [...ANCHORS].reverse(),
      }),
    );
    expect(reversed.canonical).toBe(forward.canonical);
    const ids = forward.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("freezes what it returns", () => {
    const manifest = buildCapabilityManifest(sources());
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.entries)).toBe(true);
    expect(Object.isFrozen(manifest.entries[0])).toBe(true);
  });
});

describe("the SHIPPED sources", () => {
  it("validate cleanly", () => {
    expect(validateCapabilitySources(SHIPPED_CAPABILITY_SOURCES)).toEqual([]);
  });

  it("build without throwing", () => {
    expect(() => buildCapabilityManifest()).not.toThrow();
  });

  it("exempt only Home from needing its own help entry", () => {
    // Enumerated rather than a wildcard so a NEW screen without help content fails
    // the coverage check instead of quietly joining the exemption.
    expect(ROUTES_WITHOUT_CAPABILITY_ENTRY).toEqual(["home"]);
  });

  it("describe every shipped anchor from exactly one entry", () => {
    const manifest = buildCapabilityManifest();
    for (const anchor of manifest.anchors) {
      const owners = manifest.entries.filter((e) => e.controlAnchor === anchor.anchorId);
      expect(owners, `anchor "${anchor.anchorId}"`).toHaveLength(1);
    }
  });
});
