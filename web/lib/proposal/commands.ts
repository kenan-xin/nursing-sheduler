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
// The rule arms (`add_/edit_shift_sequence_rule`, and the count, requirement and remove
// arms after them) widen the set the same way: each one fills the rule editor's own
// form draft and runs that editor's own validator and builder in `operations.ts`.
// `add_/edit_pairing_rule` (the Affinities screen) and `add_/edit_supervision_rule`
// (the Shift Type Coverings screen) do too, named in plain words (bead 31og).
//
// The Staff-screen arms (`add_person`, `edit_person`, `remove_person`,
// `add_people_group`, `edit_people_group`, `remove_people_group`) compile to the
// Staff screen's own primitives over `peopleDescriptor` (`addItem`, `renameItem`,
// `deleteItem`, `addGroup`, `renameGroup`, `updateGroupFields`, `deleteGroup`,
// `writeItemGroups`, `writeGroupMembers`). A nurse borrowed from another ward is
// expressed with EXISTING arms: `add_person` for the float nurse, then
// `set_off_request` with weight `"must"` painted over the surrounding dates so they
// are only available on the days they are actually here (see
// `operations.test.ts`'s "borrows one RN" case). `add_person`'s new person can be
// referenced by later commands in the same batch as `PersonRef` = their trimmed name
// (`applyAddPerson` derives the id the Staff row does, via `validateFullEditId`).
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

