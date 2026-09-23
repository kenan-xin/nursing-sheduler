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
// `add_shift_type` / `add_shift_group` widen the original Phase-1 four on purpose:
// shift setup is Phase-1 scenario authoring, and both compile to the Shifts page's
// own primitives (`addItem` / `addGroup` / `setGroupMembers`), so the rule above holds.
//
// The rule arms (`add_/edit_succession_rule`, and the count, requirement and remove
// arms after them) widen the set the same way: each one fills the rule editor's own
// form draft and runs that editor's own validator and builder in `operations.ts`.
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

/** The Shift counts screen's six expressions (`expression-model.ts` `SUPPORTED_EXPRESSIONS`). */
export const COUNT_EXPRESSIONS = [
  "x <= T",
  "x >= T",
  "x = T",
  "x < T",
  "x > T",
  "|x - T|^2",
] as const;

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
  | { type: "move_leave"; personId: PersonRef; fromDate: DateRef; toDate: DateRef }
  /**
   * Add one shift type -- the Shifts page "Add shift" form with no staffing.
   * `endTime` before `startTime` is an overnight shift. `restMinutes: 0` means no
   * break. Paid minutes are derived by the host, never supplied.
   */
  | {
      type: "add_shift_type";
      code: string;
      name: string;
      startTime: string;
      endTime: string;
      restMinutes: number;
    }
  /** Add one shift group whose members are existing shift codes -- the Groups "New group" form. */
  | { type: "add_shift_group"; groupId: string; members: string[] }
  /**
   * Add one shift sequence rule -- the Shift sequences screen's Add form. `weight` is
   * the text the Weight box would hold ("-infinity" = never, "-50" = discourage).
   */
  | {
      type: "add_succession_rule";
      description: string;
      people: PersonRef[];
      pattern: string[];
      dates: string[];
      weight: string;
    }
  /** Replace every field of one shift sequence rule -- that screen's Edit form. */
  | {
      type: "edit_succession_rule";
      ruleId: string;
      description: string;
      people: PersonRef[];
      pattern: string[];
      dates: string[];
      weight: string;
    }
  /** Add one shift count rule -- the Shift counts screen's Add form (ordinary counts only). */
  | {
      type: "add_count_rule";
      description: string;
      people: PersonRef[];
      shiftTypes: string[];
      dates: string[];
      expression: (typeof COUNT_EXPRESSIONS)[number];
      target: number;
      weight: string;
    }
  /** Replace every field of one ordinary shift count rule -- that screen's Edit form. */
  | {
      type: "edit_count_rule";
      ruleId: string;
      description: string;
      people: PersonRef[];
      shiftTypes: string[];
      dates: string[];
      expression: (typeof COUNT_EXPRESSIONS)[number];
      target: number;
      weight: string;
    };

export type AssistantCommandType = AssistantCommandV1["type"];

/** Every arm's discriminant, for registry/parity tests and tool descriptions. */
export const ASSISTANT_COMMAND_TYPES = [
  "set_roster_range",
  "set_rule_enabled",
  "set_staffing_requirement_people",
  "move_leave",
  "add_shift_type",
  "add_shift_group",
  "add_succession_rule",
  "edit_succession_rule",
  "add_count_rule",
  "edit_count_rule",
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

/** Shape only; the 30-minute grid and span rules are the Shifts page's, applied in `operations.ts`. */
const clockSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "a time must be written HH:MM in 24-hour form, e.g. 08:00 or 20:30");

// RULE FIELDS are built per arm (a call, not a shared constant) so every arm's JSON
// Schema is emitted inline rather than as a reference the transport would have to
// resolve.

function ruleIdSchema() {
  return z
    .string()
    .min(1)
    .describe('The rule\'s stable id (its "uid"), as reported by get_schedule_section("rules").');
}

function ruleDescriptionSchema() {
  return z
    .string()
    .describe(
      "A short plain title in the ward's words, e.g. \"No day shift straight after a night " +
        'shift". Use "" only when there is nothing to go on.',
    );
}

function rulePeopleSchema() {
  return z
    .array(refSchema)
    .describe(
      "Who the rule is for: person ids and staff group ids exactly as in the schedule. " +
        '"ALL" is not accepted here -- for every nurse, list each person or use a staff ' +
        "group that holds everyone.",
    );
}

function ruleDatesSchema() {
  return z
    .array(z.string())
    .describe(
      'Which dates. EITHER exactly one of "ALL", "WEEKDAY", "WEEKEND", a weekday name such ' +
        'as "MONDAY", or an existing date group id -- OR one or more roster dates written ' +
        "YYYY-MM-DD. Never mix the two kinds.",
    );
}

