// Deterministic digests for proposals and confirmations (T07).
//
// THREE DIGESTS, three different questions:
//   • `commandsDigest`      — "is this the same change?"      (Preview ↔ Apply)
//   • `confirmationsDigest` — "is this the same agreement?"   (Confirm ↔ Apply)
//   • `idempotencyKey`      — "is this the same Apply?"       (retry ↔ replay)
//
// SELF-CONTAINED ON PURPOSE. The repository has its own `commandDigest`, but this
// module may not import it: `lib/repository` sits behind the authority boundary
// (`lib/store/authority-boundary.test.ts`) and only the projection adapter may cross
// it. Nor does it need to — the two digests answer different questions over
// different values and are never compared, so there is no drift to guard against.
// What IS required is that this one is stable across page lifetimes, which is why
// the encoding sorts keys and tags non-finite numbers rather than relying on
// `JSON.stringify`'s insertion order and its `null` flattening.
//
// NON-CRYPTOGRAPHIC, and it must never be promoted: Optimize submission identity is
// SHA-256 over exact bytes and is owned by the basis record.

/** Stable JSON with sorted keys. `undefined` is dropped; `±Infinity` stays distinguishable. */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : `"#${String(value)}"`;
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "undefined" || typeof value === "function") return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(record[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  return "null";
}

/** 128-bit FNV-1a over the stable encoding, as 32 lowercase hex characters. */
export function proposalDigest(value: unknown): string {
  const text = stableStringify(value);
  const lanes = [0x811c9dc5, 0x01000193, 0xdeadbeef, 0x9e3779b9];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    for (let lane = 0; lane < lanes.length; lane += 1) {
      lanes[lane] = Math.imul(lanes[lane] ^ code ^ (lane * 0x27d4eb2f), 0x01000193) >>> 0;
    }
  }
  return lanes.map((lane) => lane.toString(16).padStart(8, "0")).join("");
}
