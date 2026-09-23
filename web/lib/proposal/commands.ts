// The VERSIONED assistant-exposed command union (T07, tech-plan "Domain commands
// and Preview").
//
// WHAT THIS IS NOT. It is not `ScenarioCommandV1`. The repository's union is a set
// of durable PRIMITIVES (`patch_scenario`, `set_req_data`, ...) that can express any
// document at all; handing that to a model would be a JSON Patch with extra steps.
// This union is the narrow, named set of DOMAIN operations the assistant may
// propose, each one corresponding to a supported manual host operation, each one
// compiled by the host into a repository primitive it has already validated.
//
// THE SUBSET IS DELIBERATE, and its boundary is the ticket's: an arm exists here
// only when the host already owns a validated transform for it. The tech plan's
// example list (`add_backup_person`, a generic `batch`, ...) is illustrative, not
// authorising -- inventing an arm whose host operation does not exist would let the
// model announce a capability no validated path can honour, which is the exact
// failure the closed flows forbid. Arms are additive under `schemaVersion`.
//
// EVERY FIELD IS A TARGET, NEVER A DOCUMENT. There is no arm that accepts scenario
// content, a patch, a card body, or a free-form object: the model names WHICH
// existing thing to change and WHAT value it should take, and the host derives the
// resulting document. That is what makes "no arbitrary patches" a property of the
// type rather than a rule someone has to remember.

import { z } from "zod";
import type { DateRef, GuidedRuleConstraintKind, IsoDate, PersonRef } from "@/lib/scenario";

/** Bumped when an arm's SHAPE changes. A persisted proposal records the version it was prepared under. */
export const ASSISTANT_COMMAND_SCHEMA_VERSION = 1 as const;

/** The five rule kinds a `set_rule_enabled` may target — the guided rule constraint kinds. */
export const RULE_KINDS = [
  "requirements",
  "successions",
  "counts",
  "affinities",
  "coverings",
] as const satisfies readonly GuidedRuleConstraintKind[];

export type AssistantCommandV1 =
  /**
   * Move the roster period. The most consequential supported operation: dates that
   * leave the range take every reference to them with them, so its cascade is the
   * reason Preview exposes downstream consequences at all.
   *
   * `importPublicHolidays` is REQUIRED rather than defaulted. The manual card
   * defaults it per situation, but a defaulted value here would be the assistant
   * inventing a consequential choice the user never made — the setup flow's first
   * translation rule.
   */
  | { type: "set_roster_range"; start: IsoDate; end: IsoDate; importPublicHolidays: boolean }
  /** Turn one existing rule on or off — the Rules screen's own enable toggle. */
  | {
      type: "set_rule_enabled";
      ruleKind: (typeof RULE_KINDS)[number];
      ruleId: string;
      enabled: boolean;
    }
  /** Change one staffing requirement's required head count — the Rules quick edit. */
  | { type: "set_staffing_requirement_people"; ruleId: string; requiredNumPeople: number }
  /**
   * Move one person's LEAVE pin from one roster date to another.
   *
   * The one arm that carries a real-world commitment: a leave date is an agreement
   * with a person, so it is also the arm that produces a host-derived operational
   * confirmation (see `assumptions.ts`).
   */
  | { type: "move_leave"; personId: PersonRef; fromDate: DateRef; toDate: DateRef };

export type AssistantCommandType = AssistantCommandV1["type"];

/** Every arm's discriminant, for registry/parity tests and tool descriptions. */
export const ASSISTANT_COMMAND_TYPES = [
  "set_roster_range",
  "set_rule_enabled",
  "set_staffing_requirement_people",
  "move_leave",
] as const satisfies readonly AssistantCommandType[];

// EXHAUSTIVE IN BOTH DIRECTIONS. `satisfies` above proves every listed name is a real
// arm; this proves every arm is listed. `phase-2-absence.test.ts` used to establish the
// second direction by regexing `z.literal("...")` out of this file's source -- a
// hand-rolled parser over a schema declaration, and one that would have returned nothing
// (and passed vacuously) if the union were ever reshaped. Add an arm without listing it
// here and `tsc --noEmit` fails, before any test runs.
type _EveryArmIsListed = AssistantCommandType extends (typeof ASSISTANT_COMMAND_TYPES)[number]
  ? true
  : [
      "missing from ASSISTANT_COMMAND_TYPES",
      Exclude<AssistantCommandType, (typeof ASSISTANT_COMMAND_TYPES)[number]>,
    ];
