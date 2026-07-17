// Unique "… copy" id generation for duplicated items/groups (T09).
//
// Faithful port of the prototype's `getUniqueCopyLabel` (spec 03 "Duplicate
// labeling"): trim the source, strip a trailing " copy"/" copy {n}" suffix
// (case-insensitive), append " copy", then dedupe with " 2", " 3", … against the
// existing id namespace. An empty/whitespace source falls back to "Copy".

/** Trailing " copy" or " copy {n}" suffix (case-insensitive). */
const COPY_SUFFIX = /\s+copy(?: \d+)?$/i;

/**
 * Produce a unique copy id for `source`, avoiding every id in `existing`.
 * Example: `Alice → Alice copy`; a second duplicate → `Alice copy 2`;
 * `Alice copy → Alice copy` (re-uses the base), then `Alice copy 2`.
 *
 * An empty/whitespace source uses the fallback itself (`Copy`) as the first
 * candidate, per spec 03 "Duplicate labeling" — not `Copy copy`.
 */
export function getUniqueCopyLabel(
  source: string,
  existing: readonly string[],
  fallback = "Copy",
): string {
  const trimmed = source.trim();
  const taken = new Set(existing);

  // Empty/whitespace source → the fallback is the first candidate (spec 03).
  const first = trimmed === "" ? fallback : `${trimmed.replace(COPY_SUFFIX, "")} copy`;
  if (!taken.has(first)) return first;

  let n = 2;
  while (taken.has(`${first} ${n}`)) n++;
  return `${first} ${n}`;
}
