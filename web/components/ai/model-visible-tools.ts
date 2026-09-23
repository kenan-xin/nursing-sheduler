// Every tool schema the model can see, in one place, so the shipped set can be
// validated AS A SET.
//
// WHY THIS EXISTS. A live turn issued one provider request and stopped with no answer
// and no error on screen. The web container had logged `Invalid JSON schema: { "type":
// "null" }`: `@copilotkit/runtime@1.66.2` converts each tool's JSON Schema back into Zod
// before the provider loop, and its converter handles object/string/number/integer/
// boolean/array and unions of those -- nothing else. One `.nullable()` field, five
// levels down a schema nobody had reason to re-read, disabled every tool on the turn.
//
// A per-file test could not have caught that, because the failure is a property of the
// SET: the runtime converts all of them, and one bad node stops the lot. So the tools
// are listed here, the registration sites import their schema from their own module as
// before, and `model-visible-tools.test.ts` pushes every entry through the real locked
// conversion boundary.

import type { z } from "zod";

import { sliceParameters } from "./use-context-tools";
import { diagnosticParameters } from "./use-diagnostic-tools";
import { capabilityIdParameters, policyParameters } from "./use-help-tools";
import { prepareParameters } from "./use-proposal-tools";

/**
 * The tools that take arguments, by the exact name the model calls.
 *
 * `get_schedule_overview` and `list_app_capabilities` are absent deliberately: they are
 * registered with no `parameters` at all, and {@link PARAMETERLESS_MODEL_VISIBLE_TOOLS}
 * accounts for them so the two lists together are the whole shipped set.
 */
export const MODEL_VISIBLE_TOOL_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze({
  get_schedule_section: sliceParameters,
  test_feasibility_candidates: diagnosticParameters,
  explain_app_capability: capabilityIdParameters,
  suggest_scheduling_rule: policyParameters,
  open_app_screen: capabilityIdParameters,
  prepare_scenario_change: prepareParameters,
});

/** The tools registered with no parameters. Named so the set is provably complete. */
export const PARAMETERLESS_MODEL_VISIBLE_TOOLS: readonly string[] = Object.freeze([
  "get_schedule_overview",
  "list_app_capabilities",
  "request_optimize_run",
  "get_optimize_result",
]);
