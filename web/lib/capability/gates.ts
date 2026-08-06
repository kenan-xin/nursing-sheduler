// Feature gates the capability registry resolves against (T06).
//
// THIS UNION HAS ONE MEMBER, AND THAT IS THE HONEST ANSWER. The shipped app has
// exactly one product capability that can be present or absent at runtime: the
// optional AI assistant, which is off by default and becomes available only once a
// probe-passed OpenRouter configuration exists. Everything else the app can do is
// either always there or is governed by Guided/Advanced MODE, which is a separate
// axis the registry already models. `NEXT_PUBLIC_NS_TEST_BRIDGE` is a test seam, not
// a product gate, and is deliberately absent.
//
// The shape is a union with a resolver rather than a flag framework on purpose: a
// registry entry declares the gates it needs, resolution intersects them with what
// is live, and a closed gate is a `capability_unavailable` with no substitute. When
// a genuine second gate ships, it is one entry here plus one line in the resolver.

export const FEATURE_GATES = ["aiAssistant"] as const;

export type FeatureGate = (typeof FEATURE_GATES)[number];

export interface FeatureGateInput {
  /** AI enabled AND a probe-passed key/model stored -- i.e. the assistant is Ready. */
  readonly assistantReady: boolean;
}

/**
 * Which gates are OPEN right now. Absence is the default: an unknown or
 * unresolvable input contributes no gate, so a capability that needs one fails
 * closed rather than being offered on the strength of a missing signal.
 */
export function resolveFeatureGates(input: FeatureGateInput): readonly FeatureGate[] {
  const open: FeatureGate[] = [];
  if (input.assistantReady) open.push("aiAssistant");
  return Object.freeze(open);
}
