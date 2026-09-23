// NEGATIVE TYPE FIXTURES for the scenario projection façade (custom-AST ticket 2).
//
// These replace the alias/destructuring/bracket half of `authority-boundary.test.ts`.
// That gate walked the TypeScript AST looking for a WRITE SPELLING; it was correct and
// it was also the wrong layer, because it could only ever enumerate the shapes someone
// had already thought of. The rule here is not "do not spell `setState`" — it is that
// the projection HAS no `setState` to spell, so every one of those shapes fails for the
// same reason, including the ones nobody enumerated.
//
// Every `@ts-expect-error` FAILS THE BUILD if the error stops occurring, so each line is
// a live claim rather than a comment. Checked by the ordinary `tsc --noEmit` gate;
// `.test-d.ts` is not collected by vitest, so nothing here executes.
//
// WHAT THIS FILE CANNOT DO. A compile-time fixture cannot prove a RUNTIME object lacks a
// member — annotations are erased, and `Reflect.get` is typed `any`. The complement is
// `scenario-projection.test.ts`, which proves the mutator is genuinely absent from the
// value, not merely from its type.

import type { ScenarioProjection, ScenarioStoreState } from "./scenario-store";
import type { StateSpine } from "./spine";

/** True only when `K` is a member of `T`. Keeps every assertion an expression-free type. */
type Has<T, K extends PropertyKey> = K extends keyof T ? true : false;

/** Compile error unless the argument is exactly `false`. */
function assertAbsent(_absent: false): void {}

// --- the projection carries READS, never a write ------------------------------
//
// Every mutating member of zustand's store api, asserted absent. If the exported value
// ever widened back to the api, its `Has<…>` becomes `true` and this file stops
// compiling.

assertAbsent(false as Has<ScenarioProjection, "setState">);
assertAbsent(false as Has<ScenarioProjection, "destroy">);
assertAbsent(false as Has<ScenarioProjection, "temporal">);

// And the spine's copy of it is the same value, not a wider one.
assertAbsent(false as Has<StateSpine["scenario"], "setState">);

// THE FOUR EVASIONS THE REGEX SCAN LET THROUGH, and which the AST scan had to be
// written to catch. None of them is caught by a name here: each fails because the
// member does not exist.
declare const projection: ScenarioProjection;

// @ts-expect-error bracket access resolves to nothing: there is no index signature.
const byIndex: unknown = projection["setState"];
void byIndex;

// @ts-expect-error destructuring cannot produce a member the value does not have.
const { setState } = projection;
void setState;

// @ts-expect-error an alias to a write-bearing type is rejected at the assignment.
const aliased: { setState: (next: ScenarioStoreState) => void } = projection;
void aliased;

// @ts-expect-error and so is the same move through the spine.
const viaSpine: { setState: unknown } = ({} as StateSpine).scenario;
void viaSpine;

// The reads it DOES carry stay usable — the façade removes the writer, not the view.
const usable: unknown = [projection.getState, projection.subscribe, projection.getInitialState];
void usable;

// --- the write capability is not obtainable from the public surface -----------
//
// `@/lib/store` deliberately re-exports neither `createScenarioProjection` nor the
// writer types. The app projection's writer is a module-local `const` in `spine.ts`,
// so there is no exported value anywhere from which one can be recovered — which is
// why there is no `@ts-expect-error` here to write: the import itself would not
// resolve, and an unresolved import is a hard error, not a suppressible one.

// `Reflect.get` is the one route TypeScript cannot reject — it returns `any`. That is a
// real limit of this file, and it is why the projection is a WRAPPER at runtime rather
// than the api behind a narrow annotation: there is genuinely no member to find. The
// runtime half of that claim is proved by `scenario-projection.test.ts`.
const reflected: unknown = Reflect.get(projection, "setState");
void reflected;
