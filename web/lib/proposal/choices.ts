// Valid-choice lists for "unknown target" refusals (nursing-sheduler-912).
//
// A refusal that only says "not found" sends the model back to guessing. Live, "apply a
// rule to everyone" produced three invented names in a row before the model gave up and
// asked the user. A refusal that names what IS there lets it correct the id in one retry.
//
// CAPPED, because a list of 60 nurses is not a sentence anyone reads. The rest are one
// read away, and saying so is the model-facing wrapper's job (`use-proposal-tools.ts`):
// these strings are also shown to a nurse, so they never name a tool.
//
// Every id comes from the DOCUMENT, never from the payload, so listing them echoes
// nothing the model sent.

import type { CardsByKind, ScenarioUiState } from "@/lib/scenario";

/** How many choices a refusal names before "and N more". */
export const LISTED_CHOICES = 20;

/** One id as it must be sent back: strings quoted, numbers bare (`7` and `"7"` differ). */
export function idLabel(id: unknown): string {
  return typeof id === "number" ? String(id) : JSON.stringify(String(id));
}

/** `Valid choices: "ana", 7 and 3 more.` Labels are already formatted and in document order. */
export function choiceList(labels: readonly string[]): string {
  const unique = [...new Set(labels)];
  if (unique.length === 0) return "There are none yet.";
  const more = unique.length - LISTED_CHOICES;
  return (
    `Valid choices: ${unique.slice(0, LISTED_CHOICES).join(", ")}` +
    `${more > 0 ? ` and ${more} more` : ""}.`
  );
}

/** What a manual picker offers, minus what it shows disabled. */
export function offeredChoices(options: readonly { value: unknown; disabled?: boolean }[]): string {
  return choiceList(
    options.filter((option) => !option.disabled).map((option) => idLabel(option.value)),
  );
}

export function peopleChoices(state: ScenarioUiState): string {
  return choiceList(state.staff.map((person) => idLabel(person.id)));
}

export function staffGroupChoices(state: ScenarioUiState): string {
  return choiceList(state.staffGroups.map((group) => idLabel(group.id)));
}

/** The request matrix's rows: people, then staff groups. */
export function staffRowChoices(state: ScenarioUiState): string {
  return choiceList([
    ...state.staff.map((person) => idLabel(person.id)),
    ...state.staffGroups.map((group) => idLabel(group.id)),
  ]);
}

export function shiftChoices(state: ScenarioUiState): string {
  return choiceList(state.shifts.map((shift) => idLabel(shift.id)));
}

/** Rule ids of one family, each with its title when it has one: `"cnt-nights" (Night cap)`. */
export function ruleChoices(state: ScenarioUiState, kind: keyof CardsByKind): string {
  const cards = state.cardsByKind[kind] as readonly { uid: string; description?: string }[];
  return choiceList(
    cards.map((card) => {
      const title = card.description?.trim();
      return title ? `${idLabel(card.uid)} (${title})` : idLabel(card.uid);
    }),
  );
}

/** Whether a person ref is the model's way of saying "every nurse". */
export function meansEveryone(ref: unknown): boolean {
  return typeof ref === "string" && /^(all|everyone|everybody)$/i.test(ref.trim());
}

/**
 * Staff groups that already hold every person on the staff list.
 *
 * The rule pickers never offer the synthetic `ALL` (see `rulePeopleSchema`), so an
 * authored group like this is the only way these screens can name everyone at once.
 */
export function everyoneGroups(state: ScenarioUiState): string[] {
  if (state.staff.length === 0) return [];
  return state.staffGroups
    .filter((group) =>
      state.staff.every((person) => group.members.some((member) => Object.is(member, person.id))),
    )
    .map((group) => String(group.id));
}
