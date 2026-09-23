// What the assistant is told about the current document (T04, closed
// no-consent/no-redaction posture).
//
// The product decision this implements is explicit and closed: once AI is enabled
// and Ready, the COMPLETE relevant scenario may be sent on the first request,
// including real names, descriptions, leave and scheduling values. There is no
// classification step here that pretends to detect sensitive text, and no field
// minimisation -- adding either would be a different product than the one that was
// approved.
//
// What "complete relevant context" excludes is equally explicit, and this module is
// where it is enforced by construction: the payload is projected from the scenario
// document and the route alone, so unrelated browser storage, cookies, other local
// files, and above all the OpenRouter credential have no path into it. The
// credential is a request header consumed by server code (T01) and is never a
// context entry, a tool argument, or a message.

import { toCanonicalScenarioDocument, type ScenarioUiState } from "@/lib/scenario";

/** One context entry, in the shape the transport's context hook accepts. */
export interface AssistantContextEntry {
  description: string;
  value: string;
}

/**
 * JSON with signed infinities preserved as readable markers.
 *
 * Load-bearing: a hard constraint is authored as `Infinity`, and `JSON.stringify`
 * turns that into `null`. Sending `null` would present every hard rule as an
 * absent one -- the model would then reason about a document the user does not
 * have. The markers match the strict YAML spelling the backend uses, so the two
 * representations describe the same value.
 */
export function stringifyScenario(scenario: ScenarioUiState): string {
  return JSON.stringify(toCanonicalScenarioDocument(scenario), (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return Number.isNaN(value) ? "nan" : value > 0 ? ".inf" : "-.inf";
    }
    return value;
  });
}

/** A compact, host-derived overview. The model gets it without asking. */
export interface ScenarioSummary {
  scenarioId: string;
  documentRevision: number;
  description: string | null;
  rosterPeriod: { start: string; end: string };
  counts: {
    people: number;
    peopleGroups: number;
    shiftTypes: number;
    shiftTypeGroups: number;
    dateGroups: number;
    requestCells: number;
    rules: Record<string, number>;
  };
}

export function summarizeScenario(
  scenario: ScenarioUiState,
  identity: { scenarioId: string; documentRevision: number },
): ScenarioSummary {
  const cards = scenario.cardsByKind;
  return {
    scenarioId: identity.scenarioId,
    documentRevision: identity.documentRevision,
    description: scenario.meta.description ?? null,
    rosterPeriod: { start: scenario.rangeStart, end: scenario.rangeEnd },
    counts: {
      people: scenario.staff.length,
      peopleGroups: scenario.staffGroups.length,
      shiftTypes: scenario.shifts.length,
      shiftTypeGroups: scenario.shiftGroups.length,
      dateGroups: scenario.dateGroups.length,
      requestCells: scenario.reqData.length,
      rules: {
        requirements: cards.requirements.length,
        successions: cards.successions.length,
        counts: cards.counts.length,
        affinities: cards.affinities.length,
        coverings: cards.coverings.length,
      },
    },
  };
}

/**
 * The authority statement.
 *
 * Not decoration: without it a capable model will confidently offer to change the
 * roster, and the user would then have to discover by trying that it cannot. T07
 * replaces this text when typed Preview/Apply actually exists -- until then the
 * honest capability is "explain and discuss".
 */
export const READ_ONLY_AUTHORITY_STATEMENT = [
  "You can read this schedule and explain it. You CANNOT change it.",
  "You have no tool that edits, creates or deletes anything, and none that runs the optimiser.",
  "If the user asks for a change, explain exactly what they should change and where in the app to do it,",
  "then say plainly that you cannot make the change yourself yet.",
  "Never claim to have applied, saved, queued or scheduled anything.",
  "Speak plain language suitable for a ward nurse; avoid product jargon unless you name it and explain it.",
].join(" ");

export interface BuildContextInput {
  scenario: ScenarioUiState;
  scenarioId: string;
  documentRevision: number;
  /** Current route path, e.g. `/shift-requests`. */
  routePath: string;
  /** Human label for that route, when the nav registry knows one. */
  routeLabel: string | null;
}

/** The complete context set attached to a turn. Deliberately only these three. */
export function buildAssistantContext(input: BuildContextInput): AssistantContextEntry[] {
  return [
    {
      description: READ_ONLY_AUTHORITY_STATEMENT,
      value: "read-only",
    },
    {
      description:
        "The complete current scheduling scenario, as the backend-facing document. " +
        "Weights of `.inf` / `-.inf` are HARD constraints; numeric weights are soft preferences.",
      value: stringifyScenario(input.scenario),
    },
    {
      description: "The screen the user is looking at right now.",
      value: JSON.stringify({
        path: input.routePath,
        label: input.routeLabel,
        scenarioId: input.scenarioId,
        documentRevision: input.documentRevision,
      }),
    },
  ];
}