/** The five rule families -- targets of `set_rule_enabled` and `remove_rule`. */
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
  | {
      type: "set_roster_range";
      start: IsoDate;
      end: IsoDate;
      importPublicHolidays: boolean;
    }
  /** Turn one existing rule on or off — the Rules screen's own enable toggle. */
  | {
      type: "set_rule_enabled";
      ruleKind: (typeof RULE_KINDS)[number];
      ruleId: string;
      enabled: boolean;
    }
  /** Change one staffing requirement's required head count — the Rules quick edit. */
  | {
      type: "set_staffing_requirement_people";
      ruleId: string;
      requiredNumPeople: number;
    }
  /**
   * Move one person's LEAVE pin from one roster date to another.
   *
   * The one arm that carries a real-world commitment: a leave date is an agreement
   * with a person, so it is also the arm that produces a host-derived operational
   * confirmation (see `assumptions.ts`).
   */
  | {
      type: "move_leave";
      personId: PersonRef;
      fromDate: DateRef;
      toDate: DateRef;
    }
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
  | {
      type: "add_leave";
      personId: PersonRef;
      startDate: IsoDate;
      endDate: IsoDate;
    }
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
  | {
      type: "clear_requests";
      personId: PersonRef;
      startDate: IsoDate;
      endDate: IsoDate;
    }
  /**
   * Add one shift sequence rule -- the Shift Successions screen's Add form. Named in
   * plain words, not the engine's "succession", because the model repeats op names to
   * the user (bead nj3q); the stored card kind stays `successions`. `weight` is
   * the text the Weight box would hold ("-infinity" = never, "-50" = discourage).
   */
  | {
      type: "add_shift_sequence_rule";
      description: string;
      people: PersonRef[];
      pattern: string[];
      dates: string[];
      weight: string;
    }
  /** Replace every field of one shift sequence rule -- that screen's Edit form. */
  | {
      type: "edit_shift_sequence_rule";
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
  /** Add the one rolling "2 rest days in any 7 days in a row" rule for everyone (bead 1v5k). */
  | { type: "add_rest_days_rule" }
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
    }
  /**
   * Add one staffing requirement -- the Staffing requirements screen's Add form. An omitted
   * preferred count leaves Preferred blank; an omitted weight keeps the form's default.
   */
  | {
      type: "add_staffing_requirement";
      description: string;
      shiftType: string;
      qualifiedPeople: PersonRef[];
      dates: string[];
      requiredNumPeople: number;
      preferredNumPeople?: number;
      weight?: string;
      skillMix?: { people: PersonRef; minNumPeople: number }[];
    }
  /**
   * Replace these fields of one staffing requirement -- that screen's Edit form. An
   * omitted preferred count or weight, the coefficients and skill mix are kept as stored.
   */
  | {
      type: "edit_staffing_requirement";
      ruleId: string;
      description: string;
      shiftType: string;
      qualifiedPeople: PersonRef[];
      dates: string[];
      requiredNumPeople: number;
      preferredNumPeople?: number;
      weight?: string;
    }
  /**
   * Replace one staffing requirement's skill mix -- that screen's Edit form "Skill mix"
   * rows. Each entry: at least `minNumPeople` of `people` among the shift's staff. It
   * bans nobody (unlike qualifiedPeople). An empty list clears it.
   */
  | {
      type: "set_skill_mix";
      ruleId: string;
      skillMix: { people: PersonRef; minNumPeople: number }[];
    }
  /**
   * Give one staffing requirement a different head count on ONE date -- the Staffing
   * requirements form's "Different number on some dates" row. The rule's own number
   * removes the exception.
   */
  | {
      type: "set_staffing_requirement_on_date";
      ruleId: string;
      date: string;
      requiredNumPeople: number;
    }
  /** Delete one rule of any family -- every rule screen's Delete. */
  | {
      type: "remove_rule";
      ruleKind: (typeof RULE_KINDS)[number];
      ruleId: string;
    }
  /** Add one person -- the Staff screen's "Add nurse" row: a name and the staff groups they join. */
  | { type: "add_person"; name: string; groups: string[] }
  /**
   * Rename one person and set EXACTLY which staff groups they are in -- the Staff row's
   * Edit. A name equal to the current id text is not a rename.
   */
  | { type: "edit_person"; personId: PersonRef; name: string; groups: string[] }
  /** Remove one person and every reference to them -- the Staff row's Delete. */
  | { type: "remove_person"; personId: PersonRef }
  /** Add one staff group -- the Staff groups "New group" form. */
  | {
      type: "add_people_group";
      groupId: string;
      description: string;
      members: PersonRef[];
    }
  /** Rename a staff group, set its description and EXACTLY its members -- the group's Edit form. */
  | {
      type: "edit_people_group";
      groupId: string;
      newGroupId: string;
      description: string;
      members: PersonRef[];
    }
  /** Remove one staff group and every reference to it -- the group's Delete. */
  | { type: "remove_people_group"; groupId: string }
  /**
   * Book one temporary cover -- the Staff screen's "Add temporary cover" form: a named
   * nurse from another ward, ONE date, one shift she works and the staff groups she
   * counts as. She is a staffing credit, never a solver person: her date's need drops by
   * one and no staff row, request or rule names her. A second cover for the same name on
   * the same date is refused, in the form's own words.
   */
  | {
      type: "add_temporary_cover";
      name: string;
      date: string;
      shiftType: string;
      groups: string[];
    }
  /** Remove one temporary cover, named by its three identity fields -- the Staff row's Delete. */
  | { type: "remove_temporary_cover"; name: string; date: string; shiftType: string }
  /**
   * Add one pairing rule -- the Affinities screen's Add form: `people` and `withPeople` on
   * the same shifts on the same date, encouraged (positive weight) or kept apart
   * (negative). `weight` is the text the Weight box would hold.
   */
  | {
      type: "add_pairing_rule";
      description: string;
      people: PersonRef[];
      withPeople: PersonRef[];
      shiftTypes: string[];
      dates: string[];
      weight: string;
    }
  /** Replace every field of one pairing rule -- the Affinities screen's Edit form. */
  | {
      type: "edit_pairing_rule";
      ruleId: string;
      description: string;
      people: PersonRef[];
      withPeople: PersonRef[];
      shiftTypes: string[];
      dates: string[];
      weight: string;
    }
  /**
   * Add one supervision rule -- the Shift Type Coverings screen's Add form: whenever one
   * of `supervisedPeople` works one of the shifts, one of `supervisors` works it too.
   * Always a hard rule, so it has no weight. `dates: []` means every date.
   */
  | {
      type: "add_supervision_rule";
      description: string;
      supervisors: PersonRef[];
      supervisedPeople: PersonRef[];
      shiftTypes: string[];
      dates: string[];
    }
  /** Replace every field of one supervision rule -- that screen's Edit form. */
  | {
      type: "edit_supervision_rule";
      ruleId: string;
      description: string;
      supervisors: PersonRef[];
      supervisedPeople: PersonRef[];
      shiftTypes: string[];
      dates: string[];
    };

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
  "add_shift_sequence_rule",
  "edit_shift_sequence_rule",
  "add_count_rule",
  "add_rest_days_rule",
  "edit_count_rule",
  "add_staffing_requirement",
  "edit_staffing_requirement",
  "set_skill_mix",
  "set_staffing_requirement_on_date",
  "remove_rule",
  "add_person",
  "edit_person",
  "remove_person",
  "add_people_group",
  "edit_people_group",
  "remove_people_group",
  "add_temporary_cover",
  "remove_temporary_cover",
  "add_pairing_rule",
  "edit_pairing_rule",
  "add_supervision_rule",
  "edit_supervision_rule",
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
 * A clock is a plain string on the wire. The format, the 30-minute grid and the span
 * rules are all the Shifts page's (`validateWorkingTimeDraft`, applied in
 * `operations.ts`), whose refusal names the shift and gives an example. A regex here
 * refused "0800" before the host could say which shift it was.
 */
