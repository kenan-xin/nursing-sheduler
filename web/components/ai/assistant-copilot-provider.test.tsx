// @vitest-environment jsdom
//
// THE RUNTIME HALF of the canonical provider wrapper.
//
// `CopilotKitProvider` registers tools supplied as PROPS, with no hook call and no core
// access. The wrapper closes that by accepting only the three configuration props this app
// sets. Two things need proving at runtime, because a type cannot show either:
//
//   1. the wrapper still mounts a working provider with the app's real configuration;
//   2. an entry smuggled in through a spread -- the one route TypeScript does not reject,
//      for any channel -- reaches the library as NOTHING, because the wrapper forwards
//      only its four named props.
//
// SCOPE, stated so the evidence is not read as broader than it is. The spread cases below
// cover the two EXECUTABLE channels: `frontendTools` and `openGenerativeUI.sandboxFunctions`.
// Each has a raw-provider control, so neither can pass against a wrapper that simply never
// worked. `humanInTheLoop`, `agents__unsafe_dev_only`, `selfManagedAgents` and the render
// registries are dropped by the same mechanism -- the wrapper never forwards them -- but
// that is an argument from the implementation, not a case in this file. The type fixtures
// cover all of those names for the direct, alias and index routes.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useCopilotKit, useSandboxFunctions } from "@copilotkit/react-core/v2";
import { z } from "zod";

import {
  AssistantCopilotProvider,
  type AssistantCopilotProviderProps,
} from "./assistant-copilot-provider";

const RUNTIME_URL = "/api/copilotkit";

interface Seen {
  runtimeUrl: string | undefined;
  toolNames: string[];
}

let seen: Seen | null = null;

function Probe() {
  const { copilotkit } = useCopilotKit();
  seen = {
    runtimeUrl: copilotkit.runtimeUrl,
    toolNames: (copilotkit.tools as { name: string }[]).map((tool) => tool.name),
  };
  return null;
}

/**
 * What the sandbox-function context actually holds.
 *
 * Read through the library's own hook, because that is what
 * `OpenGenerativeUIActivityRenderer` reads before executing each `handler`.
 */
let sandboxSeen: string[] = [];

function SandboxProbe() {
  sandboxSeen = useSandboxFunctions().map((fn: { name: string }) => fn.name);
  return null;
}

afterEach(() => {
  cleanup();
  seen = null;
  sandboxSeen = [];
});

describe("the canonical provider wrapper", () => {
  it("mounts a working provider with the app's real configuration", () => {
    render(
      <AssistantCopilotProvider runtimeUrl={RUNTIME_URL} headers={() => ({ "x-probe": "1" })}>
        <Probe />
      </AssistantCopilotProvider>,
    );
    // Non-vacuity: a provider really mounted and carries what the surface configures.
    expect(seen).not.toBeNull();
    expect(seen!.runtimeUrl).toBe(RUNTIME_URL);
  });

  it("registers nothing by itself, so the tool surface starts empty", () => {
    render(
      <AssistantCopilotProvider runtimeUrl={RUNTIME_URL} headers={() => ({})}>
        <Probe />
      </AssistantCopilotProvider>,
    );
    expect(seen!.toolNames).toEqual([]);
  });

  it("DROPS a frontendTools entry smuggled through a spread", () => {
    // The exact shape a same-name override would take: a frontend tool supplied as a
    // provider prop. The type system permits the spread; the wrapper forwards only its
    // four named props, so the library never sees it.
    const smuggled = {
      frontendTools: [
        {
          name: "get_schedule_overview",
          agentId: "scheduler:thread-1",
          description: "unsafe replacement",
          handler: async () => "unsafe",
        },
      ],
    };
    const props = {
      runtimeUrl: RUNTIME_URL,
      headers: () => ({}),
      children: <Probe />,
      ...smuggled,
    } as AssistantCopilotProviderProps;

    render(<AssistantCopilotProvider {...props} />);

    // Nothing was registered: the prop never reached `CopilotKitProvider`.
    expect(seen!.toolNames).toEqual([]);
    expect(seen!.toolNames).not.toContain("get_schedule_overview");
  });

  it("DROPS sandbox functions smuggled through openGenerativeUI", async () => {
    // THE OTHER EXECUTABLE CHANNEL, and it does not look like one. `openGenerativeUI`
    // carries `sandboxFunctions`, whose `handler` callbacks `OpenGenerativeUIActivityRenderer`
    // executes by building `api[fn.name] = fn.handler` for sandboxed HTML. Supplying them
    // as a provider prop is therefore supplying executable behaviour, with no hook call and
    // no core access.
    let called = false;
    const smuggled = {
      openGenerativeUI: {
        sandboxFunctions: [
          {
            name: "unsafe",
            description: "unsafe",
            parameters: z.object({}),
            handler: async () => {
              called = true;
              return "unsafe";
            },
          },
        ],
      },
    };
    const props = {
      runtimeUrl: RUNTIME_URL,
      headers: () => ({}),
      children: <SandboxProbe />,
      ...smuggled,
    } as AssistantCopilotProviderProps;

    render(<AssistantCopilotProvider {...props} />);

    // The wrapper forwards four named props, so the context the renderer reads is empty.
    expect(sandboxSeen).toEqual([]);
    expect(called).toBe(false);
  });

  it("is not vacuous: the raw provider DOES accept those sandbox functions", async () => {
    // Without this control the case above would pass against a wrapper that never worked.
    const { CopilotKitProvider } = await import("@copilotkit/react-core/v2");
    render(
      <CopilotKitProvider
        runtimeUrl={RUNTIME_URL}
        openGenerativeUI={{
          sandboxFunctions: [
            {
              name: "unsafe",
              description: "unsafe",
              parameters: z.object({}),
              handler: async () => "unsafe",
            },
          ],
        }}
      >
        <SandboxProbe />
      </CopilotKitProvider>,
    );
    expect(sandboxSeen).toEqual(["unsafe"]);
  });

  it("is not vacuous: the raw provider WOULD have registered that same prop", async () => {
    // Without this, the case above would pass against a wrapper that simply never worked.
    // The raw library provider is given the identical prop and does register it -- which
    // is precisely the door the wrapper exists to close.
    const { CopilotKitProvider } = await import("@copilotkit/react-core/v2");
    render(
      <CopilotKitProvider
        runtimeUrl={RUNTIME_URL}
        frontendTools={[
          {
            name: "get_schedule_overview",
            agentId: "scheduler:thread-1",
            description: "unsafe replacement",
            handler: async () => "unsafe",
          },
        ]}
      >
        <Probe />
      </CopilotKitProvider>,
    );
    expect(seen!.toolNames).toContain("get_schedule_overview");
  });
});
