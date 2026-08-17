// Can the locked runtime actually convert the tools we ship?
//
// THE DEFECT THIS PINS. A live grounded turn issued exactly one POST to
// `/api/copilotkit/agent/scheduler/run`, produced no follow-up and no answer, and left
// the user with only their own question on screen. The web container had logged:
//
//     Invalid JSON schema: { "type": "null" }
//
// `prepare_scenario_change.evidence[].reference` was `z.string().nullable()`.
// `zod-to-json-schema` (what the CopilotKit client uses to put a tool on the wire)
// serialises that with a `{ "type": "null" }` branch, and
// `@copilotkit/runtime@1.66.2`'s converter throws on it BEFORE the provider tool loop
// runs. One field disabled every tool on the turn.
//
// WHY SCHEMA INSPECTION WOULD NOT HAVE CAUGHT IT. Nothing about the Zod schema, the
// generated JSON Schema, or `.parse()` is wrong -- all three are perfectly valid. The
// failure exists only at the seam between two libraries, so this test drives that seam:
// the real `zodToJsonSchema` the client uses, into the real exported
// `convertToolsToVercelAITools` the runtime uses. Both are the locked implementations,
// not restatements of them.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// RESOLVED THROUGH THE CLIENT, not added as a dependency of this app. `CopilotKitProvider`
// serialises a tool with `schemaToJsonSchema(fn.parameters, { zodToJsonSchema })`; this
// reaches the exact copies it resolves, so the serialisation half of the boundary is the
// shipped one and the lockfile is untouched.
//
// The wrapper matters, and a first attempt at this test got it wrong: this app is on Zod
// v4, and `zod-to-json-schema` alone targets v3 and silently produces a schema with no
// `type` at all -- which the runtime rejects for EVERY tool. `schemaToJsonSchema` is what
// bridges the two, so using it is what makes this the real path rather than a plausible
// one.
const requireHere = createRequire(import.meta.url);
const requireFromClient = createRequire(requireHere.resolve("@copilotkit/react-core/package.json"));
const { schemaToJsonSchema } = requireFromClient("@copilotkit/shared") as {
  schemaToJsonSchema: (schema: unknown, options: { zodToJsonSchema: unknown }) => unknown;
};
const { zodToJsonSchema } = requireFromClient("zod-to-json-schema") as {
  zodToJsonSchema: (schema: unknown) => unknown;
};

/** Exactly what `CopilotKitProvider` does to put a tool schema on the wire. */
const onTheWire = (schema: z.ZodTypeAny): unknown =>
  schemaToJsonSchema(schema, { zodToJsonSchema });
// The PUBLIC entry -- the same subpath the app's own route handler imports from, and
// the same function that threw live. Not a deep path into the package's internals.
import { convertToolsToVercelAITools } from "@copilotkit/runtime/v2";

import {
  MODEL_VISIBLE_TOOL_SCHEMAS,
  PARAMETERLESS_MODEL_VISIBLE_TOOLS,
} from "@/components/ai/model-visible-tools";

/** Put one tool on the wire exactly as the client does, then convert it back. */
function crossTheRuntimeBoundary(name: string, schema: z.ZodTypeAny): void {
  const parameters = onTheWire(schema);
  convertToolsToVercelAITools([
    { name, description: `${name} (schema conversion probe)`, parameters },
  ]);
}

// The registration list is NOT restated here, and it is no longer discovered by scanning
// source either -- the inventory helper that once did is deleted. Completeness now comes
// from the production code itself: a tool can only reach the model through
// `useModelVisibleTool`, only that wrapper may import `useFrontendTool` and only
// `copilotkit-core-access.ts` may reach the core (Oxlint `no-restricted-imports`), and the
// registry the shipped session MOUNTS is enumerated against these names by the
// provider-backed proof in `components/ai/session-real-core.test.tsx`.

describe("the shipped tool set, through the locked conversion boundary", () => {
  it.each(Object.entries(MODEL_VISIBLE_TOOL_SCHEMAS))(
    "%s converts for the provider loop",
    (name, schema) => {
      expect(() => crossTheRuntimeBoundary(name, schema)).not.toThrow();
    },
  );

  it("converts the whole set in one call, the way a real turn does", () => {
    // A turn hands the runtime EVERY tool at once and one bad node stops all of them,
    // so the set is converted as a set rather than only one at a time.
    const tools = Object.entries(MODEL_VISIBLE_TOOL_SCHEMAS).map(([name, schema]) => ({
      name,
      description: name,
      parameters: onTheWire(schema),
    }));
    const converted = convertToolsToVercelAITools(tools);
    expect(Object.keys(converted).sort()).toEqual(Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS).sort());
  });

  it("is NOT VACUOUS: the exact shape that broke the live turn still fails here", () => {
    // The causal control. If this ever stops throwing, the boundary has changed and the
    // guarantee above is worth nothing -- the test would be passing because the runtime
    // grew tolerant, not because our schemas are sound.
    const nullable = z.object({
      evidence: z.array(z.object({ reference: z.string().nullable() })),
    });
    expect(() => crossTheRuntimeBoundary("probe_nullable", nullable)).toThrow(
      /Invalid JSON schema/,
    );
  });

  it.each([
    ["record", z.object({ a: z.record(z.string(), z.string()) })],
    ["tuple", z.object({ a: z.tuple([z.string(), z.number()]) })],
  ] as const)("documents that a %s SILENTLY loses its shape rather than throwing", (_l, schema) => {
    // WORSE THAN THE BUG WE FIXED, and worth pinning for the next tool author.
    //
    // `.nullable()` at least fails loudly. A `record` serialises to an object with no
    // `properties`, and a `tuple` to an array whose `items` is an ARRAY -- and the
    // runtime's converter answers both with a bare `z.object({})`. Nothing throws, no
    // log appears, and the model is simply handed a tool whose argument has no fields.
    //
    // So neither belongs in a model-visible schema, and this records why in a way that
    // will fail here if a runtime upgrade ever changes the behaviour.
    expect(() => crossTheRuntimeBoundary("probe", schema)).not.toThrow();
  });

  it("accounts for every registered tool, so a new one cannot slip past", () => {
    // WHAT MAKES THE REGISTRY COMPLETE is no longer a scan of the source tree. A tool can
    // only reach the model through `useModelVisibleTool`, only the wrapper may import
    // `useFrontendTool` (Oxlint `no-restricted-imports`), and the shipped session's
    // MOUNTED registry is enumerated against these same names by the provider-backed proof
    // in `components/ai/session-real-core.test.tsx`. A ninth tool with an unconvertible
    // schema therefore fails there, and its schema fails the conversion cases above.
    const registered = [
      ...Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS),
      ...PARAMETERLESS_MODEL_VISIBLE_TOOLS,
    ];
    expect(registered.length).toBeGreaterThanOrEqual(8);
  });
});