const clockSchema = z.string();

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
        "group that holds everyone. An edit may keep the people the rule already names, " +
        'including "ALL".',
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

function countWeightSchema() {
  return z
    .string()
    .describe(
      "How strongly, written as you would type it in the Weight box. The solver is " +
        "REWARDED for the expression holding, in proportion to the weight: " +
        '"infinity" = must always hold (hard rule), a positive number such as "10" = keep ' +
        "to it where possible. A negative number works against the expression (the solver " +
        'is paid for breaking it) and "-infinity" forces the opposite, so a soft cap is ' +
        '"x <= T" with a POSITIVE weight. For "|x - T|^2" only 0 or less is allowed: a ' +
        'negative number such as "-5" pulls the count toward T, "-infinity" makes it ' +
        "exactly T. The schedule shows hard weights as .inf / -.inf: send them as " +
        "infinity / -infinity. Ask the user whether a new rule is a must or a preference " +
        "when they did not say.",
    );
}

function successionWeightSchema() {
  return z
    .string()
    .describe(
      'How strongly, written as you would type it in the Weight box: "-infinity" = must ' +
        "never happen (hard rule, the usual choice for a forbidden order such as a day " +
        'straight after a night), a negative number such as "-50" discourages, a positive ' +
        'number such as "10" encourages (for example a day off after nights). Avoid ' +
        '"infinity" (must always follow): with other hard rules it can make a roster ' +
        "impossible that would otherwise work; use a positive number instead. The schedule " +
        "shows hard weights as .inf / -.inf: send them as infinity / -infinity. Ask the user " +
        "whether a new rule is a must or a preference when they did not say.",
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
    weight: successionWeightSchema(),
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
          'close to T as possible (needs a weight of 0 or less, never "infinity"). x is a ' +
          "total over the dates, never days in a row: for at most 5 days in a row, any " +
          'shift, use add_shift_sequence_rule with "ALL" 6 times at "-infinity".',
      ),
    target: z.number().describe("The target T, a whole number of zero or more, e.g. 5."),
    weight: countWeightSchema(),
  };
}

function requirementFields() {
  return {
    description: ruleDescriptionSchema(),
    shiftType: z
      .string()
      .describe(
        "ONE shift code or shift group id to staff. A shift group id is one combined " +
          "count across all of its shifts on each date. OFF, LEAVE and ALL cannot be staffed.",
      ),
    qualifiedPeople: z
      .array(refSchema)
      .describe(
        "Only these people may work this shift; everyone else is banned from it (a hard " +
          'rule). Person ids or staff group ids, or ["ALL"] for no restriction. Not for a ' +
          "skill mix (e.g. at least 2 RNs on a shift with others allowed too): use " +
          'skillMix on add_staffing_requirement, or set_skill_mix, with ["ALL"] here. ' +
          "Never approximate a skill mix by naming a group here, which bans everyone " +
          "else from the shift.",
      ),
    dates: ruleDatesSchema(),
    requiredNumPeople: z
      .number()
      .describe(
        "The exact number of people on that shift on each date, e.g. 2 (a hard rule), " +
          "unless the requirement has a preferred count, which makes it the lowest " +
          "allowed. 0 with no preferred count forbids the shift. It cannot go below the " +
          "requirement's skill mix.",
      ),
    preferredNumPeople: z
      .number()
      .optional()
      .describe(
        "The Preferred number of people: 'at least requiredNumPeople, ideally this many'. " +
          'For "optional, ideally 1" send requiredNumPeople 0 and preferredNumPeople 1. At ' +
          "least 1 and not below requiredNumPeople; equal to it means no preference. Omit it " +
          "for an exact count. On an edit, omitting it keeps the stored preferred count.",
      ),
    weight: z
      .string()
      .optional()
      .describe(
        "How strongly the preferred count is pursued, as typed in the Weight box: 0 or " +
          'less, e.g. "-50" (the default for a new requirement); the more negative, the ' +
          'stronger. "-infinity" makes the preferred count a must. Only used when ' +
          "preferredNumPeople is above requiredNumPeople. On an edit, omitting it keeps the " +
          "stored weight.",
      ),
  };
}

