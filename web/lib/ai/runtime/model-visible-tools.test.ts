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
import { beforeAll, describe, expect, it } from "vitest";
import { asSchema } from "ai";
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
import { ASSISTANT_COMMAND_TYPES, parseAssistantCommands } from "@/lib/proposal";

import { createSchedulerCopilotRuntime } from "./handler";
import { readSse, recordingOpenRouter, runRequest } from "./test-support";

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

// --- what the model is actually SHOWN --------------------------------------
//
// CONVERTING WITHOUT THROWING IS NOT THE GUARANTEE. Everything above proves the locked
// converter ACCEPTS our schemas. It cannot prove the schema that comes out the far side
// still SAYS anything, and the difference is a whole class of live failure: a tool the
// provider accepts, the model enumerates, and then refuses to call because the arguments
// it was shown do not describe a callable shape.
//
// THE DEFECT THIS PINS. `prepare_scenario_change` and `test_feasibility_candidates` were
// the only two tools real Sonnet 4.5 and Haiku 4.5 would not call, and the only two whose
// parameters embed `assistantCommandListSchema`. Each arm's discriminant was
// `z.literal("set_rule_enabled")`, which Zod v4 serialises as
// `{ "type": "string", "const": "set_rule_enabled" }`. The runtime's JSON-Schema-to-Zod
// converter has an `enum` case and NO `const` case, so it rebuilt every discriminant as a
// bare `z.string()`. What reached OpenRouter was four near-identical objects whose `type`
// was an unconstrained string -- the operation names were nowhere on the wire, so no model
// could supply one. It reported the change as "not available through the preview system",
// which was true of what it had been shown.
//
// So the assertion is about the BYTES THAT LEAVE, read off the recorded provider request
// rather than recomputed from the Zod schema.

type JsonNode = Record<string, unknown>;

function child(parent: JsonNode | undefined, key: string): JsonNode {
  const value = parent?.[key];
  if (typeof value !== "object" || value === null) {
    throw new Error(`expected an object at "${key}", found ${JSON.stringify(value)}`);
  }
  return value as JsonNode;
}

/** The union branches of a node, whichever keyword the pipeline ended up emitting. */
function branches(schema: JsonNode): JsonNode[] {
  const union = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(union)) {
    throw new Error(`expected a union, found keys ${JSON.stringify(Object.keys(schema))}`);
  }
  return union as JsonNode[];
}

/**
 * The single value a discriminant node admits, or `null` when it admits anything.
 *
 * `null` is the failure the live models hit, so it is a value this helper RETURNS rather
 * than throws on -- the tests below have to be able to state it.
 */
function pinnedValue(discriminant: JsonNode): string | null {
  if (typeof discriminant.const === "string") return discriminant.const;
  const enumerated = discriminant.enum;
  if (Array.isArray(enumerated) && enumerated.length === 1 && typeof enumerated[0] === "string") {
    return enumerated[0];
  }
  return null;
}

/** The arm names a command-list node offers the model, in declaration order. */
function offeredArms(commandList: JsonNode): (string | null)[] {
  return branches(child(commandList, "items")).map((arm) =>
    pinnedValue(child(child(arm, "properties"), "type")),
  );
}

/**
 * The tool definitions EXACTLY as they leave for OpenRouter.
 *
 * Nothing is simulated: the shipped Zod schema is serialised the way the client does,
 * posted through the real mounted runtime handler, converted by the real runtime and
 * re-serialised by the real AI SDK. The only fixture is the OpenRouter endpoint itself,
 * which records the outgoing body. A restatement of any of those four steps would be a
 * test of the restatement.
 */
async function providerToolDefinitions(): Promise<Map<string, JsonNode>> {
  const provider = recordingOpenRouter();
  const runtime = createSchedulerCopilotRuntime({
    fetch: provider.fetch,
    instanceId: "instance-wire-probe",
  });

  await readSse(
    await runtime.handler(
      runRequest({
        threadId: "t-wire",
        tools: Object.entries(MODEL_VISIBLE_TOOL_SCHEMAS).map(([name, schema]) => ({
          name,
          description: `${name} (wire probe)`,
          parameters: onTheWire(schema),
        })),
      }),
    ),
  );

  const tools = provider.calls[0].body.tools as { function: { name: string } }[];
  return new Map(tools.map((tool) => [tool.function.name, child(tool as JsonNode, "function")]));
}