function ruleWeightSchema() {
  return z
    .string()
    .describe(
      'How strongly, written as you would type it in the Weight box: "-infinity" = must ' +
        'never happen (hard rule), "infinity" = must always hold (hard rule), a negative ' +
        'number such as "-50" discourages, a positive number such as "10" encourages. ' +
        "The schedule shows hard weights as .inf / -.inf: send them as infinity / " +
        "-infinity. Ask the user whether a new rule is a must or a preference when they " +
        "did not say.",
    );
}

function successionFields() {
  return {
    description: ruleDescriptionSchema(),
    people: rulePeopleSchema(),
    pattern: z
      .array(z.string())
      .describe(
        'The shifts in order on consecutive days, at least two, e.g. ["Night", "Day"] ' +
          "for a day shift straight after a night. Shift codes, shift group ids, OFF, " +
          "LEAVE or ALL.",
      ),
    dates: ruleDatesSchema(),
    weight: ruleWeightSchema(),
  };
}

function countFields() {
  return {
    description: ruleDescriptionSchema(),
    people: rulePeopleSchema(),
    shiftTypes: z
      .array(z.string())
      .describe(
        "The shifts to count, per person: shift codes, shift group ids, OFF, LEAVE or ALL.",
      ),
    dates: ruleDatesSchema(),
    expression: z
      .enum(COUNT_EXPRESSIONS)
      .describe(
        'How each person\'s count x relates to the target T: "x <= T" at most, "x >= T" at ' +
          'least, "x = T" exactly, "x < T" fewer than, "x > T" more than, "|x - T|^2" as ' +
          'close to T as possible (needs a weight of 0 or less, never "infinity").',
      ),
    target: z.number().describe("The target T, a whole number of zero or more, e.g. 5."),
    weight: ruleWeightSchema(),
  };
}

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
  z.strictObject({
    type: z.enum(["add_shift_type"]),
    code: z
      .string()
      .describe(
        "The new shift's short code as shown on the roster, e.g. am1, N. Must not match any " +
          "existing shift code or shift group id, and must contain a letter.",
      ),
    name: z
      .string()
      .describe('The shift\'s longer name, e.g. "Night shift". Use "" when the user gave none.'),
    startTime: clockSchema.describe(
      "Start time, HH:MM 24-hour on the half hour. Convert what the user wrote: 0800 -> 08:00.",
    ),
    endTime: clockSchema.describe(
      "End time, HH:MM 24-hour on the half hour. An end earlier than the start means the " +
        "shift ends the next day (e.g. 20:00 to 08:30).",
    ),
    restMinutes: z
      .number()
      .int()
      .describe(
        "Unpaid break in whole minutes, a multiple of 30 and shorter than the shift. " +
          "Send 0 when the user gave no break.",
      ),
  }),
  z.strictObject({
    type: z.enum(["add_shift_group"]),
    groupId: z
      .string()
      .describe(
        "The new group's name. Shift codes and group names share one list, so it must differ " +
          'from every shift code -- e.g. "Night shifts" when a shift is called Night.',
      ),
    members: z
      .array(z.string())
      .min(1, "a shift group needs at least one shift")
      .describe(
        "Codes of the shifts in the group. Each must already exist or be added EARLIER in " +
          "the same change.",
      ),
  }),
  z.strictObject({ type: z.enum(["add_succession_rule"]), ...successionFields() }),
  z.strictObject({
    type: z.enum(["edit_succession_rule"]),
    ruleId: ruleIdSchema(),
    ...successionFields(),
  }),
  z.strictObject({ type: z.enum(["add_count_rule"]), ...countFields() }),
  z.strictObject({ type: z.enum(["edit_count_rule"]), ruleId: ruleIdSchema(), ...countFields() }),
]);

/** The most operations one change may hold. Also stated to the model, in its tool description -- see `use-proposal-tools.ts`. */
export const MAX_ASSISTANT_OPERATIONS = 25;

/**
 * A coherent batch — the unit the user reviews and applies.
 *
 * Bounded, and empty is refused: an empty proposal would render a Preview with an
 * enabled Apply that changes nothing, which reads to the user as a change they made.
 */
export const assistantCommandListSchema = z
  .array(assistantCommandSchema)
  .min(1, "a change must contain at least one operation")
  .max(MAX_ASSISTANT_OPERATIONS, "that is too many operations for one reviewable change");

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
