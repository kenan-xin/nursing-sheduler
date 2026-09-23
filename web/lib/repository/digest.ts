// A deterministic, order-independent DIGEST for typed commands and proposals.
//
// This is explicitly a non-cryptographic identity for de-duplication, idempotency
// keys, and "is this the same command?" comparisons. It must never be promoted
// into Optimize submission identity or feasibility evidence — that identity is
// SHA-256 over exact bytes and is owned by T08 (tech-plan, "Optimize identity").

/**
 * Stable JSON with sorted object keys, so two structurally equal values always
 * produce the same text regardless of insertion order. `undefined` properties are
 * dropped (matching `JSON.stringify`); non-finite numbers are tagged rather than
 * flattened to `null`, so `Infinity` and `-Infinity` stay distinguishable.
 */
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
      const encoded = record[key];
      if (encoded === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(encoded)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return "null";
}

/**
 * 128-bit FNV-1a over the stable encoding, emitted as 32 lowercase hex chars.
 * Four independently seeded lanes rather than one 32-bit lane, so an ordinary
 * command stream cannot realistically collide.
 */
export function commandDigest(value: unknown): string {
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