describe("the command arms the provider is actually shown", () => {
  let wire: Map<string, JsonNode>;

  beforeAll(async () => {
    wire = await providerToolDefinitions();
  });

  it("puts every shipped tool on the wire", () => {
    expect([...wire.keys()].sort()).toEqual(Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS).sort());
  });

  it("names every command arm in prepare_scenario_change's operations", () => {
    const parameters = child(wire.get("prepare_scenario_change"), "parameters");
    const operations = child(child(parameters, "properties"), "operations");
    // Not "at least one arm survived": the model must be shown the WHOLE family, or a
    // command kind silently becomes unreachable while the tool keeps working.
    expect(offeredArms(operations)).toEqual([...ASSISTANT_COMMAND_TYPES]);
  });

  it("names every command arm in test_feasibility_candidates' candidates", () => {
    // One level deeper -- `candidates[].operations` -- which is why it gets its own case
    // rather than being inferred from the tool above.
    const parameters = child(wire.get("test_feasibility_candidates"), "parameters");
    const candidates = child(child(parameters, "properties"), "candidates");
    const candidate = child(candidates, "items");
    const operations = child(child(candidate, "properties"), "operations");
    expect(offeredArms(operations)).toEqual([...ASSISTANT_COMMAND_TYPES]);
  });

  it("offers, for every arm, exactly the fields the canonical schema requires", () => {
    // WIRE AND HOST, TIED TOGETHER. Showing the model the right arm NAMES is only half of
    // it: a name it can select but whose fields the host would reject is the same dead end
    // wearing a different hat. So each arm's advertised property set and `required` list
    // are compared against a real payload, and that payload is then pushed through the
    // canonical parser and required to come back UNCHANGED.
    const representative: Record<string, Record<string, unknown>> = {
      set_roster_range: {
        type: "set_roster_range",
        start: "2026-04-01",
        end: "2026-04-30",
        importPublicHolidays: true,
      },
      set_rule_enabled: {
        type: "set_rule_enabled",
        ruleKind: "counts",
        ruleId: "c1",
        enabled: false,
      },
      set_staffing_requirement_people: {
        type: "set_staffing_requirement_people",
        ruleId: "r1",
        requiredNumPeople: 2,
      },
      move_leave: { type: "move_leave", personId: 7, fromDate: "02", toDate: "03" },
      add_shift_type: {
        type: "add_shift_type",
        code: "N",
        name: "Night shift",
        startTime: "20:00",
        endTime: "08:30",
        restMinutes: 60,
      },
      add_shift_group: { type: "add_shift_group", groupId: "Night shifts", members: ["N"] },
      add_succession_rule: {
        type: "add_succession_rule",
        description: "No day shift straight after a night shift",
        people: ["ana", "ben"],
        pattern: ["Night", "Day"],
        dates: ["ALL"],
        weight: "-infinity",
      },
      edit_succession_rule: {
        type: "edit_succession_rule",
        ruleId: "s1",
        description: "No day shift straight after a night shift",
        people: ["ana", "ben"],
        pattern: ["Night", "Day"],
        dates: ["ALL"],
        weight: "-50",
      },
      add_count_rule: {
        type: "add_count_rule",
        description: "At most 5 night shifts per nurse per month",
        people: ["ana", "ben"],
        shiftTypes: ["Night"],
        dates: ["ALL"],
        expression: "x <= T",
        target: 5,
        weight: "infinity",
      },
      edit_count_rule: {
        type: "edit_count_rule",
        ruleId: "c1",
        description: "Night cap",
        people: ["ana"],
        shiftTypes: ["Night"],
        dates: ["ALL"],
        expression: "x <= T",
        target: 4,
        weight: "infinity",
      },
    };
    expect(Object.keys(representative).sort()).toEqual([...ASSISTANT_COMMAND_TYPES].sort());

    const parameters = child(wire.get("prepare_scenario_change"), "parameters");
    const operations = child(child(parameters, "properties"), "operations");

    for (const arm of branches(child(operations, "items"))) {
      const name = pinnedValue(child(child(arm, "properties"), "type"));
      const payload = representative[name ?? ""];
      expect(payload, `no representative payload for arm ${name}`).toBeDefined();

      const advertised = Object.keys(child(arm, "properties")).sort();
      expect(advertised).toEqual(Object.keys(payload).sort());
      expect([...(arm.required as string[])].sort()).toEqual(Object.keys(payload).sort());

      const parsed = parseAssistantCommands([payload]);
      expect(parsed.ok, `canonical parse rejected the wire arm ${name}`).toBe(true);
      if (parsed.ok) expect(parsed.commands).toEqual([payload]);
    }
  });

  it("leaves the parameterless and flat-parameter tools exactly as they were", () => {
    // The flat tools worked live throughout, so the repair has to be provably confined:
    // an enum that was already an enum still reaches the wire as one.
    const section = child(wire.get("get_schedule_section"), "parameters");
    const domain = child(child(section, "properties"), "domain");
    expect(domain.enum).toEqual(["dates", "staff", "shifts", "rules", "requests"]);

    const capability = child(wire.get("explain_app_capability"), "parameters");
    expect(child(child(capability, "properties"), "capabilityId").type).toBe("string");

    // The two parameterless tools are registered with no schema at all, so they are not
    // in this map and cannot be affected by anything the command union does.
    for (const name of PARAMETERLESS_MODEL_VISIBLE_TOOLS) {
      expect(wire.has(name)).toBe(false);
    }
  });

  it("IS NOT VACUOUS: a z.literal discriminant still arrives unconstrained", () => {
    // THE MUTATION CONTROL, and the reason the repair is what it is.
    //
    // This is the exact shape the union had when the two tools failed live. If this ever
    // starts preserving its discriminant, the runtime has grown a `const` case and the
    // three assertions above would pass for a reason that has nothing to do with our
    // schemas -- so this failing is the signal to re-read the repair, not to delete it.
    const literalDiscriminated = z.object({
      operations: z.array(
        z.discriminatedUnion("type", [
          z.strictObject({ type: z.literal("probe_a"), a: z.string() }),
          z.strictObject({ type: z.literal("probe_b"), b: z.string() }),
        ]),
      ),
    });

    const converted = convertToolsToVercelAITools([
      {
        name: "probe_literal",
        description: "probe",
        parameters: onTheWire(literalDiscriminated),
      },
    ]) as Record<string, { inputSchema: Parameters<typeof asSchema>[0] }>;

    const operations = child(
      child(asSchema(converted.probe_literal.inputSchema).jsonSchema as JsonNode, "properties"),
      "operations",
    );
    expect(offeredArms(operations)).toEqual([null, null]);
  });
});
