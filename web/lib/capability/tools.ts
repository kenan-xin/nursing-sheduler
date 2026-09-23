// The typed name of every assistant tool the capability registry may reference (T06).
//
// A registry entry names the read tools that are allowed to serve it. That claim is
// only worth anything if the names correspond to tools the app actually registers, so
// `tools.test.ts` reads the two registration modules' source and asserts the sets
// agree in BOTH directions: a name here that nothing registers is a capability the
// model would be told it has, and a registered tool missing from here is a tool the
// registry cannot govern.
//
// The T04 read tools are listed but not owned here; T06 adds only the help/guidance
// group, all of which are read-only. There is deliberately no mutation, Apply,
// diagnosis or navigation-by-URL tool in this union.

export const ASSISTANT_TOOL_NAMES = [
  // T04 -- read the current scenario.
  "get_schedule_overview",
  "get_schedule_section",
  // T06 -- read the versioned help/capability registry.
  "list_app_capabilities",
  "explain_app_capability",
  "suggest_scheduling_rule",
  // T06 -- ask the HOST to take the user to a screen. The model supplies a
  // capability id; the host resolves the route, re-checks mode/gates, and confirms
  // the live DOM anchor. The model never receives or supplies a URL.
  "open_app_screen",
] as const;

export type AssistantToolName = (typeof ASSISTANT_TOOL_NAMES)[number];

/** The T06-owned subset, for the registration hook and its tests. */
export const HELP_TOOL_NAMES = [
  "list_app_capabilities",
  "explain_app_capability",
  "suggest_scheduling_rule",
  "open_app_screen",
] as const satisfies readonly AssistantToolName[];

export type HelpToolName = (typeof HELP_TOOL_NAMES)[number];
