// Shared anonymization transform (T05, critique #3 — single owner).
//
// One pure ID-map + nested-reference rewrite lives here; T16 (Optimize's fixed
// options + reverse-map + XLSX ID restoration) and T17 (Save/Load 3-toggle panel)
// both consume it — there is no second copy. The transform is copy-not-mutate:
// it deep-clones the document and rewrites the clone, so live durable state is
// never touched. Only *people* identifiers are PII: people items → `P#`, people
// groups → `G#`. Shift types, dates, weights, and descriptions are left as-is
// (description/history blanking are the panel toggles T16/T17 layer on top).

import {
  type CanonicalScenarioDocument,
  type GroupId,
  type NestedPersonRefList,
  type PersonId,
  type PersonRef,
} from "./types";

/** The bijective people-id map + its reverse (for XLSX restoration in T16). */
export interface AnonymizationIdMap {
  /** Original person id → anonymized `P#`. */
  people: Map<PersonId, string>;
  /** Original people-group id → anonymized `G#`. */
  groups: Map<GroupId, string>;
  /** Combined original ref → anonymized ref (people + groups). */
  forward: Map<PersonRef, PersonRef>;
  /** Anonymized ref → original ref (restore anonymized output to real ids). */
  reverse: Map<PersonRef, PersonRef>;
}

/**
 * Build a collision-safe people-id map from a canonical document. People items
 * are numbered `P1, P2, …` and people groups `G1, G2, …` in definition order.
 * Collision-safe: a generated id is skipped if it would clash with any *retained*
 * original id (a non-people id kept verbatim elsewhere), so the rewrite can never
 * alias an untouched reference onto an anonymized one. Pure — reads, never writes.
 */
export function buildIdMap(doc: Pick<CanonicalScenarioDocument, "people">): AnonymizationIdMap {
  const people = new Map<PersonId, string>();
  const groups = new Map<GroupId, string>();
  const forward = new Map<PersonRef, PersonRef>();
  const reverse = new Map<PersonRef, PersonRef>();

  // Every original id in the document's people domain, so a generated `P#`/`G#`
  // that happens to equal one of them is skipped.
  const retained = new Set<PersonRef>([
    ...doc.people.items.map((p) => p.id),
    ...(doc.people.groups ?? []).map((g) => g.id),
  ]);

  const assign = (
    originalId: PersonId | GroupId,
    prefix: "P" | "G",
    counter: { n: number },
    domain: Map<PersonId | GroupId, string>,
  ) => {
    let candidate: string;
    do {
      counter.n += 1;
      candidate = `${prefix}${counter.n}`;
    } while (retained.has(candidate) || reverse.has(candidate));
    domain.set(originalId, candidate);
    forward.set(originalId, candidate);
    reverse.set(candidate, originalId);
  };

  const personCounter = { n: 0 };
  for (const person of doc.people.items) assign(person.id, "P", personCounter, people);
  const groupCounter = { n: 0 };
  for (const group of doc.people.groups ?? []) assign(group.id, "G", groupCounter, groups);

  return { people, groups, forward, reverse };
}

/**
 * Return a NEW canonical document with every people reference rewritten through
 * `idMap.forward`. Reserved keywords (`ALL`/`OFF`/`LEAVE`) and unmapped refs pass
 * through unchanged. The input document is never mutated (deep-cloned first).
 */
export function anonymizeDocument(
  doc: CanonicalScenarioDocument,
  idMap: AnonymizationIdMap,
): CanonicalScenarioDocument {
  const clone = structuredClone(doc);

  // Consult the map FIRST: a backend-valid person/group literally named `OFF` or
  // `LEAVE` (the people domain reserves only `ALL`, which is never a mapped id)
  // must be anonymized. Unmapped refs — including the reserved all-people keyword
  // `ALL` and any shift-type selector keyword — are left unchanged naturally.
  const ref = (value: PersonRef): PersonRef => idMap.forward.get(value) ?? value;
  const refOrList = (value: PersonRef | PersonRef[]): PersonRef | PersonRef[] =>
    Array.isArray(value) ? value.map(ref) : ref(value);
  const nested = (value: NestedPersonRefList): NestedPersonRefList =>
    value.map((el) => (Array.isArray(el) ? el.map(ref) : ref(el)));

  for (const person of clone.people.items) person.id = ref(person.id);
  for (const group of clone.people.groups ?? []) {
    group.id = ref(group.id) as GroupId;
    group.members = group.members.map(ref);
  }

  for (const pref of clone.preferences) {
    switch (pref.type) {
      case "shift request":
        pref.person = refOrList(pref.person);
        break;
      case "shift type successions":
        pref.person = refOrList(pref.person);
        break;
      case "shift count":
        pref.person = refOrList(pref.person);
        break;
      case "shift type requirement":
        if (pref.qualifiedPeople !== undefined)
          pref.qualifiedPeople = refOrList(pref.qualifiedPeople);
        break;
      case "shift affinity":
        pref.people1 = nested(pref.people1);
        pref.people2 = nested(pref.people2);
        break;
      case "shift type covering":
        pref.preceptors = nested(pref.preceptors);
        pref.preceptees = nested(pref.preceptees);
        break;
    }
  }

  if (clone.export) {
    for (const rule of clone.export.formatting ?? []) {
      if (rule.type === "row" || rule.type === "people header" || rule.type === "history") {
        rule.people = rule.people.map(ref);
      } else if (rule.type === "cell") {
        rule.people = rule.people.map(ref);
      }
    }
    for (const row of clone.export.extraRows ?? []) row.countPeople = row.countPeople.map(ref);
  }

  return clone;
}
