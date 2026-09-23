// The canonical byte form the manifest hash is taken over (T06).
//
// WHY NOT REUSE `lib/repository/digest`'s `stableStringify`. Two reasons, and the
// second is the decisive one. It is documented as the input to a non-cryptographic
// de-duplication digest, so borrowing it would tie this hash's stability to a helper
// whose contract is explicitly weaker. And `lib/repository` is behind the authority
// boundary that only the projection adapter may cross — reaching through it for a
// string utility would spend a deliberate architectural gate on a convenience.
//
// The form is deliberately minimal and total over what a manifest contains: strings,
// finite numbers, booleans, null, arrays and plain objects with sorted keys. Anything
// else throws rather than being coerced, because a silently-encoded value is a hash
// that stops tracking the content it claims to identify.

/**
 * Deterministic JSON with object keys sorted and `undefined` properties dropped.
 *
 * Dropping `undefined` is what makes "field absent" and "field explicitly undefined"
 * hash identically — they mean the same thing to every consumer of the registry, so
 * they must not produce two different manifests.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJson: ${String(value)} is not representable`);
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const encoded = record[key];
        if (encoded === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${canonicalJson(encoded)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      // A function, symbol or bare `undefined` in manifest content is a mistake, and
      // encoding it as `null` would hide the mistake behind a stable-looking hash.
      throw new Error(`canonicalJson: cannot encode ${typeof value}`);
  }
}
