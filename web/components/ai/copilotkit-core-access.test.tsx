// @vitest-environment jsdom
//
// THE RUNTIME HALF of the core-access boundary.
//
// WHY THIS FILE HAD TO EXIST. `useRegistrationScope()` was typed `object` but RETURNED THE
// LIVE CORE. TypeScript erases the annotation, so at runtime the value still carried
// `setTools`, `addTool`, `tools` and the rest on its prototype -- and a reviewer recovered
// them with `Reflect.get`, replaced every handler while preserving name, agent and schema,
// and passed both normal lint and normal typecheck. The compile-time fixtures could not
// catch that, because a type cannot describe what an object has at runtime.
//
// So these assertions are deliberately made against the REAL provider, through the REAL
// hook, with no type narrowing: `Reflect.get`, `Reflect.ownKeys` and prototype inspection,
// which are exactly the routes a cast would use.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";

import { useAssistantTurnRunner, useRegistrationScope } from "./copilotkit-core-access";

/** Every capability the live core exposes that must not be reachable from the scope. */
const CORE_CAPABILITIES = [
  "addTool",
  "removeTool",
  "setTools",
  "setToolEnabled",
  "isToolEnabled",
  "subscribe",
  "runAgent",
  "stopAgent",
  "tools",
  "agents",
  "context",
  "runtimeUrl",
  "headers",
  "properties",
] as const;

const scopes: object[] = [];
const runners: unknown[] = [];

function Probe() {
  scopes.push(useRegistrationScope());
  runners.push(useAssistantTurnRunner()());
  return null;
}

function Provider({ children }: { children: React.ReactNode }) {
  return <CopilotKitProvider>{children}</CopilotKitProvider>;
}

afterEach(() => {
  cleanup();
  scopes.length = 0;
  runners.length = 0;
});

describe("the registration scope is inert at runtime", () => {
  it("is non-vacuous: a scope really was produced through the real provider", () => {
    render(
      <Provider>
        <Probe />
      </Provider>,
    );
    // Counted as DISTINCT tokens, not as calls: the provider re-renders after it
    // initialises, so the probe runs more than once per mount and a call count would be
    // asserting an implementation detail of the library.
    expect(scopes.length).toBeGreaterThan(0);
    expect(new Set(scopes).size).toBe(1);
    expect(typeof scopes[0]).toBe("object");
    expect(scopes[0]).not.toBeNull();
  });

  it("exposes NO core capability through Reflect.get", () => {
    render(
      <Provider>
        <Probe />
      </Provider>,
    );
    const scope = scopes[0];
    // The exact route the reviewer used. Every one of these was reachable before.
    for (const capability of CORE_CAPABILITIES) {
      expect(Reflect.get(scope, capability), capability).toBeUndefined();
    }
  });

  it("has no own keys and no prototype, so nothing is inherited either", () => {
    render(
      <Provider>
        <Probe />
      </Provider>,
    );
    const scope = scopes[0];
    expect(Reflect.ownKeys(scope)).toEqual([]);
    // `Object.create(null)`: not even `Object.prototype`, so no inherited member exists to
    // find by any spelling.
    expect(Object.getPrototypeOf(scope)).toBeNull();
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it("cannot be written to, so a capability cannot be grafted on", () => {
    render(
      <Provider>
        <Probe />
      </Provider>,
    );
    const scope = scopes[0] as Record<string, unknown>;
    expect(() => {
      "use strict";
      scope.setTools = () => {};
    }).toThrow();
    expect(Reflect.get(scope, "setTools")).toBeUndefined();
  });

  it("the per-turn RUNNER exposes no registry capability either", () => {
    // The runner is the other thing production holds, and it is where the reviewer
    // reached a core last time: the session used to construct its own `CopilotKitCore`
    // and could call `setTools` on it, replacing a canonical handler with the same name,
    // agent and exact schema while the parent registry -- the one the mounted proof
    // reads -- stayed untouched.
    render(
      <Provider>
        <Probe />
      </Provider>,
    );
    const runner = runners[0] as Record<string, unknown>;
    for (const capability of CORE_CAPABILITIES) {
      expect(Reflect.get(runner, capability), capability).toBeUndefined();
    }
    // Also the base-class members reachable through the package's `export *` wildcard --
    // `CopilotKitCore` and `RunHandler` -- and any obvious back-reference.
    for (const capability of ["runTool", "initialize", "core", "_core", "runHandler"]) {
      expect(Reflect.get(runner, capability), capability).toBeUndefined();
    }
    // EXACTLY three capabilities, all functions, frozen.
    expect(Reflect.ownKeys(runner).sort()).toEqual(["dispose", "errored", "run"]);
    expect(Object.isFrozen(runner)).toBe(true);
    for (const key of ["run", "errored", "dispose"]) {
      expect(typeof runner[key], key).toBe("function");
    }
  });
});

describe("the scope's identity matches the provider's, which is what the ledger needs", () => {
  it("is STABLE across re-renders of one provider", () => {
    const { rerender } = render(
      <Provider>
        <Probe />
      </Provider>,
    );
    rerender(
      <Provider>
        <Probe />
      </Provider>,
    );
    expect(scopes.length).toBeGreaterThanOrEqual(2);
    // One core, one token: otherwise a re-render would look like a fresh provider and the
    // duplicate ledger would lose track of what is mounted.
    expect(new Set(scopes).size).toBe(1);
  });

  it("is DISTINCT between two independent providers", () => {
    render(
      <>
        <Provider>
          <Probe />
        </Provider>
        <Provider>
          <Probe />
        </Provider>
      </>,
    );
    // Two cores, two tokens. This is what keeps a collision core-local: the same tool
    // identity in two providers is not a conflict, and a shared token would make it one.
    expect(new Set(scopes).size).toBe(2);
  });
});
