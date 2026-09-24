// The nurse-facing help content (T06).
//
// This is the one file a product person edits. Everything around it is machinery:
// the ids, routes, anchors, tools and command types below are all typed references
// that fail to compile if they name something the app does not ship, and the
// generated manifest hash changes the moment any word here changes -- so content and
// code cannot drift apart quietly.
//
// THE GROUNDING RULE, restated where it is easiest to break: every summary describes
// what the CURRENT app does. No planned behaviour, no solver guarantee, no legal or
// clinical claim, no URL. The one fixed exception is the law-versus-guidance line on
// rest (user decision, 2026-09-24): what the Employment Act sets, and that rest rules
// are recommended practice with no MOH minimum. Where the app cannot express something, the entry says so
// rather than pointing at the nearest similar thing -- "reject near-miss rules" from
// the guided-setup flow applies to help text just as much as to proposals.
//
// WHAT IS DELIBERATELY ABSENT. `supportedCommands` records the HOST's durable write
// path for a screen, so an entry can say "changes here are undoable". No entry grants
// the model a write: T06 registers read-only tools only, and the four command types
// referenced are the repository's existing manual-editor primitives.

import type { CapabilityEntryV1 } from "./types";

/** Read tools that can serve any entry: describe it, and take the user to it. */
const BASE_TOOLS = ["list_app_capabilities", "explain_app_capability", "open_app_screen"] as const;

/** Entries about choosing a rule additionally admit the guidance tool. */
const RULE_TOOLS = [...BASE_TOOLS, "suggest_scheduling_rule"] as const;

/** A concept explanation with no screen: describe only, nothing to open. */
const CONCEPT_TOOLS = ["list_app_capabilities", "explain_app_capability"] as const;

const BOTH_MODES = ["guided", "advanced"] as const;
const ADVANCED_ONLY = ["advanced"] as const;