function pairingFields() {
  const side = (which: string) =>
    z
      .array(refSchema)
      .describe(
        `${which}: person ids and staff group ids exactly as in the schedule. A group means ` +
          'any one of its members. "ALL" is not accepted.',
      );
  return {
    description: ruleDescriptionSchema(),
    people: side('One side of the pair, e.g. ["Ana"] or a group of new nurses'),
    withPeople: side('The other side, e.g. ["Ben"] or a group of seniors'),
    shiftTypes: z
      .array(z.string())
      .describe(
        "The shifts it is about: shift codes, shift group ids, OFF, LEAVE or ALL. Someone " +
          "from each side on any of these shifts on the same date counts as together.",
      ),
    dates: ruleDatesSchema(),
    weight: z
      .string()
      .describe(
        "How strongly, written as you would type it in the Weight box. On each date where " +
          "someone from people and someone from withPeople both work one of these shifts, the " +
          'solver gains the weight: a positive number such as "5" = together where possible, ' +
          'a negative number such as "-10" = apart where possible, "-infinity" = keep apart ' +
          'always (hard rule). Soft weights are finite numbers; "+infinity" is refused, ' +
          "because it forces both sides onto those shifts on every date. The schedule shows " +
          "a hard weight as -.inf: send it as -infinity. Ask the user whether a new rule is " +
          "a must or a preference when they did not say.",
      ),
  };
}

function supervisionFields() {
  return {
    description: ruleDescriptionSchema(),
    supervisors: z
      .array(refSchema)
      .describe(
        'Who can supervise, e.g. ["Seniors"]: person ids and staff group ids exactly as in ' +
          'the schedule. One of them on the shift is enough. "ALL" is not accepted.',
      ),
    supervisedPeople: z
      .array(refSchema)
      .describe(
        "Who needs a supervisor on shift with them, e.g. a new nurse or a student: person " +
          "ids and staff group ids. Whenever one of them works one of the shifts, at least " +
          "one supervisor works it too. Always a hard rule.",
      ),
    shiftTypes: z
      .array(z.string())
      .describe(
        "The shifts it applies to: shift codes or shift group ids. OFF and LEAVE are not " +
          "allowed, and neither is ALL: list every worked shift it applies to.",
      ),
    dates: z.array(z.string()).describe(
      // Deliberately NOT `ruleDatesSchema()`: unlike the other rule dates fields,
      // a Covering's date is OPTIONAL, so an empty list means every date and the
      // description must say so (`validateCoveringForm` allows it; the pairing /
      // succession / count forms require a date). The rest of the wording matches.
      'Which dates. [] = every date. Otherwise EITHER exactly one of "ALL", "WEEKDAY", ' +
        '"WEEKEND", a weekday name such as "MONDAY", or an existing date group id -- OR ' +
        "one or more roster dates written YYYY-MM-DD.",
    ),
  };
}

