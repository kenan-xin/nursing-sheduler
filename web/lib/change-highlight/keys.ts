// The stable identity of a changed row or card.
//
// ONE VOCABULARY, TWO SIDES. `lib/proposal/diff.ts` names a change with these
// strings; a screen renders the same string on the row that shows it. The diff is
// not edited to import this module (other work edits it concurrently);
// `keys.test.ts` pins every builder against the real diff instead.
//
// NEUTRAL ON PURPOSE. Scheduling screens may not import assistant code
// (`.oxlintrc.json`, "AI IS OPTIONAL"), so the vocabulary lives here and both sides
// import it. No React: this sits beside lib/proposal, which must stay React-free.

import type { CardsByKind } from "@/lib/scenario";
import { stableStringify } from "@/lib/proposal/digest";

const cellRow = (person: unknown): string => `cell:${stableStringify(person)}|`;

export const changeKeys = {
  rosterRange: (): string => "dates:range",
  dateGroup: (id: string): string => `dategroup:${id}`,
  person: (id: unknown): string => `person:${stableStringify(id)}`,
  peopleGroup: (id: string): string => `peoplegroup:${id}`,
  shift: (id: unknown): string => `shift:${stableStringify(id)}`,
  shiftGroup: (id: string): string => `shiftgroup:${id}`,
  rule: (kind: keyof CardsByKind, uid: string): string => `rule:${kind}:${uid}`,
  /** Every cell key of one matrix row starts with this. */
  cellRow,
  cell: (person: unknown, date: unknown): string => `${cellRow(person)}${stableStringify(date)}`,
} as const;
