// NEGATIVE TYPE FIXTURES for the production core façade.
//
// The runtime proofs cannot show an ABSENCE: a test that never calls `setTools` proves
// nothing about whether it could. These are compile-time assertions instead -- every
// `@ts-expect-error` below FAILS THE BUILD if the error stops occurring, so each one is a
// live claim that the capability is unreachable rather than merely unused.
//
// Checked by `tsc --noEmit` on the ordinary typecheck gate; `.test-d.ts` is not collected
// by vitest, so nothing here executes.
//
// WHAT THIS FILE CANNOT DO. A compile-time fixture cannot prove a RUNTIME object lacks a
// member: a type annotation is erased, and the previous version of this boundary returned
// the live core annotated as `object`, from which `Reflect.get` recovered every mutator.
// The runtime claims live in `copilotkit-core-access.test.tsx`; these are its complement.
//
// The routes covered are the ones a reviewer actually used to get past name-based lint:
// direct property, computed index, destructuring, aliasing, and `Reflect.get`.

import type { AssistantTurnRunner } from "./copilotkit-core-access";

/** True only when `K` is a member of `T`. Keeps every assertion an expression-free type. */
type Has<T, K extends PropertyKey> = K extends keyof T ? true : false;

/** Compile error unless the argument is exactly `false`. */
function assertAbsent(_absent: false): void {}

// --- the turn basis carries CONFIGURATION, never capability -------------------
//
// Every mutator CopilotKit's core exposes, asserted absent. If the façade ever widened to
// leak one, its `Has<…>` becomes `true` and this file stops compiling.

assertAbsent(false as Has<AssistantTurnRunner, "addTool">);
assertAbsent(false as Has<AssistantTurnRunner, "removeTool">);
// `setTools` is the exact route a reviewer used to replace a per-turn handler while
// keeping its name, agent and exact schema object -- invisible to every registry proof,
// because the parent provider's registry is untouched by it.
assertAbsent(false as Has<AssistantTurnRunner, "setTools">);
assertAbsent(false as Has<AssistantTurnRunner, "setToolEnabled">);
assertAbsent(false as Has<AssistantTurnRunner, "runTool">);
assertAbsent(false as Has<AssistantTurnRunner, "subscribe">);
assertAbsent(false as Has<AssistantTurnRunner, "initialize">);
// The registry itself, and the core behind it.
assertAbsent(false as Has<AssistantTurnRunner, "tools">);
assertAbsent(false as Has<AssistantTurnRunner, "agents">);
assertAbsent(false as Has<AssistantTurnRunner, "core">);

// COMPUTED AND ALIASED ROUTES. These are the spellings `no-restricted-properties` cannot
// see; they fail here because the member does not exist, not because it is spelled a
// particular way.
declare const runner: AssistantTurnRunner;
// @ts-expect-error a computed literal resolves to nothing: there is no index signature.
const byIndex: unknown = runner["setTools"];
void byIndex;
// @ts-expect-error destructuring cannot produce a member the value does not have.
const { setTools } = runner;
void setTools;
// @ts-expect-error and aliasing to a capability-bearing type is rejected.
const aliased: { setTools: unknown } = runner;
void aliased;

// The three capabilities it DOES carry stay usable -- the boundary removes the registry,
// not the ability to run a turn.
const usable: unknown = [runner.run, runner.errored, runner.dispose];
void usable;

// --- the registration scope is an identity, not a core ------------------------

assertAbsent(false as Has<object, "addTool">);
assertAbsent(false as Has<object, "setTools">);

declare const scope: object;
// @ts-expect-error `object` has no members at all; it is a WeakMap key.
const scopedIndex: unknown = scope["setTools"];
void scopedIndex;
// @ts-expect-error and it cannot be widened to something that does.
const escaped: { setTools: unknown } = scope;
void escaped;

// `Reflect.get` is the one route TypeScript cannot reject -- it is typed to return `any`,
// so no compile-time fixture can bound it. That is a real limit of this file, and it is
// why the scope is an INERT TOKEN at runtime rather than the core behind an `object`
// annotation: there is genuinely no member to find, whatever the caller writes.
//
// The runtime half of that claim is proved by `copilotkit-core-access.test.tsx`, not here.
// This line only records that the compile-time proof stops at this point.
const reflected: unknown = Reflect.get(scope, "setTools");
void reflected;
