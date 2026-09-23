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
// `add_leave` / `set_off_request` / `set_shift_request` / `clear_requests` are the
// Requests page's quick paint (select LEAVE, OFF, a shift, or nothing, then drag over
// dates) and compile to its own fold (`foldPaintIntents`). Removing someone's leave is
// an agreement with them; `assumptions.ts` asks about it from the document diff, so no
// arm carries a confirmation flag the model could leave out.
//
// The Staff-screen arms (`add_person`, `edit_person`, `remove_person`,
// `add_people_group`, `edit_people_group`, `remove_people_group`) compile to the
// Staff screen's own primitives over `peopleDescriptor` (`addItem`, `renameItem`,
// `deleteItem`, `addGroup`, `renameGroup`, `updateGroupFields`, `deleteGroup`,
// `writeItemGroups`, `writeGroupMembers`). `mark_person_off` is the Requests
// screen's quick paint of OFF at weight Infinity across a run of days. Together
// they express a nurse borrowed from another ward for a few dates.
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
  /** Leave for one person (or staff group row) on every date from `startDate` to `endDate` -- painting LEAVE. */
  | { type: "add_leave"; personId: PersonRef; startDate: IsoDate; endDate: IsoDate }
  /** A day-off request over a date range -- painting OFF at `weight`. */
  | {
      type: "set_off_request";
      personId: PersonRef;
      startDate: IsoDate;
      endDate: IsoDate;
      weight: RequestWeight;
    }
  /** A wish for, or against, one shift (or shift group, or ALL) over a date range -- painting that shift. */
  | {
      type: "set_shift_request";
      personId: PersonRef;
      shiftType: string;
      startDate: IsoDate;
      endDate: IsoDate;
      weight: RequestWeight;
    }
  /** Remove everything recorded on those dates -- Clear cell / painting with nothing selected. */
  | { type: "clear_requests"; personId: PersonRef; startDate: IsoDate; endDate: IsoDate }
  /** Add one person -- the Staff screen's "Add nurse" row: a name and the staff groups they join. */
  | { type: "add_person"; name: string; groups: string[] }
  /**
   * Rename one person and set EXACTLY which staff groups they are in -- the Staff
   * row's Edit. A name equal to the current id text is not a rename.
   */
  | { type: "edit_person"; personId: PersonRef; name: string; groups: string[] }
  /** Remove one person and every reference to them -- the Staff row's Delete. */
  | { type: "remove_person"; personId: PersonRef }
  /** Add one staff group -- the Staff groups "New group" form. */
  | { type: "add_people_group"; groupId: string; description: string; members: PersonRef[] }
  /** Rename a staff group, set its description and EXACTLY its members -- the group's Edit form. */
  | {
      type: "edit_people_group";
      groupId: string;
      newGroupId: string;
      description: string;
      members: PersonRef[];
    }
  /** Remove one staff group and every reference to it -- the group's Delete. */
  | { type: "remove_people_group"; groupId: string };

/** A request strength: a finite number, or a hard pin. JSON cannot carry an infinity, so the pins are words. */
export type RequestWeight = number | "must" | "never";

export type AssistantCommandType = AssistantCommandV1["type"];

