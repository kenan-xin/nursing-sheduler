// The repository command types a capability entry may reference (T06).
//
// WHAT `supportedCommands` MEANS, precisely: the durable command types the HOST's
// own manual path commits for that capability. It is NOT model authority and never
// becomes one -- T06 registers no mutation tool, and the Apply boundary stays a host
// action. Recording it is what lets a help answer say "this screen writes a change
// you can undo" truthfully, and it is what a later mutation ticket validates its
// typed proposals against instead of inventing a parallel list.
//
// WHY THIS IS RESTATED RATHER THAN IMPORTED FROM `lib/repository`. The durable
// repository sits behind an enforced authority boundary: only the projection adapter
// may import it, so that no other module can acquire a path to durable mutation. A
// type-only import would grant no runtime capability, but the gate is about the
// specifier, and spending a P0 architectural boundary to save four string literals in
// a READ-ONLY help feature is the wrong trade.
//
// The drift risk that import would have covered is covered instead by
// `commands.test.ts`, which reads `lib/repository/commands.ts` as TEXT and asserts the
// two lists agree in both directions. Same guarantee, no boundary crossing -- the
// technique the assistant's `protocol.test.ts` already uses to keep the browser's
// header constants identical to the runtime's without importing the server module.

export const SCENARIO_COMMAND_TYPES = [
  "patch_scenario",
  "set_req_data",
  "replace_scenario",
  "record_backup",
] as const;

export type ScenarioCommandType = (typeof SCENARIO_COMMAND_TYPES)[number];