const _exhaustive: _EveryArmIsListed = true;
void _exhaustive;

/**
 * A person/date reference as the backend models them (`int | str`).
 *
 * Accepted from the model as either, because the ids in the document genuinely are
 * either — coercing would make the distinct ids `1` and `"1"` collide, which is the
 * exact confusion the producer schema refuses elsewhere.
 */
const refSchema = z.union([z.string(), z.number()]);

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date must be written YYYY-MM-DD");

/**
 * The wire schema for one command.
 *
 * Structural only. It proves the SHAPE is one of the supported arms; whether the
 * target exists, the value is legal, and the record is representable is decided by
 * `operations.ts` against the live document, because none of that is knowable from
 * the payload alone.
 *
 * STRICT objects, not merely typed ones. An ordinary object schema STRIPS unknown
 * keys, which would be safe (nothing reaches the host) but silent -- a model that
 * attached a card body alongside its targets would be told the operation was
 * accepted. Refusing outright turns "no arbitrary content" into a message the model
 * can act on rather than a quiet omission.
 *
 * EACH DISCRIMINANT IS A ONE-MEMBER `z.enum`, NOT A `z.literal`, and that is a
 * transport constraint rather than a style choice. Zod v4 serialises
 * `z.literal("move_leave")` as `{ "type": "string", "const": "move_leave" }`, and
 * `@copilotkit/runtime@1.66.2` converts each tool's JSON Schema back into Zod before
 * the provider loop using a converter that has an `enum` case and NO `const` case --
 * so every discriminant was rebuilt as a bare `z.string()` and the arm NAMES never
 * reached the provider at all. Live Sonnet 4.5 and Haiku 4.5 enumerated
 * `prepare_scenario_change` and `test_feasibility_candidates`, then declined to call
 * them, because the only two tools embedding this union were the only two whose
 * arguments arrived describing nothing. `z.enum(["move_leave"])` admits exactly the
 * same one string, infers the same literal type, and discriminates the same union --
 * it simply survives the round trip. `model-visible-tools.test.ts` asserts the arm
 * names on the recorded provider request and keeps a `z.literal` mutation control
 * beside them.
 */
export const assistantCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum(["set_roster_range"]),
    start: isoDateSchema.describe("First day of the roster period, YYYY-MM-DD."),
    end: isoDateSchema.describe("Last day of the roster period, YYYY-MM-DD."),
    importPublicHolidays: z
      .boolean()
      .describe(
        "Whether to (re)import the Singapore public-holiday date groups for the new period. " +
          "Ask the user; never assume.",
      ),
  }),
  z.strictObject({
    type: z.enum(["set_rule_enabled"]),
    ruleKind: z.enum(RULE_KINDS).describe("Which rule family the rule belongs to."),
    ruleId: z.string().min(1).describe("The rule's stable id, as reported by a read tool."),
    enabled: z.boolean(),
  }),
  z.strictObject({
    type: z.enum(["set_staffing_requirement_people"]),
    ruleId: z.string().min(1).describe("The staffing requirement's stable id."),
    requiredNumPeople: z.number().describe("How many people that shift must have."),
  }),
  z.strictObject({
    type: z.enum(["move_leave"]),
    personId: refSchema.describe("The person whose leave is moving."),
    fromDate: refSchema.describe("The roster date the leave is currently on."),
    toDate: refSchema.describe("The roster date the leave should move to."),
  }),
]);

/**
 * A coherent batch — the unit the user reviews and applies.
 *
 * Bounded, and empty is refused: an empty proposal would render a Preview with an
 * enabled Apply that changes nothing, which reads to the user as a change they made.
 */
export const assistantCommandListSchema = z
  .array(assistantCommandSchema)
  .min(1, "a change must contain at least one operation")
  .max(25, "that is too many operations for one reviewable change");

/** Parse an untrusted payload into typed commands, or report why it is not one. */
export function parseAssistantCommands(
  value: unknown,
): { ok: true; commands: AssistantCommandV1[] } | { ok: false; message: string } {
  const parsed = assistantCommandListSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      message: first
        ? `${first.path.join(".") || "commands"}: ${first.message}`
        : "invalid commands",
    };
  }
  return { ok: true, commands: parsed.data as AssistantCommandV1[] };
}