/** Every arm's discriminant, for registry/parity tests and tool descriptions. */
export const ASSISTANT_COMMAND_TYPES = [
  "set_roster_range",
  "set_rule_enabled",
  "set_staffing_requirement_people",
  "move_leave",
  "add_shift_type",
  "add_shift_group",
  "add_leave",
  "set_off_request",
  "set_shift_request",
  "clear_requests",
  "add_person",
  "edit_person",
  "remove_person",
  "add_people_group",
  "edit_people_group",
  "remove_people_group",
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

const requestPersonSchema = refSchema.describe(
  "The person's id exactly as the staff list reports it, or a staff group id to record it " +
    "on that group's row.",
);
const startDateSchema = isoDateSchema.describe(
  "First calendar date, YYYY-MM-DD, inside the roster period.",
);
const endDateSchema = isoDateSchema.describe(
  "Last calendar date, YYYY-MM-DD, inclusive. The same as startDate for a single day.",
);
/** Shape only: a finite whole number or a hard pin. The host maps "must"/"never" to
 *  ±Infinity. Whole because the backend and `zWeight` both reject fractional weights. */
const requestWeightSchema = z.union([z.number().int(), z.enum(["must", "never"])], {
  error: 'a weight is a whole number, or "must"/"never"',
});

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
  z.strictObject({
    type: z.enum(["add_leave"]),
    personId: requestPersonSchema,
    startDate: startDateSchema,
    endDate: endDateSchema,
  }),
  z.strictObject({
    type: z.enum(["set_off_request"]),
    personId: requestPersonSchema,
    startDate: startDateSchema,
    endDate: endDateSchema,
    weight: requestWeightSchema.describe(
      "How much they want those days off: a positive number wants them (e.g. 5), 0 is a plain " +
        'day-off request, a negative number would rather not be off. "must" makes it a hard ' +
        "rule; use it only when the user says it is not negotiable. Replaces anything already " +
        "on those dates, including leave.",
    ),
  }),
  z.strictObject({
    type: z.enum(["set_shift_request"]),
    personId: requestPersonSchema,
    shiftType: z
      .string()
      .describe('A shift code or shift group id from the schedule, or "ALL" for any shift.'),
    startDate: startDateSchema,
    endDate: endDateSchema,
    weight: requestWeightSchema.describe(
      "Positive wants that shift (e.g. 5), negative does not want it (e.g. -5); larger is " +
        'stronger. "must" / "never" make it a hard rule; use them only when the user says it ' +
        "is not negotiable. 0 removes their existing request for that shift. Dates with leave " +
        "or a day off are left as they are.",
    ),
  }),
  z
    .strictObject({
      type: z.enum(["clear_requests"]),
      personId: requestPersonSchema,
      startDate: startDateSchema,
      endDate: endDateSchema,
    })
    .describe(
      "Remove everything recorded for that person on those dates: leave, day-off and shift " +
        "requests. Removing leave makes the preview ask the user to confirm the person agreed. " +
        "To free someone on leave to cover a shift, tell the user to ask them first, and " +
        "propose this as that question, never as a decision.",
    ),
  z.strictObject({
    type: z.enum(["add_person"]),
    name: z
      .string()
      .describe(
        'The person\'s name as the staff list should show it, e.g. "Float RN (Ward 5)". Must ' +
          "not match any existing person or staff group, and must not be ALL.",
      ),
    groups: z
      .array(z.string())
      .describe(
        'Staff groups to put them in, e.g. ["RN"]. Each must exist or be added EARLIER in ' +
          "the same change. Send [] for none. Never list ALL: everyone is in it.",
      ),
  }),
  z.strictObject({
    type: z.enum(["edit_person"]),
    personId: refSchema.describe(
      "The person's id exactly as the staff list shows it. A number stays a number.",
    ),
    name: z.string().describe("The name they should have. Send their current name to keep it."),
    groups: z
      .array(z.string())
      .describe(
        "EVERY staff group they should be in after the change -- groups left out are " +
          "removed. Send their current groups to keep them.",
      ),
  }),
  z.strictObject({
    type: z.enum(["remove_person"]),
    personId: refSchema.describe(
      "The person to remove, exactly as the staff list shows the id. Their requests, leave " +
        "and any rule that only names them go too; the preview lists every one.",
    ),
  }),
  z.strictObject({
    type: z.enum(["add_people_group"]),
    groupId: z
      .string()
      .describe(
        "The new staff group's name, e.g. Seniors. People and staff groups share one list of " +
          "names, so it must differ from every person and group, and must not be ALL.",
      ),
    description: z.string().describe('What the group is for. Send "" for none.'),
    members: z
      .array(refSchema)
      .describe(
        "Ids of the people in the group, exactly as the staff list shows them. Each must " +
          "exist or be added EARLIER in the same change. May be [].",
      ),
  }),
  z.strictObject({
    type: z.enum(["edit_people_group"]),
    groupId: z.string().describe("The staff group's current name."),
    newGroupId: z.string().describe("The name it should have. Send the current name to keep it."),
    description: z
      .string()
      .describe('The description it should have. Send the current one to keep it, "" to clear.'),
    members: z
      .array(refSchema)
      .describe(
        "EVERY person who should be in the group after the change -- people left out are " +
          "removed.",
      ),
  }),
  z.strictObject({
    type: z.enum(["remove_people_group"]),
    groupId: z
      .string()
      .describe(
        "The staff group to remove. Rules that only target this group go too; the preview " +
          "lists them.",
      ),
  }),
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
