// Shared, deterministic naming for the uncredited-leave guard (qq0.23, tech-plan
// §2/§5). Both the import warning banner (qq0.23e) and the editor advisory
// (qq0.23d) word the guard through these helpers so the two surfaces stay
// identical and never grow a second phrasing of the policy.

import type { ImportCard, CountCardBody, UiPerson } from "../types";
import type { UncreditedLeaveFinding } from "./detector";

/**
 * Map a finding's affected staff indices to their declared person ids, preserving
 * scenario (staff declaration) order. The detector emits ascending indices — i.e.
 * staff declaration order — so this only needs to join `staff[index].id`; an index
 * with no matching person is dropped defensively (the detector only ever emits
 * indices it resolved against the same staff array).
 */
export function affectedPersonNames(
  affectedPersonIndices: readonly number[],
  staff: readonly UiPerson[],
): string[] {
  const names: string[] = [];
  for (const index of affectedPersonIndices) {
    const person = staff[index];
    // `PersonId` may be numeric; render it as its displayed spelling.
    if (person) names.push(String(person.id));
  }
  return names;
}

/**
 * One human-readable uncredited-leave warning line naming the affected people in
 * scenario (staff declaration) order. Shared by the import banner and the editor
 * advisory. `names` is expected non-empty (a finding always carries at least one
 * affected person); an empty list still yields a well-formed sentence.
 */
export function formatUncreditedLeaveWarning(names: readonly string[]): string {
  const who = names.length > 0 ? names.join(", ") : "the affected staff";
  return (
    `A contracted-hours count omits LEAVE from its counted shift types, so paid leave ` +
    `will not be credited toward the contract for ${who}.`
  );
}

/**
 * Format one deterministic warning line per finding against the snapshot the
 * findings were computed from, deduplicating identical lines while preserving
 * finding order. Findings with no resolvable affected people are skipped.
 */
export function formatUncreditedLeaveWarnings(
  findings: readonly UncreditedLeaveFinding[],
  staff: readonly UiPerson[],
  counts: readonly ImportCard<CountCardBody>[],
): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const finding of findings) {
    const names = affectedPersonNames(finding.affectedPersonIndices, staff);
    if (names.length === 0) continue;
    const count = counts[finding.countIndex];
    if (!count) continue;
    const ordinal = finding.countIndex + 1;
    const label = count.description
      ? `"${count.description}" (count ${ordinal})`
      : `Count ${ordinal}`;
    const line = `${label}: ${formatUncreditedLeaveWarning(names)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}