export const CAPABILITY_ENTRIES = [
  // --- Set up -------------------------------------------------------------
  {
    id: "roster-period",
    title: "Roster period and calendar",
    nurseFacingSummary:
      "Set the first and last day of the roster you are planning, and mark public holidays. " +
      "Everything else — people, shifts, rules and requests — is planned inside these dates.",
    concepts: ["roster period", "date range", "public holiday", "date group", "calendar"],
    modes: BOTH_MODES,
    featureGates: [],
    routeId: "dates",
    controlAnchor: "dates.roster-period",
    toolAccess: BASE_TOOLS,
    supportedCommands: ["patch_scenario"],
  },
  {
    id: "staff-list",
    title: "Staff and people groups",
    nurseFacingSummary:
      "List the nurses being rostered and put them into groups — for example seniors, or a " +
      "team — so a rule can be written about the group instead of naming every person. A nurse " +
      "borrowed from another ward, the float pool or an agency is added with Temporary switched " +
      "on, and marked off on the days they are not here. Borrowed for nights? Also mark them Must work the night " +
      "shift on those dates (a shift request at weight must), or the solver may put them on " +
      "day shifts. The assistant can prepare these changes for you to review " +
      "and apply.",
    concepts: [
      "staff",
      "nurse",
      "person",
      "people group",
      "seniors",
      "team",
      "float nurse",
      "agency nurse",
      "borrowed staff",
      "temporary staff",
    ],
    modes: BOTH_MODES,
    featureGates: [],
    routeId: "people",
    controlAnchor: "people.add-person",
    toolAccess: BASE_TOOLS,
    supportedCommands: ["patch_scenario"],
  },
  {
    id: "shift-types",
    title: "Shifts and shift groups",
    nurseFacingSummary:
      "Define each kind of shift the ward runs — its code, name, clock times and rest break — " +
      "and group related shifts together, such as all the night shifts. Working hours are the " +
      "clock time minus the unpaid break, and that is what the Employment Act's 12-hour daily " +
      "limit counts: 08:00 to 20:30 with a 2-hour break is 10.5 hours. The assistant can also " +
      "prepare new shifts and shift groups for you to review and apply.",
    concepts: ["shift", "shift type", "shift group", "night shift", "clock times", "duration"],
    modes: BOTH_MODES,
    featureGates: [],
    routeId: "shift-types",
    controlAnchor: "shift-types.add-shift-type",
    toolAccess: BASE_TOOLS,
    supportedCommands: ["patch_scenario"],
  },

  // --- Rules --------------------------------------------------------------
  {
    id: "rule-library",
    title: "The plain-English rule library",
    nurseFacingSummary:
      "Every rule the roster runs on, written in ward language. Switch a rule off, change its " +
      "numbers, or rename it to the words your team uses. A built-in rule is one the engine " +
      "always enforces — it can be renamed but never switched off.",
    concepts: ["rule", "constraint", "rule library", "built-in rule", "enable rule", "rename rule"],
    modes: BOTH_MODES,
    featureGates: [],
    routeId: "rules",
    controlAnchor: "rules.rule-library",
    toolAccess: RULE_TOOLS,
    supportedCommands: ["patch_scenario"],
  },
  {
    id: "hard-and-soft-rules",
    title: "Hard rules and soft rules",
    nurseFacingSummary:
      "A hard rule must hold: if it cannot, the roster comes back as not possible rather than " +
      "bending it. A soft rule is a preference with a weight — the optimiser trades soft rules " +
      "off against each other and reports what it could not satisfy. Making a preference hard " +
      "is the most common reason a roster becomes impossible.",
    concepts: ["hard rule", "soft rule", "weight", "preference", "infeasible", "trade-off"],
    modes: BOTH_MODES,
    featureGates: [],
    toolAccess: CONCEPT_TOOLS,
    supportedCommands: [],
  },
  {
    id: "staffing-requirements",
    title: "Staffing requirements",
    nurseFacingSummary:
      "How many people a shift needs: exactly that number, or a range when a preferred number " +
      "is set. Naming who is qualified means nobody else may work that shift at all. The " +
      "scheduler cannot express a skill-mix rule yet, and the assistant cannot set one up.",
    concepts: ["staffing requirement", "minimum staffing", "skill mix", "coverage", "headcount"],
    modes: ADVANCED_ONLY,
    featureGates: [],
    routeId: "shift-type-requirements",
    toolAccess: RULE_TOOLS,
    supportedCommands: ["patch_scenario"],
  },
  {
    id: "shift-successions",
    title: "Shift successions",
    nurseFacingSummary:
      "Which shift may follow which, for the same person on consecutive days — for example " +
      "forbidding a day shift straight after a night shift. It controls the ORDER of shifts, " +
      "not how many of them somebody works. Rest rules like this are recommended practice, not " +
      "law: MOH sets no minimum rest between shifts, and the Employment Act sets 1 rest day a " +
      "week, at most 12 working hours a day and 72 hours of overtime a month, and 44 hours a " +
      "week averaged over 3 weeks for shift workers. You may soften a rest rule or turn it off.",
    concepts: ["succession", "shift sequence", "night to day", "consecutive shifts", "rest"],
    modes: ADVANCED_ONLY,
    featureGates: [],
    routeId: "shift-type-successions",
    controlAnchor: "shift-type-successions.add-succession",
    toolAccess: RULE_TOOLS,
    supportedCommands: ["patch_scenario"],
  },
  {
    id: "shift-counts",
    title: "Shift counts",
    nurseFacingSummary:
      "Limits and targets on HOW MANY of something a person gets over the roster — rest days, " +
      "a cap on nights, or balancing hours across the team.",
    concepts: ["shift count", "rest days", "night cap", "hours balance", "contracted hours"],
    modes: ADVANCED_ONLY,
    featureGates: [],
    routeId: "shift-counts",
    toolAccess: RULE_TOOLS,
    supportedCommands: ["patch_scenario"],
  },
  {
    id: "shift-affinities",
    title: "Affinities",
    nurseFacingSummary: "Keep particular people together on the same shift, or deliberately apart.",
    concepts: ["affinity", "keep together", "keep apart", "pairing"],
    modes: ADVANCED_ONLY,
    featureGates: [],
    routeId: "shift-affinities",
    toolAccess: RULE_TOOLS,
    supportedCommands: ["patch_scenario"],
  },
  {
    id: "shift-type-coverings",
    title: "Shift type coverings",
    nurseFacingSummary:
      "Require that whenever one person is on a shift, somebody who can supervise them is on it " +
      "too — the preceptor arrangement.",
    concepts: ["covering", "preceptor", "supervision", "mentor"],
    modes: ADVANCED_ONLY,
    featureGates: [],
    routeId: "shift-type-coverings",
    toolAccess: RULE_TOOLS,
    supportedCommands: ["patch_scenario"],
  },

  // --- Requests and leave -------------------------------------------------
  {
    id: "leave-and-requests",
    title: "Leave and shift requests",
    nurseFacingSummary:
      "Record approved leave, off-days, and each person's shift preferences on a person-by-date " +
      "grid. Approved leave is entered here as leave for those dates; the app has no separate " +
      "leave-approval workflow. The assistant can also prepare leave, day-off and shift " +
      "requests for you to review and apply, and asks you to confirm before it removes anyone's leave.",
    concepts: ["leave", "annual leave", "day off", "shift request", "preference", "availability"],
    modes: BOTH_MODES,
    featureGates: [],
    routeId: "shift-requests",
    controlAnchor: "shift-requests.mode-toolbar",
    toolAccess: BASE_TOOLS,
    supportedCommands: ["patch_scenario", "set_req_data"],
  },

  // --- Output -------------------------------------------------------------
  {
    id: "generate-roster",
    title: "Generate the roster and export it",
    nurseFacingSummary:
      "Send the current setup to the optimiser and, when it finishes, download the result. The " +
      "optimiser only knows the rules that are written down here — it cannot infer ward custom, " +
      "policy or anything outside the recorded rules. The assistant can offer to start a run " +
      "for you; it starts only when you press Run on its card, and then runs exactly as if you " +
      "had pressed Optimize.",
    concepts: ["optimise", "generate roster", "solver", "run", "export", "download"],
    modes: BOTH_MODES,
    featureGates: [],
    routeId: "optimize-and-export",
    controlAnchor: "optimize.run-options",
    toolAccess: BASE_TOOLS,
    supportedCommands: [],
  },
  {
    id: "guided-and-advanced-modes",
    title: "Guided and Advanced modes",
    nurseFacingSummary:
      "Guided shows the six-step set-up and the plain-English rule library. Advanced adds the " +
      "raw constraint editors behind those rules. Switching mode changes only what is shown — " +
      "it never alters the roster you have set up. A screen or control that is missing is " +
      "usually one that lives in the other mode.",
    concepts: ["guided mode", "advanced mode", "mode", "hidden screen", "disabled control"],
    modes: BOTH_MODES,
    featureGates: [],
    toolAccess: CONCEPT_TOOLS,
    supportedCommands: [],
  },

  // --- System -------------------------------------------------------------
  {
    id: "save-and-load",
    title: "Save, load and anonymise",
    nurseFacingSummary:
      "Download the whole set-up as a file, load one back, or download an anonymised copy with " +
      "names removed. Loading a file replaces what is currently open.",
    concepts: ["save", "load", "backup", "download", "upload", "anonymise", "start over"],
    modes: BOTH_MODES,
    featureGates: [],
    routeId: "save-and-load",
    controlAnchor: "save-and-load.download-backup",
    toolAccess: BASE_TOOLS,
    supportedCommands: ["replace_scenario", "record_backup"],
  },
  // --- Output -------------------------------------------------------------
  {
    id: "roster-viewer",
    title: "Reviewing and adjusting the roster",
    nurseFacingSummary:
      "After a run finishes you can open the saved roster here, change individual assignments by " +
      "hand, and export the result. Edits made here apply to the saved roster only — they do not " +
      "change the people, shifts, rules or requests the run was based on." +
      " The assistant can read this roster, suggest who can swap a shift without breaking the " +
      "rules it was made with, and prepare the swap; it changes only when you press Apply on its " +
      "card, and you can undo it here. When the swap also changes the schedule (a leave move, " +
      "an MC or a temporary nurse), undo that part from the change list too.",
    concepts: ["roster", "schedule", "view roster", "adjust roster", "assignment", "manual edit"],
    // The Roster destination carries no `guidedStep`, but persistent shell navigation
    // reaches it in BOTH modes (see `nav-config.ts`, group `out`), so the capability
    // exists in both. Gating it to advanced would deny a guided user an answer about a
    // screen their own sidebar offers them.
    modes: BOTH_MODES,
    featureGates: [],
    routeId: "roster",
    // NO `controlAnchor`: the viewer declares no owner-local anchors, and `ControlAnchorId`
    // is derived from the declarations, so naming one here would not compile. Describe and
    // open the screen; do not point at a control that is not anchored.
    toolAccess: BASE_TOOLS,
    // EMPTY, and not an oversight. `supportedCommands` records the durable SCENARIO
    // command types a screen's manual path commits. Roster edits are written through the
    // roster storage, not through a scenario command, so listing one here would tell the
    // model this screen makes scenario changes undoable when it does not.
    supportedCommands: [],
  },
  {
    id: "ai-assistant-setup",
    title: "Turning the AI assistant on",
    nurseFacingSummary:
      "The assistant is optional and off until you turn it on in Settings and add your own " +
      "OpenRouter key. The key is stored in this browser and is not encrypted — anyone using " +
      "this browser profile can use it. Rostering works fully without it.",
    concepts: ["ai assistant", "openrouter", "api key", "settings", "enable ai", "model"],
    modes: BOTH_MODES,
    // UNGATED on purpose: this is the entry that explains how to OPEN the gate, so
    // gating it on the assistant being ready would hide the only answer a user
    // without the assistant needs.
    featureGates: [],
    routeId: "settings",
    toolAccess: BASE_TOOLS,
    supportedCommands: [],
  },
  {
    id: "ai-assistant-conversation",
    title: "What the assistant can and cannot do",
    nurseFacingSummary:
      "Once it is on, the assistant can read the set-up you have open, explain how the app " +
      "works, and suggest which rule expresses a policy you describe. It can also prepare " +
      "changes — the roster period, turning any rule on or off, adding, editing or deleting " +
      "staffing requirements, shift sequence rules and shift count rules, deleting any rule, " +
      "moving leave, adding new shifts and shift groups, adding, renaming or removing staff " +
      "and staff groups, marking someone off for a run of days, and recording leave, day-off " +
      "and shift requests — which you review and apply yourself. It can also offer to run the " +
      "optimiser — the run starts only when you press Run — and then tell you how it went. " +
      "It can also walk you through setting up a new schedule one step at a time, and when a " +
      "schedule cannot be filled it says which day and shift is short and why, and suggests up to " +
      "three realistic fixes — such as borrowing a nurse from another ward, asking a nurse on leave " +
      "if she can cover, or allowing one more night this period. Anything that needs someone to " +
      "agree is asked before you can apply it. If you ask it to turn off or soften a rest rule, " +
      "it prepares that with a short note that rest rules are recommended practice, not law. " +
      "It cannot change the roster on its own, it cannot yet create pairing or supervision " +
      "rules, and it cannot edit or delete existing shifts. It is not a source of employment, " +
      "legal or clinical-safety authority.",
    concepts: [
      "assistant",
      "chat",
      "read-only",
      "suggestion",
      "apply",
      "limits",
      "set-up guide",
      "infeasible",
      "short-staffed",
    ],
    modes: BOTH_MODES,
    featureGates: ["aiAssistant"],
    routeId: "settings",
    toolAccess: BASE_TOOLS,
    supportedCommands: [],
  },
] as const satisfies readonly CapabilityEntryV1[];

/** Every shipped capability id, as a literal union. Derived, never hand-written. */
export type CapabilityId = (typeof CAPABILITY_ENTRIES)[number]["id"];