function skillMixSchema(extra = "") {
  return z
    .array(
      z.strictObject({
        people: refSchema.describe('One staff group id (or one person id), for example "RN".'),
        minNumPeople: z.number().int().min(1).describe("At least this many of them on the shift."),
      }),
    )
    .describe(
      "Skill mix: floors for named groups AMONG the shift's staff. Bans nobody. " +
        '"At least 2 RNs among the 4 on nights" = requiredNumPeople 4 + skillMix [{people:"RN",minNumPeople:2}]. ' +
        "Never use qualifiedPeople for this: qualifiedPeople bans everyone else." +
        extra,
    );
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
    requiredNumPeople: z
      .number()
      .describe(
        "How many people that shift must have: exactly this many, or at least this many " +
          "when the requirement has a preferred count.",
      ),
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
        "The new shift's short code as shown on the roster, e.g. D or N. Must not match any " +
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
          "Never ask the user whether a shift has a break. If they gave none, pick one: " +
          "copy the break of an existing shift of similar length, otherwise 0 under 6 hours, " +
          "30 from 6 to under 8 hours, 60 from 8 to under 12 hours, 120 for 12 hours or more " +
          "(a long day or night, e.g. a 12-hour day shift). Hours here are the clock span, start " +
          "to end. Say which break you chose " +
          "so the user can change it in Preview.",
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
    type: z.enum(["add_shift_sequence_rule"]),
    ...successionFields(),
  }),
  z.strictObject({
    type: z.enum(["edit_shift_sequence_rule"]),
    ruleId: ruleIdSchema(),
    ...successionFields(),
  }),
  z.strictObject({ type: z.enum(["add_count_rule"]), ...countFields() }),
  z
    .strictObject({ type: z.enum(["add_rest_days_rule"]) })
    .describe(
      'Add "2 rest days in any 7 days in a row" for every nurse: at most 5 worked days in ' +
        "any 7 days in a row (any 7 days, not Monday to Sunday), a strong preference; " +
        "leave and days off are not worked, and the days before the roster count from each " +
        "nurse's history. One rule; never build it from count or shift sequence rules.",
    ),
  z.strictObject({
    type: z.enum(["edit_count_rule"]),
    ruleId: ruleIdSchema(),
    ...countFields(),
  }),
  z.strictObject({
    type: z.enum(["add_staffing_requirement"]),
    ...requirementFields(),
    skillMix: skillMixSchema().optional(),
  }),
  z.strictObject({
    type: z.enum(["edit_staffing_requirement"]),
    ruleId: ruleIdSchema(),
    ...requirementFields(),
  }),
  z.strictObject({
    type: z.enum(["set_skill_mix"]),
    ruleId: ruleIdSchema(),
    skillMix: skillMixSchema(
      " Replaces the requirement's whole skill mix: list every entry to keep, " +
        "so to add a group include the existing entries too. [] removes it.",
    ),
  }),
  z.strictObject({
    type: z.enum(["set_staffing_requirement_on_date"]),
    ruleId: ruleIdSchema(),
    date: isoDateSchema.describe("One roster date the requirement covers, YYYY-MM-DD."),
    requiredNumPeople: z
      .number()
      .describe(
        "A different number of people for this one requirement on this one date only, for " +
          "example fewer on a public holiday: exactly this many, or at least this many when " +
          "the requirement has a preferred count. Every other date keeps the requirement's " +
          "own number. Send the requirement's own number to remove the exception. To change " +
          "every date, use set_staffing_requirement_people or edit_staffing_requirement instead.",
      ),
  }),
  z.strictObject({
    type: z.enum(["remove_rule"]),
    ruleKind: z.enum(RULE_KINDS).describe("Which rule family the rule belongs to."),
    ruleId: ruleIdSchema(),
  }),
  z.strictObject({
    type: z.enum(["add_person"]),
    name: z
      .string()
      .describe(
        'The person\'s name as the staff list should show it, e.g. "Float RN (Ward X)". Must ' +
          "not match any existing person or staff group, and must not be ALL. Their trimmed " +
          "name becomes their id -- use it as personId in a later command in the same batch, " +
          "e.g. to mark a borrowed nurse off outside the days they cover.",
      ),
    groups: z
      .array(z.string())
      .describe(
        'Staff groups to put them in, e.g. ["RN"]. Each must exist or be added EARLIER in ' +
          "the same change. Send [] for none. Never list ALL: everyone is in it. Rules that " +
          "target ALL or these groups also bind this person, including hard hours and " +
          "shift-count rules; for someone here only a few days, narrow those rules with " +
          "edit_count_rule in the same change.",
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
          "removed. Send their current groups to keep them. Rules that target a group they " +
          "join also bind them, including hard hours and shift-count rules; for someone here " +
          "only a few days, narrow those rules with edit_count_rule in the same change.",
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
  z.strictObject({
    type: z.enum(["add_temporary_cover"]),
    name: z
      .string()
      .describe(
        "The nurse's name as the Staff list should show it, with the ward she comes from in " +
          'brackets, e.g. "Nurse A (Ward X)". She is a TEMPORARY COVER, not a person: no staff ' +
          "row, no requests and no rules name her, and she is never a nurse who can be put on " +
          "the roster. A cover already booked for the same name and date is refused.",
      ),
    date: isoDateSchema.describe("The one date she covers, YYYY-MM-DD."),
    shiftType: z
      .string()
      .describe(
        "The shift-type id she works on that date, exactly as the Shifts screen shows it, " +
          "e.g. N. One shift a day: a second cover for the same nurse on the same date is refused.",
      ),
    groups: z
      .array(z.string())
      .describe(
        'Staff groups she counts as on that date, e.g. ["RN"]. Each must exist. Send [] for ' +
          "none. A card restricted to a group she is not in is not lowered by her, and the " +
          "preview says so.",
      ),
  }),
  z.strictObject({
    type: z.enum(["remove_temporary_cover"]),
    name: z.string().describe("The nurse's name exactly as the Staff list shows it."),
    date: isoDateSchema.describe("That cover's date, YYYY-MM-DD."),
    shiftType: z
      .string()
      .describe("That cover's shift-type id. All three fields must match one cover."),
  }),
  z.strictObject({ type: z.enum(["add_pairing_rule"]), ...pairingFields() }),
  z.strictObject({
    type: z.enum(["edit_pairing_rule"]),
    ruleId: ruleIdSchema(),
    ...pairingFields(),
  }),
  z.strictObject({ type: z.enum(["add_supervision_rule"]), ...supervisionFields() }),
  z.strictObject({
    type: z.enum(["edit_supervision_rule"]),
    ruleId: ruleIdSchema(),
    ...supervisionFields(),
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
