"use client";

// THE HOST'S OWN PARSE OF EVERY MODEL-VISIBLE TOOL PAYLOAD.
//
// WHY A SCHEMA ON A REGISTRATION IS NOT A CHECK. `@copilotkit/core@1.66.2` turns a tool
// call's arguments into an object with `parseToolArguments`: `JSON.parse`, plus a check
// that the result is an object, and nothing else. It never executes the Zod schema the
// tool was registered with, and it never applies that schema's defaults. So a schema
// attached to a registration documents the WIRE contract to the provider; it does not
// enforce the HOST contract, and every handler receives the model's raw JSON.
//
// Two whole classes of defect followed from assuming otherwise, both reproduced live:
//
//   * A DECLARED DEFAULT NEVER ARRIVED. A field with `.default(...)` is absent from the
//     wire schema's `required` list, and the serialised default is dropped by the
//     runtime's JSON-Schema-to-Zod round trip. A model that legally omitted it handed
//     the handler `undefined` -- which then reached `.map()`, or was copied straight
//     into a durable record's required boolean.
//
//   * A WRONG TYPE REACHED REAL CODE. `{ candidates: 42 }`, `{ policy: 42 }` and a
//     missing `domain` are all well-formed JSON objects. They reached `.map()`, string
//     processing, and an exhaustive switch that fell through to an empty success.
//
// SO EACH HANDLER PARSES, ITSELF. Deliberately not a wrapper around registration and not
// a middleware: an interception layer is one another registration can forget to use, and
// the ticket's boundary has to stay safe even if the runtime converter changes underneath
// it. What is shared here is the MECHANISM and the refusal WORDING, not the call site.
//
// ORDER IS PART OF THE CONTRACT. Entry authority is proven first -- a superseded turn
// must say nothing at all, including nothing about its arguments -- and the parse comes
// next, before any read, navigation, search, repository or UI effect.

import type { z } from "zod";

/** How many field paths a refusal will name. Enough to correct, short enough to read. */
const NAMED_FIELD_LIMIT = 5;

/**
 * The longest path segment worth repeating back.
 *
 * Every shipped schema keys on declared field names, so a segment is a name or an array
 * index. This is insurance rather than a live concern: if a future schema ever keyed on
 * model-supplied strings, an over-long segment would be payload, and payload never goes
 * into a refusal.
 */
const MAX_SEGMENT_LENGTH = 40;

export type ToolPayload<S extends z.ZodTypeAny> =
  | { readonly ok: true; readonly data: z.infer<S> }
  | { readonly ok: false; readonly refusal: string };

/**
 * The declared field paths an error touched, and nothing else.
 *
 * Paths come from the SCHEMA, so naming them tells the model what to correct without
 * quoting what it sent. Zod's messages are deliberately not used: they interpolate
 * received values, which is exactly the payload echo a tool result must not carry.
 */
function namedFields(error: z.ZodError): string[] {
  const paths = new Set<string>();
  for (const issue of error.issues) {
    const path = issue.path
      .filter(
        (segment): segment is string | number =>
          typeof segment === "number" ||
          (typeof segment === "string" && segment.length <= MAX_SEGMENT_LENGTH),
      )
      .join(".");
    if (path.length > 0) paths.add(path);
  }
  return [...paths].slice(0, NAMED_FIELD_LIMIT);
}

/**
 * The ONE thing every handler says about a payload it cannot accept.
 *
 * A REFUSAL IS A TOOL RESULT, NOT A THROW. A thrown handler is converted by the locked
 * core into `Error: <message>` and fed back as the tool result anyway -- so throwing
 * neither stops the turn nor hides anything, it just makes an internal message the
 * model's evidence. Answering plainly lets the model tell the user what it could not do.
 *
 * Bounded on purpose: declared field paths only. No values, no arguments, no transcript
 * text, no model output, no provider detail, no key, no raw error.
 */
export function malformedPayloadRefusal(error: z.ZodError): string {
  const fields = namedFields(error);
  return (
    "Those arguments are not a valid call to this tool" +
    (fields.length > 0 ? ` (check: ${fields.join(", ")})` : "") +
    ". Nothing was read, changed or opened. Tell the user you could not do that and ask " +
    "them for what is missing. Do not retry with an approximate call, and do not use a " +
    "different tool instead."
  );
}

/**
 * Parse one tool payload against the exact schema its registration declares.
 *
 * Call it after the entry authority check and before any effect, and use `data` from
 * here on -- never the raw object. The declared defaults are applied by this call, which
 * is the only place they are applied at all.
 */
export function parseToolPayload<S extends z.ZodTypeAny>(
  schema: S,
  rawArgs: unknown,
): ToolPayload<S> {
  const parsed = schema.safeParse(rawArgs);
  if (parsed.success) return { ok: true, data: parsed.data as z.infer<S> };
  return { ok: false, refusal: malformedPayloadRefusal(parsed.error) };
}
